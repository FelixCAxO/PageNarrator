import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { readPdfShading, renderPdfShading } from '../../src/pdf/shading.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { simplePdf, options } from './fixtures.js';

const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 0 0] /N 1 >>';
const pdf = (coords, extra = '') => simplePdf('/R sh', { page: '/Resources << /Shading << /R 6 0 R >> >>',
  extra: [`<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${coords.join(' ')}] /Function ${fn} ${extra} >>`] });
afterEach(() => vi.unstubAllGlobals());
async function commandOf(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return (await core.pagePayload(1)).commands.find(command => command.op === 'shading'); }
  finally { core.destroy(); }
}
async function pixel(command, x, y, matrix = [1, 0, 0, 1]) {
  const written = [], surfaces = [], [a, b, c, d] = matrix;
  vi.stubGlobal('ImageData', class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width, height) { Object.assign(this, { width, height }); surfaces.push(this); }
    getContext() { return { putImageData: image => written.push([...image.data]) }; }
  });
  const ctx = { canvas: { width: 1, height: 1 }, getTransform: () => ({ a, b, c, d, e: .5 - a * x - c * y, f: .5 - b * x - d * y }),
    save() {}, restore() {}, setTransform() {}, drawImage() {} };
  await renderPdfShading(command, ctx);
  expect(surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  return written[0] || [0, 0, 0, 0];
}

describe('original radial PDF shading', () => {
  it('admits all six coordinates and retains the direct-paint contract', async () => {
    const command = await commandOf(pdf([0, 0, 1, 0, 0, 3], '/Extend [true false] /Background [0 1 0]'));
    expect(command).toMatchObject({ type: 3, coords: [0, 0, 1, 0, 0, 3], extend: [true, false], domain: [0, 1], alpha: 1, blend: 'source-over' });
    expect(command).not.toHaveProperty('background');
  });
  it.each([
    [[0, 0, -1, 0, 0, 3]], [[0, 0, 1, 0, 0, -3]], [[0, 0, 1, 0]],
  ])('rejects negative radii or incomplete coordinate arrays (%s)', async coords => {
    await expect(commandOf(pdf(coords))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });
  it.each([
    ['quarter expanding ring', [0, 0, 1, 0, 0, 3], [1.5, 0], [false, false], [64, 0, 191, 255]],
    ['unextended hole', [0, 0, 1, 0, 0, 3], [.5, 0], [false, false], [0, 0, 0, 0]],
    ['start extension stops at zero radius', [0, 0, 1, 0, 0, 3], [.5, 0], [true, false], [0, 0, 255, 255]],
    ['no end extension', [0, 0, 1, 0, 0, 3], [4, 0], [false, false], [0, 0, 0, 0]],
    ['end extension', [0, 0, 1, 0, 0, 3], [4, 0], [false, true], [255, 0, 0, 255]],
    ['shrinking radii reject the negative-radius root', [0, 0, 4, 0, 0, 1], [2, 0], [false, false], [170, 0, 85, 255]],
    ['overlapping circles choose the later root', [0, 0, 2, 4, 0, 2], [2, 0], [false, false], [255, 0, 0, 255]],
    ['later disallowed root leaves an earlier valid one', [0, 0, 2, 4, 0, 2], [3, 0], [false, false], [64, 0, 191, 255]],
    ['extended later root covers the earlier one', [0, 0, 2, 4, 0, 2], [3, 0], [false, true], [255, 0, 0, 255]],
    ['point outside the cone', [0, 0, 2, 4, 0, 2], [2, 3], [true, true], [0, 0, 0, 0]],
    ['linear tangent-cone equation', [0, 0, 0, 2, 0, 2], [1, 1], [false, false], [128, 0, 128, 255]],
    ['two zero radii paint nothing', [0, 0, 0, 2, 0, 0], [1, 0], [true, true], [0, 0, 0, 0]],
    ['identical circles paint nothing', [0, 0, 2, 0, 0, 2], [1, 0], [true, true], [0, 0, 0, 0]],
  ])('%s at an independently specified circle point', async (_name, coords, point, extend, expected) => {
    const command = await commandOf(pdf(coords)); command.extend = extend;
    expect(await pixel(command, ...point)).toEqual(expected);
  });
  it('uses the inverse nonuniform, sheared CTM before solving circles', async () => {
    const command = await commandOf(pdf([10, 20, 1, 10, 20, 3]));
    expect(await pixel(command, 11.5, 20, [2, .5, 1, 3])).toEqual([64, 0, 191, 255]);
  });
  it('maps the circle parameter through a non-unit function domain', async () => {
    const data = simplePdf('/R sh', { page: '/Resources << /Shading << /R 6 0 R >> >>',
      extra: ['<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [0 0 1 0 0 3] /Domain [2 4] /Function << /FunctionType 2 /Domain [2 4] /C0 [0] /C1 [.25] /N 1 >> >>'] });
    expect(await pixel(await commandOf(data), 2, 0)).toEqual([191, 191, 191, 255]);
  });
  it('keeps parser lifetimes explicit when shading is read directly', async () => {
    const reader = await NativePdfReader.create(pdf([0, 0, 0, 0, 0, 1]), options);
    try { expect(await readPdfShading(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)), 0, options.loadAsset)).toMatchObject({ type: 3 }); }
    finally { reader.destroy(); }
  });
  it('fails explicitly when finite coordinates overflow the circle equation', async () => {
    const command = await commandOf(pdf([0, 0, 1, 1, 0, 2]));
    command.coords[3] = 1e200; // Exercise the renderer's numeric boundary after valid PDF parsing.
    await expect(pixel(command, 0, 0)).rejects.toMatchObject({ code: 'pdf_limit' });
  });
  it('checks cancellation before allocating a radial surface', async () => {
    const command = await commandOf(pdf([0, 0, 0, 0, 0, 1]));
    await expect(renderPdfShading(command, {}, { cancellation: () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
  });
});
