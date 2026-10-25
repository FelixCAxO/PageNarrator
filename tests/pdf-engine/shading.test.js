import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfFunction, compilePdfFunction } from '../../src/pdf/pdf-functions.js';
import { readPdfShading, renderPdfShading } from '../../src/pdf/shading.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());
async function functionOf(value, extras = []) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [value, ...extras] }), options);
  try { return await readPdfFunction(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0))); } finally { reader.destroy(); }
}
const exponential = (extra = '') => `<< /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 0 0] /N 1 ${extra} >>`;
const axialPdf = (extra = '') => simplePdf('/S sh', { page: '/Resources << /Shading << /S 6 0 R >> >>', extra: [`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [1 0 3 0] /Extend [false true] /Function 7 0 R ${extra} >>`, exponential()] });

describe('original bounded PDF functions', () => {
  it.each([1, 2, 4, 8, 12, 16, 24, 32])('decodes %i-bit sampled endpoints with the normative packed sample order', async bits => {
    const values = [0, 2 ** bits - 1], binary = values.map(n => n.toString(2).padStart(bits, '0')).join(''), data = Uint8Array.from({ length: Math.ceil(binary.length / 8) }, (_, i) => parseInt(binary.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2));
    const descriptor = await functionOf(stream(data, `/FunctionType 0 /Domain [0 1] /Range [-1 1] /Size [2] /BitsPerSample ${bits}`)), fn = compilePdfFunction(descriptor);
    expect(fn([-10])).toEqual([-1]); expect(fn([.25])[0]).toBeCloseTo(-.5, 12); expect(fn([1])).toEqual([1]); expect(fn([10])).toEqual([1]);
  });
  it('multilinearly interpolates two dimensions with the first input varying fastest', async () => {
    const fn = compilePdfFunction(await functionOf(stream(Uint8Array.of(0, 64, 128, 255), '/FunctionType 0 /Domain [0 1 0 1] /Range [0 1] /Size [2 2] /BitsPerSample 8')));
    expect(fn([.25, .5])[0]).toBeCloseTo(87.875 / 255, 12); expect(fn([1, 0])[0]).toBeCloseTo(64 / 255, 12); expect(fn([0, 1])[0]).toBeCloseTo(128 / 255, 12);
  });
  it('applies reversed Encode, Decode, output Range and independent C0/C1 channels', async () => {
    const sampled = compilePdfFunction(await functionOf(stream(Uint8Array.of(0, 255), '/FunctionType 0 /Domain [0 1] /Range [-1 1] /Size [2] /BitsPerSample 8 /Encode [1 0] /Decode [-1 1]')));
    expect(sampled([.25])).toEqual([.5]);
    const fn = compilePdfFunction(await functionOf('<< /FunctionType 2 /Domain [-1 1] /Range [0 1 0 15] /C0 [0 10] /C1 [1 20] /N 2 >>'));
    expect(fn([-.5])).toEqual([.25, 12.5]); expect(fn([2])).toEqual([1, 15]);
    expect(() => fn([NaN])).toThrow(/inputs/);
  });
  it('stitches intervals with right-side boundary selection and reversed child encoding', async () => {
    const fn = compilePdfFunction(await functionOf('<< /FunctionType 3 /Domain [0 2] /Functions [7 0 R 8 0 R] /Bounds [.5] /Encode [0 1 1 0] >>', ['<< /FunctionType 2 /Domain [0 1] /N 1 >>', '<< /FunctionType 2 /Domain [0 1] /N 2 >>']));
    expect(fn([.25])).toEqual([.5]); expect(fn([.5])).toEqual([1]); expect(fn([1.25])).toEqual([.25]); expect(fn([2])).toEqual([0]);
  });
  it.each([
    [stream(Uint8Array.of(0), '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8'), 'pdf_corrupt'],
    [stream('', '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [4000001] /BitsPerSample 8'), 'pdf_limit'],
    [stream('', '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8 /Order 3'), 'pdf_unsupported'],
    ['<< /FunctionType 3 /Domain [0 1] /Functions [6 0 R] /Bounds [] /Encode [0 1] >>', 'pdf_corrupt'],
    ['<< /FunctionType 2 /Domain [0 1] /Range [0 1] /C0 [0 1] /C1 [1 0] /N 1 >>', 'pdf_corrupt'],
    [stream('{exec}', '/FunctionType 4 /Domain [0 1] /Range [0 1]'), 'pdf_corrupt'],
  ])('rejects malformed or unsupported function without partial output (%s)', async (data, code) => {
    await expect(functionOf(data)).rejects.toMatchObject({ code });
  });
});

describe('original axial PDF shading', () => {
  it('preserves sh as an independent paint and ignores Background as required for direct sh', async () => {
    const core = await createPdfDocumentCore(axialPdf('/Background [0 1 0] /BBox [0 0 4 1]'), options);
    try {
      const payload = await core.pagePayload(1), command = payload.commands.find(c => c.op === 'shading');
      expect(command).toMatchObject({ type: 2, coords: [1, 0, 3, 0], domain: [0, 1], extend: [false, true], box: [0, 0, 4, 1], alpha: 1, blend: 'source-over' });
      expect(payload.inspection.hasRenderableNonText).toBe(true); expect(payload.items).toEqual([]);
    } finally { core.destroy(); }
  });
  it('executes exact device-center values and Extend through a nonuniform inverse CTM', async () => {
    const reader = await NativePdfReader.create(axialPdf('/BBox [0 0 4 1]'), options); let command;
    try { command = await readPdfShading(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)), 0, options.loadAsset); } finally { reader.destroy(); }
    const written = [], surfaces = [], paths = [], states = [];
    vi.stubGlobal('ImageData', class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } });
    vi.stubGlobal('Path2D', class { rect(...args) { paths.push(args); } });
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { Object.assign(this, { width, height }); surfaces.push(this); } getContext() { return { putImageData: image => written.push([...image.data]) }; } });
    const ctx = { canvas: { width: 4, height: 1 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), save() { states.push(1); }, restore() { states.pop(); }, setTransform() {}, clip() {}, drawImage() {} };
    await renderPdfShading(command, ctx);
    expect(written[0]).toEqual([0, 0, 0, 0, 64, 0, 191, 255, 191, 0, 64, 255, 255, 0, 0, 255]);
    expect(paths).toEqual([[0, 0, 4, 1]]); expect(states).toHaveLength(0); expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    command.coords = [0, 0, 2, 0]; ctx.getTransform = () => ({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 }); await renderPdfShading(command, ctx);
    expect(written[1]).toEqual([32, 0, 223, 255, 96, 0, 159, 255, 159, 0, 96, 255, 223, 0, 32, 255]);
  });
  it('transfers original nested function sample data with the payload', async () => {
    const samples = Uint8Array.of(0, 255), descriptor = await functionOf(stream(samples, '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8'));
    const payload = { fonts: [], commands: [{ op: 'shading', functions: [{ type: 3, functions: [descriptor] }] }] }, buffers = pdfPayloadBuffers(payload);
    expect(buffers).toEqual([descriptor.samples.buffer]); const clone = structuredClone(payload, { transfer: buffers });
    expect(descriptor.samples.byteLength).toBe(0); expect([...clone.commands[0].functions[0].functions[0].samples]).toEqual([0, 255]);
  });
  it('enforces cumulative shading work before allocation', async () => {
    const ctx = { canvas: { width: 8000, height: 8001 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
    const fn = await functionOf(exponential()), command = { type: 2, colorSpace: { name: 'DeviceRGB' }, functions: [fn], coords: [0, 0, 1, 0], domain: [0, 1], extend: [true, true], box: null };
    await expect(renderPdfShading(command, ctx)).rejects.toMatchObject({ code: 'pdf_limit' });
  });
});
