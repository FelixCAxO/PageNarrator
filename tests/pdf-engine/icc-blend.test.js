import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseIccProfile, rgbToXyzD50, xyzD50ToRgb } from '../../src/pdf/icc-color.js';
import { convertPdfColor, convertBlendPixels } from '../../src/pdf/icc-blend.js';
import { deviceRgb } from '../../src/pdf/color-spaces.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { syntheticRgbProfile, iccBlendPdf } from './icc-fixture.js';
import { options, simplePdf, stream } from './fixtures.js';
const oracle = JSON.parse(await readFile(new URL('./fixtures/icc-blending-oracle.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

describe('original ICC numeric blending space', () => {
  it('round trips the default display PCS without clipping in the inverse matrix', () => {
    for (const values of [[0, 0, 0], [1, 1, 1], [1, 0, .3], [.001, .04, .7], [.9, .6, .2]]) {
      xyzD50ToRgb(rgbToXyzD50(values)).forEach((n, i) => expect(n).toBeCloseTo(values[i], 10));
    }
  });
  const curves = [
    { gamma: null }, { gamma: 2 }, { samples: [0, 4096, 16384, 36864, 65535] },
    { kind: 0, parameters: [2] }, { kind: 1, parameters: [2, .9, .1] },
    { kind: 2, parameters: [2, .8, .1, .05] },
    { kind: 3, parameters: [2, 1, 0, .1, .1] },
    { kind: 4, parameters: [2, 1, 0, .1, .1, .02, .02] },
  ];
  it.each(curves)('inverts the encoded monotone curve %j through unclipped XYZ', curve => {
    const profile = parseIccProfile(syntheticRgbProfile({ curve }));
    for (const values of [[.03, .09, .7], [.2, .5, .8], [0, 0, 0], [1, 1, 1]]) {
      profile.fromXyz(profile.toXyz(values)).forEach((value, i) => expect(value).toBeCloseTo(values[i], 6));
    }
  });
  it('does not manufacture an inverse for a nonmonotone lookup curve', () => {
    const profile = parseIccProfile(syntheticRgbProfile({ curve: { samples: [0, 40000, 10000, 65535] } }));
    expect(profile.fromXyz).toBeNull(); expect(profile.convert([.1, .2, .3]).every(Number.isFinite)).toBe(true);
    expect(() => convertPdfColor(deviceRgb(), [.2, .4, .6], profile)).toThrow(/inverse/);
  });
  it('preserves forward-only source profiles with singular colorants', () => {
    const profile = parseIccProfile(syntheticRgbProfile({ matrix: [.4, .4, .4, .3, .3, .3, .2, .2, .2] }));
    expect(profile.fromXyz).toBeNull(); expect(profile.convert([.1, .2, .3]).every(Number.isFinite)).toBe(true);
    expect(() => convertPdfColor(deviceRgb(), [.2, .4, .6], profile)).toThrow(/inverse/);
  });
  it('matches frozen independent LittleCMS colors in both directions', () => {
    const profileBytes = syntheticRgbProfile(); expect(sha256(profileBytes)).toBe(oracle.profileSha256);
    const profile = parseIccProfile(profileBytes); let maximumForward = 0, maximumInverse = 0;
    oracle.colors.forEach((color, index) => {
      const input = color.map(n => n / 255), forward = profile.convert(input), inverse = convertPdfColor(deviceRgb(), input, profile);
      for (let channel = 0; channel < 3; channel++) {
        maximumForward = Math.max(maximumForward, Math.abs(Math.round(forward[channel] * 255) - oracle.toSrgb[index][channel]));
        maximumInverse = Math.max(maximumInverse, Math.abs(Math.round(inverse[channel] * 255) - oracle.fromSrgb[index][channel]));
      }
    });
    expect(maximumForward).toBeLessThanOrEqual(oracle.maximumColorChannelError);
    expect(maximumInverse).toBeLessThanOrEqual(oracle.maximumColorChannelError);
  });
  it('retains out-of-display-gamut PCS and alpha when converting group pixels', () => {
    const profile = parseIccProfile(syntheticRgbProfile()), values = [0, 1, 0];
    const encoded = convertPdfColor(profile, values, profile);
    encoded.forEach((n, i) => expect(n).toBeCloseTo(values[i], 7));
    expect(profile.fromXyz(rgbToXyzD50(profile.convert(values)))[0]).toBeGreaterThan(.1);
    const pixels = Uint8ClampedArray.of(50, 125, 220, 128, 30, 45, 60, 0);
    const expected = profile.convert([50 / 255, 125 / 255, 220 / 255]).map(n => Math.round(n * 255));
    expect([...convertBlendPixels(pixels, profile)]).toEqual([...expected, 128, 30, 45, 60, 0]);
  });
  it('carries explicit group profiles, inherited colors and profile-specific image cache entries', async () => {
    const core = await createPdfDocumentCore(iccBlendPdf(), options);
    try {
      const payload = await core.pagePayload(1), groups = payload.commands.filter(c => c.op === 'group');
      expect(groups).toHaveLength(2); expect(groups[0].colorProfile).toEqual(syntheticRgbProfile()); expect(groups[1].colorProfile).toBeNull();
      const initial = groups[0].commands.find(c => c.op === 'color' && c.fill);
      const profile = parseIccProfile(groups[0].colorProfile), expected = convertPdfColor(deviceRgb(), [.25, .45, .7], profile).map(n => Math.round(n * 255));
      expect(initial.value).toBe(`rgb(${expected.join(',')})`);
      const nested = groups[0].commands.find(c => c.op === 'group'); expect(nested.colorProfile).toBeNull();
      const wide = groups[0].commands.find(c => c.op === 'image'), rgb = groups[1].commands.find(c => c.op === 'image');
      expect(wide.pixels).not.toEqual(rgb.pixels); expect([...rgb.pixels]).toEqual([55, 120, 210, 255]);
    } finally { core.destroy(); }
  });
  it('converts one shared image resource independently in two blend spaces', async () => {
    const bytes = simplePdf('/F Do /R Do', { page: '/Resources << /XObject << /F 6 0 R /R 8 0 R >> >>', extra: [
      stream('/I Do', '/Subtype /Form /BBox [0 0 30 30] /Group << /S /Transparency /I true /CS [/ICCBased 7 0 R] >> /Resources 10 0 R'),
      stream(syntheticRgbProfile(), '/N 3'),
      stream('/I Do', '/Subtype /Form /BBox [0 0 30 30] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources 10 0 R'),
      stream(Uint8Array.of(55, 120, 210), '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
      '<< /XObject << /I 9 0 R >> >>',
    ] });
    const core = await createPdfDocumentCore(bytes, options);
    try {
      const groups = (await core.pagePayload(1)).commands.filter(c => c.op === 'group');
      const images = groups.map(group => group.commands.find(c => c.op === 'image'));
      expect(images[0].pixels).not.toEqual(images[1].pixels); expect([...images[1].pixels]).toEqual([55, 120, 210, 255]);
    } finally { core.destroy(); }
  });
  it('rejects a changed non-isolated blending space explicitly', async () => {
    const bytes = simplePdf('/F Do', { page: '/Resources << /XObject << /F 6 0 R >> >>', extra: [
      stream('0 0 20 20 re f', '/Subtype /Form /BBox [0 0 30 30] /Group << /S /Transparency /CS [/ICCBased 7 0 R] >>'), stream(syntheticRgbProfile(), '/N 3'),
    ] });
    const core = await createPdfDocumentCore(bytes, options);
    try { await expect(core.pagePayload(1)).rejects.toThrow(/Non-isolated.*change blend/); } finally { core.destroy(); }
  });
});
