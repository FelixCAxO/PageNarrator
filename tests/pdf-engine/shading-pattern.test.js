import { describe, expect, it, vi } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfPatternReader, resolvePdfPaintSpace, paintPdfShadingPattern } from '../../src/pdf/shading-pattern.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { axialPatternPdf } from './shading-pattern-fixture.js';
import { options, pdf, stream } from './fixtures.js';

async function withPattern(data, run) {
  const reader = await NativePdfReader.create(data, options);
  try {
    const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources');
    const id = reader.field(reader.field(resources, 'Pattern'), 'P');
    await run({ reader, id, resources, read: createPdfPatternReader(reader, options.loadAsset, new Map()) });
  } finally { reader.destroy(); }
}
const identity = [1, 0, 0, 1, 0, 0];
const payload = async (content, settings) => { const core = await createPdfDocumentCore(axialPatternPdf(content, settings), options); try { return await core.pagePayload(1); } finally { core.destroy(); } };

describe('bounded geometric axial shading patterns', () => {
  it('binds the parent initial basis while reusing immutable parsed shading', async () => {
    await withPattern(axialPatternPdf(''), async ({ id, resources, read }) => {
      const first = await read(id, resources, identity), second = await read(id, resources, [1, 0, 0, 1, 12, 20]);
      expect(first.matrix).toEqual([64, 0, 0, 64, 16, 4]); expect(second.matrix).toEqual([64, 0, 0, 64, 28, 24]);
      expect(first.functions).toBe(second.functions); expect(first.matrix).not.toBe(second.matrix);
    });
  });
  it('admits Pattern only through paint-colour aliases', async () => {
    await withPattern(axialPatternPdf(''), async ({ reader, resources }) => {
      const alias = reader.field(reader.field(resources, 'ColorSpace'), 'Paint');
      expect(await resolvePdfPaintSpace(reader, resources, alias, options.loadAsset)).toEqual({ name: 'Pattern', components: 0 });
      await expect(resolvePdfColorSpace(reader, resources, alias, options.loadAsset)).rejects.toMatchObject({ code: 'pdf_unsupported' });
    });
  });
  it('admits the parameterless array family through a paint alias while general spaces still reject it', async () => {
    const data = axialPatternPdf('/Paint cs /P scn 1 1 20 20 re f', { paintSpace: '[/Pattern]' });
    await withPattern(data, async ({ reader, resources }) => {
      const alias = reader.field(reader.field(resources, 'ColorSpace'), 'Paint');
      expect(await resolvePdfPaintSpace(reader, resources, alias, options.loadAsset)).toEqual({ name: 'Pattern', components: 0 });
      await expect(resolvePdfColorSpace(reader, resources, alias, options.loadAsset)).rejects.toMatchObject({ code: 'pdf_unsupported' });
    });
    const core = await createPdfDocumentCore(data, options);
    try { expect((await core.pagePayload(1)).commands.find(command => command.fillPattern).fillPattern.matrix).toEqual([64, 0, 0, 64, 16, 4]); } finally { core.destroy(); }
  });
  it.each(['[/Pattern /DeviceRGB]', '[/Pattern /DeviceRGB /Extra]'])('keeps parameterized Pattern families unsupported: %s', async paintSpace => {
    await expect(payload('/Paint cs /P scn 1 1 20 20 re f', { paintSpace })).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it.each([
    [{ pattern: '/PatternType 1' }, 'pdf_corrupt'],
    [{ matrix: [1, 0, 0, 0, 0, 0] }, 'pdf_unsupported'],
    [{ matrix: [1, 0, 0] }, 'pdf_corrupt'],
    [{ pattern: '/ExtGState << /ca .5 >>' }, 'pdf_unsupported'],
    [{ pattern: '/ExtGState 7' }, 'pdf_corrupt'],
    [{ shading: '/Background [1 0 0]' }, 'pdf_unsupported'],
    [{ shading: '/ShadingType 3' }, 'pdf_unsupported'],
  ])('refuses unsupported/malformed declarations without stale colour: %j', async (settings, code) => {
    await withPattern(axialPatternPdf('', settings), async ({ id, resources, read }) => await expect(read(id, resources, identity)).rejects.toMatchObject({ code }));
  });
  it('admits null optionals and an empty ExtGState', async () => {
    await withPattern(axialPatternPdf('', { pattern: '/Matrix null /Type null /ExtGState << >>', shading: '/Background null' }), async ({ id, resources, read }) => expect((await read(id, resources, identity)).matrix).toEqual(identity));
  });

  it('serializes only painted pattern state, resets it with a solid colour and respects q/Q', async () => {
    const result = await payload('/Pattern cs /P scn q 1 0 0 rg 1 1 2 2 re f Q 3 3 4 4 re f');
    const paints = result.commands.filter(command => command.op === 'paint');
    expect(paints[0].fillPattern).toBeFalsy(); expect(paints[1].fillPattern.matrix).toEqual([64, 0, 0, 64, 16, 4]);
  });
  it('keeps cm before and after selection out of the pattern basis', async () => {
    for (const content of ['1 0 .2 1 3 4 cm /Pattern cs /P scn 1 1 20 20 re f', '/Pattern cs /P scn 1 0 .2 1 3 4 cm 1 1 20 20 re f']) {
      const result = await payload(content); expect(result.commands.find(command => command.fillPattern).fillPattern.matrix).toEqual([64, 0, 0, 64, 16, 4]);
    }
  });
  it('binds local and inherited Form patterns at each entry instead of retaining an outer context', async () => {
    for (const local of [true, false]) {
      const result = await payload(`${local ? '' : '/Pattern cs /P scn '}q 1 0 0 1 8 8 cm /F Do Q q 1 0 0 1 52 38 cm /F Do Q`, { form: `${local ? '/Pattern cs /P scn ' : ''}0 0 32 20 re f` });
      const patterns = result.commands.filter(command => command.fillPattern).map(command => command.fillPattern);
      expect(patterns.map(pattern => pattern.matrix)).toEqual([[64, 0, 0, 64, 24, 12], [64, 0, 0, 64, 68, 42]]);
      expect(patterns[0].patternMatrix).toEqual([64, 0, 0, 64, 16, 4]);
      expect(patterns[0].functions).toBe(patterns[1].functions);
    }
  });
  it('freezes an inherited Form pattern before later cm changes and preserves the caller state', async () => {
    const result = await payload('/Pattern cs /P scn /Pattern CS /P SCN q 1 0 0 1 8 8 cm /F Do Q 2 2 4 4 re B', {
      form: '1 0 .3 1 4 6 cm 0 0 20 10 re B',
    });
    const paints = result.commands.filter(command => command.fillPattern);
    expect(paints).toHaveLength(2);
    expect(paints[0].fillPattern.matrix).toEqual([64, 0, 0, 64, 24, 12]);
    expect(paints[0].strokePattern.matrix).toEqual(paints[0].fillPattern.matrix);
    expect(paints[1].fillPattern.matrix).toEqual([64, 0, 0, 64, 16, 4]);
    expect(paints[1].strokePattern.matrix).toEqual(paints[1].fillPattern.matrix);
  });
  it.each(['/Pattern cs 1 1 20 20 re f', '/Pattern cs /P sc', '/Pattern cs /P scn BT /F1 12 Tf (A) Tj ET'])('refuses missing selection or unsupported painted use: %s', async content => {
    await expect(payload(content)).rejects.toBeInstanceOf(Error);
  });
  it('refuses a stencil image using the selected pattern instead of its stale solid colour', async () => {
    await expect(payload('/Pattern cs /P scn q 10 0 0 10 10 10 cm BI /W 1 /H 1 /BPC 1 /IM true ID \x80 EI Q')).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('stencil') });
  });
  it('refuses painted Type3 text before its CharProc can use a stale solid colour', async () => {
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 96 72] >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> /Font << /F1 8 0 R >> >> >>',
      stream('/Pattern cs /P scn BT /F1 12 Tf (A) Tj ET'), '<< /PatternType 2 /Shading 6 0 R >>',
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function 7 0 R >>',
      '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>',
      '<< /Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /A 9 0 R >> >>',
      stream('600 0 0 0 600 700 d1 0 0 600 700 re f')]);
    const core = await createPdfDocumentCore(data, options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('text') }); } finally { core.destroy(); }
  });
  it('rebuilds owned sampled pattern data after worker transfer and page cleanup', async () => {
    const data = axialPatternPdf('/Pattern cs /P scn 0 0 10 10 re f', { functionBody: stream(Uint8Array.of(255, 0, 0, 0, 0, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8') });
    const core = await createPdfDocumentCore(data, options);
    try {
      const first = await core.pagePayload(1), samples = first.commands.find(command => command.fillPattern).fillPattern.functions[0].samples;
      const original = [...samples], clone = structuredClone(first, { transfer: pdfPayloadBuffers(first) });
      expect(samples.byteLength).toBe(0);
      expect([...clone.commands.find(command => command.fillPattern).fillPattern.functions[0].samples]).toEqual(original);
      core.cleanup(1); const rebuilt = await core.pagePayload(1);
      expect([...rebuilt.commands.find(command => command.fillPattern).fillPattern.functions[0].samples]).toEqual(original);
    } finally { core.destroy(); }
  });
  it('deduplicates pattern buffers across paints and nested groups and traverses cyclic aliases safely', () => {
    const samples = Uint8Array.of(1, 2), profileBytes = Uint8Array.of(3, 4), fn = { samples, functions: [] }; fn.functions.push(fn);
    const pattern = { functions: [fn], colorSpace: { profileBytes } }, command = { op: 'paint', fillPattern: pattern, strokePattern: pattern };
    expect(new Set(pdfPayloadBuffers({ commands: [command, { commands: [command] }] }))).toEqual(new Set([samples.buffer, profileBytes.buffer]));
  });
});

function resourceFixture(count) {
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Resources << /Pattern << ${Array.from({ length: count }, (_, i) => `/P${i} ${i + 6} 0 R`).join(' ')} >> >> >>`,
    '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function 5 0 R >>', '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>',
    ...Array.from({ length: count }, () => '<< /PatternType 2 /Shading 4 0 R >>')]);
}
describe('page-build pattern resource admission', () => {
  it('admits256 distinct pattern identities and rejects the next', async () => {
    const reader = await NativePdfReader.create(resourceFixture(257), options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), dictionary = reader.field(resources, 'Pattern'), read = createPdfPatternReader(reader, options.loadAsset);
      for (let i = 0; i < 256; i++) await read(reader.field(dictionary, 'P' + i), resources, identity);
      await expect(read(reader.field(dictionary, 'P256'), resources, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    } finally { reader.destroy(); }
  });
  it('bounds aggregate distinct function descriptors across admitted patterns', async () => {
    const count = 228, children = 17, firstPattern = 6 + children;
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /Resources << /Pattern << ${Array.from({ length: count }, (_, i) => `/P${i} ${i + firstPattern} 0 R`).join(' ')} >> >> >>`,
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function 5 0 R >>',
      `<< /FunctionType 3 /Domain [0 1] /Functions [${Array.from({ length: children }, (_, i) => `${6 + i} 0 R`).join(' ')}] /Bounds [${Array.from({ length: children - 1 }, (_, i) => (i + 1) / children).join(' ')}] /Encode [${'0 1 '.repeat(children)}] >>`,
      ...Array.from({ length: children }, () => '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>'),
      ...Array.from({ length: count }, () => '<< /PatternType 2 /Shading 4 0 R >>')]);
    const reader = await NativePdfReader.create(data, options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), dictionary = reader.field(resources, 'Pattern'), read = createPdfPatternReader(reader, options.loadAsset);
      for (let i = 0; i < 227; i++) await read(reader.field(dictionary, 'P' + i), resources, identity); // 227*18=4086 unique retained nodes.
      await expect(read(reader.field(dictionary, 'P227'), resources, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    } finally { reader.destroy(); }
  });
  it('admits exactly32MiB of sampled buffers and rejects further retention', async () => {
    const lengths = [...Array(8).fill(4_000_000), 32 * 1024 * 1024 - 32_000_000, 1];
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /Resources << /Pattern << ${lengths.map((_, i) => `/P${i} ${i * 3 + 5} 0 R`).join(' ')} >> >> >>`, 'null',
      ...lengths.flatMap((length, i) => [`<< /PatternType 2 /Shading ${i * 3 + 6} 0 R >>`,
        `<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Function ${i * 3 + 7} 0 R >>`,
        stream(new Uint8Array(length), `/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [${length}] /BitsPerSample 8`)])]);
    const reader = await NativePdfReader.create(data, options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), dictionary = reader.field(resources, 'Pattern'), read = createPdfPatternReader(reader, options.loadAsset);
      for (let i = 0; i < 9; i++) await read(reader.field(dictionary, 'P' + i), resources, identity);
      await expect(read(reader.field(dictionary, 'P9'), resources, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    } finally { reader.destroy(); }
  });
  it('bounds retained high-fanout references even when each graph has only two unique nodes', async () => {
    const count = 64;
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /Resources << /Pattern << ${Array.from({ length: count }, (_, i) => `/P${i} ${i + 7} 0 R`).join(' ')} >> >> >>`,
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function 5 0 R >>',
      `<< /FunctionType 3 /Domain [0 1] /Functions [${'6 0 R '.repeat(256)}] /Bounds [${Array.from({ length: 255 }, (_, i) => (i + 1) / 256).join(' ')}] /Encode [${'0 1 '.repeat(256)}] >>`,
      '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>',
      ...Array.from({ length: count }, () => '<< /PatternType 2 /Shading 4 0 R >>')]);
    const reader = await NativePdfReader.create(data, options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), dictionary = reader.field(resources, 'Pattern'), read = createPdfPatternReader(reader, options.loadAsset);
      for (let i = 0; i < 63; i++) await read(reader.field(dictionary, 'P' + i), resources, identity); // 63*257=16191 references,126 distinct nodes.
      await expect(read(reader.field(dictionary, 'P63'), resources, identity)).rejects.toMatchObject({ code: 'pdf_limit' });
    } finally { reader.destroy(); }
  });
});

describe('pattern temporary surface admission and cleanup', () => {
  it('charges both immutable snapshot and source before allocation, including outer surfaces', async () => {
    const ctx = { canvas: { width: 2000, height: 2000 } }, budget = { pixels: 8_000_001 };
    await expect(paintPdfShadingPattern({}, ctx, () => {}, { surfaceBudget: budget })).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(budget.pixels).toBe(8_000_001);
  });
  it('returns empty clipped bounds before any allocation', async () => {
    const budget = { pixels: 0 }, paint = vi.fn();
    await paintPdfShadingPattern({}, { canvas: { width: 10, height: 10 } }, paint, { clipBounds: [20, 20, 30, 30], surfaceBudget: budget });
    expect(paint).not.toHaveBeenCalled(); expect(budget.pixels).toBe(0);
  });
  it('releases reserved pixels and clears the surface if allocation fails', async () => {
    const surfaces = [], budget = { pixels: 12 };
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); } getContext() { return null; } });
    try { await expect(paintPdfShadingPattern({}, { canvas: { width: 10, height: 10 } }, () => {}, { surfaceBudget: budget })).rejects.toMatchObject({ code: 'pdf_render' }); }
    finally { vi.unstubAllGlobals(); }
    expect(budget.pixels).toBe(12); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
  it('honours cancellation before allocation or painting', async () => {
    const budget = { pixels: 0 }, error = new Error('cancelled');
    await expect(paintPdfShadingPattern({}, { canvas: { width: 10, height: 10 } }, () => {}, { surfaceBudget: budget, cancellation() { throw error; } })).rejects.toBe(error);
    expect(budget.pixels).toBe(0);
  });
});
