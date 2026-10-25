// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { loadSimplePdfFont } from './fonts.js';
import { multiply } from './viewport.js';
import { deviceGray, resolvePdfColorSpace } from './color-spaces.js';
import { readPdfImage } from './image-data.js';
import { decodePdfString } from './pdf-string.js';
import { MAX_IMAGE_PIXELS } from './image-limits.js';
import { convertPdfColor } from './icc-blend.js';
import { readPdfShading } from './shading.js';
import { PDF_CMYK_PRINT_DEFAULTS, createPdfPrintStateReader, createPdfCmykConverter } from './native-cmyk.js';
import { createPdfNativeImageSourceBudget } from './native-cmyk-image.js';
import { assertPdfCmykContributionGroup } from './native-cmyk-contribution.js';
import { PDF_ICC4_CONTRIBUTION, assertPdfIcc4ContributionGroup, pdfIcc4SourceValues } from './native-icc4-contribution.js';
import { assertPdfNativeRgbPrintDefaults } from './native-rgb-image.js';
import { iteratePdfContent } from './inline-image.js';
import { admitTextOutline } from './text-stroke.js';
import { createPdfPatternReader, resolvePdfPaintSpace } from './shading-pattern.js';
import { createPdfGroupSoftMaskContext, readPdfGroupSoftMask } from './group-soft-mask.js';
import { PDF_INHERITED_RGB_RECTANGLE, preparePdfInheritedRgbRectangle, assertPdfInheritedRgbMask, assertPdfInheritedRgbRectangle } from './inherited-rgb-rectangle.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const TYPE3_COLOR_OPERATORS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'sh', 'ri']);
const TILING_OPERATORS = new Set(['q', 'Q', 'cm', 'm', 'l', 'c', 'v', 'y', 're', 'h', 'W', 'W*', 'f', 'F', 'f*', 'n',
  'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'gs', 'BI', 'Do', 'ri', 'i']);
const CONTRIBUTION_OPERATORS = new Set(['q', 'Q', 'cm', 'm', 'l', 'c', 'v', 'y', 're', 'h', 'W', 'W*', 'f', 'F', 'f*', 'n',
  'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'gs', 'ri', 'i']);
const ICC4_CONTRIBUTION_OPERATORS = new Set([...CONTRIBUTION_OPERATORS, 'Do']);
const color = values => `rgb(${values.map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)).join(',')})`;
const unsupported = message => { throw new PdfEngineError(message); };
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };

export async function buildPdfDisplayList(reader, pageId, resourcesId, loadAsset, view = [0, 0, 612, 792], fontPrefix = '') {
  const commands = [], items = [], fonts = new Map(), fontCache = new Map(), imageCache = new Map(), activeForms = new Set();
  const nativeTextStates = new WeakMap();
  let warnedInheritedRgb = false;
  const printStateAt = createPdfPrintStateReader(reader), blendProfiles = new Map(), opaqueImagePixels = new WeakSet(), contributionProfiles = new WeakMap();
  const patternAt = createPdfPatternReader(reader, loadAsset, blendProfiles, buildPatternCell);
  const warningStart = reader.codecWarnings?.length || 0, textOutlineBudget = { points: 0 };
  let operations = 0, imagePixels = 0, hasRasterImage = false, hasRenderableNonText = false, outlinedWords = 0, unmappedGlyphs = 0, unknownType3Glyphs = 0, recognizedSymbolGlyphs = 0, textBytes = 0, textCharacters = 0, actualTextCharacters = 0, retainedTextCharacters = 0, mergeBoundary = 0, fontBytes = 0;
  const chargeOperation = () => { if (++operations > 500000) throw new PdfEngineError('PDF page operation budget exceeded.', 'pdf_limit'); };
  const nativeColor = createPdfCmykConverter(chargeOperation), nativeImageSources = createPdfNativeImageSourceBudget(); let nativeProfileBytes = null;
  const softMasks = createPdfGroupSoftMaskContext(blendProfiles, chargeOperation, pixels => {
    if ((imagePixels += pixels) > MAX_IMAGE_PIXELS) throw new PdfEngineError('PDF image pixel budget exceeded.', 'pdf_limit');
  });
  const state = () => ({ ctm: [...IDENTITY], font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0,
    matrix: [...IDENTITY], lineMatrix: [...IDENTITY], inText: false, fill: 'rgb(0,0,0)', stroke: 'rgb(0,0,0)', textMode: 0,
    fillSpace: deviceGray(), strokeSpace: deviceGray(), fillValues: [0], strokeValues: [0], outputProfile: null, outputProfileBytes: null, outputProfileKey: 0, nativeCmyk: false, printState: PDF_CMYK_PRINT_DEFAULTS,
    fillOverprint: false, strokeOverprint: false, overprintMode: 0, textKnockout: true, nativeMaskScope: false,
    fillAlpha: 1, strokeAlpha: 1, blend: 'source-over', lineWidth: 1, strokeAdjustment: false, fillPattern: null, strokePattern: null, softMask: null, alphaIsShape: false });
  function groupIsolation(group, label) {
    if (reader.node(group).kind !== 'dictionary') corrupt(`Invalid PDF ${label} group attributes.`);
    const type = reader.field(group, 'Type');
    if (type && reader.node(type).kind !== 'null' && reader.name(type) !== 'Group') corrupt(`Invalid PDF ${label} group Type.`);
    const subtype = reader.field(group, 'S');
    if (!subtype || reader.node(subtype).kind !== 'name') corrupt(`Invalid PDF ${label} group subtype.`);
    if (reader.name(subtype) !== 'Transparency') unsupported(`This PDF ${label} group type is not implemented yet.`);
    const flag = name => {
      const id = reader.field(group, name); if (!id) return false;
      const value = reader.node(id); if (value.kind === 'null') return false;
      if (value.kind !== 'boolean') corrupt(`PDF ${label} group ${name} must be boolean.`);
      return value.aux !== 0;
    };
    const isolated = flag('I');
    if (flag('K')) unsupported('Knockout PDF transparency groups are not implemented yet.');
    return isolated;
  }
  async function groupBlendContext(group, resources, parent) {
    const id = reader.field(group, 'CS');
    if (!id || reader.node(id).kind === 'null') return { outputProfile: parent.outputProfile, outputProfileBytes: parent.outputProfileBytes, outputProfileKey: parent.outputProfileKey, nativeCmyk: parent.nativeCmyk, nativeIcc4: parent.nativeIcc4 };
    // Exact-byte canonical profiles belong only to this build; no transferred bytes are reused by a reader.
    const space = await resolvePdfColorSpace(reader, resources, id, loadAsset, 0, blendProfiles);
    if (space.name === 'DeviceRGB') return { outputProfile: null, outputProfileBytes: null, outputProfileKey: 0, nativeCmyk: false };
    if (space.name === 'DeviceCMYK') {
      nativeProfileBytes ??= (await loadAsset('iccs/CGATS001Compat-v2-micro.icc')).slice();
      return { outputProfile: null, outputProfileBytes: nativeProfileBytes, outputProfileKey: 'DeviceCMYK', nativeCmyk: true };
    }
    if (space.name === 'ICCBased' && space.components === 4) {
      contributionProfiles.set(space.profileBytes, space.profile);
      return { outputProfile: null, outputProfileBytes: space.profileBytes, outputProfileKey: space.profileIdentity, nativeCmyk: true, nativeIcc4: true };
    }
    if (space.name !== 'ICCBased' || space.components !== 3 || typeof space.profile.fromXyz !== 'function') unsupported('This PDF group blend color space is not implemented yet.');
    return { outputProfile: space.profile, outputProfileBytes: space.profileBytes, outputProfileKey: space.profileIdentity, nativeCmyk: false };
  }
  function nativeState(s, fill = true, stroke = false, object = 'closed') {
    if (s.nativeIcc4) {
      if (!s.icc4ContributionScope || s.blend !== 'source-over' || s.softMask || s.fillOverprint || s.strokeOverprint
        || fill && s.fillSpace.name === 'Pattern' || stroke && s.strokeSpace.name === 'Pattern') unsupported('This PDF normal ICC4 contribution state is not implemented.');
      return;
    }
    if (s.blend !== 'source-over' || s.softMask || s.alphaIsShape) unsupported('This native PDF ink transparency or overprint is not implemented yet.');
    if (fill && s.fillOverprint || stroke && s.strokeOverprint) {
      if (s.nativeMaskScope || s.softMask) unsupported('Native PDF overprint in masked groups is not implemented yet.');
      if (object === 'closed') unsupported('This native PDF ink transparency or overprint is not implemented yet.');
      // Group objects do not invoke CompatibleOverprint; their elementary paints do.
      if (object !== 'group' && (s.type3Glyph || fill && s.fillOverprint && s.fillSpace.name !== 'DeviceCMYK'
        || stroke && s.strokeOverprint && s.strokeSpace.name !== 'DeviceCMYK')) unsupported('Native PDF overprint requires a direct DeviceCMYK vector source.');
    }
    if (fill && s.fillSpace.name === 'Pattern' || stroke && s.strokeSpace.name === 'Pattern') unsupported('Native PDF pattern paints are not implemented yet.');
  }
  const nativeInk = (s, fill) => s.nativeIcc4 ? pdfIcc4SourceValues(s[fill ? 'fillSpace' : 'strokeSpace'], s[fill ? 'fillValues' : 'strokeValues'], s.outputProfileBytes)
    : nativeColor(s[fill ? 'fillSpace' : 'strokeSpace'], s[fill ? 'fillValues' : 'strokeValues'], s.printState);
  const nativeBlend = (s, fill) => s.overprintMode === 1 && s[fill ? 'fillOverprint' : 'strokeOverprint'] ? 'overprint-nonzero' : 'source-over';
  const textPaintState = s => [s.fillSpace.name, ...s.fillValues, s.strokeSpace.name, ...s.strokeValues, s.fillOverprint, s.strokeOverprint,
    s.overprintMode, s.textKnockout, s.fillAlpha, s.strokeAlpha, s.blend, s.softMask, s.alphaIsShape, s.textMode,
    s.printState.blackGeneration, s.printState.undercolorRemoval];
  function validateNativeText(first, stateChanged) {
    const span = commands.slice(first), texts = span.filter(command => command.op === 'text');
    if (!texts.some(command => nativeTextStates.get(command)?.overprint)) return;
    if (span.some(command => !['text', 'save', 'restore', 'color', 'transform', 'setPdfTransform', 'lineStyle', 'dash'].includes(command.op))) unsupported('Native PDF overprinted text objects may contain only glyph paints.');
    const initial = nativeTextStates.get(texts[0]);
    if (!initial) unsupported('Invalid native PDF overprint text scope.');
    if (texts.some(command => nativeTextStates.get(command)?.knockout !== initial.knockout)) corrupt('PDF text knockout may not change within a text object.');
    if (!initial.knockout) return; // TKfalse makes every glyph an elementary object.
    if (stateChanged || texts.some(command => {
      const entry = nativeTextStates.get(command);
      return !entry?.knockout || !entry.direct || command.alpha !== 1 || entry.overprint !== initial.overprint || entry.mode !== initial.mode
        || !command.nativeCmyk || command.nativeCmyk.some((value, i) => value !== texts[0].nativeCmyk[i]);
    })) unsupported('Native PDF knockout overprint text requires homogeneous opaque DeviceCMYK glyphs.');
    // For this entire opaque same-ink object, per-glyph coverage has exactly the
    // same union/ink result as its implicit knockout group (ISO32000-1 9.3.8).
  }
  const nativeMarker = s => s.nativeCmyk ? { nativeColorSpace: s.nativeIcc4 ? 'ICCBased4' : 'DeviceCMYK' } : {};
  async function fontAt(id, retainOutlines = false) {
    id = reader.node(id).id;
    const key = retainOutlines ? `${id}:outlines` : id;
    if (!fontCache.has(key)) {
      if (fontCache.size >= 256) throw new PdfEngineError('PDF page font count limit exceeded.', 'pdf_limit');
      const font = await loadSimplePdfFont(reader, id, loadAsset, { retainOutlines });
      font.sourceFontId = id;
      const resourceBytes = font.resourceBytes ?? font.bytes.byteLength;
      if (fontBytes + resourceBytes > 64 * 1024 * 1024) throw new PdfEngineError('PDF page font byte limit exceeded.', 'pdf_limit');
      fontBytes += resourceBytes; font.family = `${fontPrefix}${font.family}`; fonts.set(font.family, font); fontCache.set(key, font);
    }
    return fontCache.get(key);
  }
  async function fontFor(resource, name) {
    const dictionary = reader.field(resource, 'Font'), id = dictionary && reader.field(dictionary, name);
    if (!id) corrupt(`Missing PDF font /${name}.`);
    return fontAt(id);
  }
  function number(id) { const n = reader.number(id, NaN); if (!Number.isFinite(n)) corrupt('Expected numeric PDF operand.'); return n; }
  function lineStyle(name, value, s) {
    if (name === 'w' && value < 0 || ['J', 'j'].includes(name) && (!Number.isInteger(value) || value < 0 || value > 2) || name === 'M' && value < 1) corrupt('Invalid PDF line style.');
    if (name === 'w') s.lineWidth = value;
    commands.push({ op: 'lineStyle', name, value });
  }
  function retainText(added, removed = 0) {
    const total = retainedTextCharacters - removed + added;
    if (total > 2_000_000) throw new PdfEngineError('PDF retained Unicode text budget exceeded.', 'pdf_limit');
    retainedTextCharacters = total;
  }
  function actualText(value) {
    const bytes = reader.bytes(value), unicode = bytes[0] === 254 && bytes[1] === 255 || bytes[0] === 255 && bytes[1] === 254;
    const utf8 = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
    // Reject oversized PDFDoc/UTF-16 strings before constructing character arrays.
    const units = unicode ? Math.max(0, (bytes.length - 2) / 2) : utf8 ? 0 : bytes.length;
    if (actualTextCharacters + units > 2_000_000) throw new PdfEngineError('PDF ActualText work budget exceeded.', 'pdf_limit');
    const text = decodePdfString(bytes); actualTextCharacters += text.length;
    if (actualTextCharacters > 2_000_000) throw new PdfEngineError('PDF ActualText work budget exceeded.', 'pdf_limit');
    return text;
  }
  function textItem(item) {
    const previous = items.at(-1), height = item.height;
    if (items.length > mergeBoundary && previous && !previous.vertical && !item.vertical && previous.fontName === item.fontName && !previous.hasEOL && height > 0 && previous.transform.slice(0, 4).every((n, i) => Math.abs(n - item.transform[i]) < 1e-7)) {
      const [a, b] = item.transform, magnitude = Math.hypot(a, b), dx = item.transform[4] - previous.transform[4], dy = item.transform[5] - previous.transform[5];
      const gap = (dx * a + dy * b) / magnitude - previous.width, offset = Math.abs(dx * b - dy * a) / magnitude;
      if (offset < height * .001 && gap >= -height * .5 && gap <= height * .7) {
        const space = gap > height * .12 && !/\s$/.test(previous.str) && !/^\s/.test(item.str) ? ' ' : '';
        retainText(space.length + item.str.length);
        const start = previous.str.length + space.length;
        if (item.recognizedSymbols?.length) previous.recognizedSymbols = [...(previous.recognizedSymbols || []), ...item.recognizedSymbols.map(symbol => ({ ...symbol, start: start + symbol.start }))];
        previous.str += space + item.str; previous.width += gap + item.width; return;
      }
    }
    retainText(item.str.length); items.push(item);
  }
  function verticalActualText(replaced, actual) {
    const first = replaced[0], [a, b, c, d, e, f] = first.transform, magnitude = Math.hypot(c, d), determinant = a * d - b * c;
    if (!magnitude || !determinant) unsupported('Singular vertical PDF ActualText geometry is not implemented yet.');
    const glyphs = []; let height = first.height;
    for (const item of replaced) {
      if (!item.vertical || item.fontName !== first.fontName || !item.glyphs || item.transform.slice(0, 4).some((n, i) => Math.abs(n - first.transform[i]) > 1e-7)) unsupported('Mixed-style vertical PDF ActualText geometry is not implemented yet.');
      const dx = item.transform[4] - e, dy = item.transform[5] - f;
      if (Math.abs(dx * d - dy * c) / magnitude > Math.max(first.width, item.width) * .5) unsupported('Multi-column vertical PDF ActualText geometry is not implemented yet.');
      height = Math.max(height, -(dx * c + dy * d) / magnitude + item.height);
      const tx = (d * dx - c * dy) / determinant, ty = (-b * dx + a * dy) / determinant;
      for (const glyph of item.glyphs) glyphs.push({ ...glyph, x: glyph.x + tx, y: (glyph.y ?? 0) + ty });
    }
    if (glyphs.map(glyph => glyph.text).join('') !== actual) {
      const points = [...actual];
      if (glyphs.length === 1) glyphs[0].text = actual;
      else if (points.length === glyphs.length) glyphs.forEach((glyph, i) => { glyph.text = points[i]; });
      else unsupported('Vertical PDF ActualText has no unambiguous per-glyph source association.');
    }
    return { ...first, str: actual, glyphs, height, dir: 'ttb', textOrder: 'logical', recognizedSymbols: undefined };
  }
  async function show(bytes, s, resource, depth, textClips) {
    if (!s.inText || !s.font) corrupt('PDF text has no active font or text object.');
    if ((textBytes += bytes.length) > 500000) throw new PdfEngineError('PDF text glyph budget exceeded.', 'pdf_limit');
    const outlinedText = ![0, 3].includes(s.textMode), clipText = s.textMode >= 4, paintMode = s.textMode & 3, needsOutlines = outlinedText && s.fontSize !== 0 && s.hScale !== 0;
    if (needsOutlines && !s.font.glyphOutline && s.font.canProvideOutlines) s.font = await fontAt(s.font.sourceFontId, true);
    const glyphs = s.font.decode(bytes), matrix = multiply(s.ctm, s.matrix), textTransform = multiply(matrix, [s.fontSize * s.hScale, 0, 0, s.fontSize, 0, s.rise]);
    textCharacters += glyphs.reduce((sum, glyph) => sum + glyph.text.length, 0); if (textCharacters > 2_000_000) throw new PdfEngineError('PDF Unicode text budget exceeded.', 'pdf_limit');
    unmappedGlyphs += glyphs.filter(glyph => glyph.unmapped).length;
    recognizedSymbolGlyphs += glyphs.filter(glyph => glyph.symbol).length;
    if (needsOutlines && glyphs.some(glyph => !glyph.type3) && typeof s.font.glyphOutline !== 'function') unsupported('This PDF font has no original glyph outline support.');
    const vertical = !!s.font.vertical, spacing = glyph => s.charSpacing + (glyph.code === 32 && (glyph.codeLength ?? 1) === 1 ? s.wordSpacing : 0);
    if (!s.fontSize || !s.hScale) {
      const advance = glyphs.reduce((sum, glyph) => sum + (vertical ? glyph.vmetric.advanceY / 1000 * s.fontSize : 0) + spacing(glyph), 0) * (vertical ? 1 : s.hScale);
      s.matrix = multiply(s.matrix, [1, 0, 0, 1, vertical ? 0 : advance, vertical ? advance : 0]); return;
    }
    if (s.softMask && (paintMode !== 3 || s.textMode !== 3 && glyphs.some(glyph => glyph.type3))) unsupported('PDF soft masks on elementary text paints are not implemented yet.');
    if (s.nativeCmyk && paintMode !== 3) {
      nativeState(s, paintMode !== 1, paintMode !== 0, paintMode === 0 ? 'elementary' : 'closed');
      if (s.fillOverprint && glyphs.some(glyph => glyph.type3)) unsupported('Native PDF overprinted Type3 glyphs are not implemented yet.');
      if (outlinedText) unsupported('Native PDF outlined text paint is not implemented yet.');
    }
    if (glyphs.length && (glyphs.some(glyph => glyph.type3) && s.textMode !== 3 && (s.fillPattern || s.strokePattern)
      || [0, 2].includes(paintMode) && s.fillSpace.name === 'Pattern' || [1, 2].includes(paintMode) && s.strokeSpace.name === 'Pattern')) unsupported('PDF shading patterns in painted text are not implemented.');
    if (!s.type3Glyph) unknownType3Glyphs += glyphs.filter(glyph => glyph.unknownType3Text).length;
    let advance = 0; const positions = [];
    for (const glyph of glyphs) {
      const retainedOutline = outlinedText && !glyph.type3 ? admitTextOutline(s.font.glyphOutline(glyph.code, glyph), textOutlineBudget) : null;
      const x = vertical ? -glyph.vmetric.vx / 1000 : advance / (s.fontSize * s.hScale), y = vertical ? advance / s.fontSize - glyph.vmetric.vy / 1000 : 0;
      if (glyph.type3 && s.textMode !== 3) {
        const stream = reader.node(glyph.type3.stream).id; if (activeForms.has(stream)) corrupt('Cyclic Type3 glyph.'); activeForms.add(stream);
        const ctm = multiply(multiply(textTransform, [1, 0, 0, 1, x, 0]), glyph.type3.matrix), before = items.length;
        commands.push({ op: 'save' }, { op: 'setPdfTransform', args: ctm });
        try { await contents(glyph.type3.stream, glyph.type3.resources || resource, { ...state(), ctm, fill: s.fill, stroke: s.stroke, fillSpace: s.fillSpace, strokeSpace: s.strokeSpace, fillValues: s.fillValues, strokeValues: s.strokeValues,
          outputProfile: s.outputProfile, outputProfileBytes: s.outputProfileBytes, outputProfileKey: s.outputProfileKey, nativeCmyk: s.nativeCmyk, printState: s.printState,
          fillOverprint: s.fillOverprint, strokeOverprint: s.strokeOverprint, overprintMode: s.overprintMode, textKnockout: s.textKnockout, nativeMaskScope: s.nativeMaskScope,
          fillAlpha: s.fillAlpha, strokeAlpha: s.strokeAlpha, blend: s.blend, lineWidth: s.lineWidth, strokeAdjustment: s.strokeAdjustment, type3Uncolored: s.type3Uncolored, type3Glyph: true }, depth + 1); }
        finally { const removed = items.splice(before); retainedTextCharacters -= removed.reduce((sum, item) => sum + item.str.length, 0); activeForms.delete(stream); }
        commands.push({ op: 'restore' });
      } else if (!glyph.type3) positions.push({ text: glyph.text, ...(glyph.renderText ? { renderText: glyph.renderText } : {}), ...(glyph.systemText ? { systemText: glyph.systemText } : {}), x,
        ...(vertical ? { y, width: glyph.width / 1000 } : {}), ...(retainedOutline ?? (glyph.outline ? { outline: glyph.outline, fontMatrix: glyph.fontMatrix } : {})) });
      advance += vertical ? glyph.vmetric.advanceY / 1000 * s.fontSize + spacing(glyph) : (glyph.width / 1000 * s.fontSize + spacing(glyph)) * s.hScale;
    }
    const recognizedSymbols = []; let characterOffset = 0;
    for (const glyph of glyphs) { if (glyph.symbol) recognizedSymbols.push({ ...glyph.symbol, start: characterOffset, length: glyph.text.length }); characterOffset += glyph.text.length; }
    const str = glyphs.map(glyph => glyph.text).join('');
    if (str) {
      textItem({ str: str.replace(/\u00ad/g, '-'), transform: textTransform,
        width: vertical ? Math.hypot(textTransform[0], textTransform[1]) : Math.abs(advance) * Math.hypot(matrix[0], matrix[1]),
        height: vertical ? Math.abs(advance) * Math.hypot(matrix[2], matrix[3]) : Math.hypot(textTransform[2], textTransform[3]), fontName: s.font.family,
        dir: vertical ? 'ttb' : /[\u0590-\u08ff]/u.test(str) ? 'rtl' : 'ltr', textOrder: 'logical', hasEOL: false,
        ...(vertical ? { vertical: true, glyphs: positions } : {}), ...(recognizedSymbols.length ? { recognizedSymbols } : {}) });
    }
    if (clipText) { const clipped = positions.filter(glyph => glyph.outline?.length); if (clipped.length) textClips.push({ matrix: textTransform, glyphs: clipped }); }
    if (paintMode !== 3 && positions.length) {
      const command = { op: 'text', glyphs: positions, matrix: textTransform, font: s.font.family, fill: s.fill, alpha: s.fillAlpha, blend: s.blend, ...(s.nativeCmyk ? { nativeCmyk: nativeInk(s, true), ...(nativeBlend(s, true) !== 'source-over' ? { nativeCmykBlend: nativeBlend(s, true) } : {}) } : {}),
      ...(outlinedText ? { paintMode, paintMatrix: multiply(s.matrix, [s.fontSize * s.hScale, 0, 0, s.fontSize, 0, s.rise]),
        stroke: s.stroke, strokeAlpha: s.strokeAlpha, lineWidth: s.lineWidth, strokeAdjustment: s.strokeAdjustment } : {}) };
      commands.push(command);
      if (s.nativeCmyk) nativeTextStates.set(command, { knockout: s.textKnockout, overprint: s.fillOverprint, mode: s.overprintMode, direct: s.fillSpace.name === 'DeviceCMYK' });
    }
    s.matrix = multiply(s.matrix, [1, 0, 0, 1, vertical ? 0 : advance, vertical ? advance : 0]);
  }
  async function image(id, s, resource) {
    if (s.nativeCmyk) nativeState(s);
    let nativeImageSpace = null;
    if (s.nativeIcc4) {
      nativeImageSpace = await resolvePdfColorSpace(reader, resource, reader.field(id, 'ColorSpace'), loadAsset, 0, blendProfiles);
      pdfIcc4SourceValues(nativeImageSpace, [0, 0, 0, 0], s.outputProfileBytes);
      if (s.fillAlpha !== 1) unsupported('Translucent elementary ICC4 contribution images are not implemented.');
    }
    // RGB source planes have default print semantics even when their bytes are cached.
    if (s.nativeCmyk && !s.nativeIcc4 && reader.name(reader.field(id, 'ColorSpace')) === 'DeviceRGB') assertPdfNativeRgbPrintDefaults(s.printState);
    if (s.softMask) unsupported('PDF soft masks on elementary image paints are not implemented yet.');
    if (s.patternArtwork) {
      const interpolation = reader.field(id, 'Interpolate'), value = interpolation && reader.node(interpolation);
      if (value && value.kind !== 'null') {
        if (value.kind !== 'boolean') corrupt('PDF tiling cell image Interpolate must be boolean.');
        if (value.aux) unsupported('Interpolated PDF tiling cell images are not implemented.');
      }
    }
    const imageMask = reader.field(id, 'ImageMask');
    if (imageMask && reader.node(imageMask).kind === 'boolean' && reader.node(imageMask).aux && s.fillSpace.name === 'Pattern') unsupported('PDF shading patterns in stencil images are not implemented.');
    const width = number(reader.field(id, 'Width')), height = number(reader.field(id, 'Height'));
    const fill = (s.fill.match(/[\d.]+/g) || []).map(n => Number(n) / 255);
    const key = `${reader.node(id).id}:${resource ? reader.node(resource).id : 0}:${s.outputProfileKey}:${reader.field(id, 'ImageMask') ? s.fill : ''}`;
    if (!imageCache.has(key)) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS || (imagePixels += width * height) > MAX_IMAGE_PIXELS) throw new PdfEngineError('PDF image pixel budget exceeded.', 'pdf_limit');
      imageCache.set(key, readPdfImage(reader, id, { resources: resource, loadAsset, fill, outputProfile: s.outputProfile, outputProfileBytes: s.outputProfileBytes,
        ...(s.nativeCmyk ? { nativeCmyk: true, sourceBudget: nativeImageSources } : {}),
        ...(s.nativeIcc4 ? { nativeIcc4: nativeImageSpace, profileMemo: blendProfiles } : {}) }));
    }
    const decoded = await imageCache.get(key);
    commands.push({ op: decoded.format === 'jpeg' ? 'jpeg' : 'image', ...decoded, width, height, matrix: [...s.ctm], alpha: s.fillAlpha, blend: s.blend });
    hasRasterImage = true;
  }
  function applySingleImageGroupBlend(firstCommand, blend) {
    const refuse = () => unsupported('Non-isolated PDF groups with an outer blend mode are not implemented yet.');
    let imagePaint = null;
    for (let i = firstCommand; i < commands.length; i++) {
      const command = commands[i];
      if (command.op === 'image' || command.op === 'jpeg') {
        if (imagePaint) refuse();
        imagePaint = command;
      } else if (command.op === 'paint' ? command.kind !== 'n'
        : !['save', 'restore', 'color', 'transform', 'setPdfTransform', 'lineStyle', 'dash', 'path'].includes(command.op)) refuse();
    }
    if (!imagePaint || imagePaint.alpha !== 1 || imagePaint.blend !== 'source-over') refuse();
    if (imagePaint.op === 'jpeg') {
      if (imagePaint.maskAlpha || imagePaint.colorKey || imagePaint.matte) refuse();
    } else if (!opaqueImagePixels.has(imagePaint.pixels)) {
      for (let at = 3; at < imagePaint.pixels.length; at += 4) {
        if (at % 16384 === 3) reader.check();
        if (imagePaint.pixels[at] !== 255) refuse();
      }
      opaqueImagePixels.add(imagePaint.pixels);
    }
    // One opaque Normal element has no internal blend to separate from its group.
    imagePaint.blend = blend;
  }
  async function contents(id, resource, s, depth = 0, prepared = null) {
    if (depth > 16) throw new PdfEngineError('PDF Form nesting limit exceeded.', 'pdf_limit');
    const node = reader.node(id);
    if (node.kind === 'array') {
      // Contents arrays are one logical stream, including operands crossing a boundary.
      const chunks = []; let length = 0;
      for (const part of reader.array(id)) {
        const chunk = await decodePdfStream(reader, part); length += chunk.bytes.length + 1;
        if (length > 32 * 1024 * 1024) throw new PdfEngineError('Page content exceeds its 32 MiB limit.', 'pdf_limit');
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk.bytes, offset); offset += chunk.bytes.length; bytes[offset++] = 10; }
      await interpret(iteratePdfContent(reader, bytes, resource, loadAsset), resource, s, depth);
    } else {
      await interpret(prepared?.tokens ? [prepared.tokens] : iteratePdfContent(reader, prepared?.bytes || (await decodePdfStream(reader, id)).bytes, resource, loadAsset), resource, s, depth);
    }
  }
  async function buildPatternCell(pattern, context, program) {
    const first = commands.length, previousOutlinedWords = outlinedWords;
    const initial = { ...context.initial, ctm: [...IDENTITY], matrix: [...IDENTITY], lineMatrix: [...IDENTITY], inText: false,
      fillAlpha: 1, strokeAlpha: 1, blend: 'source-over', softMask: null, alphaIsShape: false, patternArtwork: true };
    try {
      commands.push({ op: 'color', fill: true, value: initial.fill }, { op: 'color', fill: false, value: initial.stroke });
      if (context.depth + 1 > 16) throw new PdfEngineError('PDF Form nesting limit exceeded.', 'pdf_limit');
      await interpret(iteratePdfContent(reader, program, pattern.resources, loadAsset), pattern.resources, initial, context.depth + 1);
      return commands.slice(first);
    } finally {
      commands.splice(first); outlinedWords = previousOutlinedWords;
    }
  }
  async function interpret(tokens, resource, initial, depth) {
    const patternInitialMatrix = [...initial.ctm];
    const patternContext = { initial: { ...initial }, depth };
    // Patterns are local to each content context, including inherited Form colours.
    // ISO32000-1 8.7.2 does not retain the outer context's pattern anchoring.
    const localPattern = pattern => pattern && { ...pattern, matrix: multiply(patternInitialMatrix, pattern.patternMatrix) };
    let s = { ...initial, fillPattern: localPattern(initial.fillPattern), strokePattern: localPattern(initial.strokePattern) }, operands = [], pathBounds = null, clip = null, compatibility = 0;
    const stack = [], marked = []; let textClips = [], clippingText = false, firstTextCommand = 0, textPainted = false, textStateChanged = false;
    const numeric = count => { if (operands.length !== count) corrupt('Incorrect PDF operand count.'); return operands.map(number); };
    const bound = (x, y) => { const [a, b, c, d, e, f] = s.ctm, px = a * x + c * y + e, py = b * x + d * y + f;
      pathBounds = pathBounds ? [Math.min(pathBounds[0], px), Math.min(pathBounds[1], py), Math.max(pathBounds[2], px), Math.max(pathBounds[3], py)] : [px, py, px, py]; };
    for await (const batch of tokens) for (const id of batch) {
      reader.check(); chargeOperation();
      const token = reader.node(id); if (token.kind !== 'operator') { operands.push(id); if (operands.length > 10000) throw new PdfEngineError('PDF operand limit exceeded.', 'pdf_limit'); continue; }
      const op = reader.text(token);
      const beforeTextPaintState = s.inText && textPainted && ['g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'gs', 'q', 'Q', 'Tr'].includes(op) ? textPaintState(s) : null;
      if (s.patternArtwork && !TILING_OPERATORS.has(op)) unsupported(`PDF tiling cell operator ${op} is not implemented.`);
      if (s.contributionScope && !CONTRIBUTION_OPERATORS.has(op)) unsupported('This PDF backdrop-independent contribution program is not implemented.');
      if (s.icc4ContributionScope && !ICC4_CONTRIBUTION_OPERATORS.has(op)) unsupported('This PDF normal ICC4 contribution origin is not implemented.');
      if (s.type3Uncolored && TYPE3_COLOR_OPERATORS.has(op)) { operands = []; continue; }
      if (op === 'q') { numeric(0); if (stack.length >= 64) throw new PdfEngineError('PDF graphics stack limit exceeded.', 'pdf_limit'); stack.push({ ...s, ctm: [...s.ctm], matrix: [...s.matrix], lineMatrix: [...s.lineMatrix] }); commands.push({ op: 'save' }); }
      else if (op === 'Q') {
        numeric(0); if (!stack.length) corrupt('Unbalanced PDF graphics restore.');
        const restored = stack.pop();
        if (s.inText && restored.textKnockout !== s.textKnockout) corrupt('PDF text knockout may not change within a text object.');
        // Text-object framing and matrices are not graphics-state parameters
        // (ISO32000-1 9.4.1); Q must not close BT or rewind glyph advances.
        s = { ...restored, inText: s.inText, matrix: s.matrix, lineMatrix: s.lineMatrix };
        commands.push({ op: 'restore' });
      }
      else if (op === 'cm') { const args = numeric(6); s.ctm = multiply(s.ctm, args); commands.push({ op: 'transform', args }); }
      else if (['w', 'J', 'j', 'M'].includes(op)) { const [value] = numeric(1); lineStyle(op, value, s); }
      else if (op === 'd') { if (operands.length !== 2) corrupt('Invalid PDF dash operands.'); const dash = reader.array(operands[0]).map(number), phase = number(operands[1]); if (dash.some(n => n < 0) || dash.length && dash.every(n => n === 0)) corrupt('Invalid PDF dash pattern.'); commands.push({ op: 'dash', dash, phase }); }
      else if (['m', 'l', 'c', 'v', 'y', 're', 'h'].includes(op)) {
        const n = op === 'h' ? 0 : op === 'c' ? 6 : ['v', 'y', 're'].includes(op) ? 4 : 2, args = numeric(n);
        if (op === 're') { bound(args[0], args[1]); bound(args[0] + args[2], args[1]); bound(args[0], args[1] + args[3]); bound(args[0] + args[2], args[1] + args[3]); }
        else for (let i = 0; i < args.length; i += 2) bound(args[i], args[i + 1]);
        commands.push({ op: 'path', kind: op, args }); hasRenderableNonText = true;
      } else if (op === 'W' || op === 'W*') { numeric(0); clip = op === 'W*' ? 'evenodd' : 'nonzero'; }
      else if (['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'].includes(op)) {
        numeric(0);
        const fills = ['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(op), strokes = ['S', 's', 'B', 'B*', 'b', 'b*'].includes(op);
        if (s.contributionScope && op !== 'n' && (!fills || strokes || s.fillSpace.name !== 'DeviceCMYK' || s.fillAlpha !== 1
          || s.fillOverprint || s.strokeOverprint || s.alphaIsShape || s.softMask || s.blend !== 'source-over')) unsupported('This PDF backdrop-independent contribution program is not implemented.');
        if (s.icc4ContributionScope && (strokes || fills && s.fillAlpha !== 1)) unsupported('This PDF normal ICC4 contribution paint is not implemented.');
        if (s.nativeCmyk && (fills || strokes)) nativeState(s, fills, strokes, fills !== strokes ? 'elementary' : 'closed');
        if (s.patternArtwork && fills && s.fillSpace.name === 'Pattern') unsupported('Nested PDF tiling patterns are not implemented.');
        if (s.softMask && (fills || strokes)) unsupported('PDF soft masks on elementary path paints are not implemented yet.');
        if (fills && s.fillSpace.name === 'Pattern' && !s.fillPattern || strokes && s.strokeSpace.name === 'Pattern' && !s.strokePattern) corrupt('A PDF Pattern colour has no selected pattern.');
        if (pathBounds && fills && s.fillPattern?.type === 1) s.fillPattern = await patternAt(s.fillPattern.sourceId, resource, patternInitialMatrix, patternContext);
        if (pathBounds && strokes && s.strokePattern?.type === 1) s.strokePattern = await patternAt(s.strokePattern.sourceId, resource, patternInitialMatrix, patternContext);
        commands.push({ op: 'paint', kind: op, clip, fillAlpha: s.fillAlpha, strokeAlpha: s.strokeAlpha, blend: s.blend, lineWidth: s.lineWidth, strokeAdjustment: s.strokeAdjustment,
          ...(s.nativeCmyk && fills ? { nativeCmykFill: nativeInk(s, true), ...(nativeBlend(s, true) !== 'source-over' ? { nativeCmykFillBlend: nativeBlend(s, true) } : {}) } : {}),
          ...(s.nativeCmyk && strokes ? { nativeCmykStroke: nativeInk(s, false), ...(nativeBlend(s, false) !== 'source-over' ? { nativeCmykStrokeBlend: nativeBlend(s, false) } : {}) } : {}),
          ...(fills && s.fillPattern && (s.fillPattern.type !== 1 || pathBounds) ? { fillPattern: s.fillPattern } : {}),
          ...(strokes && s.strokePattern && (s.strokePattern.type !== 1 || pathBounds) ? { strokePattern: s.strokePattern } : {}) }); clip = null;
        if (pathBounds && ['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(op)) {
          const width = pathBounds[2] - pathBounds[0], height = pathBounds[3] - pathBounds[1], pageHeight = view[3] - view[1], pageWidth = view[2] - view[0];
          if (height >= pageHeight * .002 && height <= pageHeight * .05 && width >= height * 2 && width <= pageWidth * .15) outlinedWords++;
        }
        pathBounds = null;
      } else if (['g', 'G', 'rg', 'RG', 'k', 'K'].includes(op)) {
        const space = await resolvePdfColorSpace(reader, resource, op === 'g' || op === 'G' ? 'DeviceGray' : op === 'rg' || op === 'RG' ? 'DeviceRGB' : 'DeviceCMYK', loadAsset, 0, blendProfiles);
        if (s.inheritedRgbRectangleScope && space.name !== 'DeviceCMYK') unsupported('This inherited-RGB PDF rectangle source is not implemented.');
        const values = numeric(space.components), nativeColor = convertPdfColor(space, values, s.outputProfile), value = color(nativeColor);
        const fill = op === op.toLowerCase(); s[fill ? 'fillPattern' : 'strokePattern'] = null; s[fill ? 'fillSpace' : 'strokeSpace'] = space; s[fill ? 'fillValues' : 'strokeValues'] = values; s[fill ? 'fill' : 'stroke'] = value; commands.push({ op: 'color', fill, value, nativeColor, ...nativeMarker(s) });
      } else if (op === 'cs' || op === 'CS') {
        if (operands.length !== 1) corrupt('Invalid PDF color-space operands.');
        const fill = op === 'cs', space = await resolvePdfPaintSpace(reader, resource, operands[0], loadAsset, 0, blendProfiles); s[fill ? 'fillSpace' : 'strokeSpace'] = space; s[fill ? 'fillPattern' : 'strokePattern'] = null;
        if (s.patternArtwork && space.name === 'Pattern') unsupported('Nested PDF tiling patterns are not implemented.');
        if (s.contributionScope && space.name === 'Pattern') unsupported('This PDF backdrop-independent contribution program is not implemented.');
        const values = space.initialValues ? [...space.initialValues] : Array(space.components).fill(0); if (space.name === 'DeviceCMYK') values[3] = 1;
        s[fill ? 'fillValues' : 'strokeValues'] = values;
        if (space.name !== 'Pattern') { const nativeColor = convertPdfColor(space, values, s.outputProfile), value = color(nativeColor); s[fill ? 'fill' : 'stroke'] = value; commands.push({ op: 'color', fill, value, nativeColor, ...nativeMarker(s) }); }
      } else if (['sc', 'SC', 'scn', 'SCN'].includes(op)) {
        const fill = op === op.toLowerCase(), space = s[fill ? 'fillSpace' : 'strokeSpace'];
        if (space.name === 'Pattern') {
          if (s.patternArtwork) unsupported('Nested PDF tiling patterns are not implemented.');
          if (!['scn', 'SCN'].includes(op) || operands.length !== 1 || reader.node(operands[0]).kind !== 'name') corrupt('Invalid PDF shading pattern colour operands.');
          const dictionary = reader.field(resource, 'Pattern'), target = dictionary && reader.field(dictionary, reader.name(operands[0])); if (!target) corrupt('Missing PDF shading pattern resource.');
          s[fill ? 'fillPattern' : 'strokePattern'] = await patternAt(target, resource, patternInitialMatrix);
        } else {
          if (operands.some(id => reader.node(id).kind !== 'number')) unsupported('PDF pattern colors are not implemented yet.');
          const values = numeric(space.components), nativeColor = convertPdfColor(space, values, s.outputProfile), value = color(nativeColor); s[fill ? 'fillValues' : 'strokeValues'] = values; s[fill ? 'fill' : 'stroke'] = value; commands.push({ op: 'color', fill, value, nativeColor, ...nativeMarker(s) });
        }
      } else if (op === 'sh') {
        if (s.nativeCmyk && s.fillOverprint) unsupported('Native PDF overprinted shading paints are not implemented yet.');
        if (s.nativeCmyk) unsupported('Native PDF shading paint is not implemented yet.');
        if (s.softMask) unsupported('PDF soft masks on elementary shading paints are not implemented yet.');
        if (operands.length !== 1 || !reader.name(operands[0])) corrupt('Invalid PDF shading operand.');
        const dictionary = reader.field(resource, 'Shading'), target = dictionary && reader.field(dictionary, reader.name(operands[0]));
        if (!target) corrupt('Missing PDF shading resource.');
        commands.push({ op: 'shading', ...await readPdfShading(reader, target, resource, loadAsset), alpha: s.fillAlpha, blend: s.blend }); hasRenderableNonText = true;
      } else if (op === 'gs') {
        if (operands.length !== 1) corrupt('Invalid PDF graphics-state operands.');
        const states = reader.field(resource, 'ExtGState'), target = states && reader.field(states, reader.name(operands[0])); if (!target) corrupt('Missing PDF ExtGState.');
        const mask = reader.field(target, 'SMask');
        if (s.contributionScope && (mask && reader.node(mask).kind !== 'null' && reader.name(mask) !== 'None'
          || reader.field(target, 'Font'))) unsupported('This PDF backdrop-independent contribution program is not implemented.');
        if (s.icc4ContributionScope && reader.field(target, 'Font')) unsupported('This PDF normal ICC4 contribution state is not implemented.');
        if (s.patternArtwork && (mask && reader.node(mask).kind !== 'null' && reader.name(mask) !== 'None'
          || reader.field(target, 'Font'))) unsupported('PDF tiling cell masks and fonts are not implemented.');
        if (mask && reader.node(mask).kind !== 'null') s.softMask = reader.name(mask) === 'None' ? null : await readPdfGroupSoftMask(reader, mask, resource, loadAsset, s.ctm, softMasks, depth + 1);
        const ais = reader.field(target, 'AIS');
        if (ais && reader.node(ais).kind !== 'null') { const value = reader.node(ais); if (value.kind !== 'boolean') corrupt('PDF alpha source must be boolean.'); s.alphaIsShape = value.aux !== 0; }
        for (const [name, property] of [['ca', 'fillAlpha'], ['CA', 'strokeAlpha']]) { const id = reader.field(target, name); if (id) { const value = number(id); if (value < 0 || value > 1) corrupt('Invalid PDF alpha constant.'); s[property] = value; } }
        const blends = { Normal: 'source-over', Compatible: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference', Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity' };
        const bm = reader.field(target, 'BM'); if (bm) { const names = reader.node(bm).kind === 'array' ? reader.array(bm).map(id => reader.name(id)) : [reader.name(bm)]; const name = names.find(name => blends[name]); if (!name) unsupported('This PDF blend mode is not implemented yet.'); s.blend = blends[name]; }
        if (s.patternArtwork && (s.blend !== 'source-over' || s.alphaIsShape)) unsupported('Non-Normal PDF tiling cell transparency is not implemented.');
        for (const [name, command] of [['LW', 'w'], ['LC', 'J'], ['LJ', 'j'], ['ML', 'M']]) { const id = reader.field(target, name); if (id) lineStyle(command, number(id), s); }
        const dash = reader.field(target, 'D'); if (dash) { const array = reader.array(dash); if (array.length !== 2) corrupt('Invalid ExtGState dash.'); commands.push({ op: 'dash', dash: reader.array(array[0]).map(number), phase: number(array[1]) }); }
        const font = reader.field(target, 'Font'); if (font) { const array = reader.array(font); if (array.length !== 2) corrupt('Invalid ExtGState font.'); s.font = await fontAt(array[0]); s.fontSize = number(array[1]); }
        if (!s.type3Uncolored) {
          for (const key of ['TR', 'TR2', 'HT']) { const value = reader.field(target, key); if (value && !['Default', 'Identity'].includes(reader.name(value))) unsupported(`PDF ExtGState ${key} is not implemented yet.`); }
          // Retain the effective immutable state for paint/Do-time conversion.
          // This stage still rejects CMYK group targets, leaving RGB pixels unchanged.
          s.printState = await printStateAt(target, s.printState);
        }
        const adjustment = reader.field(target, 'SA'); if (adjustment) { const value = reader.node(adjustment); if (value.kind !== 'boolean') corrupt('PDF stroke adjustment must be boolean.'); s.strokeAdjustment = value.aux !== 0; }
        // Composite RGB preview does not simulate printing ink separations.
        const overprint = {};
        for (const key of ['OP', 'op']) { const value = reader.field(target, key); if (value && reader.node(value).kind !== 'null') { const node = reader.node(value); if (node.kind !== 'boolean') corrupt(`PDF overprint ${key} must be boolean.`); overprint[key] = node.aux !== 0; } }
        if (Object.hasOwn(overprint, 'OP')) { s.strokeOverprint = overprint.OP; if (!Object.hasOwn(overprint, 'op')) s.fillOverprint = overprint.OP; }
        if (Object.hasOwn(overprint, 'op')) s.fillOverprint = overprint.op;
        if (s.contributionScope && (s.fillOverprint || s.strokeOverprint || s.alphaIsShape || s.softMask || s.blend !== 'source-over')) unsupported('This PDF backdrop-independent contribution program is not implemented.');
        if (s.icc4ContributionScope && (s.fillOverprint || s.strokeOverprint || s.blend !== 'source-over')) unsupported('This PDF normal ICC4 contribution state is not implemented.');
        const overprintMode = reader.field(target, 'OPM');
        if (overprintMode && reader.node(overprintMode).kind !== 'null') { const value = number(overprintMode); if (![0, 1].includes(value)) corrupt('PDF overprint mode must be 0 or 1.'); s.overprintMode = value; }
        const knockout = reader.field(target, 'TK');
        if (knockout && reader.node(knockout).kind !== 'null') {
          if (s.inText) corrupt('PDF text knockout may not change within a text object.');
          const value = reader.node(knockout); if (value.kind !== 'boolean') corrupt('PDF text knockout must be boolean.'); s.textKnockout = value.aux !== 0;
        }
      }
      else if (op === 'BT') { numeric(0); if (s.inText) corrupt('Nested PDF text object.'); s.inText = true; s.matrix = [...IDENTITY]; s.lineMatrix = [...IDENTITY]; textClips = []; clippingText = s.textMode >= 4; firstTextCommand = commands.length; textPainted = textStateChanged = false; }
      else if (op === 'ET') { numeric(0); if (!s.inText) corrupt('Unbalanced PDF text object.'); if (textClips.length) commands.push({ op: 'textClip', groups: textClips }); if (s.nativeCmyk) validateNativeText(firstTextCommand, textStateChanged); textClips = []; s.inText = false; }
      else if (op === 'Tf') { if (operands.length !== 2 || !reader.name(operands[0])) corrupt('Invalid PDF font operands.'); s.font = await fontFor(resource, reader.name(operands[0])); s.fontSize = number(operands[1]); }
      else if (['Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr'].includes(op)) { const [value] = numeric(1), property = { Tc: 'charSpacing', Tw: 'wordSpacing', Tz: 'hScale', TL: 'leading', Ts: 'rise', Tr: 'textMode' }[op]; if (op === 'Tr') { if (!Number.isInteger(value) || value < 0 || value > 7) corrupt('Invalid PDF text rendering mode.'); if (s.inText && clippingText && value < 4) corrupt('PDF clipping text mode cannot end before ET.'); if (s.inText && value >= 4) clippingText = true; } s[property] = op === 'Tz' ? value / 100 : value; }
      else if (op === 'Tm') { s.matrix = numeric(6); s.lineMatrix = [...s.matrix]; }
      else if (['Td', 'TD', 'T*'].includes(op)) { const args = op === 'T*' ? (numeric(0), [0, -s.leading]) : numeric(2); if (op === 'TD') s.leading = -args[1]; s.lineMatrix = multiply(s.lineMatrix, [1, 0, 0, 1, ...args]); s.matrix = [...s.lineMatrix]; if (items.length) items.at(-1).hasEOL = true; }
      else if (op === 'Tj' || op === "'" || op === '"') {
        if (operands.length !== (op === '"' ? 3 : 1)) corrupt('Invalid PDF text operands.');
        if (op === '"') { s.wordSpacing = number(operands[0]); s.charSpacing = number(operands[1]); }
        if (op !== 'Tj') { s.lineMatrix = multiply(s.lineMatrix, [1, 0, 0, 1, 0, -s.leading]); s.matrix = [...s.lineMatrix]; if (items.length) items.at(-1).hasEOL = true; }
        const value = reader.node(operands.at(-1)); if (value.kind !== 'string') corrupt('Expected PDF text string.'); await show(reader.bytes(value), s, resource, depth, textClips);
      } else if (op === 'TJ') {
        if (operands.length !== 1) corrupt('Invalid PDF text array.');
        for (const valueId of reader.array(operands[0])) { const value = reader.node(valueId); if (value.kind === 'string') await show(reader.bytes(value), s, resource, depth, textClips); else if (value.kind === 'number') {
          const displacement = -value.number / 1000 * s.fontSize; s.matrix = multiply(s.matrix, [1, 0, 0, 1, s.font?.vertical ? 0 : displacement * s.hScale, s.font?.vertical ? displacement : 0]);
        } else corrupt('Invalid PDF text array value.'); }
      } else if (op === 'd0' || op === 'd1') {
        if (!s.type3Glyph) corrupt('Type3 metrics outside a glyph.'); numeric(op === 'd0' ? 2 : 6);
        if (op === 'd1') s.type3Uncolored = true;
      } else if (op === 'BI') {
        if (operands.length !== 1 || reader.node(operands[0]).kind !== 'stream' || reader.node(operands[0]).inlineDataOffset === undefined) corrupt('Invalid inline image operands.');
        await image(operands[0], s, resource);
      } else if (op === 'Do') {
        if (operands.length !== 1) corrupt('Invalid PDF XObject operands.');
        const xobjects = reader.field(resource, 'XObject'), target = xobjects && reader.field(xobjects, reader.name(operands[0])); if (!target) corrupt('Missing PDF XObject.');
        const subtype = reader.name(reader.field(target, 'Subtype'));
        if (s.patternArtwork && subtype !== 'Image') unsupported('PDF tiling cell Form artwork is not implemented.');
        if (subtype === 'Image') await image(target, s, resource);
        else if (subtype === 'Form') {
          const resolved = reader.node(target).id; if (activeForms.has(resolved)) corrupt('Cyclic PDF Form XObject.'); activeForms.add(resolved);
          const formResources = reader.field(target, 'Resources') || resource;
          const groupEntry = reader.field(target, 'Group'), group = groupEntry && reader.node(groupEntry).kind !== 'null' ? groupEntry : 0;
          if (s.icc4ContributionScope && !group) unsupported('Ordinary Forms inside ICC4 source contributions are not implemented.');
          let isolated = false, backdropIndependent = false, sourceContribution = false, prepared = null, inheritedRgb = null, outputProfile = s.outputProfile, outputProfileBytes = s.outputProfileBytes, outputProfileKey = s.outputProfileKey, nativeCmyk = s.nativeCmyk, nativeIcc4 = s.nativeIcc4;
          try {
          if (group) {
            isolated = groupIsolation(group, 'Form');
            if (s.softMask && s.blend !== 'source-over') unsupported('PDF masked groups with an outer blend mode are not implemented yet.');
            if (!isolated && !s.nativeCmyk && s.outputProfile === null && reader.name(reader.field(group, 'CS')) === 'DeviceCMYK') {
              if (depth >= 16) throw new PdfEngineError('PDF Form nesting limit exceeded.', 'pdf_limit');
              prepared = await preparePdfInheritedRgbRectangle(reader, target, formResources);
              inheritedRgb = prepared?.rectangle;
              if (inheritedRgb) {
                if (s.inText || s.type3Glyph || s.patternArtwork || s.fillOverprint || s.strokeOverprint || s.blend !== 'source-over'
                  || s.fillSpace.name === 'Pattern' || s.strokeSpace.name === 'Pattern') unsupported('This inherited-RGB PDF rectangle boundary is not implemented.');
                assertPdfInheritedRgbMask(s.softMask);
              }
            }
            // Compatibility is explicit and confined to a proved primitive;
            // other conflicting-CS groups retain their existing policies.
            if (!inheritedRgb) ({ outputProfile, outputProfileBytes, outputProfileKey, nativeCmyk, nativeIcc4 } = await groupBlendContext(group, formResources, s));
            if (nativeIcc4) {
              if (isolated || s.fillOverprint || s.strokeOverprint || s.inText || s.type3Glyph || s.patternArtwork
                || s.nativeCmyk && (!s.nativeIcc4 || outputProfileBytes !== s.outputProfileBytes || s.blend !== 'source-over')
                || !s.nativeCmyk && !['source-over', 'multiply'].includes(s.blend)) unsupported('This PDF normal ICC4 contribution boundary is not implemented.');
              sourceContribution = true;
            } else if (s.icc4ContributionScope) unsupported('ICC4 source contribution child profiles must match exactly.');
            if (s.nativeCmyk && !nativeCmyk) unsupported('Native PDF child group colour-space changes are not implemented yet.');
            if (nativeCmyk && !nativeIcc4) {
              if (s.softMask && !isolated) unsupported('Non-isolated native PDF masked groups are not implemented yet.');
              nativeState(s.softMask ? { ...s, softMask: null, nativeMaskScope: true } : s, true, true, 'group');
            }
            if (!sourceContribution && !isolated && outputProfileKey !== s.outputProfileKey) {
              if (!nativeCmyk || s.nativeCmyk || s.softMask || s.fillOverprint || s.strokeOverprint || s.alphaIsShape || s.blend !== 'source-over') unsupported('Non-isolated PDF groups that change blend color space are not implemented yet.');
              backdropIndependent = true;
            }
          }
          const matrixId = reader.field(target, 'Matrix'), matrix = matrixId && reader.node(matrixId).kind !== 'null' ? reader.array(matrixId).map(number) : IDENTITY;
          const bboxId = reader.field(target, 'BBox'), bbox = bboxId ? reader.array(bboxId).map(number) : null;
          if (matrix.length !== 6 || !bbox || bbox.length !== 4) corrupt('Invalid PDF Form bounds or transform.');
          const firstCommand = commands.length;
          const nativeFill = s.fillSpace.name === 'Pattern' ? null : convertPdfColor(s.fillSpace, s.fillValues, outputProfile), nativeStroke = s.strokeSpace.name === 'Pattern' ? null : convertPdfColor(s.strokeSpace, s.strokeValues, outputProfile);
          const fill = nativeFill ? color(nativeFill) : s.fill, stroke = nativeStroke ? color(nativeStroke) : s.stroke;
          const marker = nativeCmyk ? { nativeColorSpace: nativeIcc4 ? 'ICCBased4' : 'DeviceCMYK' } : {};
          commands.push({ op: 'save' }, { op: 'color', fill: true, value: fill, nativeColor: nativeFill, ...marker }, { op: 'color', fill: false, value: stroke, nativeColor: nativeStroke, ...marker },
            { op: 'transform', args: matrix }, { op: 'path', kind: 're', args: [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]] }, { op: 'paint', kind: 'n', clip: 'nonzero' });
          await contents(target, formResources, { ...s, fill, stroke, outputProfile, outputProfileBytes, outputProfileKey, nativeCmyk, nativeIcc4,
            inText: false, matrix: [...IDENTITY], lineMatrix: [...IDENTITY], ctm: multiply(s.ctm, matrix), contributionScope: backdropIndependent, icc4ContributionScope: sourceContribution, inheritedRgbRectangleScope: Boolean(inheritedRgb),
            ...(group ? { fillAlpha: 1, strokeAlpha: 1, blend: 'source-over', softMask: null, nativeMaskScope: s.nativeMaskScope || Boolean(s.softMask) } : {}) }, depth + 1, prepared);
          commands.push({ op: 'restore' }); activeForms.delete(resolved);
          if (group && !sourceContribution && !isolated && s.blend !== 'source-over') {
            if (s.fillAlpha !== 1) unsupported('Non-isolated PDF groups with an outer blend mode are not implemented yet.');
            applySingleImageGroupBlend(firstCommand, s.blend);
          }
          if (group && (isolated || backdropIndependent || sourceContribution || inheritedRgb || s.fillAlpha !== 1 || s.softMask)) {
            const children = commands.splice(firstCommand); children.unshift({ op: 'transform', args: s.ctm });
            const command = { op: 'group', commands: children, colorProfile: outputProfileBytes, ...marker, alpha: s.fillAlpha, blend: s.blend, isolated,
              ...(sourceContribution ? { sourceContribution: PDF_ICC4_CONTRIBUTION } : {}),
              ...(backdropIndependent ? { backdropIndependent: true } : {}), ...(s.softMask ? { softMask: s.softMask } : {}) };
            if (inheritedRgb) {
              Object.assign(command, { rgbCompatibility: PDF_INHERITED_RGB_RECTANGLE, declaredColorSpace: 'DeviceCMYK', effectiveColorSpace: 'DeviceRGB',
                sourceCmyk: inheritedRgb.source, sourceAlphaIsShape: inheritedRgb.alphaIsShape, alphaIsShape: s.alphaIsShape,
                knockout: false, fillOverprint: false, strokeOverprint: false });
              assertPdfInheritedRgbRectangle(command, () => reader.check());
              if (!warnedInheritedRgb) { (reader.codecWarnings ||= []).push({ filter: 'TransparencyGroup', compatibility: PDF_INHERITED_RGB_RECTANGLE,
                declaredColorSpace: 'DeviceCMYK', effectiveColorSpace: 'DeviceRGB', isolated: false }); warnedInheritedRgb = true; }
            }
            if (backdropIndependent) assertPdfCmykContributionGroup(command, () => reader.check());
            if (sourceContribution) assertPdfIcc4ContributionGroup(command, { check: () => reader.check(), profileCache: contributionProfiles });
            commands.push(command);
          }
          } finally { prepared?.release?.(); }
        } else unsupported(`PDF XObject ${subtype} is not implemented yet.`);
      } else if (['BMC', 'BDC', 'EMC', 'MP', 'DP'].includes(op)) {
        if (op === 'BDC' && operands.length !== 2 || ['BMC', 'MP'].includes(op) && operands.length !== 1 || op === 'EMC' && operands.length !== 0 || op === 'DP' && operands.length !== 2) corrupt('Invalid PDF marked content operands.');
        if (op === 'BMC' || op === 'BDC') {
          if (marked.length >= 64) throw new PdfEngineError('PDF marked-content nesting limit exceeded.', 'pdf_limit');
          if (!reader.name(operands[0])) corrupt('Invalid PDF marked-content tag.');
          let actual = null;
          if (op === 'BDC') {
            const property = reader.name(operands[1]), properties = property ? reader.field(resource, 'Properties') : null;
            const dictionary = property ? properties && reader.field(properties, property) : operands[1]; if (!dictionary) corrupt('Missing PDF marked-content properties.');
            const value = reader.field(dictionary, 'ActualText'); if (value) { if (reader.node(value).kind !== 'string') corrupt('ActualText must be a PDF text string.'); actual = actualText(value); }
          }
          marked.push({ actual, first: items.length, unmapped: unmappedGlyphs, unknownType3: unknownType3Glyphs, recognized: recognizedSymbolGlyphs }); mergeBoundary = items.length;
        } else if (op === 'EMC') {
          const entry = marked.pop(); if (!entry) corrupt('Unbalanced PDF marked content.');
          if (entry.actual !== null) {
            const replaced = items.slice(entry.first), first = replaced[0];
            retainText(first ? entry.actual.length : 0, replaced.reduce((sum, item) => sum + item.str.length, 0)); items.splice(entry.first);
            unmappedGlyphs = entry.unmapped; unknownType3Glyphs = entry.unknownType3; recognizedSymbolGlyphs = entry.recognized;
            if (first && entry.actual) {
              if (first.vertical) items.push(verticalActualText(replaced, entry.actual));
              else {
                const [a, b] = first.transform, magnitude = Math.hypot(a, b); let right = first.width;
                for (const item of replaced) { const dx = item.transform[4] - first.transform[4], dy = item.transform[5] - first.transform[5]; if (Math.abs(dx * b - dy * a) / magnitude > Math.max(first.height, item.height) * .5) unsupported('Multi-line PDF ActualText geometry is not implemented yet.'); right = Math.max(right, (dx * a + dy * b) / magnitude + item.width); }
                items.push({ ...first, str: entry.actual, width: right, dir: /[\u0590-\u08ff]/u.test(entry.actual) ? 'rtl' : 'ltr', textOrder: 'logical', recognizedSymbols: undefined });
              }
            }
          }
          mergeBoundary = items.length;
        }
      } else if (op === 'BX') { numeric(0); compatibility++; }
      else if (op === 'EX') { numeric(0); if (!compatibility--) corrupt('Unbalanced PDF compatibility section.'); }
      else if (op === 'ri' || op === 'i') { if (operands.length !== 1) corrupt('Invalid PDF rendering intent operand.'); }
      else if (!compatibility) unsupported(`PDF content operator ${op} is not implemented yet.`);
      if (s.inText && ['Tj', 'TJ', "'", '"'].includes(op)) textPainted = true;
      if (beforeTextPaintState) {
        const after = textPaintState(s);
        if (beforeTextPaintState.length !== after.length || beforeTextPaintState.some((value, i) => value !== after[i])) textStateChanged = true;
      }
      operands = [];
    }
    if (operands.length || stack.length || s.inText || compatibility || marked.length) corrupt('Unbalanced PDF content stream.');
  }
  try {
  const pageGroupEntry = reader.field(pageId, 'Group'), pageGroup = pageGroupEntry && reader.node(pageGroupEntry).kind !== 'null' ? pageGroupEntry : 0; let pageContext = null, pageGray = null;
  if (pageGroup) {
    groupIsolation(pageGroup, 'page'); // Direct page output is isolated regardless of I (ISO32000-1 Table147).
    pageContext = await groupBlendContext(pageGroup, resourcesId, state());
    if (pageContext.nativeIcc4) unsupported('Native ICC4 PageGroups are not implemented.');
    if (pageContext.nativeCmyk) pageGray = await resolvePdfColorSpace(reader, resourcesId, 'DeviceGray', loadAsset, 0, blendProfiles);
  }
  const pageState = (gray = pageGray) => {
    const initial = state(); if (!pageContext) return initial;
    Object.assign(initial, pageContext);
    if (initial.nativeCmyk) initial.fillSpace = initial.strokeSpace = gray;
    initial.fillNative = convertPdfColor(initial.fillSpace, initial.fillValues, initial.outputProfile); initial.fill = color(initial.fillNative);
    initial.strokeNative = convertPdfColor(initial.strokeSpace, initial.strokeValues, initial.outputProfile); initial.stroke = color(initial.strokeNative);
    return initial;
  };
  const initialColors = initial => pageContext ? [{ op: 'color', fill: true, value: initial.fill, nativeColor: initial.fillNative, ...nativeMarker(initial) }, { op: 'color', fill: false, value: initial.stroke, nativeColor: initial.strokeNative, ...nativeMarker(initial) }] : [];
  const contentId = reader.field(pageId, 'Contents');
  if (contentId) { const initial = pageState(); commands.push({ op: 'save' }, ...initialColors(initial)); await contents(contentId, resourcesId, initial); commands.push({ op: 'restore' }); }
  const annots = reader.field(pageId, 'Annots');
  if (annots) for (const id of reader.array(annots)) {
    const flags = reader.number(reader.field(id, 'F'), 0); if (flags & (1 | 2 | 32)) continue;
    const rectangleId = reader.field(id, 'Rect'), rectangle = rectangleId && reader.array(rectangleId).map(number);
    if (!rectangle || rectangle.length !== 4) corrupt('Invalid PDF annotation rectangle.');
    const rect = [Math.min(rectangle[0], rectangle[2]), Math.min(rectangle[1], rectangle[3]), Math.max(rectangle[0], rectangle[2]), Math.max(rectangle[1], rectangle[3])];
    const appearanceId = reader.field(id, 'AP'); let normal = appearanceId && reader.field(appearanceId, 'N');
    if (normal) {
      if (reader.node(normal).kind === 'dictionary') {
        const selected = reader.field(id, 'AS'); if (!selected) unsupported('PDF annotation appearance has no selected state.');
        normal = reader.field(normal, reader.name(selected)); if (!normal) corrupt('Missing PDF annotation appearance state.');
      }
      if (reader.node(normal).kind !== 'stream') corrupt('Invalid PDF annotation appearance stream.');
      const appearanceGroup = reader.field(normal, 'Group');
      if (appearanceGroup && reader.node(appearanceGroup).kind !== 'null') unsupported('PDF annotation transparency groups are not implemented yet.');
      const boxId = reader.field(normal, 'BBox'), box = boxId && reader.array(boxId).map(number);
      const matrixId = reader.field(normal, 'Matrix'), matrix = matrixId ? reader.array(matrixId).map(number) : IDENTITY;
      if (!box || box.length !== 4 || matrix.length !== 6) corrupt('Invalid PDF annotation appearance bounds.');
      const corners = [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
      const minX = Math.min(...corners.map(c => c[0])), minY = Math.min(...corners.map(c => c[1]));
      const width = Math.max(...corners.map(c => c[0])) - minX, height = Math.max(...corners.map(c => c[1])) - minY;
      if (width <= 0 || height <= 0 || rect[2] === rect[0] || rect[3] === rect[1]) continue;
      const sx = (rect[2] - rect[0]) / width, sy = (rect[3] - rect[1]) / height;
      const transform = multiply([sx, 0, 0, sy, rect[0] - minX * sx, rect[1] - minY * sy], matrix);
      const appearanceResources = reader.field(normal, 'Resources') || resourcesId;
      const initial = pageState(pageContext?.nativeCmyk ? await resolvePdfColorSpace(reader, appearanceResources, 'DeviceGray', loadAsset, 0, blendProfiles) : null);
      commands.push({ op: 'save' }, ...initialColors(initial), { op: 'transform', args: transform }, { op: 'path', kind: 're', args: [box[0], box[1], box[2] - box[0], box[3] - box[1]] }, { op: 'paint', kind: 'n', clip: 'nonzero' });
      await contents(normal, appearanceResources, { ...initial, ctm: transform }); commands.push({ op: 'restore' });
    } else if (reader.name(reader.field(id, 'Subtype')) === 'Link') {
      const bsEntry = reader.field(id, 'BS'), bs = bsEntry && reader.node(bsEntry).kind !== 'null' ? bsEntry : 0;
      // BS supersedes Border (ISO 32000-1 Table164).
      const borderId = !bs && reader.field(id, 'Border'), border = borderId && reader.node(borderId).kind !== 'null' ? reader.array(borderId) : [];
      const widthId = bs && reader.field(bs, 'W'), width = widthId && reader.node(widthId).kind !== 'null' ? number(widthId) : bs ? 1 : border.length >= 3 ? number(border[2]) : 1;
      if (width < 0) corrupt('Negative PDF link border width.'); if (!width) continue;
      if (border.length >= 2 && (number(border[0]) !== 0 || number(border[1]) !== 0)) unsupported('Rounded PDF annotation borders are not implemented yet.');
      const style = bs && reader.field(bs, 'S'); let styleName = 'S';
      if (style && reader.node(style).kind !== 'null') { styleName = reader.name(style); if (!styleName) corrupt('PDF annotation border style must be a name.'); }
      if (['B', 'I'].includes(styleName)) unsupported(`PDF annotation border style ${styleName} is not implemented yet.`);
      if (!['S', 'D', 'U'].includes(styleName)) styleName = 'S'; // Table166 requires the default for unrecognized styles.
      const c = reader.field(id, 'C'), values = c ? reader.array(c).map(number) : [0, 0, 0];
      if (![0, 1, 3].includes(values.length)) unsupported('This PDF annotation color is not implemented yet.'); if (!values.length) continue;
      const borderRgb = pageContext ? convertPdfColor(await resolvePdfColorSpace(reader, resourcesId, values.length === 1 ? 'DeviceGray' : 'DeviceRGB', loadAsset), values, pageContext.outputProfile)
        : values.length === 1 ? [values[0], values[0], values[0]] : values;
      commands.push({ op: 'save' }, { op: 'lineStyle', name: 'w', value: width }, { op: 'color', fill: false, value: color(borderRgb), nativeColor: borderRgb, ...(pageContext?.nativeCmyk ? { nativeColorSpace: 'DeviceCMYK' } : {}) });
      const dash = bs ? styleName === 'D' && reader.field(bs, 'D') : border[3];
      if (dash && reader.node(dash).kind !== 'null') {
        const pattern = reader.array(dash).map(number);
        if (pattern.some(n => n < 0) || pattern.length && pattern.every(n => n === 0)) corrupt('Invalid PDF annotation dash.');
        commands.push({ op: 'dash', dash: pattern, phase: 0 });
      }
      else if (styleName === 'D') commands.push({ op: 'dash', dash: [3], phase: 0 });
      if (styleName === 'U') commands.push({ op: 'path', kind: 'm', args: [rect[0], rect[1]] }, { op: 'path', kind: 'l', args: [rect[2], rect[1]] });
      else commands.push({ op: 'path', kind: 're', args: [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]] });
      const borderInk = pageContext?.nativeCmyk ? nativeColor(await resolvePdfColorSpace(reader, resourcesId, values.length === 1 ? 'DeviceGray' : 'DeviceRGB', loadAsset, 0, blendProfiles), values) : null;
      commands.push({ op: 'paint', kind: 'S', clip: null, ...(borderInk ? { nativeCmykStroke: borderInk } : {}) }, { op: 'restore' });
    } else unsupported('This PDF annotation default appearance is not implemented yet.');
  }
  if (pageContext && commands.length) commands.splice(0, commands.length, { op: 'group', commands: commands.slice(), colorProfile: pageContext.outputProfileBytes, ...nativeMarker(pageContext), alpha: 1, blend: 'source-over', isolated: true });
  return { commands, items, fonts: [...fonts.values()].map(({ family, bytes, ascent, descent, vertical = false, localFaces, requiresLocalFace }) => ({ family, bytes, ascent, descent, vertical, ...(localFaces ? { localFaces } : {}), ...(requiresLocalFace === true ? { requiresLocalFace: true } : {}) })),
    inspection: { hasRasterImage, hasRenderableNonText, hasOutlinedText: outlinedWords >= 50, unmappedGlyphs, unknownType3Glyphs, recognizedSymbolGlyphs, repairFlags: reader.api.pn_pdf_repair_flags(), decodingWarnings: reader.codecWarnings?.slice(warningStart) || [], inspectionFailed: false, error: null } };
  } finally { nativeImageSources.destroy(); }
}
