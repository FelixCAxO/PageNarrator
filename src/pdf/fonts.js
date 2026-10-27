// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { readTrueTypeMetrics } from './font-metrics.js';
import { parseType1Font, createType1GlyphReader, standardGlyphName, glyphNameText, isDingbatsFont } from './type1-font.js';
import { loadCffPdfFont } from './cff-pdf-font.js';
import { loadCidTrueTypeFont } from './cid-truetype.js';
import { loadType3PdfFont } from './type3-font.js';
import { remapTrueTypeCmap, privateGlyphCode } from './font-container.js';
import { convertType1Font } from './type1-container.js';
import { pdfLocalFontNames, pdfSystemGlyph } from './system-fonts.js';
import { pdfLatinGlyphName, pdfLatinGlyphText } from './latin-encodings.js';
import { recognizedPdfSymbol } from './symbol-fonts.js';
import { loadStandard14Widths } from './standard14-metrics.js';
import { retainType1Outlines } from './text-stroke.js';
import { createTrueTypeGlyphReader, simpleTrueTypeOutlineGlyph, TRUE_TYPE_OUTLINE_CACHE_BYTES } from './ttf-outline.js';
import { readToUnicodeValues } from './cmap-lexer.js';
import { loadLocalCidFont } from './local-cid-font.js';

export function utf16be(bytes) {
  if (bytes.length % 2) throw new PdfEngineError('Odd-length ToUnicode value.', 'pdf_corrupt');
  let result = ''; for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  if (!result.isWellFormed()) throw new PdfEngineError('Invalid ToUnicode surrogate sequence.', 'pdf_corrupt');
  return result.startsWith('\ufeff') ? result.slice(1) : result;
}
const key = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function unicodeText(map, source) {
  const error = map?.invalidCodes?.get(source); if (error) throw new PdfEngineError(error, 'pdf_corrupt'); return map?.get(source);
}
export function pdfFontResourceBytes(bytes, unicode, additionalBytes = 0) {
  let estimate = bytes.byteLength + additionalBytes;
  // A bounded admission estimate, not a measurement of a browser's Map/string heap.
  for (const entries of [unicode, unicode?.invalidCodes]) for (const [source, text] of entries ?? []) estimate += 64 + 2 * (source.length + text.length);
  return estimate;
}
export async function readToUnicode(reader, id) {
  const { bytes } = await decodePdfStream(reader, id), tokens = readToUnicodeValues(bytes), result = new Map();
  result.invalidCodes = new Map(); let unicodeUnits = 0, mappingWork = 0;
  const chargeMapping = () => { if (++mappingWork > 500000) throw new PdfEngineError('ToUnicode mapping work limit exceeded.', 'pdf_limit'); };
  const admit = (source, units = 0) => {
    if (!result.has(source) && !result.invalidCodes.has(source) && result.size + result.invalidCodes.size >= 100000) throw new PdfEngineError('ToUnicode entry limit exceeded.', 'pdf_limit');
    if (unicodeUnits - (result.get(source)?.length || 0) + units > 2_000_000) throw new PdfEngineError('ToUnicode retained text limit exceeded.', 'pdf_limit');
  };
  const invalid = (source, message) => { admit(source); unicodeUnits -= result.get(source)?.length || 0; result.delete(source); result.invalidCodes.set(source, message); };
  const store = (source, bytes) => {
    admit(source, bytes.length % 2 ? 0 : bytes.length / 2 - (bytes[0] === 0xfe && bytes[1] === 0xff ? 1 : 0));
    try { const text = utf16be(bytes); unicodeUnits += text.length - (result.get(source)?.length || 0); result.set(source, text); result.invalidCodes.delete(source); }
    catch (error) { if (error.code !== 'pdf_corrupt') throw error; invalid(source, error.message); }
  };
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i]; if (op.kind !== 'word') continue;
    const name = op.value; if (!['beginbfchar', 'beginbfrange'].includes(name)) continue;
    const count = tokens[i - 1]?.kind === 'number' ? tokens[i - 1].value : -1;
    if (!Number.isInteger(count) || count < 0 || count > 100000) throw new PdfEngineError('Invalid ToUnicode entry count.', 'pdf_corrupt');
    for (let j = 0; j < count; j++) {
      const from = tokens[++i]; if (from?.kind !== 'string' || from.bytes.length < 1 || from.bytes.length > 4) throw new PdfEngineError('Invalid ToUnicode source code.', 'pdf_corrupt');
      if (name === 'beginbfchar') {
        chargeMapping();
        const target = tokens[++i]; if (target?.kind !== 'string') throw new PdfEngineError('Invalid ToUnicode target.', 'pdf_corrupt');
        store(key(from.bytes), target.bytes);
      } else {
        const to = tokens[++i], target = tokens[++i];
        if (to?.kind !== 'string' || to.bytes.length !== from.bytes.length) throw new PdfEngineError('Invalid ToUnicode range.', 'pdf_corrupt');
        const asNumber = n => n.bytes.reduce((sum, b) => sum * 256 + b, 0), first = asNumber(from), last = asNumber(to);
        if (last < first || last - first > 100000 || result.size + last - first + 1 > 100000) throw new PdfEngineError('ToUnicode range is too large.', 'pdf_limit');
        const targets = target?.kind === 'array' ? target.values : null;
        if (targets && targets.length !== last - first + 1 || !targets && target?.kind !== 'string') throw new PdfEngineError('Invalid ToUnicode range target.', 'pdf_corrupt');
        const initial = targets ? null : target.bytes;
        for (let code = first; code <= last; code++) {
          chargeMapping();
          const mapping = code.toString(16).padStart(from.bytes.length * 2, '0');
          if (targets) {
            const value = targets[code - first];
            if (value.kind !== 'string') invalid(mapping, 'ToUnicode range target must be a string.'); else store(mapping, value.bytes);
          }
          else {
            const increment = code - first; let carry = increment, high = initial[0], low = initial[1];
            for (let p = initial.length - 1; p >= 0 && carry; p--) { carry += initial[p]; if (p === 0) high = carry & 255; if (p === 1) low = carry & 255; carry = Math.floor(carry / 256); }
            if (carry) { invalid(mapping, 'ToUnicode target range overflows.'); continue; }
            admit(mapping, initial.length % 2 ? 0 : initial.length / 2 - (high === 0xfe && low === 0xff ? 1 : 0));
            const value = initial.slice(); carry = increment;
            for (let p = value.length - 1; p >= 0 && carry; p--) { carry += value[p]; value[p] = carry & 255; carry = Math.floor(carry / 256); }
            store(mapping, value);
          }
        }
      }
    }
    if (tokens[++i]?.kind !== 'word' || tokens[i].value !== (name === 'beginbfchar' ? 'endbfchar' : 'endbfrange')) throw new PdfEngineError('Unterminated ToUnicode section.', 'pdf_corrupt');
  }
  return result;
}

const standardAssets = {
  Helvetica: 'LiberationSans-Regular.ttf', 'Helvetica-Bold': 'LiberationSans-Bold.ttf',
  'Helvetica-Oblique': 'LiberationSans-Italic.ttf', 'Helvetica-BoldOblique': 'LiberationSans-BoldItalic.ttf',
  Arial: 'LiberationSans-Regular.ttf', 'ArialMT': 'LiberationSans-Regular.ttf',
  'Arial-BoldMT': 'LiberationSans-Bold.ttf', 'Arial-ItalicMT': 'LiberationSans-Italic.ttf', 'Arial-BoldItalicMT': 'LiberationSans-BoldItalic.ttf',
  'Arial,Bold': 'LiberationSans-Bold.ttf', 'Arial,Italic': 'LiberationSans-Italic.ttf', 'Arial,BoldItalic': 'LiberationSans-BoldItalic.ttf',
};
const type1Assets = { 'Times-Roman': 'FoxitSerif.pfb', 'Times-Bold': 'FoxitSerifBold.pfb', 'Times-Italic': 'FoxitSerifItalic.pfb',
  'Times-BoldItalic': 'FoxitSerifBoldItalic.pfb', Courier: 'FoxitFixed.pfb', 'Courier-Bold': 'FoxitFixedBold.pfb',
  'Courier-Oblique': 'FoxitFixedItalic.pfb', 'Courier-BoldOblique': 'FoxitFixedBoldItalic.pfb', Symbol: 'FoxitSymbol.pfb', ZapfDingbats: 'FoxitDingbats.pfb' };
Object.assign(type1Assets, { TimesNewRomanPSMT: 'FoxitSerif.pfb', 'TimesNewRomanPS-BoldMT': 'FoxitSerifBold.pfb', 'TimesNewRomanPS-ItalicMT': 'FoxitSerifItalic.pfb', 'TimesNewRomanPS-BoldItalicMT': 'FoxitSerifBoldItalic.pfb', TimesNewRoman: 'FoxitSerif.pfb' });
// These exact unembedded Latin families use substitute outlines and PDF advances.
const latinSubstitutes = {
  TrebuchetMS: 'LiberationSans-Regular.ttf', Verdana: 'LiberationSans-Regular.ttf',
  'Verdana,Italic': 'LiberationSans-Italic.ttf', 'Verdana,Bold': 'LiberationSans-Bold.ttf',
  CourierNew: 'FoxitFixed.pfb', 'CourierNew,Bold': 'FoxitFixedBold.pfb',
  'TimesNewRoman,Italic': 'FoxitSerifItalic.pfb',
  ArialBlack: 'LiberationSans-Bold.ttf',
};
for (const [name, asset] of Object.entries(latinSubstitutes)) (asset.endsWith('.pfb') ? type1Assets : standardAssets)[name] = asset;

function admitLatinSubstitute(reader, id, descriptor, encoding, base) {
  const flags = descriptor ? reader.number(reader.field(descriptor, 'Flags'), 0) : 0;
  const dictionary = encoding && reader.node(encoding).kind === 'dictionary';
  const encodingName = encoding && reader.name(dictionary ? reader.field(encoding, 'BaseEncoding') : encoding);
  if (reader.name(reader.field(id, 'Subtype')) !== 'TrueType' || !Number.isInteger(flags) || flags < 0 || !(flags & 32) || flags & 4 || encodingName !== 'WinAnsiEncoding') throw new PdfEngineError('This unembedded Latin font needs a nonsymbolic WinAnsi encoding for substitution.');
  if (base === 'TimesNewRoman,Italic') {
    const angle = reader.number(reader.field(descriptor, 'ItalicAngle'), NaN);
    if (reader.name(reader.field(descriptor, 'FontName')) !== base || !(flags & 64) || !Number.isFinite(angle) || angle >= 0) throw new PdfEngineError('This italic Latin substitute needs matching italic font metadata.');
  }
  if (base === 'ArialBlack') {
    const angle = reader.number(reader.field(descriptor, 'ItalicAngle'), NaN);
    if (reader.name(reader.field(descriptor, 'FontName')) !== base || flags & 64 || angle !== 0) throw new PdfEngineError('This Latin black-font substitute needs matching nonitalic font metadata.');
  }
  const differences = dictionary && reader.field(encoding, 'Differences');
  if (differences) {
    if (reader.node(differences).kind !== 'array') throw new PdfEngineError('Invalid Latin font Differences.', 'pdf_corrupt');
    let code = null;
    for (const value of reader.array(differences)) {
      const token = reader.node(value);
      if (token.kind === 'number' && Number.isInteger(token.number) && token.number >= 0 && token.number < 256) code = token.number;
      else if (token.kind === 'name' && code !== null && code < 256 && reader.text(token) === pdfLatinGlyphName('WinAnsiEncoding', code)) code++;
      else throw new PdfEngineError('This Latin font substitution needs standard WinAnsi glyph names.');
    }
  }
  const first = reader.number(reader.field(id, 'FirstChar'), NaN), last = reader.number(reader.field(id, 'LastChar'), NaN), widthId = reader.field(id, 'Widths');
  if (!Number.isInteger(first) || first < 0 || !Number.isInteger(last) || last < first || last > 255 || !widthId || reader.node(widthId).kind !== 'array') throw new PdfEngineError('This unembedded Latin font needs explicit PDF glyph widths for substitution.');
  const widths = reader.array(widthId);
  if (widths.length !== last - first + 1 || widths.some(width => !Number.isFinite(reader.number(width, NaN)))) throw new PdfEngineError('Invalid PDF font width table.', 'pdf_corrupt');
  return { base, first, last, asset: latinSubstitutes[base] };
}
function retainLatinSubstitution(reader, font, substitution) {
  if (!substitution) return font;
  const decode = font.decode; let warned = false;
  font.decode = source => {
    for (const code of source) if (code < substitution.first || code > substitution.last) throw new PdfEngineError('This Latin substitute cannot paint a code without its declared PDF width.');
    if (source.length && !warned) { (reader.codecWarnings ||= []).push({ filter: 'FontSubstitution', sourceFont: substitution.base, replacement: substitution.asset }); warned = true; }
    return decode(source);
  };
  return font;
}

async function loadType1(reader, id, descriptor, file, encoding, loadAsset, retainOutlines = false) {
  const glyphOptions = { dingbats: isDingbatsFont(reader.name(reader.field(id, 'BaseFont'))) };
  const source = file ? (await decodePdfStream(reader, file)).bytes : await loadAsset(`standard_fonts/${type1Assets[reader.name(reader.field(id, 'BaseFont'))]}`);
  if (source[0] === 1) return loadCffPdfFont(reader, id, source, { descriptor, loadAsset, predefinedEncoding: !file ? reader.name(reader.field(id, 'BaseFont')) : null, retainOutlines });
  const program = parseType1Font(source, { length1: file ? reader.number(reader.field(file, 'Length1')) : null, length2: file ? reader.number(reader.field(file, 'Length2')) : null });
  const glyph = createType1GlyphReader(reader, program), names = new Map(program.encoding);
  let baseEncoding = null;
  if (encoding) baseEncoding = reader.node(encoding).kind === 'name' ? reader.name(encoding) : reader.name(reader.field(encoding, 'BaseEncoding'));
  if (baseEncoding && !['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding'].includes(baseEncoding)) throw new PdfEngineError(`Type 1 encoding ${baseEncoding} is not implemented yet.`);
  if (baseEncoding) for (let code = 0; code < 256; code++) names.set(code, pdfLatinGlyphName(baseEncoding, code));
  if (encoding && reader.node(encoding).kind === 'dictionary') {
    const differences = reader.field(encoding, 'Differences'); let at = 0;
    if (differences) for (const value of reader.array(differences)) {
      const n = reader.node(value);
      if (n.kind === 'number') { at = n.number; if (!Number.isInteger(at) || at < 0 || at > 255) throw new PdfEngineError('Invalid Type 1 difference code.', 'pdf_corrupt'); }
      else if (n.kind === 'name' && at < 256) names.set(at++, reader.text(n));
      else throw new PdfEngineError('Invalid Type 1 encoding difference.', 'pdf_corrupt');
    }
  }
  const unicodeId = reader.field(id, 'ToUnicode'), unicode = unicodeId ? await readToUnicode(reader, unicodeId) : null;
  const first = reader.number(reader.field(id, 'FirstChar'), 0), widthsId = reader.field(id, 'Widths'), widths = widthsId ? reader.array(widthsId).map(n => reader.number(n, NaN)) : null;
  if (!Number.isInteger(first) || first < 0 || widths?.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid Type 1 font widths.', 'pdf_corrupt');
  const aliases = new Map();
  for (const [code, name] of names) {
    const explicit = unicode?.get(code.toString(16).padStart(2, '0'));
    const symbol = explicit === undefined && program.glyphs.has(name) ? recognizedPdfSymbol(reader.name(reader.field(id, 'BaseFont')), name) : null;
    const text = explicit ?? symbol?.text ?? glyphNameText(name, glyphOptions); if (text && [...text].length === 1) aliases.set(text.codePointAt(0), name);
  }
  const converted = convertType1Font(program, glyph, aliases);
  const glyphNames = new Set(program.glyphs.keys());
  const ascent = descriptor ? reader.number(reader.field(descriptor, 'Ascent'), 900) / 1000 : .9;
  const descent = descriptor ? reader.number(reader.field(descriptor, 'Descent'), -250) / 1000 : -.25;
  const retained = retainOutlines ? retainType1Outlines(program, glyph, names, standardGlyphName) : {};
  return { bytes: converted.bytes, resourceBytes: pdfFontResourceBytes(converted.bytes, unicode, retained.resourceBytes ?? 0), family: `PageNarratorPdf${id}`, ascent, descent,
    canProvideOutlines: true, ...(retained.glyphOutline ? { glyphOutline: retained.glyphOutline } : {}),
    decode(sourceBytes) {
      return Array.from(sourceBytes, code => {
        const name = names.get(code) ?? standardGlyphName(code);
        const explicit = unicodeText(unicode, code.toString(16).padStart(2, '0'));
        const symbol = explicit === undefined && glyphNames.has(name) ? recognizedPdfSymbol(reader.name(reader.field(id, 'BaseFont')), name) : null;
        const text = explicit ?? symbol?.text ?? (baseEncoding ? pdfLatinGlyphText(baseEncoding, code, name, glyphOptions) : glyphNameText(name, glyphOptions));
        const width = widths && code >= first && code - first < widths.length ? widths[code - first] : converted.widths.get(name) ?? 0;
        return { code, text: text ?? String.fromCodePoint(0xe000 + code), width, renderText: converted.renderText(name), ...(symbol ? { symbol: { ...symbol, sourceCode: code } } : {}),
          systemText: !file && converted.widths.has(name) ? pdfSystemGlyph(glyphNameText(name, glyphOptions)) : undefined, ...(text === null ? { unmapped: true } : {}) };
      });
    } };
}

function fontDescriptor(reader, font) {
  const id = reader.field(font, 'FontDescriptor'); if (!id || reader.node(id).kind === 'null') return null;
  if (reader.node(id).kind !== 'dictionary') throw new PdfEngineError('FontDescriptor must be a dictionary.', 'pdf_corrupt'); return id;
}
function embeddedFontProgram(reader, descriptor, subtype) {
  if (!descriptor) return {};
  const programs = ['FontFile', 'FontFile2', 'FontFile3'].map(key => ({ key, id: reader.field(descriptor, key) })).filter(program => program.id && reader.node(program.id).kind !== 'null');
  // ISO 32000-1 9.8.1/Table 126 permits one compatible embedded font stream.
  if (programs.length > 1) throw new PdfEngineError('Multiple embedded FontFile entries.', 'pdf_corrupt');
  if (!programs.length) return {};
  const program = programs[0];
  if (reader.node(program.id).kind !== 'stream') throw new PdfEngineError('Embedded FontFile must be a stream.', 'pdf_corrupt');
  const allowed = program.key === 'FontFile' ? ['Type1', 'MMType1'] : program.key === 'FontFile2' ? ['TrueType', 'CIDFontType2'] : ['Type1', 'MMType1', 'TrueType', 'CIDFontType0', 'CIDFontType2'];
  if (!allowed.includes(subtype)) throw new PdfEngineError(`Embedded ${program.key} is incompatible with ${subtype}.`, 'pdf_corrupt');
  if (program.key === 'FontFile3') {
    program.format = reader.name(reader.field(program.id, 'Subtype'));
    if (!program.format) throw new PdfEngineError('Embedded FontFile3 needs a Subtype.', 'pdf_corrupt');
    if (program.format === 'Type1C' && !['Type1', 'MMType1'].includes(subtype) || program.format === 'CIDFontType0C' && subtype !== 'CIDFontType0') throw new PdfEngineError('Embedded FontFile3 Subtype is incompatible with its font.', 'pdf_corrupt');
  }
  return program;
}

function symbolicTrueTypeGlyphs(metrics) {
  // Symbolic Macintosh subsets use raw byte slots, including control-byte glyphs.
  if (metrics.platform === 1) return Array.from({ length: 256 }, (_, code) => metrics.glyphId(code));
  // ISO 32000-1 9.6.6.4, printed p267: a (3,0) symbolic cmap uses one
  // of four byte ranges. Its glyph indices do not establish Unicode text.
  const ranges = [0, 0xf000, 0xf100, 0xf200].map(prefix =>
    Array.from({ length: 256 }, (_, code) => metrics.glyphId(prefix + code)));
  const populated = ranges.filter(glyphs => glyphs.some(gid => gid !== 0));
  if (populated.length !== 1) throw new PdfEngineError('This symbolic TrueType cmap range is not implemented yet.');
  return populated[0];
}

export async function loadSimplePdfFont(reader, id, loadAsset, { retainOutlines = false } = {}) {
  const subtype = reader.name(reader.field(id, 'Subtype')), base = reader.name(reader.field(id, 'BaseFont'));
  if (subtype === 'Type3') return loadType3PdfFont(reader, id, loadAsset);
  if (subtype === 'Type0') {
    const descendants = reader.field(id, 'DescendantFonts'), list = descendants && reader.array(descendants);
    if (!list || list.length !== 1) throw new PdfEngineError('Invalid PDF descendant font.', 'pdf_corrupt');
    const child = list[0], descriptor = fontDescriptor(reader, child), program = embeddedFontProgram(reader, descriptor, reader.name(reader.field(child, 'Subtype')));
    if (!program.key) return loadLocalCidFont(reader, id, child, descriptor, loadAsset, { retainOutlines });
    if (program.key === 'FontFile2') return loadCidTrueTypeFont(reader, id, child, program.id, loadAsset, { retainOutlines });
    if (program.key !== 'FontFile3' || program.format !== 'CIDFontType0C') throw new PdfEngineError('This PDF CID font container is not implemented yet.');
    return loadCffPdfFont(reader, id, (await decodePdfStream(reader, program.id)).bytes, { descendant: child, descriptor, loadAsset, retainOutlines });
  }
  if (!['Type1', 'TrueType'].includes(subtype)) throw new PdfEngineError(`PDF font ${subtype} is not implemented yet.`);
  const encoding = reader.field(id, 'Encoding');
  const descriptor = fontDescriptor(reader, id), program = embeddedFontProgram(reader, descriptor, subtype), type1File = program.key === 'FontFile' ? program.id : null;
  const substitution = !program.key && Object.hasOwn(latinSubstitutes, base) ? admitLatinSubstitute(reader, id, descriptor, encoding, base) : null;
  const cffFile = program.key === 'FontFile3' ? program.id : null;
  if (cffFile) {
    if (program.format !== 'Type1C') throw new PdfEngineError('This embedded FontFile3 container is not implemented yet.');
    return loadCffPdfFont(reader, id, (await decodePdfStream(reader, cffFile)).bytes, { descriptor, loadAsset, retainOutlines });
  }
  if (subtype === 'Type1' && (type1File || type1Assets[base]) || type1Assets[base] && program.key !== 'FontFile2') {
    const font = await loadType1(reader, id, descriptor, type1File, encoding, loadAsset, retainOutlines);
    if (!program.key) font.localFaces = pdfLocalFontNames(base); return retainLatinSubstitution(reader, font, substitution);
  }
  const encodingDictionary = encoding && reader.node(encoding).kind === 'dictionary';
  if (encoding && !encodingDictionary && reader.node(encoding).kind !== 'name') throw new PdfEngineError('Invalid TrueType font encoding.', 'pdf_corrupt');
  const baseEncoding = encodingDictionary ? reader.field(encoding, 'BaseEncoding') : encoding;
  if (baseEncoding && reader.node(baseEncoding).kind !== 'name') throw new PdfEngineError('Invalid TrueType base encoding.', 'pdf_corrupt');
  const encodingName = baseEncoding ? reader.name(baseEncoding) : 'StandardEncoding', differences = new Map();
  if (!['WinAnsiEncoding', 'StandardEncoding', 'MacRomanEncoding'].includes(encodingName)) throw new PdfEngineError(`PDF encoding ${encodingName} is not implemented yet.`);
  if (encodingDictionary) {
    const values = reader.field(encoding, 'Differences'); let at = null;
    if (values) for (const value of reader.array(values)) {
      const token = reader.node(value);
      if (token.kind === 'number' && Number.isInteger(token.number) && token.number >= 0 && token.number < 256) at = token.number;
      else if (token.kind === 'name' && at !== null && at < 256) differences.set(at++, reader.text(token));
      else throw new PdfEngineError('Invalid TrueType encoding difference.', 'pdf_corrupt');
    }
  }
  const embedded = program.key === 'FontFile2' ? program.id : null;
  let bytes;
  if (embedded) bytes = (await decodePdfStream(reader, embedded)).bytes;
  else {
    const file = standardAssets[base]; if (!file) throw new PdfEngineError(`Standard font ${base} is not implemented yet.`);
    bytes = await loadAsset(`standard_fonts/${file}`);
  }
  const metrics = readTrueTypeMetrics(bytes), unicodeId = reader.field(id, 'ToUnicode');
  const unicode = unicodeId ? await readToUnicode(reader, unicodeId) : null;
  const flags = descriptor ? reader.number(reader.field(descriptor, 'Flags'), 0) : 0;
  const symbolicGlyphs = embedded && !encoding && Number.isInteger(flags) && flags >= 0 && (flags & 4) && !(flags & 32)
    && [1, 3].includes(metrics.platform) && metrics.encoding === 0 ? symbolicTrueTypeGlyphs(metrics) : null;
  const first = reader.number(reader.field(id, 'FirstChar'), 0), widthsId = reader.field(id, 'Widths');
  const widths = widthsId ? reader.array(widthsId).map(n => reader.number(n, NaN)) : null;
  if (!Number.isInteger(first) || first < 0 || widths?.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid PDF font width table.', 'pdf_corrupt');
  const canonicalWidths = !embedded && !widths ? await loadStandard14Widths(standardAssets[base], loadAsset) : null;
  const canonicalBytes = canonicalWidths ? [...canonicalWidths.keys()].reduce((sum, name) => sum + 64 + 2 * name.length, 0) : 0;
  const encodedGlyphName = code => differences.get(code) ?? pdfLatinGlyphName(encodingName, code);
  const encodedText = code => pdfLatinGlyphText(encodingName, code, encodedGlyphName(code));
  const encodedGlyphText = code => glyphNameText(encodedGlyphName(code));
  const glyphs = new Map(), unresolvedGlyphs = new Map();
  if (encodingDictionary && !metrics.isUnicode && !(metrics.platform === 1 && metrics.encoding === 0)) throw new PdfEngineError('This TrueType encoding dictionary cmap is not implemented yet.');
  // Rebuild declared encodings for browsers; unused subset cmap entries can reference omitted glyphs.
  if (!metrics.isUnicode || !embedded || encoding) {
    const aliases = new Map(), macintosh = new Map(), macDecoder = new TextDecoder('macintosh');
    for (let code = 0; code < 256; code++) macintosh.set(macDecoder.decode(Uint8Array.of(code)), code);
    for (let code = 0; code < 256; code++) {
      const text = unicode?.get(code.toString(16).padStart(2, '0')) ?? (symbolicGlyphs ? '' : encodedText(code)) ?? '';
      // ISO 32000-1 9.6.6.4: select the painted glyph through the encoding's
      // glyph name and the font cmap. ToUnicode describes semantic text only.
      const glyphText = encodedGlyphText(code), single = glyphText && [...glyphText].length === 1;
      const source = metrics.isUnicode ? single ? glyphText.codePointAt(0) : 0
        : metrics.platform === 1 && (encodingName === 'WinAnsiEncoding' || encodingDictionary) ? macintosh.get(glyphText) ?? (differences.has(code) ? null : code) : code;
      const gid = symbolicGlyphs ? symbolicGlyphs[code] : encodedGlyphName(code) === '.notdef' ? 0 : metrics.glyphId(source) || (metrics.platform === 3 && metrics.encoding === 0 ? metrics.glyphId(0xf000 + code) : 0);
      if (differences.has(code) && encodedGlyphName(code) !== '.notdef' && (!single || !gid)) unresolvedGlyphs.set(code, encodedGlyphName(code));
      glyphs.set(code, gid); if (!unresolvedGlyphs.has(code) && [...text].length === 1 && (!aliases.has(text.codePointAt(0)) || unicode?.has(code.toString(16).padStart(2, '0')))) aliases.set(text.codePointAt(0), gid);
    }
    bytes = remapTrueTypeCmap(bytes, metrics.glyphCount, aliases);
  }
  const readOutline = retainOutlines ? createTrueTypeGlyphReader(reader, bytes, metrics) : null;
  const outlineFields = readOutline ? { glyphOutline(code, glyph) {
    reader.check(); const gid = simpleTrueTypeOutlineGlyph(code, glyph, glyphs, metrics);
    return gid === null ? { outline: [], fontMatrix: [1 / metrics.units, 0, 0, 1 / metrics.units, 0, 0] } : readOutline(gid);
  } } : {};
  let warnedSymbolicText = false;
  return retainLatinSubstitution(reader, { bytes, canProvideOutlines: true, ...outlineFields, resourceBytes: pdfFontResourceBytes(bytes, unicode, canonicalBytes + (retainOutlines ? TRUE_TYPE_OUTLINE_CACHE_BYTES : 0)), family: `PageNarratorPdf${id}`, ascent: metrics.ascent, descent: metrics.descent, ...(!embedded ? { localFaces: pdfLocalFontNames(base) } : {}),
    decode(source) {
      const result = [];
      for (const code of source) {
        if (unresolvedGlyphs.has(code)) throw new PdfEngineError(`TrueType glyph name ${unresolvedGlyphs.get(code)} is not supported by its cmap.`);
        if (!symbolicGlyphs && encodingName === 'StandardEncoding' && code > 126 && !unicode && !differences.has(code)) throw new PdfEngineError('Non-ASCII StandardEncoding is not implemented yet.');
        const explicit = unicodeText(unicode, code.toString(16).padStart(2, '0')), unmapped = symbolicGlyphs && explicit === undefined;
        const text = explicit ?? (symbolicGlyphs ? String.fromCodePoint(0xe000 + code) : encodedText(code)) ?? '';
        if (unmapped && !warnedSymbolicText) { (reader.codecWarnings ||= []).push({ filter: 'TrueType', unmappedSymbolicText: true }); warnedSymbolicText = true; }
        const sourceText = encodedGlyphText(code), gid = glyphs.get(code);
        if (gid >= metrics.glyphCount) throw new PdfEngineError('Simple font cmap references an absent glyph.', 'pdf_corrupt');
        const width = widths && code >= first && code - first < widths.length ? widths[code - first]
          : canonicalWidths?.get(encodedGlyphName(code)) ?? (gid !== undefined ? metrics.widthByGlyph(gid) : metrics.width((text || sourceText)?.codePointAt(0) ?? 0));
        result.push({ code, text, width, ...(unmapped ? { unmapped: true } : {}), ...(!embedded && gid ? { systemText: pdfSystemGlyph(sourceText) } : {}),
          ...(gid !== undefined ? { renderText: String.fromCodePoint(privateGlyphCode(gid)) } : text === '' && sourceText ? { renderText: sourceText } : {}) });
      }
      return result;
    } }, substitution);
}
