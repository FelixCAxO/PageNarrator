import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { compilePdfFunction, readPdfFunction } from '../../src/pdf/pdf-functions.js';
import { options, simplePdf } from './fixtures.js';

async function stitching({ domain = '[0 1]', bounds = '[0]', encode = '[.75 1 .25 1]', count = 2 } = {}) {
  const children = Array.from({ length: count }, (_, i) => `${i + 7} 0 R`).join(' ');
  const pdf = simplePdf('', { extra: [
    `<< /FunctionType 3 /Domain ${domain} /Functions [${children}] /Bounds ${bounds} /Encode ${encode} >>`,
    ...Array.from({ length: count }, () => '<< /FunctionType 2 /Domain [0 1] /N 1 >>'),
  ] });
  const reader = await NativePdfReader.create(pdf, options);
  try { return compilePdfFunction(await readPdfFunction(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))); }
  finally { reader.destroy(); }
}

describe('PDF stitching function endpoint intervals', () => {
  it('retains a first singleton endpoint and uses its first Encode value', async () => {
    const run = await stitching();
    expect(run([-1])[0]).toBeCloseTo(.75, 12);
    expect(run([0])[0]).toBeCloseTo(.75, 12);
    expect(run([Number.MIN_VALUE])).toEqual([.25]);
    expect(run([.5])).toEqual([.625]);
    expect(run([1])).toEqual([1]);
  });
  it('retains a last singleton endpoint and uses its first Encode value', async () => {
    const run = await stitching({ bounds: '[1]', encode: '[0 1 .25 .75]' });
    expect(run([0])).toEqual([0]);
    expect(run([.5])).toEqual([.5]);
    expect(run([1 - Number.EPSILON])).toEqual([1 - Number.EPSILON]);
    expect(run([1])).toEqual([.25]);
    expect(run([2])).toEqual([.25]);
  });
  it('preserves interior right-side selection between singleton endpoints', async () => {
    const run = await stitching({ bounds: '[0 .5 1]', encode: '[.125 .875 0 1 1 0 .75 .25]', count: 4 });
    expect(run([0])[0]).toBeCloseTo(.125, 12);
    expect(run([.25])).toEqual([.5]);
    expect(run([.5])).toEqual([1]);
    expect(run([.75])).toEqual([.5]);
    expect(run([1])[0]).toBeCloseTo(.75, 12);
  });
  it('allows a singleton entire domain only with one child', async () => {
    const run = await stitching({ domain: '[2 2]', bounds: '[]', encode: '[.375 .625]', count: 1 });
    expect(run([0])[0]).toBeCloseTo(.375, 12);
    expect(run([2])[0]).toBeCloseTo(.375, 12);
    expect(run([3])[0]).toBeCloseTo(.375, 12);
    await expect(stitching({ domain: '[2 2]', bounds: '[2]' })).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it.each(['[-.001]', '[1.001]', '[NaN]', '[.5 .5]', '[.75 .25]'])('rejects invalid boundary array %s', async bounds => {
    const count = bounds.includes(' ') ? 3 : 2;
    await expect(stitching({ bounds, count, encode: count === 3 ? '[0 1 0 1 0 1]' : '[0 1 0 1]' })).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
});
