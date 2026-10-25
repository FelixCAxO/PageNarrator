import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfShading } from '../../src/pdf/shading.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { simplePdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/image-limits.js', async original => ({ ...await original(), MAX_IMAGE_BAND_PIXELS: 4 }));
afterEach(() => vi.unstubAllGlobals());
const ramp = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>';
const tint = '<< /FunctionType 2 /Domain [0 1] /C0 [1 .5 0] /C1 [0 .25 1] /N 2 >>';
function shadingPdf({ alternate = '/DeviceRGB', colorant = '/Ink', transform = tint, fn = ramp, type = 2, coords = '0 0 4 0', extra = [], group = '' } = {}) {
  return simplePdf('/S sh', { page: `${group} /Resources << /Shading << /S 6 0 R >> >>`, extra: [
    `<< /ShadingType ${type} /ColorSpace [/Separation ${colorant} ${alternate} 7 0 R] /Coords [${coords}] /Extend [true true] /Function 8 0 R >>`, transform, fn, ...extra,
  ] });
}
async function commandOf(data) {
  const core = await createPdfDocumentCore(data, options);
  try { return (await core.pagePayload(1)).commands.find(command => command.op === 'shading'); }
  finally { core.destroy(); }
}
function canvas(width = 4, height = 1, transform = {}) {
  const written = [], surfaces = [], drawImage = vi.fn(), restore = vi.fn();
  vi.stubGlobal('ImageData', class { constructor(data, w, h) { Object.assign(this, { data, width: w, height: h }); } });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) { Object.assign(this, { width: w, height: h }); surfaces.push(this); }
    getContext() { return { putImageData: image => written.push([...image.data]) }; }
  });
  return { written, surfaces, drawImage, restore, ctx: { canvas: { width, height }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, ...transform }), save() {}, restore, setTransform() {}, drawImage } };
}

describe('named Separation axial and radial composite shading', () => {
  it('evaluates nonlinear single-ink tint before conversion at every pixel center', async () => {
    const command = await commandOf(shadingPdf()), target = canvas();
    expect(command.colorSpace).toMatchObject({ name: 'Separation', components: 1, alternate: { name: 'DeviceRGB', profileBytes: null }, tintTransform: { inputs: 1, outputs: 3 } });
    expect(command.colorSpace).not.toHaveProperty('convert');
    await renderPdfShading(structuredClone(command), target.ctx);
    // t=(x+.5)/4. RGB=(1-t*t,.5-.25*t*t,t*t), rounded once to unorm8.
    expect(target.written).toEqual([[251, 127, 4, 255, 219, 119, 36, 255, 155, 103, 100, 255, 60, 79, 195, 255]]);
    expect(target.surfaces[0]).toMatchObject({ width: 0, height: 0 }); expect(target.restore).toHaveBeenCalledOnce();
  });

  it('clips shading-function tints to the Separation component range', async () => {
    const command = await commandOf(shadingPdf({ fn: '<< /FunctionType 2 /Domain [0 1] /C0 [-1] /C1 [3] /N 1 >>' })), target = canvas();
    await renderPdfShading(command, target.ctx);
    expect(target.written[0]).toEqual([255, 128, 0, 255, 191, 112, 64, 255, 0, 64, 255, 255, 0, 64, 255, 255]);
  });

  it('applies radial geometry before the tint transform', async () => {
    const command = await commandOf(shadingPdf({ type: 3, coords: '0 0 1 0 0 3', alternate: '/DeviceGray', transform: '<< /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 2 >>' }));
    const target = canvas(1, 1, { e: -1, f: .5 });
    await renderPdfShading(command, target.ctx);
    // Pixel center(1.5,0) =>s=.25; alternate gray=1-.25².
    expect(target.written[0]).toEqual([239, 239, 239, 255]);
  });

  it('composes sampled four-channel CMYK tint through the retained ICC policy', async () => {
    const command = await commandOf(shadingPdf({ alternate: '/DeviceCMYK', transform: stream(Uint8Array.of(0, 0, 0, 0, 0, 51, 153, 204), '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1 0 1] /Size [2] /BitsPerSample 8'), fn: '<< /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [1] /N 1 >>' })), target = canvas(1, 1);
    await renderPdfShading(command, target.ctx);
    // Existing independent LittleCMS fixture: CMYK8(0,51,153,204)->sRGB8(87,69,33).
    expect(target.written[0]).toEqual([87, 69, 33, 255]);
  });

  it('transfers owned nested sampled tint/shading functions and ICC once and rebuilds after detachment', async () => {
    const profile = syntheticRgbProfile(), data = shadingPdf({ alternate: '[/ICCBased 9 0 R]', transform: '<< /FunctionType 3 /Domain [0 1] /Functions [10 0 R] /Bounds [] /Encode [0 1] >>', fn: '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R] /Bounds [] /Encode [0 1] >>', extra: [stream(profile, '/N 3'), stream(Uint8Array.of(0, 0, 0, 255, 255, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8'), stream(Uint8Array.of(0, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8')] });
    const command = await commandOf(data), buffers = pdfPayloadBuffers({ commands: [command, command] });
    expect(buffers).toHaveLength(3);
    const clone = structuredClone(command, { transfer: buffers }); expect(buffers.every(b => b.byteLength === 0)).toBe(true);
    expect(clone.colorSpace.alternate.profileBytes).toEqual(profile);
    clone.coords = [0, 0, 2, 0]; const target = canvas(1, 1);
    await renderPdfShading(clone, target.ctx, { outputProfile: parseIccProfile(profile) }); expect(target.written[0]).toEqual([64, 64, 64, 255]);
    const rebuilt = await commandOf(data); expect(rebuilt.colorSpace.alternate.profileBytes).toEqual(profile);
    expect(rebuilt.colorSpace.alternate.profileBytes.buffer).not.toBe(clone.colorSpace.alternate.profileBytes.buffer);
  });

  it.each([
    { transform: '<< /FunctionType 2 /Domain [0 1] /N 1 >>' },
    { fn: '<< /FunctionType 2 /Domain [0 1] /C0 [0 0] /C1 [1 1] /N 1 >>' },
    { transform: stream('{exec}', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]') },
  ])('keeps malformed tint/function dimensions and syntax closed: %j', async attributes => {
    await expect(commandOf(shadingPdf(attributes))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each(['/All', '/None'])('keeps the special colorant%s outside named-ink shading admission', async colorant => {
    await expect(commandOf(shadingPdf({ colorant }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('does not admit shading into native CMYK groups', async () => {
    await expect(commandOf(shadingPdf({ group: '/Group << /S /Transparency /CS /DeviceCMYK /I true >>' }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it.each(['[/CalRGB << /WhitePoint [.9642 1 .8249] >>]', '[/Lab << /WhitePoint [.9642 1 .8249] >>]'])('keeps unsupported alternate%s explicit', async alternate => {
    await expect(commandOf(shadingPdf({ alternate }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('validates damaged serialized descriptors before allocation even with zero alpha', async () => {
    const command = await commandOf(shadingPdf()), target = canvas(); command.alpha = 0;
    for (const change of [{ components: 2 }, { tintTransform: null }, { alternate: { name: 'ICCBased' } }]) {
      await expect(renderPdfShading({ ...command, colorSpace: { ...command.colorSpace, ...change } }, target.ctx)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    }
    expect(target.surfaces).toHaveLength(0); expect(target.drawImage).not.toHaveBeenCalled();
  });

  it('preserves cumulative work and cancellation before allocation', async () => {
    const command = await commandOf(shadingPdf()), target = canvas(1, 1);
    await expect(renderPdfShading(command, target.ctx, { surfaceBudget: { shadingPixels: 64_000_000 } })).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(renderPdfShading(command, target.ctx, { cancellation() { throw Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(target.surfaces).toHaveLength(0);
  });

  it('releases surfaces on bad tint output and between-band cancellation', async () => {
    const command = await commandOf(shadingPdf({ transform: stream('{pop 1 0 div 0 0}', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]') })), target = canvas();
    await expect(renderPdfShading(command, target.ctx)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(target.drawImage).not.toHaveBeenCalled(); expect(target.restore).toHaveBeenCalledOnce(); expect(target.surfaces[0]).toMatchObject({ width: 0, height: 0 });
    const next = await commandOf(shadingPdf()), banded = canvas(2, 3);
    await expect(renderPdfShading(next, banded.ctx, { cancellation() { if (banded.drawImage.mock.calls.length) throw Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(banded.drawImage).toHaveBeenCalledOnce(); expect(banded.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
});
