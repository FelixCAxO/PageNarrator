import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { renderPdfShading } from '../../src/pdf/shading.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { simplePdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/image-limits.js', async original => ({ ...await original(), MAX_IMAGE_BAND_PIXELS: 4 }));
afterEach(() => vi.unstubAllGlobals());
const ramp = '<< /FunctionType 2 /Domain [0 1] /C0 [0 1] /C1 [1 0] /N 1 >>';
const nonlinear = stream('{exch dup mul exch 0}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]');
function shadingPdf({ alternate = '/DeviceRGB', names = '/InkA /InkB', tint = nonlinear, fn = ramp, extra = [], type = 2, coords = '0 0 4 0' } = {}) {
  return simplePdf('/S sh', { page: '/Resources << /Shading << /S 6 0 R >> >>', extra: [
    `<< /ShadingType ${type} /ColorSpace [/DeviceN [${names}] ${alternate} 7 0 R] /Coords [${coords}] /Extend [true true] /Function 8 0 R >>`, tint, fn, ...extra,
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

describe('DeviceN axial and radial composite shading', () => {
  it('evaluates the nonlinear tint at pixel centers before alternate RGB conversion', async () => {
    const command = await commandOf(shadingPdf());
    expect(command.colorSpace).toMatchObject({ name: 'DeviceN', components: 2, alternate: { name: 'DeviceRGB', profileBytes: null }, tintTransform: { type: 4, inputs: 2, outputs: 3 } });
    expect(command.colorSpace).not.toHaveProperty('convert'); expect(command.colorSpace.alternate).not.toHaveProperty('toXyz');
    const target = canvas(); await renderPdfShading(structuredClone(command), target.ctx);
    // t=(x+.5)/4, so the declared inks yield RGB=(t*t,1-t,0), not interpolated RGB endpoints.
    expect(target.written).toEqual([[4, 223, 0, 255, 36, 159, 0, 255, 100, 96, 0, 255, 195, 32, 0, 255]]);
    expect(target.surfaces[0]).toMatchObject({ width: 0, height: 0 }); expect(target.restore).toHaveBeenCalledOnce();
  });

  it('supports independent per-ink shading functions and clips supplied tints to the DeviceN range', async () => {
    const fn = '[<< /FunctionType 2 /Domain [0 1] /C0 [-1] /C1 [3] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [2] /C1 [-2] /N 1 >>]';
    const command = await commandOf(shadingPdf({ fn })), target = canvas();
    await renderPdfShading(command, target.ctx);
    // Clipped ink pairs are(0,1),(.5,.5),(1,0),(1,0), then RGB=(a*a,b,0).
    expect(target.written[0]).toEqual([0, 255, 0, 255, 64, 128, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  });

  it('uses radial geometry before applying a two-ink gray alternate tint', async () => {
    const command = await commandOf(shadingPdf({ type: 3, coords: '0 0 1 0 0 3', alternate: '/DeviceGray',
      tint: stream('{mul}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1]') }));
    const target = canvas(1, 1, { e: -1, f: .5 }); // Pixel center is(1.5,0): circle parameter1/4, inks(.25,.75).
    await renderPdfShading(command, target.ctx); expect(target.written[0]).toEqual([48, 48, 48, 255]);
  });

  it('inserts process components before the existing CMYK ICC conversion', async () => {
    const command = await commandOf(shadingPdf({ names: '/Magenta /Yellow /Black', alternate: '/DeviceCMYK',
      tint: stream('{0 4 1 roll}', '/FunctionType 4 /Domain [0 1 0 1 0 1] /Range [0 1 0 1 0 1 0 1]'),
      fn: '<< /FunctionType 2 /Domain [0 1] /C0 [.2 .6 .8] /C1 [.2 .6 .8] /N 1 >>' }));
    const target = canvas(1, 1); await renderPdfShading(command, target.ctx);
    // Independent LittleCMS2.19, retained CGATS001Compat profile, intent0: CMYK8(0,51,153,204)->sRGB8(87,69,33).
    expect(target.written[0]).toEqual([87, 69, 33, 255]);
  });

  it('transfers nested sampled functions and ICC bytes once, then preserves encoded PCS blending', async () => {
    const profile = syntheticRgbProfile();
    const command = await commandOf(shadingPdf({ names: '/Ink', alternate: '[/ICCBased 9 0 R]',
      tint: '<< /FunctionType 3 /Domain [0 1] /Functions [10 0 R] /Bounds [] /Encode [0 1] >>',
      fn: '<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R] /Bounds [] /Encode [0 1] >>', extra: [stream(profile, '/N 3'),
        stream(Uint8Array.of(0, 0, 0, 255, 255, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8'),
        stream(Uint8Array.of(0, 255), '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8')] }));
    const payload = { commands: [{ op: 'group', commands: [command, command] }] }, buffers = pdfPayloadBuffers(payload);
    expect(buffers).toHaveLength(3); expect(new Set(buffers).size).toBe(3);
    const clone = structuredClone(payload, { transfer: buffers }), transferred = clone.commands[0].commands[0];
    expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(transferred.colorSpace.alternate.profileBytes).toEqual(profile);
    expect([...transferred.colorSpace.tintTransform.functions[0].samples]).toEqual([0, 0, 0, 255, 255, 255]);
    expect([...transferred.functions[0].functions[0].samples]).toEqual([0, 255]);
    transferred.coords = [0, 0, 2, 0]; const target = canvas(1, 1);
    await renderPdfShading(transferred, target.ctx, { outputProfile: parseIccProfile(profile) });
    expect(target.written[0]).toEqual([64, 64, 64, 255]);
  });

  it.each([
    { fn: '<< /FunctionType 2 /Domain [0 1] /N 1 >>' },
    { fn: '[<< /FunctionType 2 /Domain [0 1] /N 1 >>]' },
    { tint: stream('{}', '/FunctionType 4 /Domain [0 1] /Range [0 1]') },
    { tint: stream('{exec}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]') },
  ])('rejects malformed shading/tint dimensions and forbidden tint syntax: %j', async attributes => {
    await expect(commandOf(shadingPdf(attributes))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each(['[/CalRGB << /WhitePoint [.9642 1 .8249] >>]', '[/Lab << /WhitePoint [.9642 1 .8249] >>]'])('keeps unsupported shading alternates explicit: %s', async alternate => {
    await expect(commandOf(shadingPdf({ alternate }))).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('rejects damaged serialized descriptors before allocating or painting', async () => {
    const command = await commandOf(shadingPdf()); delete command.colorSpace.tintTransform;
    await expect(renderPdfShading(command, {})).rejects.toMatchObject({ code: 'pdf_corrupt' });
    command.colorSpace.tintTransform = { ...command.functions[0], inputs: 1, outputs: 2 };
    await expect(renderPdfShading(command, {})).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('retains the cumulative pixel budget and cancellation before allocation', async () => {
    const command = await commandOf(shadingPdf()), target = canvas(1, 1);
    await expect(renderPdfShading(command, target.ctx, { surfaceBudget: { shadingPixels: 64_000_000 } })).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(renderPdfShading(command, target.ctx, { cancellation() { throw Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(target.surfaces).toHaveLength(0);
  });

  it('releases the band surface and restores state when tint execution fails', async () => {
    const command = await commandOf(shadingPdf({ tint: stream('{pop pop 1 0 div 0 0}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]') }));
    const target = canvas(); await expect(renderPdfShading(command, target.ctx)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(target.drawImage).not.toHaveBeenCalled(); expect(target.restore).toHaveBeenCalledOnce(); expect(target.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });

  it('cancels between bounded bands and releases the active surface', async () => {
    const command = await commandOf(shadingPdf()), target = canvas(2, 3);
    await expect(renderPdfShading(command, target.ctx, { cancellation() { if (target.drawImage.mock.calls.length) throw Error('cancelled between bands'); } })).rejects.toThrow('cancelled between bands');
    expect(target.drawImage).toHaveBeenCalledOnce(); expect(target.restore).toHaveBeenCalledOnce(); expect(target.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
});
