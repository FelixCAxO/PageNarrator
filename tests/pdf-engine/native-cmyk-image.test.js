// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { readPdfImage } from '../../src/pdf/image-data.js';
import { createPdfNativeImageSourceBudget, createPdfNativeCmykImageSampler } from '../../src/pdf/native-cmyk-image.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options, loadAsset } from './fixtures.js';

const fixtures = new URL('./fixtures/jpeg-original/', import.meta.url);
const colours = JSON.parse(await readFile(new URL('colour-controls.json', fixtures), 'utf8'));
const inputs = colours.streams.filter(source => source.marker === 0 || source.marker === 2);
const sampleMask = (w, h) => Uint8Array.from({ length: w * h }, (_, i) => [0, 64, 128, 255][i % 4]);
async function imagePdf({ source = inputs[0], mask = false, base = '', maskEntry = '', maskSpace = 'DeviceGray', maskFilter = 'FlateDecode', maskWidth = source.width, maskHeight = source.height, space = '/DeviceCMYK', bits = 8, filter = '/DCTDecode', resource = '' } = {}) {
  const jpeg = await readFile(new URL(source.id + '.jpg', fixtures)), alpha = sampleMask(maskWidth, maskHeight);
  return simplePdf('/I Do', { page: `/Resources << /XObject << /I 6 0 R >> ${resource} >>`, extra: [
    stream(jpeg, `/Type /XObject /Subtype /Image /Width ${source.width} /Height ${source.height} /ColorSpace ${space} /BitsPerComponent ${bits} /Filter ${filter} ${mask ? '/SMask 7 0 R' : ''} ${base}`),
    stream(deflateSync(alpha), `/Type /XObject /Subtype /Image /Width ${maskWidth} /Height ${maskHeight} /ColorSpace /${maskSpace} /BitsPerComponent 8 /Filter /${maskFilter} ${maskEntry}`),
  ] });
}
async function readNative(data, budget = createPdfNativeImageSourceBudget(), nativeCmyk = true) {
  const reader = await NativePdfReader.create(data, options);
  try {
    const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)), page = reader.checked(reader.api.pn_pdf_resolve(3, 0));
    return await readPdfImage(reader, id, { resources: reader.field(page, 'Resources'), loadAsset, nativeCmyk, sourceBudget: budget });
  } finally { reader.destroy(); }
}
const literalSamples = source => Uint8Array.from(Array.from({ length: source.width * source.height }, (_, i) => (source.marker === 2 ? source.inverseYcckPatches : source.literalPatches)[Math.floor((i % source.width) / 8)]).flat());
function smallImage() { return { format: 'native-cmyk', width: 2, height: 2, bits: 8, components: 4, colorSpace: { name: 'DeviceCMYK', components: 4 }, interpolate: false,
  bytes: Uint8Array.of(0, 64, 128, 255, 255, 128, 64, 0, 32, 96, 160, 224, 224, 160, 96, 32), softMask: { width: 2, height: 2, bits: 8, components: 1, bytes: Uint8Array.of(0, 64, 128, 255) } }; }
const settings = budget => ({ imageMatrix: [2, 0, 0, -2, 0, 2], pageTransform: [1, 0, 0, 1, 0, 0], surfaceBudget: budget });
function expected(image, indices) { return indices.flatMap(i => { const alpha = image.softMask ? image.softMask.bytes[i] / 255 : 1; return [...image.bytes.slice(i * 4, i * 4 + 4)].map(value => value * alpha / 255).concat(alpha); }); }
function near(actual, wanted) { expect(actual).toHaveLength(wanted.length); actual.forEach((value, i) => expect(value).toBeCloseTo(wanted[i], 6)); }

describe('native CMYK image source-only ownership', () => {
  it.each(inputs.flatMap(source => [false, true].map(mask => ({ source, mask }))))('retains independently authored $source.id native samples and mask=$mask exactly once', async ({ source, mask }) => {
    const budget = createPdfNativeImageSourceBudget(), image = await readNative(await imagePdf({ source, mask }), budget);
    expect(image.bytes).toEqual(literalSamples(source)); expect(image.pixels).toBeUndefined(); expect(image.components).toBe(4); expect(image.interpolate).toBe(false);
    if (mask) expect(image.softMask.bytes).toEqual(sampleMask(source.width, source.height)); else expect(image.softMask).toBeNull();
    expect(budget.bytes).toBe(source.width * source.height * (mask ? 5 : 4)); expect(budget.pixels).toBe(source.width * source.height); expect(budget.peakBytes).toBeGreaterThan(budget.bytes);
    budget.release(image); budget.release(image); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0); budget.destroy();
  });
  it('keeps the old display RGB result as the default separate image path', async () => {
    const data = await imagePdf({ mask: true }), image = await readNative(data, undefined, false);
    expect(image.format).toBe('raw'); expect(image.pixels).toBeInstanceOf(Uint8ClampedArray); expect(image.pixels.length).toBe(48 * 8 * 4);
    expect([...image.pixels].filter((_, i) => i % 4 === 3)).toEqual([...sampleMask(48, 8)]);
  });
  it('requires one explicit shared source owner', async () => {
    await expect(readNative(await imagePdf(), {})).rejects.toMatchObject({ code: 'pdf_configuration' });
  });
  it.each([
    { base: '/Decode [1 0 1 0 1 0 1 0]' }, { base: '/Interpolate true' }, { base: '/Matte [0 0 0 0]' }, { bits: 16 }, { filter: '/JPXDecode' }, { space: '/DeviceRGB' },
    { mask: true, maskEntry: '/Matte [0 0 0 0]' }, { mask: true, maskEntry: '/Interpolate true' }, { mask: true, maskEntry: '/Decode [1 0]' },
    { mask: true, maskWidth: 47 }, { mask: true, maskSpace: 'DeviceRGB' }, { mask: true, maskFilter: 'DCTDecode' }, { base: '/Mask [0 1 0 1 0 1 0 1]' },
    { resource: '/ColorSpace << /DefaultCMYK /DeviceCMYK >>' },
  ])('retains explicit unsupported first-scope rejection: %j', async changes => {
    const budget = createPdfNativeImageSourceBudget(); await expect(readNative(await imagePdf(changes), budget)).rejects.toMatchObject({ code: 'pdf_unsupported' }); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0);
  });
  it.each([{ base: '/Decode [0 1]' }, { base: '/Interpolate /Invalid' }, { mask: true, base: '/Mask [0 1 0 1 0 1 0 1]' }, { mask: true, maskEntry: '/SMask 7 0 R' }])('keeps malformed image data corrupt: %j', async changes => {
    const budget = createPdfNativeImageSourceBudget(); await expect(readNative(await imagePdf(changes), budget)).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(budget.bytes).toBe(0);
  });
  it('accepts explicit defaults and optional null entries without executing a second Decode', async () => {
    const image = await readNative(await imagePdf({ mask: true, base: '/Decode [0 1 0 1 0 1 0 1] /Interpolate false /Matte null', maskEntry: '/Decode [0 1] /Interpolate null /Matte null' }));
    expect(image.bytes).toEqual(literalSamples(inputs[0])); expect(image.softMask.bytes).toEqual(sampleMask(48, 8));
  });
  it('treats null base and mask Decode as absent in the native source path', async () => {
    const budget = createPdfNativeImageSourceBudget();
    const image = await readNative(await imagePdf({ mask: true, base: '/Decode null', maskEntry: '/Decode null' }), budget);
    expect(image.bytes).toEqual(literalSamples(inputs[0])); expect(image.softMask.bytes).toEqual(sampleMask(48, 8));
    budget.destroy(); expect(budget.bytes).toBe(0);
  });
  it('treats null base and mask Decode as absent in the existing RGB path', async () => {
    const image = await readNative(await imagePdf({ mask: true, base: '/Decode null', maskEntry: '/Decode null' }), undefined, false);
    expect(image.pixels.length).toBe(48 * 8 * 4); expect([...image.pixels].filter((_, i) => i % 4 === 3)).toEqual([...sampleMask(48, 8)]);
  });
  it('rolls back the peak reservation when the existing JPEG decoder rejects dimensions', async () => {
    const budget = createPdfNativeImageSourceBudget(); await expect(readNative(await imagePdf({ source: { ...inputs[0], width: 49 } }), budget)).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0);
  });
  it('preflights large decoded-copy overlap before invoking a mismatching JPEG', async () => {
    const budget = createPdfNativeImageSourceBudget(); await expect(readNative(await imagePdf({ source: { ...inputs[0], width: 1_000_000, height: 25 } }), budget)).rejects.toMatchObject({ code: 'pdf_limit' }); expect(budget.bytes).toBe(0); expect(budget.peakBytes).toBe(0);
  });
  it('retains one buffer owner across aliases and releases safely after transfer detaches bytes', () => {
    const budget = createPdfNativeImageSourceBudget(), image = smallImage(), second = { ...image };
    budget.reserve(20, 40, 4).commit(image); budget.reserve(20, 40, 4).commit(second); expect(budget.bytes).toBe(20); expect(budget.pixels).toBe(8);
    const payload = { commands: [{ op: 'nativeImage', ...image }, { op: 'group', commands: [{ op: 'nativeImage', ...second }] }] }, buffers = pdfPayloadBuffers(payload);
    expect(buffers).toHaveLength(2); const copied = structuredClone(payload, { transfer: buffers }); expect(copied.commands[0].bytes).toHaveLength(16); expect(copied.commands[0].softMask.bytes).toHaveLength(4); expect(image.bytes.byteLength).toBe(0);
    budget.release(image); expect(budget.bytes).toBe(20); budget.destroy(); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0);
  });
  it('enforces the exact96MiB source and32M image limits and pending-reservation cleanup', () => {
    const budget = createPdfNativeImageSourceBudget(), full = budget.reserve(96 * 1024 * 1024, 96 * 1024 * 1024, 32_000_000);
    expect(() => budget.reserve(1, 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_limit' })); full.rollback(); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0);
    expect(() => budget.reserve(1, 96 * 1024 * 1024 + 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_limit' }));
    budget.reserve(4, 8, 1); budget.destroy(); expect(budget.bytes).toBe(0); expect(budget.pixels).toBe(0); expect(() => budget.reserve(1, 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_closed' }));
  });
});

describe('bounded nearest native CMYKA projection', () => {
  it('keeps all four native inks and independent alpha with sourceY orientation', () => {
    const image = smallImage(), budget = { pixels: 0 }, sampler = createPdfNativeCmykImageSampler(image, settings(budget)), band = sampler.sampleBand(0, 0, 2, 2);
    near([...band.data], expected(image, [0, 1, 2, 3])); expect(budget.pixels).toBe(20); expect(budget.shadingPixels).toBe(4); band.release(); sampler.destroy(); expect(budget.pixels).toBe(0);
  });
  it('projects the actual negativeX orientation and a separately supplied page transform', () => {
    const image = smallImage(), budget = { pixels: 0 }, sampler = createPdfNativeCmykImageSampler(image, { ...settings(budget), imageMatrix: [-2, 0, 0, 2, 2, 0], pageTransform: [1, 0, 0, -1, 0, 2] });
    const band = sampler.sampleBand(0, 0, 2, 2); near([...band.data], expected(image, [1, 0, 3, 2])); sampler.destroy(); expect(budget.pixels).toBe(0);
  });
  it('edge-pads samples while leaving the true imagequad/clip coverage to the caller', () => {
    const image = smallImage(), sampler = createPdfNativeCmykImageSampler(image, settings({ pixels: 0 })), band = sampler.sampleBand(10, 10, 1, 1);
    near([...band.data], expected(image, [3])); sampler.destroy();
  });
  it.each([{ softMask: false }, { components: 3 }, { bits: 16 }, { interpolate: true }, { bytes: Uint8Array.of() }, { softMask: { width: 1, height: 1, components: 1, bits: 8, bytes: Uint8Array.of(255) } }])('rejects malformed direct descriptor before band allocation: %j', change => {
    const budget = { pixels: 0 }; expect(() => createPdfNativeCmykImageSampler({ ...smallImage(), ...change }, settings(budget))).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' })); expect(budget.pixels).toBe(0);
  });
  it.each([[0, 0, 0, 0, 0, 0], [Infinity, 0, 0, 1, 0, 0], [1, 2]])('rejects invalid image transforms %j', imageMatrix => {
    expect(() => createPdfNativeCmykImageSampler(smallImage(), { ...settings({ pixels: 0 }), imageMatrix })).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' }));
  });
  it('permits one live band, releases its five-unit reservation once and checks use after destroy', () => {
    const budget = { pixels: 0 }, sampler = createPdfNativeCmykImageSampler(smallImage(), settings(budget)), band = sampler.sampleBand(0, 0, 1, 1);
    expect(() => sampler.sampleBand(0, 0, 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_corrupt' })); band.release(); band.release(); expect(budget.pixels).toBe(0); sampler.destroy(); expect(() => sampler.sampleBand(0, 0, 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_closed' }));
  });
  it('shares live16M units and cumulative64M work without a second image allowance', () => {
    const budget = { pixels: 15_999_995, shadingPixels: 63_999_999 }, sampler = createPdfNativeCmykImageSampler(smallImage(), settings(budget)), band = sampler.sampleBand(0, 0, 1, 1);
    expect(budget.pixels).toBe(16_000_000); expect(budget.shadingPixels).toBe(64_000_000); band.release(); expect(() => sampler.sampleBand(0, 0, 1, 1)).toThrowError(expect.objectContaining({ code: 'pdf_limit' })); expect(budget.pixels).toBe(15_999_995); sampler.destroy();
  });
  it('bounds bands and releases temporary storage when cancellation interrupts projection', () => {
    const budget = { pixels: 0 }; let checks = 0;
    const sampler = createPdfNativeCmykImageSampler(smallImage(), { ...settings(budget), cancellation() { if (++checks === 3) throw new Error('cancelled'); } });
    expect(() => sampler.sampleBand(0, 0, 262145, 1)).toThrowError(expect.objectContaining({ code: 'pdf_limit' })); expect(() => sampler.sampleBand(0, 0, 8192, 1)).toThrow('cancelled'); expect(budget.pixels).toBe(0); expect(checks).toBe(3); sampler.destroy();
  });
});
