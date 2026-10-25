import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createType1GlyphReader } from '../../src/pdf/type1-font.js';
import { parseCffFont, readCffWidths } from '../../src/pdf/cff-font.js';
import { buildCffOpenType, privateGlyphCode } from '../../src/pdf/font-container.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { parseIccProfile, adaptXyzToD50, xyzD50ToRgb } from '../../src/pdf/icc-color.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { PDF_ACCEPTANCE_BENCHMARK } from '../fixtures/pdf-acceptance-manifest.js';
import { matchesOrderedCheckpoints } from '../../scripts/pdf-acceptance-metrics.mjs';
import { convertType1Font } from '../../src/pdf/type1-container.js';

afterEach(() => vi.unstubAllGlobals());
const charNumber = n => n >= -107 && n <= 107 ? [n + 139] : n >= 108 && n <= 1131 ? [247 + (n - 108 >> 8), n - 108 & 255] : n <= -108 && n >= -1131 ? [251 + (-n - 108 >> 8), -n - 108 & 255] : [255, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const charstring = (...parts) => Uint8Array.from(parts.flat());
const imagePdf = (samples, dictionary, extra = [], fill = '') => simplePdf(`${fill} q 20 0 0 20 0 0 cm /I Do Q`, { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.from(samples), `/Type /XObject /Subtype /Image ${dictionary}`), ...extra] });
async function payloadOf(data) { const core = await createPdfDocumentCore(data, options); try { return await core.pagePayload(1); } finally { core.destroy(); } }

describe('original font execution and conversion', () => {
  it('executes signed Type1 coordinates and subroutines without unsigned overflow', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const program = { glyphs: new Map([['A', charstring(charNumber(0), charNumber(600), 13, charNumber(-20), charNumber(10), 21, charNumber(0), 10, 14)]]), subrs: [charstring(charNumber(-300), charNumber(-2000), 5, 11)] };
      expect(createType1GlyphReader(reader, program)('A')).toMatchObject({ width: 600, path: [{ op: 1, points: [-20, 10] }, { op: 2, points: [-320, -1990] }] });
      program.subrs[0] = charstring(charNumber(1), charNumber(1), 5);
      expect(() => createType1GlyphReader(reader, program)('A')).toThrow(/invalid/);
    } finally { reader.destroy(); }
  });
  it('rejects executable custom Type1 OtherSubrs rather than substituting argument passthrough', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const program = { glyphs: new Map([['A', charstring(charNumber(0), charNumber(600), 13, charNumber(0), charNumber(42), 12, 16, 14)]]), subrs: [] };
      expect(() => createType1GlyphReader(reader, program)('A')).toThrow(/not implemented/);
    } finally { reader.destroy(); }
  });
  it('finds Type2 advance widths inside biased local subroutine calls', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const font = { glyphs: [charstring(charNumber(-107), 10, 14)], globalSubrs: [], selection: new Uint16Array(1), locals: [{ subrs: [charstring(charNumber(500), charNumber(0), 22, 11)], nominal: 0, fallback: 600 }] };
      expect(readCffWidths(reader, font)).toEqual([500]);
    } finally { reader.destroy(); }
  });
  it('converts original Type1 outlines into checked Type2 data with Unicode aliases', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const program = { matrix: [.001, 0, 0, .001, 0, 0], glyphs: new Map([['A', charstring(charNumber(0), charNumber(600), 13, charNumber(-20), charNumber(10), 21, charNumber(300), charNumber(400), 5, 9, 14)]]), subrs: [] };
      const converted = convertType1Font(program, createType1GlyphReader(reader, program), new Map([[65, 'A']])), metrics = readTrueTypeMetrics(converted.bytes);
      expect(metrics.glyphId(65)).toBe(1); expect(metrics.glyphId(privateGlyphCode(1))).toBe(1); expect(metrics.width(65)).toBe(600);
      expect(converted.renderText('A')).toBe(String.fromCodePoint(privateGlyphCode(1)));
    } finally { reader.destroy(); }
  });
  it.each([0x10000, 0x74727565])('paints encoded Macintosh cmap glyphs from sfnt signature %i while exposing ToUnicode', async signature => {
    const bytes = (await loadAsset('standard_fonts/LiberationSans-Regular.ttf')).slice(), view = new DataView(bytes.buffer), original = readTrueTypeMetrics(bytes), gid = original.glyphId(65);
    view.setUint32(0, signature);
    for (let i = 0; i < view.getUint16(4); i++) if (new TextDecoder().decode(bytes.subarray(12 + i * 16, 16 + i * 16)) === 'cmap') {
      const at = view.getUint32(20 + i * 16); view.setUint16(at + 2, 1); view.setUint16(at + 4, 1); view.setUint16(at + 6, 0); view.setUint32(at + 8, 12);
      view.setUint16(at + 12, 6); view.setUint16(at + 14, 12); view.setUint16(at + 16, 0); view.setUint16(at + 18, 65); view.setUint16(at + 20, 1); view.setUint16(at + 22, gid);
    }
    expect(readTrueTypeMetrics(bytes)).toMatchObject({ isUnicode: false, platform: 1, encoding: 0 });
    const payload = await payloadOf(simplePdf('BT /F1 12 Tf 1 0 0 1 20 30 Tm (A) Tj ET', { font: '/Type /Font /Subtype /TrueType /BaseFont /Encoded /FontDescriptor 6 0 R /ToUnicode 8 0 R', extra: ['<< /Type /FontDescriptor /FontFile2 7 0 R >>', stream(bytes), stream('begincmap 1 beginbfchar <41> <0058> endbfchar endcmap')] }));
    expect(payload.items[0].str).toBe('X'); expect(payload.commands.find(c => c.op === 'text').glyphs[0].renderText).toBe(String.fromCodePoint(privateGlyphCode(gid)));
    expect(readTrueTypeMetrics(payload.fonts[0].bytes).glyphId(88)).toBe(gid);
  });
  it.each(['FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifItalic.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedItalic.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitSymbol.pfb', 'FoxitDingbats.pfb'])('converts licensed CFF data %s with consistent glyph metrics and whole-font checksum', async name => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      const font = parseCffFont(await loadAsset(`standard_fonts/${name}`)), widths = readCffWidths(reader, font), converted = buildCffOpenType(font, widths), metrics = readTrueTypeMetrics(converted);
      expect(widths.length).toBeGreaterThan(100); expect(metrics.glyphCount).toBe(widths.length);
      for (let gid = 0; gid < widths.length; gid++) { expect(metrics.glyphId(privateGlyphCode(gid))).toBe(gid); expect(metrics.widthByGlyph(gid)).toBeCloseTo(widths[gid], 0); }
      const view = new DataView(converted.buffer); let sum = 0; for (let at = 0; at < converted.length; at += 4) sum = (sum + view.getUint32(at)) >>> 0;
      expect(sum).toBe(0xb1b0afba);
    } finally { reader.destroy(); }
  });
});

describe('source text and app narration contracts', () => {
  it.each(['fixture-rtl-two-column', 'fixture-mixed-direction'])('keeps logical RTL Unicode for %s through the existing page model', async id => {
    const entry = PDF_ACCEPTANCE_BENCHMARK.find(e => e.id === id), payload = await payloadOf(new Uint8Array(await readFile(new URL(`../../${entry.source}`, import.meta.url))));
    expect(payload.items.some(i => i.dir === 'rtl' && i.textOrder === 'logical')).toBe(true);
    const model = createPdfPageModel(payload.items); expect(matchesOrderedCheckpoints(model.speech, entry.orderedCheckpoints)).toMatchObject({ passed: true });
  });
  it('validates malformed ToUnicode targets when used without rejecting unrelated valid glyphs', async () => {
    const parameters = { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R', extra: [stream('begincmap 2 beginbfchar <41> <0058> <42> <000041> endbfchar endcmap')] };
    expect((await payloadOf(simplePdf('BT /F1 12 Tf (A) Tj ET', parameters))).items[0].str).toBe('X');
    await expect(payloadOf(simplePdf('BT /F1 12 Tf (B) Tj ET', parameters))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('handles zero and negative font sizes without dropping later visible text', async () => {
    const payload = await payloadOf(simplePdf('BT /F1 0 Tf (invisible) Tj /F1 -12 Tf 1 0 0 1 50 70 Tm (mirrored) Tj /F1 12 Tf 100 Tz 1 0 0 1 10 20 Tm (visible) Tj ET'));
    expect(payload.items.map(i => i.str)).toEqual(['mirrored', 'visible']); expect(payload.items[0].transform.slice(0, 4)).toEqual([-12, 0, 0, -12]); expect(payload.items[0].width).toBeGreaterThan(0);
  });
  it('honors accessible ActualText while preserving every original paint operation', async () => {
    const payload = await payloadOf(simplePdf('BT /F1 12 Tf (A) Tj /Span << /ActualText <FEFF2460> >> BDC (B) Tj EMC (C) Tj ET'));
    expect(payload.items.map(i => i.str)).toEqual(['A', '①', 'C']); expect(payload.commands.filter(c => c.op === 'text').map(c => c.glyphs.map(g => g.text).join(''))).toEqual(['A', 'B', 'C']);
    const empty = await payloadOf(simplePdf('BT /F1 12 Tf /Span << /ActualText () >> BDC (visual decoration) Tj EMC (narrated) Tj ET'));
    expect(empty.items.map(i => i.str)).toEqual(['narrated']); expect(empty.commands.filter(c => c.op === 'text')).toHaveLength(2);
    await expect(payloadOf(simplePdf('EMC'))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
});

describe('original image samples, colors and masks', () => {
  it('decodes packed two-bit gray samples and color-key transparency', async () => {
    const packed = await payloadOf(imagePdf([0b00011011], '/Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 2'));
    expect([...packed.commands.find(c => c.op === 'image').pixels]).toEqual([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
    const masked = await payloadOf(imagePdf([255, 0, 0, 0, 255, 0], '/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Mask [255 255 0 0 0 0]'));
    expect([...masked.commands.find(c => c.op === 'image').pixels]).toEqual([255, 0, 0, 0, 0, 255, 0, 255]);
  });
  it('paints stencil masks in the active PDF fill color', async () => {
    const payload = await payloadOf(imagePdf([0b01000000], '/Width 2 /Height 1 /ImageMask true /BitsPerComponent 1', [], '0 0 1 rg'));
    expect([...payload.commands.find(c => c.op === 'image').pixels]).toEqual([0, 0, 255, 255, 0, 0, 255, 0]);
    await expect(payloadOf(imagePdf([0], '/Width 1 /Height 1 /ImageMask true /BitsPerComponent 8'))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('applies soft-mask alpha and reverses premultiplication by its Matte color', async () => {
    const mask = stream(Uint8Array.of(128), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [1 1 1]');
    const payload = await payloadOf(imagePdf([128, 128, 255], '/Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 7 0 R', [mask]));
    expect([...payload.commands.find(c => c.op === 'image').pixels]).toEqual([2, 2, 255, 128]);
  });
  it('adapts calibrated D65 Lab and Gray white to neutral display white', async () => {
    const adapted = xyzD50ToRgb(adaptXyzToD50([.95047, 1, 1.08883], [.95047, 1, 1.08883]));
    expect(Math.min(...adapted)).toBeGreaterThan(.999);
    const payload = await payloadOf(simplePdf('/C cs 100 0 0 scn 0 0 20 20 re f', { page: '/Resources << /ColorSpace << /C [/Lab << /WhitePoint [.95047 1 1.08883] >>] >> >>' }));
    expect(payload.commands.filter(c => c.op === 'color').at(-1).value).toBe('rgb(255,255,255)');
    const raw = await payloadOf(imagePdf([255, 128, 128], '/Width 1 /Height 1 /ColorSpace [/Lab << /WhitePoint [.95047 1 1.08883] >>] /BitsPerComponent 8'));
    expect(Math.min(...raw.commands.find(c => c.op === 'image').pixels)).toBeGreaterThan(250);
  });
  it('reads the retained bounded CMYK ICC profile and rejects invalid profile ranges', async () => {
    const bytes = await loadAsset('iccs/CGATS001Compat-v2-micro.icc'), profile = parseIccProfile(bytes);
    expect(profile.channels).toBe(4); expect(Math.min(...profile.convert([0, 0, 0, 0]))).toBeGreaterThan(.95); expect(Math.max(...profile.convert([0, 0, 0, 1]))).toBeLessThan(.25);
    const invalid = bytes.slice(); new DataView(invalid.buffer).setUint32(136, bytes.length + 100);
    expect(() => parseIccProfile(invalid)).toThrow(/range|bounds/);
  });
  it('keeps JPEG mask alpha distinct from paint opacity and releases bitmap/surface resources', async () => {
    const mask = stream(Uint8Array.of(128), '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [1 1 1]');
    const payload = await payloadOf(imagePdf([0xff, 0xd8, 0xff, 0xd9], '/Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 7 0 R', [mask]));
    const image = payload.commands.find(c => c.op === 'jpeg'); expect(image.alpha).toBe(1); expect([...image.maskAlpha]).toEqual([128]);
    const close = vi.fn(), written = [], surfaces = [], draws = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); }
      getContext() { return { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.of(128, 128, 255, 255) }), putImageData: pixels => written.push([...pixels.data]) }; }
    });
    const ctx = { canvas: { width: 40, height: 40 }, save() {}, restore() {}, setTransform() {}, transform() {}, fillRect() {}, beginPath() {}, scale() {}, drawImage(...args) { draws.push(args); } };
    await renderPdfDisplayList(payload, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 40, 40]) }).promise;
    expect(written).toEqual([[2, 2, 255, 128]]); expect(close).toHaveBeenCalledOnce(); expect(draws).toHaveLength(1); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
});
