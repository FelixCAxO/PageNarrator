import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { resolvePdfColorSpace } from '../../src/pdf/color-spaces.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options } from './fixtures.js';

const tint = stream('{1 exch sub 1 exch sub .25}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]');
async function resolve(space, fn = tint) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [space, fn] }), options);
  try { return await resolvePdfColorSpace(reader, 0, reader.checked(reader.api.pn_pdf_resolve(6, 0)), options.loadAsset); }
  finally { reader.destroy(); }
}

describe('DeviceN composite alternate colours', () => {
  it('evaluates all named components in order, clips tints and preserves PCS conversion', async () => {
    const space = await resolve('[/DeviceN [/InkA /InkB] /DeviceRGB 7 0 R]');
    expect(space).toMatchObject({ name: 'DeviceN', components: 2, colorants: ['InkA', 'InkB'], initialValues: [1, 1] });
    expect(space.convert([.2, .7])).toEqual([.2, .7, .25]);
    expect(space.convert([-1, 2])).toEqual([0, 1, .25]);
    expect(space.toXyz([.2, .7])).toHaveLength(3);
    for (const values of [null, [], [0], [0, 1, 2], [NaN, 0], [Infinity, 0]]) expect(() => space.convert(values)).toThrow(/tint/);
  });

  it.each(['', '<< /Subtype /DeviceN >>', '<< /Subtype /NChannel >>', '<< /Subtype null >>'])('uses the declared composite fallback with attributes %s', async attributes => {
    const space = await resolve(`[/DeviceN [/InkA /InkB] /DeviceRGB 7 0 R ${attributes}]`);
    expect(space.convert([.25, .75])).toEqual([.25, .75, .25]);
  });

  it('passes a partial None component to the tint transform as specified', async () => {
    const space = await resolve('[/DeviceN [/None /None /Ink] /DeviceRGB 7 0 R]', stream('{}', '/FunctionType 4 /Domain [0 1 0 1 0 1] /Range [0 1 0 1 0 1]'));
    expect(space.convert([.2, .4, .6])).toEqual([.2, .4, .6]);
  });

  it('carries initial and supplied tints into fill, stroke and page extraction', async () => {
    const core = await createPdfDocumentCore(simplePdf('/Ink cs 10 10 20 20 re f .2 .7 scn /Ink CS .2 .7 SCN 10 10 m 30 30 l S BT /F1 12 Tf (Two inks) Tj ET', {
      page: '/Resources << /Font << /F1 5 0 R >> /ColorSpace << /Ink [/DeviceN [/InkA /InkB] /DeviceRGB 6 0 R] >> >>', extra: [tint],
    }), options);
    try {
      const payload = await core.pagePayload(1);
      expect(payload.items[0].str).toBe('Two inks');
      expect(payload.commands.filter(command => command.op === 'color')).toContainEqual({ op: 'color', fill: true, value: 'rgb(255,255,64)', nativeColor: [1, 1, .25] });
      expect(payload.commands.filter(command => command.op === 'color').at(-1)).toEqual({ op: 'color', fill: false, value: 'rgb(51,179,64)', nativeColor: [expect.closeTo(.2, 14), expect.closeTo(.7, 14), .25] });
    } finally { core.destroy(); }
  });

  it.each([
    '[/DeviceN [] /DeviceRGB 7 0 R]', '[/DeviceN [/Ink /Ink] /DeviceRGB 7 0 R]', '[/DeviceN [/All /Ink] /DeviceRGB 7 0 R]',
    '[/DeviceN [42 /Ink] /DeviceRGB 7 0 R]', '[/DeviceN [/InkA /InkB] /DeviceRGB 7 0 R 42]',
    '[/DeviceN [/InkA /InkB] /DeviceRGB 7 0 R << /Subtype /Other >>]', '[/DeviceN [/None /Ink] /DeviceRGB 7 0 R << /Subtype /NChannel >>]',
    '[/DeviceN [/Ink] /DeviceRGB 7 0 R]', '[/DeviceN [/InkA /InkB] /DeviceGray 7 0 R]',
  ])('rejects malformed names, attributes or function dimensions: %s', async definition => {
    await expect(resolve(definition)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('retains the existing function dimensional budget and explicit all-None limitation', async () => {
    await expect(resolve('[/DeviceN [/A /B /C /D /E] /DeviceRGB 7 0 R]')).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(resolve('[/DeviceN [/None /None] /DeviceRGB 7 0 R]')).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
