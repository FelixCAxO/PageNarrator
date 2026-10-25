import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { loadSimplePdfFont } from '../../src/pdf/fonts.js';
import { openPdfDocument, renderPdfTextLayer } from '../../src/pdf/browser-pdf.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { simplePdf, stream, loadAsset, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
const sourceName = '#CB#CE#CC#E5';
function data({ name = sourceName, childName = name, descriptorName = name, encoding = '/GBK-EUC-H', childSubtype = 'CIDFontType2', flags = '5', registry = '(Adobe)', ordering = '(GB1)', supplement = '2', mapping = '', unicode = '', fontExtra = '', metrics = '/DW 1100 /W [4559 [700] 3795 [900]]', descriptorMetrics = '/Ascent 859 /Descent -141', content = 'BT /F1 24 Tf 1 0 0 1 20 40 Tm <d6d0cec4> Tj ET', program = '' } = {}) {
  return simplePdf(content, { font: `/Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding ${encoding} /DescendantFonts [6 0 R] ${unicode ? '/ToUnicode 8 0 R' : ''} ${fontExtra}`,
    extra: [`<< /Type /Font /Subtype /${childSubtype} /BaseFont /${childName} /CIDSystemInfo << /Registry ${registry} /Ordering ${ordering} /Supplement ${supplement} >> /FontDescriptor 7 0 R ${mapping} ${metrics} >>`,
      `<< /Type /FontDescriptor /FontName /${descriptorName} /Flags ${flags} ${descriptorMetrics} ${program ? '/FontFile2 8 0 R' : ''} >>`, ...(unicode ? [stream(unicode)] : program ? [stream(program)] : [])] });
}
async function payload(bytes, settings = options) { const core = await createPdfDocumentCore(bytes, settings); try { return await core.pagePayload(1); } finally { core.destroy(); } }
async function font(bytes, settings = {}) {
  const reader = await NativePdfReader.create(bytes, options);
  try { return { reader, font: await loadSimplePdfFont(reader, reader.checked(reader.api.pn_pdf_resolve(5, 0)), loadAsset, settings) }; }
  catch (error) { reader.destroy(); throw error; }
}
function browserFonts({ localAvailable = true, invalidScaffold = false, pendingLocal = null } = {}) {
  const calls = [], retained = new Set(); let local = localAvailable;
  vi.stubGlobal('document', { fonts: { add: face => retained.add(face), delete: face => retained.delete(face) } });
  vi.stubGlobal('FontFace', class {
    constructor(family, source) { Object.assign(this, { family, source }); calls.push(this); }
    async load() {
      if (typeof this.source === 'string') { if (pendingLocal) await pendingLocal; if (!local) throw new Error('Unavailable local face.'); }
      else if (invalidScaffold) throw new Error('Invalid scaffold font.');
      return this;
    }
  });
  return { calls, retained, setLocal: value => { local = value; } };
}
function context() {
  return { canvas: { width: 612, height: 792 }, save() {}, restore() {}, setTransform() {}, transform() {}, beginPath() {}, scale() {},
    painted: [], fillRect() { this.painted.push('background'); }, fillText(text, x, y) { this.painted.push({ text, x, y, font: this.font }); } };
}

describe('strict local unembedded GBK CID font substitution', () => {
  it.each([sourceName, 'SimSun'])('uses canonical GBK Unicode and explicit PDF metrics for exact source name %s', async name => {
    const loaded = await font(data({ name }));
    try {
      const actual = loaded.font.decode(Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4));
      expect(actual).toEqual([{ code: 0xd6d0, cid: 4559, codeLength: 2, text: '中', systemText: '中', width: 700 }, { code: 0xcec4, cid: 3795, codeLength: 2, text: '文', systemText: '文', width: 900 }]);
      expect(loaded.font).toMatchObject({ requiresLocalFace: true, localFaces: ['SimSun', '宋体'], canProvideOutlines: false, ascent: .859, descent: -.141 });
      expect(loaded.font.resourceBytes).toBeGreaterThan(loaded.font.bytes.byteLength);
      expect(actual.every(glyph => glyph.renderText === undefined)).toBe(true);
    } finally { loaded.reader.destroy(); }
    const actual = await payload(data({ name }));
    expect(actual.items[0].str).toBe('中文'); expect(actual.items[0].width).toBeCloseTo(38.4, 9);
    expect(actual.commands.find(command => command.op === 'text').glyphs[1].x).toBeCloseTo(.7, 10);
    expect(actual.fonts[0]).toMatchObject({ requiresLocalFace: true, localFaces: ['SimSun', '宋体'] });
    expect(actual.inspection.unmappedGlyphs).toBe(0);
  });
  it('uses DW for a canonically mapped code absent from W and warns once only after a used run', async () => {
    const loaded = await font(data({ metrics: '/DW 1234 /W [3795 [900]]' }));
    try {
      expect(loaded.reader.codecWarnings).toBeUndefined(); expect(loaded.font.decode(new Uint8Array())).toEqual([]);
      expect(loaded.font.decode(Uint8Array.of(0xd6, 0xd0))[0].width).toBe(1234); loaded.font.decode(Uint8Array.of(0xce, 0xc4));
      expect(loaded.reader.codecWarnings).toEqual([{ filter: 'FontSubstitution', sourceFont: '宋体', replacement: 'required local SimSun/宋体', requiresLocalFace: true }]);
    } finally { loaded.reader.destroy(); }
  });
  it('preserves TJ, character spacing and horizontal scaling using PDF advances', async () => {
    const actual = await payload(data({ content: 'BT /F1 20 Tf 2 Tc 1 Tw 75 Tz 1 0 0 1 20 70 Tm [<d6d0> -125 <cec4d6d0>] TJ ET' }));
    const commands = actual.commands.filter(command => command.op === 'text');
    expect(actual.items.map(item => item.str).join('')).toBe('中文中');
    expect(commands).toHaveLength(2); expect(commands[1].matrix[4]).toBeCloseTo(33.875, 9);
    expect(commands[1].glyphs[1].x).toBeCloseTo(1, 9);
    expect(actual.items).toHaveLength(1); expect(actual.items[0].width).toBeCloseTo(40.875, 9);
  });
  it.each(['UnknownCJK', 'AAAAAA+SimSun', 'SongtiSC', '#E5#AE#8B#E4#BD#93'])('does not infer other names or arbitrary encodings: %s', async name => {
    await expect(payload(data({ name }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it.each([{ childName: 'Other' }, { descriptorName: 'Other' }, { childSubtype: 'CIDFontType0' }, { flags: '4' }, { flags: '32' }, { encoding: '/GBK-EUC-V' }, { encoding: '/Identity-H' }, { encoding: '<< /CMapName /GBK-EUC-H >>' }, { registry: '(Other)' }, { ordering: '(Japan1)' }, { supplement: '3' }, { mapping: '/CIDToGIDMap /Identity' }, { unicode: 'begincmap endcmap' }])('keeps unsupported font mappings closed: %j', async settings => {
    await expect(payload(data(settings))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it.each([{ registry: '/Adobe' }, { metrics: '/DW /invalid' }, { metrics: '/W [-1 [1000]]' }, { metrics: '/W [4559 [/invalid]]' }, { descriptorMetrics: '/Ascent /invalid /Descent -141' }, { descriptorMetrics: '/Ascent 859' }])('rejects malformed required metrics/collection: %j', async settings => {
    await expect(payload(data(settings))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('treats optional null ToUnicode/CIDToGIDMap as absent, but never ignores an actual embedded font program', async () => {
    expect((await payload(data({ mapping: '/CIDToGIDMap null', fontExtra: '/ToUnicode null' }))).items[0].str).toBe('中文');
    await expect(payload(data({ program: 'invalid' }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('embedded font') });
  });
  it.each([1, 2, 4, 5, 6, 7])('retains original-outline unsupported for text mode %i', async mode => {
    await expect(payload(data({ content: `BT /F1 24 Tf ${mode} Tr <d6d0cec4> Tj ET` }))).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('original glyph outline') });
  });
  it('supports invisible canonical extraction but rejects a direct retainOutlines request', async () => {
    expect((await payload(data({ content: 'BT /F1 24 Tf 3 Tr <d6d0cec4> Tj ET' }))).items[0].str).toBe('中文');
    await expect(font(data(), { retainOutlines: true })).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('original glyph outline') });
  });
  it.each(['80', 'd6'])('never fabricates missing/truncated source mappings: %s', async hex => {
    await expect(payload(data({ content: `BT /F1 24 Tf <${hex}> Tj ET` }))).rejects.toMatchObject({ code: hex === '80' ? 'pdf_unsupported' : 'pdf_corrupt' });
  });
  it.each(['', '<E000>', '<00410042>'])('refuses missing/private/multi-scalar canonical targets: %s', async target => {
    const settings = { ...options, loadAsset: name => name.endsWith('/Adobe-GB1-UCS2') ? new TextEncoder().encode(`begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${target ? `1 beginbfchar <11CF> ${target} endbfchar` : ''} endcmap`) : loadAsset(name) };
    await expect(payload(data(), settings)).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});

describe('required local CID face lifecycle', () => {
  it('registers a required local face, paints canonical glyphs, and removes both faces on destroy', async () => {
    const fonts = browserFonts(), document = await openPdfDocument(data(), { ...options, useSystemFonts: true });
    try {
      const page = await document.getPage(1), ctx = context(); await page.render({ canvasContext: ctx, viewport: page.getViewport() }).promise;
      expect(ctx.painted.filter(value => typeof value === 'object').map(value => value.text)).toEqual(['中', '文']);
      expect(fonts.calls).toHaveLength(2); expect(fonts.retained.size).toBe(2); expect(fonts.calls[1].source).toBe('local("SimSun"),local("宋体")');
      expect((await page.getTextContent()).items[0].str).toBe('中文');
    } finally { document.destroy(); }
    expect(fonts.retained.size).toBe(0);
  });
  it.each([false, true])('rejects missing or disabled required local face before every paint, enabled=%s', async enabled => {
    const fonts = browserFonts({ localAvailable: false }), document = await openPdfDocument(data(), { ...options, useSystemFonts: enabled });
    try {
      const page = await document.getPage(1), ctx = context(); expect((await page.getTextContent()).items[0].str).toBe('中文');
      await expect(page.render({ canvasContext: ctx, viewport: page.getViewport() }).promise).rejects.toMatchObject({ code: 'pdf_unsupported', message: 'Required local PDF CID font is unavailable.' });
      expect(ctx.painted).toEqual([]); expect(fonts.retained.size).toBe(0);
      expect(fonts.calls.length).toBe(enabled ? 2 : 0);
    } finally { document.destroy(); }
  });
  it('retries a rejected local load without retaining a failed face/admission record', async () => {
    const fonts = browserFonts({ localAvailable: false }), document = await openPdfDocument(data(), { ...options, useSystemFonts: true });
    try {
      const page = await document.getPage(1); await expect(page.ensureFonts()).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(fonts.retained.size).toBe(0);
      fonts.setLocal(true); await page.ensureFonts(); expect(fonts.calls).toHaveLength(4); expect(fonts.retained.size).toBe(2);
    } finally { document.destroy(); }
    expect(fonts.retained.size).toBe(0);
  });
  it('propagates a bad scaffold font and releases the failed admission', async () => {
    const fonts = browserFonts({ invalidScaffold: true }), document = await openPdfDocument(data(), { ...options, useSystemFonts: true });
    try { await expect((await document.getPage(1)).ensureFonts()).rejects.toThrow('Invalid scaffold font.'); expect(fonts.retained.size).toBe(0); }
    finally { document.destroy(); }
  });
  it.each(['destroy', 'cancel'])('does not paint after %s while local loading is pending', async action => {
    let release; const pendingLocal = new Promise(resolve => { release = resolve; }), fonts = browserFonts({ pendingLocal });
    const document = await openPdfDocument(data(), { ...options, useSystemFonts: true }), page = await document.getPage(1), ctx = context();
    const rendering = page.render({ canvasContext: ctx, viewport: page.getViewport() });
    try {
      await vi.waitFor(() => expect(fonts.calls).toHaveLength(2)); if (action === 'destroy') document.destroy(); else rendering.cancel(); release();
      await expect(rendering.promise).rejects.toMatchObject(action === 'destroy' ? { code: 'pdf_closed' } : { name: 'RenderingCancelledException' });
      expect(ctx.painted).toEqual([]);
    } finally { release(); document.destroy(); }
    expect(fonts.retained.size).toBe(0);
  });
  it('refuses text-layer font registration when the required local font is disabled', async () => {
    browserFonts(); const document = await openPdfDocument(data(), { ...options, useSystemFonts: false });
    try {
      const page = await document.getPage(1), replaceChildren = vi.fn();
      await expect(renderPdfTextLayer({ page, container: { replaceChildren }, viewport: page.getViewport() })).rejects.toMatchObject({ code: 'pdf_unsupported' });
      expect(replaceChildren).not.toHaveBeenCalled();
    } finally { document.destroy(); }
  });
  it('keeps the exported direct Canvas renderer from silently using the scaffold', async () => {
    const actual = await payload(data()), ctx = context();
    await expect(renderPdfDisplayList(actual, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 612, 792]) }).promise).rejects.toMatchObject({ code: 'pdf_unsupported', message: 'Required local PDF CID font is unavailable.' });
    expect(ctx.painted).toEqual([]);
  });
});
