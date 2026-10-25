// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { assertPdfNativeRgbPrintDefaults } from '../../src/pdf/native-rgb-image.js';
import { createPdfNativeImageSourceBudget, createPdfNativeCmykImageSampler } from '../../src/pdf/native-cmyk-image.js';
import { PDF_CMYK_PRINT_DEFAULTS } from '../../src/pdf/native-cmyk.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';
import { encodeNativeFlate, flateAlpha } from './native-cmyk-flate-fixture.js';

afterEach(() => vi.unstubAllGlobals());
const rgb = Uint8Array.of(0, 64, 128, 255, 128, 64, 17, 91, 153, 32, 96, 160, 224, 160, 96, 254, 1, 127);
const ink8 = [128, 64, 0, 127, 0, 127, 191, 0, 136, 62, 0, 102, 128, 64, 0, 95, 0, 64, 128, 31, 0, 253, 127, 1];
// Header-only source verifies adapter ownership. Separate frozen browser controls
// use complete original Adobe1 JPEG bytes and independent decoder references.
const jpeg = Uint8Array.of(255, 216, 255, 192, 0, 17, 8, 0, 2, 0, 3, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217);
function fixture({ dct = false, predictor = 1, mask = false, base = '', maskEntry = '', resource = '', width = 3, height = 2, bits = 8, space = '/DeviceRGB', encoded = null } = {}) {
  const parms = components => `/DecodeParms << /Predictor ${predictor} /Colors ${components} /Columns 3 /BitsPerComponent 8 >>`;
  return simplePdf('/I Do', { page: `/Resources << /XObject << /I 6 0 R >> ${resource} >>`, extra: [
    stream(encoded || (dct ? jpeg : deflateSync(encodeNativeFlate(rgb, 3, predictor))), `/Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent ${bits} /ColorSpace ${space} /Filter /${dct ? 'DCTDecode' : 'FlateDecode'} ${dct ? '' : parms(3)} ${mask ? '/SMask 7 0 R' : ''} ${base}`),
    stream(deflateSync(encodeNativeFlate(flateAlpha, 1, predictor)), `/Subtype /Image /Width 3 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode ${parms(1)} ${maskEntry}`),
  ] });
}
async function read(data, owner, nativeCmyk = true, signal = undefined) {
  const reader = await NativePdfReader.create(data, { ...options, signal });
  try {
    const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)), page = reader.checked(reader.api.pn_pdf_resolve(3, 0));
    return await readPdfImage(reader, id, { resources: reader.field(page, 'Resources'), loadAsset, nativeCmyk, sourceBudget: owner });
  } finally { reader.destroy(); }
}
function decoder({ alpha = 255, cancel } = {}) {
  const close = vi.fn(), surfaces = [];
  const create = vi.fn(async () => { cancel?.(); return { width: 3, height: 2, close }; }); vi.stubGlobal('createImageBitmap', create);
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width, height) { this.width = width; this.height = height; surfaces.push(this); }
    getContext() { return { drawImage() {}, getImageData() { return { data: Uint8ClampedArray.from(Array.from({ length: 6 }, (_, i) => [...rgb.subarray(i * 3, i * 3 + 3), alpha]).flat()) }; } }; }
  });
  return { close, create, surfaces };
}
const sampling = budget => ({ imageMatrix: [3, 0, 0, -2, 0, 2], pageTransform: [1, 0, 0, 1, 0, 0], surfaceBudget: budget });
describe('explicit native RGB8 source planes and default ink conversion', () => {
  it.each([1, 2, 10, 11, 12, 13, 14].flatMap(predictor => [false, true].map(mask => ({ predictor, mask }))))('retains exact literal RGB and mask for predictor=$predictor mask=$mask', async settings => {
    const owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(fixture(settings), owner);
      expect(image).toMatchObject({ format: 'native-rgb', bits: 8, components: 3, colorSpace: { name: 'DeviceRGB', components: 3 }, interpolate: false });
      expect(image.bytes).toEqual(rgb); expect(image.bytes.buffer.byteLength).toBe(18); expect(image.pixels).toBeUndefined();
      expect(image.softMask?.bytes || null).toEqual(settings.mask ? flateAlpha : null); expect(owner.bytes).toBe(settings.mask ? 24 : 18);
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); }
  });
  it.each([false, true])('uses one existing browser JPEG decode, keeps RGB samples and closes its owners: mask=%s', async mask => {
    const { close, create, surfaces } = decoder(), owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(fixture({ dct: true, mask }), owner);
      expect(image.bytes).toEqual(rgb); expect(image.softMask?.bytes || null).toEqual(mask ? flateAlpha : null);
      expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][1]).toEqual({ premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
      expect(owner.peakBytes).toBe(18 + (mask ? 6 : 0) + 4 * 6 + 8 * 6 + 2 * jpeg.length);
      expect(close).toHaveBeenCalledTimes(1); expect(surfaces[0].width).toBe(0); expect(surfaces[0].height).toBe(0);
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); }
  });
  it('derives four independent default inks once per sample and premultiplies alpha once', async () => {
    const owner = createPdfNativeImageSourceBudget(), budget = { pixels: 0 };
    try {
      const image = await read(fixture({ predictor: 14, mask: true }), owner), sampler = createPdfNativeCmykImageSampler(image, sampling(budget));
      try {
        const band = sampler.sampleBand(0, 0, 3, 2);
        for (let p = 0; p < 6; p++) {
          const a = flateAlpha[p] / 255; expect(band.data[p * 5 + 4]).toBeCloseTo(a, 7);
          for (let c = 0; c < 4; c++) expect(band.data[p * 5 + c]).toBeCloseTo(ink8[p * 4 + c] / 255 * a, 7);
        }
        expect(budget.shadingPixels).toBe(6); band.release();
      } finally { sampler.destroy(); expect(budget.pixels).toBe(0); }
    } finally { owner.destroy(); }
  });
  it('preserves the old JPEG preview path and does not decode it into RGB samples', async () => {
    const { create } = decoder(), image = await read(fixture({ dct: true }), undefined, false);
    expect(image.format).toBe('jpeg'); expect(image.bytes).toEqual(jpeg); expect(create).not.toHaveBeenCalled();
  });
  it('deduplicates owned source transfers and rebuilds fresh native bytes after detachment', async () => {
    const owner = createPdfNativeImageSourceBudget(), data = fixture({ mask: true, predictor: 12 });
    try {
      const image = await read(data, owner), payload = { commands: [{ op: 'image', ...image }, { op: 'group', commands: [{ op: 'image', ...image }] }] };
      const buffers = pdfPayloadBuffers(payload); expect(buffers).toHaveLength(2);
      const copied = structuredClone(payload, { transfer: buffers }); expect(image.bytes.byteLength).toBe(0); expect(image.softMask.bytes.byteLength).toBe(0);
      const rebuilt = await read(data, owner); expect(rebuilt.bytes).toEqual(copied.commands[0].bytes); expect(rebuilt.softMask.bytes).toEqual(copied.commands[0].softMask.bytes);
      expect(rebuilt.bytes.buffer).not.toBe(copied.commands[0].bytes.buffer); owner.release(image); expect(owner.bytes).toBe(24);
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); }
  });
  it('preflights the bitmap and two RGBA bands before invoking a large malformed JPEG', async () => {
    const { create } = decoder(), owner = createPdfNativeImageSourceBudget();
    await expect(read(fixture({ dct: true, width: 1_000_000, height: 10 }), owner)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(create).not.toHaveBeenCalled(); expect(owner.peakBytes).toBe(0); expect(owner.bytes).toBe(0); owner.destroy();
  });
  it('charges the inserted ColorTransform APP14 marker and its Blob copy before native RGB decoding', async () => {
    const { create } = decoder(), owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(fixture({ dct: true, base: '/DecodeParms << /ColorTransform 0 >>' }), owner);
      expect(image.bytes).toEqual(rgb); expect(create.mock.calls[0][0].size).toBe(jpeg.length + 16);
      expect(owner.peakBytes).toBe(18 + 4 * 6 + 8 * 6 + 2 * (jpeg.length + 16));
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); }
  });
  it('preflights ColorTransform expansion when only the old unexpanded peak would fit', async () => {
    const { create } = decoder(), owner = createPdfNativeImageSourceBudget();
    const oldPeak = 18 + 4 * 6 + 8 * 6 + 2 * jpeg.length, pending = owner.reserve(0, 96 * 1024 * 1024 - oldPeak, 1);
    try {
      await expect(read(fixture({ dct: true, base: '/DecodeParms << /ColorTransform 0 >>' }), owner)).rejects.toMatchObject({ code: 'pdf_limit' });
      expect(create).not.toHaveBeenCalled();
    } finally { pending.rollback(); owner.destroy(); expect(owner.bytes).toBe(0); }
  });
  it('rejects a three-component Adobe2 JPEG even without a PDF ColorTransform parameter', async () => {
    const { create } = decoder(), owner = createPdfNativeImageSourceBudget();
    const marker = Uint8Array.of(255, 238, 0, 14, 65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, 2);
    const encoded = Uint8Array.of(...jpeg.subarray(0, 2), ...marker, ...jpeg.subarray(2));
    await expect(read(fixture({ dct: true, encoded }), owner)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    expect(create).not.toHaveBeenCalled(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); owner.destroy();
  });
  it('closes bitmap and releases the source lease after cancellation', async () => {
    const controller = new AbortController(), { close } = decoder({ cancel: () => controller.abort() }), owner = createPdfNativeImageSourceBudget();
    await expect(read(fixture({ dct: true }), owner, true, controller.signal)).rejects.toThrow(); expect(close).toHaveBeenCalledTimes(1); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); owner.destroy();
  });
  it('refuses a browser JPEG result with invented source alpha', async () => {
    const { close } = decoder({ alpha: 128 }), owner = createPdfNativeImageSourceBudget();
    await expect(read(fixture({ dct: true }), owner)).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(close).toHaveBeenCalledTimes(1); expect(owner.bytes).toBe(0); owner.destroy();
  });
  it.each([{ base: '/Decode [1 0 1 0 1 0]' }, { base: '/Interpolate true' }, { base: '/Matte [0 0 0]' }, { bits: 16 },
    { resource: '/ColorSpace << /DefaultRGB /DeviceRGB >>' }, { resource: '/ColorSpace << /DefaultGray /DeviceGray >>' }, { resource: '/ColorSpace << /DefaultCMYK /DeviceCMYK >>' }])('retains unsupported source guards: %j', async settings => {
    const owner = createPdfNativeImageSourceBudget(); await expect(read(fixture(settings), owner)).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(owner.bytes).toBe(0); owner.destroy();
  });
  it.each([{ components: 4 }, { colorSpace: { name: 'DeviceCMYK', components: 3 } }, { format: 'raw-rgb' }, { bytes: new Uint8Array(24) }])('rejects a malformed native RGB descriptor before allocating a band: %j', async changes => {
    const owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(fixture(), owner), budget = { pixels: 0 };
      expect(() => createPdfNativeCmykImageSampler({ ...image, ...changes }, sampling(budget))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' })); expect(budget.pixels).toBe(0);
    } finally { owner.destroy(); }
  });
  it('allows only explicit effective default BG/UCR state, including after a cached first Do', () => {
    expect(() => assertPdfNativeRgbPrintDefaults(PDF_CMYK_PRINT_DEFAULTS)).not.toThrow();
    for (const property of ['blackGeneration', 'undercolorRemoval']) expect(() => assertPdfNativeRgbPrintDefaults({ ...PDF_CMYK_PRINT_DEFAULTS, [property]: { type: 2 } })).toThrow(expect.objectContaining({ code: 'pdf_unsupported' }));
    expect(() => assertPdfNativeRgbPrintDefaults({})).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });
});
