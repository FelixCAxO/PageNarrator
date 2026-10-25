// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { createPdfNativeImageSourceBudget, createPdfNativeCmykImageSampler } from '../../src/pdf/native-cmyk-image.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { options, loadAsset } from './fixtures.js';
import { nativeFlatePdf, flateCmyk, flateAlpha } from './native-cmyk-flate-fixture.js';

async function read(data, owner = createPdfNativeImageSourceBudget(), nativeCmyk = true) {
  const reader = await NativePdfReader.create(data, options);
  try {
    const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)), page = reader.checked(reader.api.pn_pdf_resolve(3, 0));
    return await readPdfImage(reader, id, { resources: reader.field(page, 'Resources'), loadAsset, nativeCmyk, sourceBudget: owner });
  } finally { reader.destroy(); }
}
describe('native literal CMYK8 Flate source planes', () => {
  it.each([1, 2, 10, 11, 12, 13, 14].flatMap(predictor => [false, true].map(mask => ({ predictor, mask }))))('decodes exact literal samples for predictor=$predictor mask=$mask', async settings => {
    const owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(nativeFlatePdf(settings), owner);
      expect(image.bytes).toEqual(flateCmyk); expect(image.pixels).toBeUndefined();
      expect(image.softMask?.bytes || null).toEqual(settings.mask ? flateAlpha : null);
      expect(image.bytes.buffer.byteLength).toBe(flateCmyk.length);
      if (image.softMask) expect(image.softMask.bytes.buffer.byteLength).toBe(flateAlpha.length);
      expect(owner.bytes).toBe(flateCmyk.length + (settings.mask ? flateAlpha.length : 0)); expect(owner.pixels).toBe(6);
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); }
  });
  it('projects the original four channels and mask once without display RGB reconstruction', async () => {
    const owner = createPdfNativeImageSourceBudget(), budget = { pixels: 0 };
    try {
      const image = await read(nativeFlatePdf({ predictor: 14, mask: true }), owner);
      const sampler = createPdfNativeCmykImageSampler(image, { imageMatrix: [3, 0, 0, -2, 0, 2], pageTransform: [1, 0, 0, 1, 0, 0], surfaceBudget: budget });
      try {
        const band = sampler.sampleBand(0, 0, 3, 2);
        for (let p = 0; p < 6; p++) {
          const a = flateAlpha[p] / 255; expect(band.data[p * 5 + 4]).toBeCloseTo(a, 7);
          for (let c = 0; c < 4; c++) expect(band.data[p * 5 + c]).toBeCloseTo(flateCmyk[p * 4 + c] / 255 * a, 7);
        }
        expect(budget.shadingPixels).toBe(6); band.release();
      } finally { sampler.destroy(); expect(budget.pixels).toBe(0); }
      const payload = { commands: [{ op: 'nativeImage', ...image }] }, buffers = pdfPayloadBuffers(payload);
      expect(buffers).toHaveLength(2); const copy = structuredClone(payload, { transfer: buffers });
      expect(copy.commands[0].bytes).toEqual(flateCmyk); expect(copy.commands[0].softMask.bytes).toEqual(flateAlpha);
    } finally { owner.destroy(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); }
  });
  it('treats optional null/default Decode and Interpolate as the unchanged native samples', async () => {
    const owner = createPdfNativeImageSourceBudget();
    try {
      const image = await read(nativeFlatePdf({ predictor: 12, mask: true, base: '/Decode null /Interpolate false /Matte null', maskEntry: '/Decode [0 1] /Interpolate null' }), owner);
      expect(image.bytes).toEqual(flateCmyk); expect(image.softMask.bytes).toEqual(flateAlpha);
    } finally { owner.destroy(); }
  });
  it.each([
    { base: '/Decode [1 0 1 0 1 0 1 0]' }, { base: '/Interpolate true' }, { base: '/Matte [0 0 0 0]' }, { bits: 16 }, { space: '/DeviceGray' }, { filter: '/LZWDecode' },
    { mask: true, maskEntry: '/Decode [1 0]' }, { mask: true, maskEntry: '/Interpolate true' }, { mask: true, maskEntry: '/Matte [0 0 0 0]' },
  ])('keeps unsupported first-scope source syntax closed: %j', async settings => {
    const owner = createPdfNativeImageSourceBudget();
    await expect(read(nativeFlatePdf(settings), owner)).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); owner.destroy();
  });
  it.each([
    { samples: flateCmyk.subarray(0, -1) },
    { encoded: deflateSync(Uint8Array.of(...flateCmyk, 255)) },
    { predictor: 10, encoded: deflateSync(Uint8Array.of(5, ...flateCmyk.subarray(0, 12), 0, ...flateCmyk.subarray(12))) },
  ])('rolls back source ownership when bounded stream validation rejects %j', async settings => {
    const owner = createPdfNativeImageSourceBudget();
    await expect(read(nativeFlatePdf(settings), owner)).rejects.toThrow(); expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); owner.destroy();
  });
  it('does not reinterpret four CMYK samples per pixel when the header now declares a supported RGB source', async () => {
    const owner = createPdfNativeImageSourceBudget();
    await expect(read(nativeFlatePdf({ space: '/DeviceRGB' }), owner)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); owner.destroy();
  });
  it('preflights conservative Flate decompression/copy overlap before opening malformed encoded bytes', async () => {
    const owner = createPdfNativeImageSourceBudget();
    await expect(read(nativeFlatePdf({ width: 1_000_000, height: 10, encoded: Uint8Array.of(1, 2, 3) }), owner)).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(owner.bytes).toBe(0); expect(owner.pixels).toBe(0); expect(owner.peakBytes).toBe(0); owner.destroy();
  });
  it('preserves the previous separate display conversion and soft-mask result', async () => {
    const image = await read(nativeFlatePdf({ predictor: 14, mask: true }), undefined, false);
    expect(image.format).toBe('raw'); expect(image.pixels).toHaveLength(24);
    expect([...image.pixels].filter((_, i) => i % 4 === 3)).toEqual([...flateAlpha]);
  });
});
