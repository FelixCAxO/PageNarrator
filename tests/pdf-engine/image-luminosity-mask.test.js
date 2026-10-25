import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfGroupSoftMaskContext, createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { createPdfImageLuminositySampler, readPdfImageLuminosityArtwork } from '../../src/pdf/image-luminosity-mask.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { pdf, stream, options } from './fixtures.js';

vi.mock('../../src/pdf/image-limits.js', async original => ({ ...await original(), MAX_IMAGE_BAND_PIXELS: 4 }));
afterEach(() => vi.unstubAllGlobals());
const I = [1, 0, 0, 1, 0, 0];
// Header-only authored samples exercise transport; frozen independent browser
// controls cover actual JPEG decoding before production raster acceptance.
const frame = (width, height) => Uint8Array.of(255, 216, 255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0, 255, 217);
function fixture({ width = 2, height = 2, image = '', source = frame(width, height), program = 'q /R gs 2 0 0 2 0 0 cm /I Do Q', state = '', overprint = '/OP false /op false', group = '', space = 'DeviceGray', resources = '', bc = '[1 1 1 1]', page = '/A gs /T Do', formMatrix = I } = {}) {
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 10 10] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /ExtGState << /A 5 0 R >> /XObject << /T 8 0 R >> >> >>', stream(page),
    `<< /SMask << /S /Luminosity /G 6 0 R ${bc === null ? '' : '/BC ' + bc} >> >>`,
    stream(program, `/Subtype /Form /BBox [0 0 2 2] /Matrix [${formMatrix.join(' ')}] /Group << /S /Transparency /CS /DeviceCMYK /I false ${group} >> /Resources << /XObject << /I 7 0 R >> /ExtGState << /R 9 0 R >> ${resources} >>`),
    stream(source, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace /${space} /Filter /DCTDecode ${image}`),
    stream('0 g 0 0 2 2 re f', '/Subtype /Form /BBox [0 0 2 2] /Group << /S /Transparency /I true >>'), `<< /ca 1 /CA 1 /BM /Normal /SMask /None /AIS false ${overprint} ${state} >>`]);
}
function decoder(samples = [0, 85, 170, 255], width = 2, height = 2, changes = {}) {
  const close = vi.fn(), surfaces = [], bands = [], bitmap = { width, height, close, ...changes.bitmap };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { changes.onBitmap?.(); return bitmap; }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) { this.width = w; this.height = h; surfaces.push(this); }
    getContext() { if (changes.missingContext) return null; let offset = 0; return {
      drawImage(_bitmap, _x, top, w, rows) { offset = top; bands.push({ top, width: w, rows }); },
      getImageData(_x, _y, w, rows) {
        if (changes.failure) throw changes.failure;
        const data = Uint8ClampedArray.from(Array.from({ length: w * rows }, (_, i) => [samples[offset * width + i], samples[offset * width + i], samples[offset * width + i], 255]).flat());
        changes.pixels?.(data); return { data };
      },
    }; }
  });
  return { close, surfaces, bands };
}
const maskOf = payload => payload.commands.find(command => command.softMask)?.softMask;
async function payload(settings, run = value => value) {
  const core = await createPdfDocumentCore(fixture(settings), options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
function descriptor(changes = {}) {
  return { type: 'Luminosity', backdrop: [1, 1, 1, 1], matrix: I, bbox: [-10, -10, 10, 10], deviceImage: { width: 1, height: 1, samples: Uint8Array.of(128), matrix: I }, ...changes };
}

describe('bounded native Gray-image luminosity-mask compilation', () => {
  it('retains exact gray samples without ICC conversion and closes native resources', async () => {
    const host = decoder(); await payload({}, value => {
      const mask = maskOf(value); expect([...mask.deviceImage.samples]).toEqual([0, 85, 170, 255]); expect(mask).not.toHaveProperty('profileBytes'); expect(mask).not.toHaveProperty('shading');
      const values = createPdfGroupSoftMaskSampler(mask).sampleBand(0, 0, 2, 2); expect([...values].map(n => Math.round(n * 255))).toEqual([170, 255, 0, 85]);
      [170, 255, 0, 85].forEach((n, i) => expect(values[i]).toBeCloseTo(n / 255, 14)); expect(value.inspection.hasRasterImage).toBe(false);
    });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' }); expect(host.close).toHaveBeenCalledOnce(); expect(host.surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
  it('preserves capture-time and Form matrices and the native default black', async () => {
    decoder(); await payload({ page: '1 0 0 1 3 4 cm /A gs 1 0 0 1 8 9 cm /T Do', formMatrix: [1, 0, 0, 1, 1, 2], bc: null }, value => { const mask = maskOf(value); expect(mask.matrix).toEqual([1, 0, 0, 1, 4, 6]); expect(mask.backdrop).toEqual([0, 0, 0, 1]); });
  });
  it('uses bounded JPEG bands and retains all source rows', async () => {
    const host = decoder([0, 32, 64, 128, 192, 255], 2, 3); await payload({ height: 3 }, value => expect([...maskOf(value).deviceImage.samples]).toEqual([0, 32, 64, 128, 192, 255]));
    expect(host.bands).toEqual([{ top: 0, width: 2, rows: 2 }, { top: 2, width: 2, rows: 1 }]);
  });
  it('transfers shared samples once and rebuilds them after page cleanup', async () => {
    const host = decoder(); await payload({ page: '/A gs /T Do /A gs /T Do' }, async (value, core) => {
      const groups = value.commands.filter(command => command.softMask); expect(groups).toHaveLength(2); expect(groups[0].softMask.deviceImage.samples).toBe(groups[1].softMask.deviceImage.samples);
      const buffers = pdfPayloadBuffers(value); expect(buffers).toHaveLength(1); const clone = structuredClone(value, { transfer: buffers }); expect(maskOf(value).deviceImage.samples.byteLength).toBe(0); expect([...maskOf(clone).deviceImage.samples]).toEqual([0, 85, 170, 255]);
      core.cleanup(1); expect([...maskOf(await core.pagePayload(1)).deviceImage.samples]).toEqual([0, 85, 170, 255]);
    }); expect(host.close).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ bc: '[0 0 0]' }, 'pdf_corrupt'], [{ image: '/Decode [0 1]' }, 'pdf_unsupported'], [{ image: '/Interpolate true' }, 'pdf_unsupported'], [{ image: '/Matte [0]' }, 'pdf_unsupported'],
    [{ image: '/SMask 7 0 R' }, 'pdf_unsupported'], [{ image: '/Interpolate 1' }, 'pdf_corrupt'], [{ state: '/BM /Multiply' }, 'pdf_unsupported'], [{ group: '/K true' }, 'pdf_unsupported'],
    [{ state: '/OP true /OPM 1' }, 'pdf_unsupported'], [{ state: '/op true /OPM 1' }, 'pdf_unsupported'],
    [{ overprint: '' }, 'pdf_unsupported'], [{ overprint: '/OP false' }, 'pdf_unsupported'], [{ overprint: '/op false' }, 'pdf_unsupported'],
    [{ width: 6000, height: 6000, source: frame(2, 2) }, 'pdf_limit'], [{ program: 'q /R gs 2 0 0 2 0 0 cm /I Do Q BT ET' }, 'pdf_unsupported'],
    [{ resources: '/ColorSpace << /DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] /Gamma 2 >>] >>' }, 'pdf_unsupported'],
  ])('refuses unsupported/malformed source before requesting a native decoder: %j', async (settings, code) => {
    decoder(); await expect(payload(settings)).rejects.toMatchObject({ code }); expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it.each([
    { bitmap: { width: 3 } }, { missingContext: true }, { pixels: data => { data[1]++; } }, { pixels: data => { data[3]--; } }, { failure: new Error('readback failed') },
  ])('releases all native resources after header/readback failure: %j', async changes => {
    const host = decoder(undefined, 2, 2, changes); await expect(payload({})).rejects.toBeTruthy(); expect(host.close).toHaveBeenCalledOnce(); expect(host.surfaces.every(surface => surface.width === 0 && surface.height === 0)).toBe(true);
  });
  it('bounds retained samples with program bytes and charges shared pixels before decoding', async () => {
    const reader = await NativePdfReader.create(fixture(), options), charge = vi.fn();
    try {
      const form = reader.checked(reader.api.pn_pdf_resolve(6, 0)), resources = reader.field(form, 'Resources'), programBytes = reader.node(form).length;
      const context = createPdfGroupSoftMaskContext(new Map(), () => {}, charge); context.programBytes = 32 * 1024 * 1024 - programBytes - 4; decoder();
      await readPdfImageLuminosityArtwork(reader, form, resources, options.loadAsset, context, () => {}); expect(context.programBytes).toBe(32 * 1024 * 1024); expect(charge).toHaveBeenCalledWith(4);
      const exceeded = createPdfGroupSoftMaskContext(new Map(), () => {}, charge); exceeded.programBytes = 32 * 1024 * 1024 - programBytes - 3; decoder();
      await expect(readPdfImageLuminosityArtwork(reader, form, resources, options.loadAsset, exceeded, () => {})).rejects.toMatchObject({ code: 'pdf_limit' }); expect(createImageBitmap).not.toHaveBeenCalled();
      const shared = createPdfGroupSoftMaskContext(new Map(), () => {}, () => { throw new Error('shared image cap'); }); decoder();
      await expect(readPdfImageLuminosityArtwork(reader, form, resources, options.loadAsset, shared, () => {})).rejects.toThrow('shared image cap'); expect(createImageBitmap).not.toHaveBeenCalled();
    } finally { reader.destroy(); }
  });
  it('closes the bitmap when cancellation occurs during native decode', async () => {
    const controller = new AbortController(), host = decoder(undefined, 2, 2, { onBitmap: () => controller.abort() });
    const core = await createPdfDocumentCore(fixture(), { ...options, signal: controller.signal });
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ name: 'AbortError' }); expect(host.close).toHaveBeenCalledOnce(); } finally { core.destroy(); }
  });
});

describe('device-CMYK luminosity after native BC compositing', () => {
  it('distinguishes two black BCs at a fractional image edge', () => {
    const image = { width: 1, height: 1, samples: Uint8Array.of(128), matrix: [1, 0, 0, 1, .5, 0] }, gray = 128 / 255;
    expect(createPdfImageLuminositySampler(descriptor({ deviceImage: image })).sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(gray / 4, 14);
    expect(createPdfImageLuminositySampler(descriptor({ deviceImage: image, backdrop: [0, 0, 0, 1] })).sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(gray / 2, 14);
  });
  it('intersects coincident BBox/image edges once before the native4component mix', () => {
    const mask = descriptor({ bbox: [.5, 0, 1.5, 1], deviceImage: { width: 1, height: 1, samples: Uint8Array.of(128), matrix: [1, 0, 0, 1, .5, 0] } });
    expect(createPdfImageLuminositySampler(mask).sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(128 / 255 / 4, 14);
  });
  it('retains nonblack BC outside and mixes before nonlinear device luminance at boundaries', () => {
    const bc = [.2, .3, .4, .5], mask = descriptor({ backdrop: bc, deviceImage: { width: 1, height: 1, samples: Uint8Array.of(128), matrix: [1, 0, 0, 1, .5, 0] } });
    const values = createPdfImageLuminositySampler(mask).sampleBand(-1, 0, 3, 1), mixed = bc.map((n, i) => n / 2 + (i === 3 ? 1 - 128 / 255 : 0) / 2), y = v => (1 - v[3]) * (.3 * (1 - v[0]) + .59 * (1 - v[1]) + .11 * (1 - v[2]));
    expect(values[0]).toBeCloseTo(y(bc), 14); expect(values[1]).toBeCloseTo(y(mixed), 14); expect(values[1]).not.toBeCloseTo((128 / 255 + y(bc)) / 2, 4);
  });
  it('preserves nearest sample orientation and reversed BBox geometry', () => {
    const mask = descriptor({ bbox: [2, 2, 0, 0], deviceImage: { width: 2, height: 2, samples: Uint8Array.of(0, 85, 170, 255), matrix: [2, 0, 0, 2, 0, 0] } });
    const values = createPdfImageLuminositySampler(mask).sampleBand(0, 0, 2, 2); expect([...values].map(n => Math.round(n * 255))).toEqual([170, 255, 0, 85]);
    [170, 255, 0, 85].forEach((n, i) => expect(values[i]).toBeCloseTo(n / 255, 14));
  });
  it.each([
    { backdrop: [0, 0, 0] }, { backdrop: [NaN, 0, 0, 1] }, { matrix: [1, 0, 0, 0, 0, 0] }, { matrix: [Infinity, 0, 0, 1, 0, 0] }, { profileBytes: new Uint8Array(1) },
    { deviceImage: { width: 2, height: 2, samples: Uint8Array.of(1), matrix: I } },
  ])('rejects malformed descriptors instead of using an ICC/scalar fallback: %j', changes => expect(() => createPdfImageLuminositySampler(descriptor(changes))).toThrow());
  it('bounds band allocation/work and cancels inside the sample loop', () => {
    const budget = { pixels: 0, shadingPixels: 63_999_999 }, sample = createPdfImageLuminositySampler(descriptor(), { surfaceBudget: budget });
    sample.sampleBand(0, 0, 1, 1); expect(budget.shadingPixels).toBe(64_000_000); expect(() => sample.sampleBand(0, 0, 1, 1)).toThrow(/work budget/);
    expect(() => sample.sampleBand(0, 0, 262145, 1)).toThrow(/sample band/);
    let checks = 0; const cancellation = () => { if (++checks > 3) throw new Error('cancelled sample'); };
    const cancel = createPdfImageLuminositySampler(descriptor(), { cancellation }); expect(() => cancel.sampleBand(0, 0, 8192, 1)).toThrow('cancelled sample');
  });
});
