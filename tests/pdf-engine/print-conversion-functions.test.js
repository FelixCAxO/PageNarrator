import { describe, expect, it } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { options, simplePdf, stream } from './fixtures.js';

const paint = '.25 .5 .75 rg 0 0 20 20 re f 0 .4 .8 .2 k 20 0 20 20 re f';
const sampled = stream(Uint8Array.of(0, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1] /BitsPerSample 8 /Size [2]');
const exponential = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>';
const stitching = '<< /FunctionType 3 /Domain [0 1] /Functions [8 0 R] /Bounds [] /Encode [1 0] >>';
const calculator = stream('{dup mul}', '/FunctionType 4 /Domain [0 1] /Range [0 1]');
async function payload(state, functions = []) {
  const core = await createPdfDocumentCore(simplePdf(`/G gs ${paint}`, {
    page: '/Resources << /ExtGState << /G 6 0 R >> >>', extra: [`<< ${state} >>`, ...functions],
  }), options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}

describe('print conversion parameters in the composite RGB PDF preview', () => {
  it.each(['BG', 'BG2', 'UCR', 'UCR2'].flatMap(key => [sampled, exponential, stitching, calculator].map(fn => [key, fn])))('validates %s functions while preserving RGB and CMYK-to-RGB paint', async (key, fn) => {
    const expected = await payload('');
    const actual = await payload(`/${key} 7 0 R`, [fn, exponential]);
    expect(actual.commands).toEqual(expected.commands); expect(actual.items).toEqual(expected.items);
  });
  it('accepts signed undercolor-removal output and validates a shared function once', async () => {
    const fn = stream(Uint8Array.of(0, 255), '/FunctionType 0 /Domain [0 1] /Range [-1 1] /BitsPerSample 8 /Size [2]');
    expect((await payload('/BG 7 0 R /UCR 7 0 R', [fn])).commands).toEqual((await payload('')).commands);
  });
  it.each([['BG', 'BG2'], ['UCR', 'UCR2']])('honors %s replacement by %s Default and null-as-absent', async (old, current) => {
    const expected = (await payload('')).commands;
    expect((await payload(`/${old} /Unused /${current} /Default`)).commands).toEqual(expected);
    expect((await payload(`/${old} 7 0 R /${current} null`, [exponential])).commands).toEqual(expected);
    expect((await payload(`/${old} null /${current} null`)).commands).toEqual(expected);
    await expect(payload(`/${old} 7 0 R /${current} 8 0 R`, [exponential, '<< /FunctionType 2 /Domain [0 1] /C0 [0 0] /C1 [1 1] /N 1 >>'])).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it.each([
    '<< /FunctionType 2 /Domain [0 1 0 1] /N 1 >>',
    '<< /FunctionType 2 /Domain [0 1] /C0 [0 0] /C1 [1 1] /N 1 >>',
    stream('{exec}', '/FunctionType 4 /Domain [0 1] /Range [0 1]'),
    stream(Uint8Array.of(0), '/FunctionType 0 /Domain [0 1] /Range [0 1] /BitsPerSample 8 /Size [2]'),
    'true',
  ])('rejects malformed print conversion functions (%s)', async fn => {
    await expect(payload('/BG 7 0 R', [fn])).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it('retains rejection of other unsupported output operations', async () => {
    await expect(payload('/BG 7 0 R /TR 7 0 R', [exponential])).rejects.toMatchObject({ code: 'pdf_unsupported' });
    const core = await createPdfDocumentCore(simplePdf('/G gs /F Do', {
      page: '/Resources << /ExtGState << /G 6 0 R >> /XObject << /F 8 0 R >> >>',
      extra: ['<< /BG 7 0 R /BM /Multiply >>', exponential, stream(paint, '/Type /XObject /Subtype /Form /BBox [0 0 40 20] /Group << /S /Transparency /CS /DeviceCMYK /I true >>')],
    }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported' }); } finally { core.destroy(); }
  });
  it('bounds distinct print functions while allowing repeated validated resources', async () => {
    const count = 257, states = Array.from({ length: count }, (_, i) => `/G${i} ${6 + i * 2} 0 R`).join(' ');
    const extra = Array.from({ length: count }, (_, i) => [`<< /BG ${7 + i * 2} 0 R >>`, exponential]).flat();
    const core = await createPdfDocumentCore(simplePdf(Array.from({ length: count }, (_, i) => `/G${i} gs`).join(' '), {
      page: `/Resources << /ExtGState << ${states} >> >>`, extra,
    }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_limit', message: expect.stringContaining('print function count') }); }
    finally { core.destroy(); }
    const repeated = await createPdfDocumentCore(simplePdf(`${'/G gs '.repeat(300)}${paint}`, {
      page: '/Resources << /ExtGState << /G 6 0 R >> >>', extra: ['<< /BG 7 0 R >>', exponential],
    }), options);
    try { expect((await repeated.pagePayload(1)).commands).toEqual((await payload('')).commands); }
    finally { repeated.destroy(); }
  });
});
