import { describe, expect, it } from 'vitest';
import { createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { deviceGray } from '../../src/pdf/color-spaces.js';
import { syntheticRgbProfile, SYNTHETIC_MATRIX } from './icc-fixture.js';
import { pdf, stream, options } from './fixtures.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
function descriptor(gray = .5, changes = {}) {
  const profileBytes = syntheticRgbProfile();
  return { type: 'Luminosity', profileBytes, backdrop: [0, 0, 0], bbox: [-32768, -32768, 32767, 32767], matrix: IDENTITY,
    shading: { type: 2, coords: [0, 0, 100, 0], domain: [0, 1], box: null, extend: [true, true], matrix: IDENTITY,
      colorSpace: { name: 'DeviceGray' }, functions: [{ type: 2, domain: [0, 1], range: null, inputs: 1, outputs: 1, c0: [gray], c1: [gray], exponent: 1 }] }, ...changes };
}
const sample = value => createPdfGroupSoftMaskSampler(value).sampleBand(0, 0, 1, 1)[0];

describe('uncalibrated DeviceGray luminosity-mask policy', () => {
  it.each([0, .1, .25, .5, .75, 1])('maps gray %s to neutral PCS Y through the nonlinear group inverse', gray => {
    expect(sample(descriptor(gray))).toBeCloseTo(gray, 12);
  });
  it('normalizes actual encoded-white Y, while preserving inverse gamut clipping', () => {
    const profileBytes = syntheticRgbProfile({ matrix: SYNTHETIC_MATRIX.map(n => n * .5) });
    expect(sample(descriptor(.25, { profileBytes }))).toBeCloseTo(.25, 12);
    // This authored profile has encoded-white Y=.5. No forced final alpha=.75.
    expect(sample(descriptor(.75, { profileBytes }))).toBeCloseTo(.5, 12);
  });
  it('mixes fractional coverage with nonblack BC in encoded ICC before extracting Y', () => {
    const values = createPdfGroupSoftMaskSampler(descriptor(.5, { bbox: [.5, 0, 1.5, 1], backdrop: [.25, .35, .2] })).sampleBand(0, 0, 3, 1);
    const coefficients = [.27, .67, .06].map(n => Math.round(n * 65536) / 65536), bc = [.25, .35, .2];
    const mixedY = coefficients.reduce((sum, n, i) => sum + n * ((Math.sqrt(.5) + bc[i]) / 2) ** 2, 0);
    const backdropY = coefficients.reduce((sum, n, i) => sum + n * bc[i] ** 2, 0);
    expect(values[0]).toBeCloseTo(mixedY, 12); expect(values[1]).toBeCloseTo(mixedY, 12); expect(values[2]).toBeCloseTo(backdropY, 12);
    expect(values[0]).not.toBeCloseTo((.5 + backdropY) / 2, 3);
  });
  it('preserves an ICCBased source and ordinary device-gray conversions', () => {
    const mask = descriptor(), profileBytes = mask.profileBytes;
    mask.shading.colorSpace = { name: 'ICCBased', profileBytes };
    mask.shading.functions[0] = { ...mask.shading.functions[0], outputs: 3, c0: [.5, .5, .5], c1: [.5, .5, .5] };
    expect(sample(mask)).toBeCloseTo(.25, 12);
    expect(deviceGray().toXyz([.5])[1]).toBeCloseTo(.214, 3);
  });
  it('applies the same policy to the admitted concentric radial sampler', () => {
    const mask = descriptor(.5); mask.shading.type = 3; mask.shading.coords = [0, 0, 0, 0, 0, 10];
    expect(sample(mask)).toBeCloseTo(.5, 12);
  });
  it('rejects a nonpositive group white before returning even an outside-BC sample', () => {
    const matrix = SYNTHETIC_MATRIX.map((n, i) => i >= 3 && i < 6 ? -n : n);
    expect(() => sample(descriptor(.5, { profileBytes: syntheticRgbProfile({ matrix }), bbox: [50, 50, 60, 60] }))).toThrow(/group white luminance/);
  });
  it('rejects a non-finite normalized white direction before sampling', () => {
    const mask = descriptor(), profileCache = new WeakMap();
    profileCache.set(mask.profileBytes, { channels: 3, fromXyz: values => values, toXyz: () => [1, Number.MIN_VALUE, 1] });
    expect(() => createPdfGroupSoftMaskSampler(mask, { profileCache })).toThrow(/neutral direction/);
  });
  it('respects DefaultGray remapping and keeps the existing unsupported calibrated-source boundary', async () => {
    const profile = syntheticRgbProfile();
    const bytes = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /ExtGState << /A 5 0 R >> /XObject << /T 10 0 R >> >> >>',
      stream('/A gs /T Do'), '<< /SMask << /S /Luminosity /G 6 0 R >> >>',
      stream('q /Perceptual ri /R gs 1 0 0 1 0 0 cm BX /S sh EX Q', '/Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS [/ICCBased 7 0 R] >> /Resources << /ColorSpace << /DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] /Gamma 2 >>] >> /ExtGState << /R 11 0 R >> /Shading << /S 8 0 R >> >>'),
      stream(profile, '/N 3'), '<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 100 0] /Extend [true true] /Function 9 0 R >>',
      '<< /FunctionType 2 /Domain [0 1] /C0 [.5] /C1 [.5] /N 1 >>', stream('0 0 100 100 re f', '/Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >>'),
      '<< /ca 1 /CA 1 /BM /Normal /SMask /None >>',
    ]);
    const core = await createPdfDocumentCore(bytes, options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('CalGray') }); }
    finally { core.destroy(); }
  });
});
