import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { rgbToXyzD50 } from '../../src/pdf/icc-color.js';
import { convertPdfColor } from '../../src/pdf/icc-blend.js';
import { simplePdf, stream, options } from './fixtures.js';

const exponential = '<< /FunctionType 2 /Domain [0 1] /C0 [1 .5 0] /C1 [0 .25 1] /N 2 >>';
async function resolve(space, extra = []) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [space, ...extra] }), options);
  try { return await resolvePdfColorSpace(reader, 0, reader.checked(reader.api.pn_pdf_resolve(6, 0)), options.loadAsset); }
  finally { reader.destroy(); }
}

describe('named Separation colours through the declared alternate space', () => {
  it('evaluates a nonlinear tint rather than treating its one input as gray', async () => {
    const space = await resolve('[/Separation /LogoInk /DeviceRGB 7 0 R]', [exponential]);
    expect(space).toMatchObject({ name: 'Separation', colorant: 'LogoInk', components: 1, initialValues: [1] });
    expect(space.convert([0])).toEqual([1, .5, 0]);
    expect(space.convert([.5])).toEqual([.75, .4375, .25]);
    expect(space.convert([1])).toEqual([0, .25, 1]);
    expect(space.convert([-1])).toEqual(space.convert([0]));
    expect(space.convert([2])).toEqual(space.convert([1]));
    for (const values of [[NaN], [Infinity], [], [0, 1], null]) expect(() => space.convert(values)).toThrow(/tint/);
    expect(space.toXyz([.5])).toHaveLength(3);
  });

  it('interpolates four-channel sampled tints and uses the existing CMYK profile', async () => {
    const samples = Uint8Array.of(0, 0, 0, 0, 0, 64, 128, 255);
    const space = await resolve('[/Separation /Ink /DeviceCMYK 7 0 R]', [stream(samples, '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1 0 1] /Size [2] /BitsPerSample 8')]);
    const profile = parseIccProfile(await options.loadAsset('iccs/CGATS001Compat-v2-micro.icc'));
    for (const tint of [0, .25, .5, .75, 1]) {
      const expected = [0, tint * 64 / 255, tint * 128 / 255, tint];
      space.convert([tint]).forEach((value, i) => expect(value).toBeCloseTo(profile.convert(expected)[i], 12));
      space.toXyz([tint]).forEach((value, i) => expect(value).toBeCloseTo(profile.toXyz(expected)[i], 12));
    }
  });

  it('resolves resource aliases and carries the tint into actual path and text colours', async () => {
    const data = simplePdf('/Spot cs .5 scn 10 10 20 20 re f BT /F1 12 Tf 1 0 0 1 54 700 Tm (Spot text) Tj ET', {
      page: '/Resources << /Font << /F1 5 0 R >> /ColorSpace << /Spot [/Separation /LogoInk /Alternate 6 0 R] /Alternate /DeviceRGB >> >>', extra: [exponential],
    });
    const core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.commands.filter(command => command.op === 'color').at(-1)).toMatchObject({ fill: true, value: 'rgb(191,112,64)' });
      expect(payload.items.map(item => item.str).join('')).toBe('Spot text');
    } finally { core.destroy(); }
  });

  it('starts fill and stroke at the maximum Separation tint before any scn operator', async () => {
    const core = await createPdfDocumentCore(simplePdf('/Spot cs 10 10 20 20 re f /Spot CS 10 10 m 30 30 l S', {
      page: '/Resources << /ColorSpace << /Spot [/Separation /LogoInk /DeviceRGB 6 0 R] >> >>', extra: [exponential],
    }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.commands.filter(command => command.op === 'color')).toEqual([
        { op: 'color', fill: true, value: 'rgb(0,64,255)', nativeColor: [0, .25, 1] },
        { op: 'color', fill: false, value: 'rgb(0,64,255)', nativeColor: [0, .25, 1] },
      ]);
    } finally { core.destroy(); }
  });

  it('maps All to complemented display channels and PCS while ignoring the alternate tint function', async () => {
    const space = await resolve('[/Separation /All /DeviceRGB 7 0 R]', [exponential]);
    const target = { channels: 3, fromXyz: xyz => xyz.map((value, i) => value * (i + 1)) };
    for (const tint of [0, .25, .5, .75, 1]) {
      const rgb = [1 - tint, 1 - tint, 1 - tint];
      expect(space.convert([tint])).toEqual(rgb);
      expect(space.toXyz([tint])).toEqual(rgbToXyzD50(rgb));
      expect(convertPdfColor(space, [tint], target)).toEqual(target.fromXyz(rgbToXyzD50(rgb)));
    }
    expect(space.convert([-1])).toEqual([1, 1, 1]); expect(space.convert([2])).toEqual([0, 0, 0]);
    for (const values of [[NaN], [Infinity], [], [0, 1], null]) expect(() => space.toXyz(values)).toThrow(/tint/);
  });

  it('does not execute a valid calculator alternate function for All', async () => {
    const space = await resolve('[/Separation /All /DeviceRGB 7 0 R]', [stream('{pop 1 0 0}', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]')]);
    expect(space.convert([.25])).toEqual([.75, .75, .75]);
  });

  it('paints initial All as black and subsequent tints as gray in both stroke and fill', async () => {
    const core = await createPdfDocumentCore(simplePdf('/Spot cs 10 10 20 20 re f .5 scn 30 10 20 20 re f /Spot CS 10 10 m 30 30 l S', {
      page: '/Resources << /ColorSpace << /Spot [/Separation /All /DeviceRGB 6 0 R] >> >>', extra: [exponential],
    }), options);
    try {
      const colors = (await core.pagePayload(1)).commands.filter(command => command.op === 'color');
      expect(colors).toEqual([{ op: 'color', fill: true, value: 'rgb(0,0,0)', nativeColor: [0, 0, 0] }, { op: 'color', fill: true, value: 'rgb(128,128,128)', nativeColor: [.5, .5, .5] }, { op: 'color', fill: false, value: 'rgb(0,0,0)', nativeColor: [0, 0, 0] }]);
    } finally { core.destroy(); }
  });

  it.each([
    ['[/Separation /Ink /DeviceRGB]', [], 'pdf_corrupt'],
    ['[/Separation (Ink) /DeviceRGB 7 0 R]', [exponential], 'pdf_corrupt'],
    ['[/Separation /Ink [/Indexed /DeviceRGB 0 <000000>] 7 0 R]', [exponential], 'pdf_corrupt'],
    ['[/Separation /Ink /DeviceRGB 7 0 R]', ['<< /FunctionType 2 /Domain [0 1] /N 1 >>'], 'pdf_corrupt'],
    ['[/Separation /Ink /DeviceRGB 7 0 R]', [stream(Uint8Array.of(0, 0, 0), '/FunctionType 0 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] /Size [1 1] /BitsPerSample 8')], 'pdf_corrupt'],
    ['[/Separation /Ink /DeviceRGB 7 0 R]', [stream('{exec}', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]')], 'pdf_corrupt'],
    ['[/Separation /None /DeviceRGB 7 0 R]', [exponential], 'pdf_unsupported'],
    ['[/Separation /All 123 7 0 R]', [exponential], 'pdf_corrupt'],
    ['[/Separation /All /DeviceRGB (not a function)]', [], 'pdf_corrupt'],
  ])('rejects malformed or unsupported spot definitions without substituting a colour', async (space, extra, code) => {
    await expect(resolve(space, extra)).rejects.toMatchObject({ code });
  });
});
