import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfPatternReader } from '../../src/pdf/shading-pattern.js';
import { planPdfTilingRaster, renderPdfTilingPattern } from '../../src/pdf/tiling-pattern.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { tilingPdf } from './tiling-pattern-fixture.js';
import { options, pdf, stream } from './fixtures.js';

const identity = [1, 0, 0, 1, 0, 0];
async function payload(settings, run = value => value) {
  const core = await createPdfDocumentCore(tilingPdf({ kind: 'solid', ...settings }), options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
const patternOf = value => value.commands.find(command => command.fillPattern)?.fillPattern;
async function withReader(build, run) {
  const reader = await NativePdfReader.create(tilingPdf({ kind: 'solid' }), options);
  try {
    const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), id = reader.field(reader.field(resources, 'Pattern'), 'P');
    await run({ reader, resources, id, read: createPdfPatternReader(reader, options.loadAsset, new Map(), build) });
  } finally { reader.destroy(); }
}

describe('coloured Normal tiling cell compilation', () => {
  it('compiles artwork outside page commands and never adds cell text or outlined-word heuristics', async () => {
    await payload({ cellContent: '0 0 1 rg ' + '0 0 3 1 re f '.repeat(60) }, value => {
      const pattern = patternOf(value); expect(pattern.type).toBe(1); expect(pattern.commands.filter(c => c.op === 'paint')).toHaveLength(60);
      expect(value.items).toEqual([]); expect(value.inspection.hasOutlinedText).toBe(false);
      expect(value.commands.filter(c => c.op === 'paint')).toHaveLength(1);
    });
  });
  it('does not decode an unused image cell or alter page image/OCR inspection', async () => {
    await payload({ kind: 'indexed', pageContent: '/Pattern cs /P scn' }, value => {
      expect(value.inspection.hasRasterImage).toBe(false); expect(value.items).toEqual([]); expect(patternOf(value)).toBeUndefined();
    });
    await payload({ kind: 'indexed', pageContent: '/Pattern cs /P scn 0 0 10 10 re W n f' }, value => {
      expect(value.inspection.hasRasterImage).toBe(false); expect(patternOf(value)).toBeUndefined();
    });
  });
  it('uses parent-initial colour for a stencil instead of the later paint colour', async () => {
    await payload({ pageContent: '0 1 0 rg /Pattern cs /P scn 0 0 10 10 re f', cellContent: 'BI /W 1 /H 1 /BPC 1 /IM true ID \x00 EI' }, value => {
      const cell = patternOf(value); expect(cell.commands[0]).toEqual({ op: 'color', fill: true, value: 'rgb(0,0,0)' });
      expect([...cell.commands.find(c => c.op === 'image').pixels]).toEqual([0, 0, 0, 255]); expect(value.inspection.hasRasterImage).toBe(true);
    });
  });
  it('captures the Form initial colour and basis before its later colour/cm changes', async () => {
    const form = stream('0 1 0 rg 1 0 0 1 3 4 cm /Pattern cs /P scn 0 0 10 10 re f', '/Subtype /Form /BBox [0 0 20 20] /Resources << /Pattern << /P 5 0 R >> >>');
    await payload({ pageResources: '/XObject << /F 8 0 R >>', extra: [form], pageContent: '1 0 0 rg q 1 0 0 1 8 9 cm /F Do Q', cellContent: '0 0 1 1 re f' }, value => {
      const cell = patternOf(value); expect(cell.commands[0].value).toBe('rgb(255,0,0)'); expect(cell.matrix).toEqual([8.2, 0, 0, 6.2, 17.125, 14.375]);
    });
  });
  it('resets cell transparency and applies the current outer constant only to the final paint', async () => {
    await payload({ alpha: .5, pageResources: '/ExtGState << /G 7 0 R >>', pageContent: '/G gs /Pattern cs /P scn 0 0 10 10 re f', cellContent: '0 0 1 1 re f' }, value => {
      const paint = value.commands.find(c => c.fillPattern), child = paint.fillPattern.commands.find(c => c.op === 'paint');
      expect(paint.fillAlpha).toBe(.5); expect(child.fillAlpha).toBe(1); expect(child.blend).toBe('source-over');
    });
  });
  it('preserves explicit Normal intrinsic cell alpha', async () => {
    await payload({ alpha: .5 }, value => expect(patternOf(value).commands.find(c => c.op === 'paint').fillAlpha).toBe(.5));
  });
  it.each([
    ['BT /F1 12 Tf (Hidden) Tj ET', 'BT'], ['0 0 1 1 re S', 'S'], ['/Pattern cs', 'Nested'], ['/X Do', 'Form'],
  ])('refuses unsupported cell artwork before side effects: %s', async (cellContent, message) => {
    await expect(payload({ cellContent, imageObject: stream('', '/Subtype /Form /BBox [0 0 1 1]') })).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining(message) });
  });
  it('refuses non-Normal blend and masks, including a mask set before the first image', async () => {
    await expect(payload({ blend: 'Multiply', cellContent: '/G gs 0 0 1 1 re f' })).rejects.toMatchObject({ code: 'pdf_unsupported' });
    await expect(payload({ gsFields: '/SMask << /S /Alpha /G 6 0 R >>', imageObject: stream('', '/Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency >>'), cellContent: '/G gs' })).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('admits nearest-sampled images only and refuses explicit interpolation before decoding', async () => {
    await expect(payload({ cellContent: 'BI /W 1 /H 1 /BPC 1 /IM true /I true ID \x00 EI' })).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('Interpolated') });
    await expect(payload({ kind: 'indexed', imageObject: stream(Uint8Array.of(0, 0, 0), '/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Interpolate 1') })).rejects.toMatchObject({ code: 'pdf_corrupt', message: expect.stringContaining('Interpolate') });
  });
  it.each([
    [{ paintType: 2 }, 'pdf_unsupported'], [{ tilingType: 2 }, 'pdf_unsupported'], [{ bbox: [0, 0, 2, 1] }, 'pdf_unsupported'],
    [{ bbox: [0, 0, 0, 1] }, 'pdf_corrupt'], [{ steps: [0, 1] }, 'pdf_corrupt'], [{ cellResources: 'null' }, 'pdf_corrupt'],
  ])('rejects unsupported/malformed cell metadata: %j', async (settings, code) => await expect(payload(settings)).rejects.toMatchObject({ code }));
  it('transfers each image once and rebuilds its bytes after page cleanup', async () => {
    await payload({ kind: 'indexed', pageContent: '/Pattern cs /P scn 0 0 10 10 re f 10 10 10 10 re f' }, async (value, core) => {
      const paints = value.commands.filter(c => c.fillPattern); expect(paints[0].fillPattern.commands).toBe(paints[1].fillPattern.commands);
      const image = patternOf(value).commands.find(c => c.op === 'image'), original = [...image.pixels], buffers = pdfPayloadBuffers(value);
      expect(buffers).toHaveLength(1); const clone = structuredClone(value, { transfer: buffers }); expect(image.pixels.byteLength).toBe(0);
      expect([...patternOf(clone).commands.find(c => c.op === 'image').pixels]).toEqual(original);
      core.cleanup(1); expect([...patternOf(await core.pagePayload(1)).commands.find(c => c.op === 'image').pixels]).toEqual(original);
    });
  });
});

describe('tiling context and retained artwork admission', () => {
  it('builds once per context and limits total admitted contexts independently of resource identities', async () => {
    const build = vi.fn(async () => []);
    await withReader(build, async ({ id, resources, read }) => {
      const first = {}, a = await read(id, resources, identity, first), b = await read(id, resources, identity, first);
      expect(a.commands).toBe(b.commands); expect(build).toHaveBeenCalledTimes(1);
      for (let i = 1; i < 256; i++) await read(id, resources, identity, {});
      expect(build).toHaveBeenCalledTimes(256); await expect(read(id, resources, identity, {})).rejects.toMatchObject({ code: 'pdf_limit' });
    });
  });
  it('keeps context-dependent artwork distinct while sharing metadata', async () => {
    await withReader(async (_, context) => [{ op: 'color', fill: true, value: context.colour }], async ({ id, resources, read }) => {
      const a = await read(id, resources, identity, { colour: 'red' }), b = await read(id, resources, identity, { colour: 'blue' });
      expect(a.commands[0].value).toBe('red'); expect(b.commands[0].value).toBe('blue'); expect(a.patternMatrix).toBe(b.patternMatrix);
    });
  });
  it('charges all retained command references even when the command object is shared', async () => {
    let calls = 0; const command = { op: 'paint', kind: 'f' };
    await withReader(async () => Array(++calls === 1 ? 16384 : 1).fill(command), async ({ id, resources, read }) => {
      await read(id, resources, identity, {}); await expect(read(id, resources, identity, {})).rejects.toMatchObject({ code: 'pdf_limit' });
    });
  });
  it('charges metadata and buffers to the shared32MiB ledger before retaining another context', async () => {
    let calls = 0;
    await withReader(async (_, __, program) => ++calls === 1 ? [{ op: 'image', pixels: new Uint8Array(32 * 1024 * 1024 - 138 - program.byteLength) }] : [{ op: 'save' }], async ({ id, resources, read }) => {
      await read(id, resources, identity, {}); await expect(read(id, resources, identity, {})).rejects.toMatchObject({ code: 'pdf_limit' });
    });
  });
  it('decodes one used source once across contexts without putting its program in payloads', async () => {
    const programs = [];
    await withReader(async (_, __, program) => { programs.push(program); return []; }, async ({ reader, id, resources, read }) => {
      const original = reader.bytes.bind(reader); let decoded = 0;
      vi.spyOn(reader, 'bytes').mockImplementation(value => { const node = typeof value === 'number' ? reader.node(value) : value; if (node.kind === 'stream' && node.id === reader.node(id).id) decoded++; return original(value); });
      await read(id, resources, identity); expect(decoded).toBe(0);
      const first = await read(id, resources, identity, {}), second = await read(id, resources, identity, {});
      expect(decoded).toBe(1); expect(programs[0]).toBe(programs[1]); expect(programs[0].length).toBeGreaterThan(0);
      expect(first).not.toHaveProperty('program'); expect(pdfPayloadBuffers({ commands: [{ fillPattern: first }, { fillPattern: second }] })).toEqual([]);
    });
  });
  it('bounds aggregate decoded compressed cell sources and repeated-context scan work including whitespace', async () => {
    const bytes = 8 * 1024 * 1024, compressed = deflateSync(new Uint8Array(bytes).fill(32));
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R >>', ...Array.from({ length: 5 }, (_, i) => stream(i === 4 ? deflateSync(Uint8Array.of(32)) : compressed, '/Filter /FlateDecode /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Resources << >>'))]);
    const reader = await NativePdfReader.create(data, options);
    try {
      const resolve = number => reader.checked(reader.api.pn_pdf_resolve(number, 0));
      const build = vi.fn(async () => []), read = createPdfPatternReader(reader, options.loadAsset, new Map(), build);
      for (let n = 4; n < 8; n++) await read(resolve(n), 0, identity, {});
      await expect(read(resolve(8), 0, identity, {})).rejects.toMatchObject({ code: 'pdf_limit' }); expect(build).toHaveBeenCalledTimes(4);
      const repeated = createPdfPatternReader(reader, options.loadAsset, new Map(), build);
      for (let n = 0; n < 4; n++) await repeated(resolve(4), 0, identity, {});
      await expect(repeated(resolve(4), 0, identity, {})).rejects.toMatchObject({ code: 'pdf_limit' }); expect(build).toHaveBeenCalledTimes(8);
    } finally { reader.destroy(); }
  });
});

describe('constant-spacing device raster and resource cleanup', () => {
  const descriptor = { type: 1, bbox: [0, 0, 1, 1], steps: [1, 1], commands: [] };
  it('keeps phase and uses a BBox-based periodic domain with symmetric signed rounding', () => {
    const plan = planPdfTilingRaster({ ...descriptor, bbox: [.2, -.3, 1.2, .7] }, [16.4, 0, 0, -12.4, 18.25, 133.25]);
    expect(plan.width).toBe(16); expect(plan.height).toBe(12); expect(plan.cellMatrix).toEqual([16, 0, 0, -12, -3.2, 8.399999999999999]);
    expect(plan.phase).toEqual([21.45, 124.85]);
    expect(planPdfTilingRaster(descriptor, [-15.5, 0, 0, 12, 0, 0]).cellMatrix[0]).toBe(-16);
  });
  it('admits exactly one pixel displacement and rejects the adjacent value, oblique and zero periods', () => {
    expect(planPdfTilingRaster({ ...descriptor, bbox: [1, 0, 2, 1] }, [15.5, 0, 0, 12, 0, 0]).displacement).toBe(1);
    // A binary-exact offset keeps the cell width exactly one; decimal 1.0001
    // can accidentally exercise the independent overlap guard instead.
    expect(() => planPdfTilingRaster({ ...descriptor, bbox: [1 + 2 ** -20, 0, 2 + 2 ** -20, 1] }, [15.5, 0, 0, 12, 0, 0])).toThrow(/one pixel/);
    expect(() => planPdfTilingRaster(descriptor, [.4, 0, 0, 12, 0, 0])).toThrow(/periods/);
    expect(() => planPdfTilingRaster(descriptor, [16, 1, 0, 12, 0, 0])).toThrow(/Oblique/);
  });
  const ctx = { canvas: { width: 10, height: 10 }, getTransform: () => ({ a: 16, b: 0, c: 0, d: 12, e: 0, f: 0 }) };
  it.each([{ pixels: 16_000_000 - 383 }, { pixels: 0, tilingExecutions: 4096 }, { pixels: 0, tilingCommands: 500000 }, { pixels: 0, tilingPixels: 64_000_000 }])('reserves both cell/snapshot pixels and bounds render work before allocating: %j', async budget => {
    const allocation = vi.fn(); vi.stubGlobal('OffscreenCanvas', allocation);
    try { await expect(renderPdfTilingPattern({ ...descriptor, commands: [{ op: 'save' }] }, ctx, { surfaceBudget: budget, renderCell: async () => {} })).rejects.toMatchObject({ code: 'pdf_limit' }); }
    finally { vi.unstubAllGlobals(); }
    expect(allocation).not.toHaveBeenCalled();
  });
  it('releases the cell and reservation if the callback fails or is cancelled', async () => {
    const surfaces = [], budget = { pixels: 12 }, error = new Error('cancelled cell');
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); } getContext() { return { setTransform() {}, beginPath() {}, rect() {}, clip() {} }; } });
    try { await expect(renderPdfTilingPattern(descriptor, ctx, { surfaceBudget: budget, renderCell: async () => { throw error; } })).rejects.toBe(error); }
    finally { vi.unstubAllGlobals(); }
    expect(budget.pixels).toBe(12); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
});
