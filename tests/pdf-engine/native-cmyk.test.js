import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { resolvePdfColorSpace, deviceGray, deviceRgb } from '../../src/pdf/color-spaces.js';
import { createPdfCmykConverter, createPdfPrintStateReader, PDF_CMYK_PRINT_DEFAULTS } from '../../src/pdf/native-cmyk.js';
import { options, simplePdf, stream } from './fixtures.js';

const native = { name: 'DeviceCMYK', components: 4 };
const square = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>';
const half = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [.5] /N 1 >>';
const negative = '<< /FunctionType 2 /Domain [0 1] /C0 [-.25] /C1 [-.25] /N 1 >>';
const zero = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0] /N 1 >>';
const close = (actual, expected) => { expect(actual).toHaveLength(expected.length); actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 14)); };
async function withReader(extra, run, page = '') {
  const reader = await NativePdfReader.create(simplePdf('', { extra, page }), options);
  const object = number => reader.checked(reader.api.pn_pdf_resolve(number, 0));
  try { return await run(reader, object); } finally { reader.destroy(); }
}
async function withSpace(definition, extra, run) {
  return withReader([definition, ...extra], async (reader, object) => run(await resolvePdfColorSpace(reader, 0, object(6), options.loadAsset)));
}

describe('native four-component CMYK colour foundation', () => {
  it('retains four independent inks and maps unremapped Gray to K only', () => {
    const convert = createPdfCmykConverter();
    expect(convert(native, [.2, .3, .4, .5])).toEqual([.2, .3, .4, .5]);
    expect(convert(native, [-1, 2, .25, .75])).toEqual([0, 1, .25, .75]);
    expect(convert(deviceGray(), [.25])).toEqual([0, 0, 0, .75]);
    expect(convert(deviceGray(), [2])).toEqual([0, 0, 0, 0]);
    expect(convert(deviceGray(), [-1])).toEqual([0, 0, 0, 1]);
  });

  it('implements the independently frozen rational RGB defaults and returns fresh values', () => {
    const source = deviceRgb(); source.convert = () => { throw new Error('Display RGB round trip is forbidden.'); };
    const values = [.2, .7, .4], convert = createPdfCmykConverter();
    close(convert(source, values), [.5, 0, .3, .3]);
    expect(values).toEqual([.2, .7, .4]);
    const first = convert(source, values); first[0] = 99;
    close(convert(source, values), [.5, 0, .3, .3]);
    close(convert(source, [-.5, 1.5, .2]), [1, 0, .8, 0]);
  });

  it('uses effective nonlinear BG/UCR at paint time, with immutable restorable snapshots', async () => {
    await withReader(['<< /BG 8 0 R /UCR 9 0 R >>', '<< /BG2 /Default /UCR2 /Default >>', square, half], async (reader, object) => {
      const read = createPdfPrintStateReader(reader), convert = createPdfCmykConverter(), selectedBeforeGs = [.2, .7, .4];
      const saved = PDF_CMYK_PRINT_DEFAULTS, active = await read(object(6), saved);
      expect(Object.isFrozen(active)).toBe(true); expect(active).not.toBe(saved);
      close(convert(deviceRgb(), selectedBeforeGs, active), [.65, .15, .45, .09]);
      close(convert(deviceRgb(), selectedBeforeGs, saved), [.5, 0, .3, .3]);
      const reset = await read(object(7), active);
      expect(reset).toEqual(PDF_CMYK_PRINT_DEFAULTS);
      close(convert(deviceRgb(), selectedBeforeGs, reset), [.5, 0, .3, .3]);
      close(convert(deviceRgb(), selectedBeforeGs, active), [.65, .15, .45, .09]);
    });
  });

  it('retains negative UCR and clips final native components, rather than clipping UCR', async () => {
    await withReader(['<< /BG 7 0 R /UCR 8 0 R >>', zero, negative], async (reader, object) => {
      const print = await createPdfPrintStateReader(reader)(object(6));
      close(createPdfCmykConverter()(deviceRgb(), [.2, .7, .4], print), [1, .55, .85, 0]);
    });
    await withReader(['<< /BG 7 0 R /UCR 8 0 R >>', '<< /FunctionType 2 /Domain [0 1] /C0 [2] /C1 [2] /N 1 >>', negative], async (reader, object) => {
      const print = await createPdfPrintStateReader(reader)(object(6));
      close(createPdfCmykConverter()(deviceRgb(), [.2, .7, .4], print), [1, .55, .85, 1]);
    });
  });

  it('honors modern precedence, optional null, Identity and absent-state inheritance', async () => {
    await withReader([
      '<< /BG /Invalid /BG2 11 0 R /UCR /Invalid /UCR2 12 0 R >>',
      '<< /BG 11 0 R /BG2 null /UCR 12 0 R /UCR2 null >>', '<< /BG null /UCR2 null >>',
      '<< /BG2 /Identity /UCR2 /Identity >>', '<< >>', square, half,
    ], async (reader, object) => {
      const read = createPdfPrintStateReader(reader), first = await read(object(6));
      expect(await read(object(7))).toEqual(first);
      expect(await read(object(8), first)).toBe(first);
      expect(await read(object(10), first)).toBe(first);
      expect(await read(object(9), first)).toEqual(PDF_CMYK_PRINT_DEFAULTS);
      expect((await read(object(6))).blackGeneration).toBe(first.blackGeneration);
    });
  });

  it('keeps All in every native ink independently of its ignored alternate', async () => {
    await withSpace('[/Separation /All /DeviceRGB 7 0 R]', [square], space => {
      expect(createPdfCmykConverter()(space, [.3])).toEqual([.3, .3, .3, .3]);
      expect(createPdfCmykConverter()(space, [0])).toEqual([0, 0, 0, 0]);
      expect(createPdfCmykConverter()(space, [1])).toEqual([1, 1, 1, 1]);
    });
  });

  it('evaluates Separation and DeviceN alternates before native conversion', async () => {
    await withSpace('[/Separation /Ink /DeviceRGB 7 0 R]', ['<< /FunctionType 2 /Domain [0 1] /C0 [1 .5 0] /C1 [0 .25 1] /N 2 >>'], space => {
      expect(space.alternate.name).toBe('DeviceRGB'); expect(space.tintTransform.outputs).toBe(3);
      close(createPdfCmykConverter()(space, [.5]), [0, .3125, .5, .25]);
    });
    await withSpace('[/DeviceN [/A /B] /DeviceRGB 7 0 R]', [stream('{1 exch sub 1 exch sub .25}', '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]')], space => {
      close(createPdfCmykConverter()(space, [.2, .7]), [.5, 0, .45, .3]);
    });
    await withSpace('[/Separation /Ink /DeviceGray 7 0 R]', [square], space => {
      close(createPdfCmykConverter()(space, [.5]), [0, 0, 0, .75]);
    });
  });

  it('uses owned bounded indexed samples without converting its CMYK palette through RGB', async () => {
    await withSpace('[/Indexed /DeviceCMYK 1 <00000000004080ffdeadbeef>]', [], space => {
      expect(space.lookup).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 64, 128, 255));
      expect(space.lookup.buffer.byteLength).toBe(8); expect(space.lookup.byteOffset).toBe(0);
      close(createPdfCmykConverter()(space, [1]), [0, 64 / 255, 128 / 255, 1]);
      expect(createPdfCmykConverter()(space, [-1])).toEqual([0, 0, 0, 0]);
      close(createPdfCmykConverter()(space, [9]), [0, 64 / 255, 128 / 255, 1]);
    });
  });

  it('resolves Default* before native admission and refuses calibrated replacements without a fake inverse', async () => {
    const definition = '[/CalRGB << /WhitePoint [.9505 1 1.089] >>]';
    await withReader([definition], async (reader, object) => {
      const page = object(3), resources = reader.field(page, 'Resources');
      const resolved = await resolvePdfColorSpace(reader, resources, 'DeviceRGB', options.loadAsset);
      expect(resolved.name).toBe('CalRGB');
      expect(() => createPdfCmykConverter()(resolved, [.2, .7, .4])).toThrow(expect.objectContaining({ code: 'pdf_unsupported' }));
    }, '/Resources << /ColorSpace << /DefaultRGB 6 0 R >> >>');
  });

  it('charges the shared work owner exactly once before any tint/function evaluation', () => {
    let calls = 0;
    const convert = createPdfCmykConverter(() => { calls++; });
    expect(convert(native, [0, 0, 0, 1])).toEqual([0, 0, 0, 1]); expect(calls).toBe(1);
    const stop = new Error('shared pixel limit');
    expect(() => createPdfCmykConverter(() => { throw stop; })({ name: 'DeviceRGB', components: 3 }, [0, 0, 0], { blackGeneration: { inputs: 1, outputs: 1 }, undercolorRemoval: null })).toThrow(stop);
  });

  it.each([null, [], [0], [0, 1, 2], [0, 0, 0, NaN], [0, 0, 0, Infinity]])('rejects malformed native component input %s', values => {
    expect(() => createPdfCmykConverter()(native, values)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });

  it('preserves explicit source-family, dimensional, cycle and nonfinite function errors', () => {
    const convert = createPdfCmykConverter();
    expect(() => convert({ name: 'ICCBased', components: 4 }, [0, 0, 0, 1])).toThrow(expect.objectContaining({ code: 'pdf_unsupported' }));
    expect(() => convert(deviceRgb(), [.2, .7, .4], { blackGeneration: { inputs: 2, outputs: 1 }, undercolorRemoval: null })).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    for (const invalid of [0, false, undefined, 'Default']) expect(() => convert(deviceRgb(), [.2, .7, .4], { blackGeneration: invalid, undercolorRemoval: null })).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => convert({ name: 'DeviceRGB', components: 4 }, [0, 0, 0, 1])).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => convert({ name: 'Separation', components: 1 }, [.5])).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    const cyclic = { name: 'Indexed', components: 1, high: 0, lookup: new Uint8Array(1) }; cyclic.base = cyclic;
    expect(() => convert(cyclic, [0])).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
  });

  it('bounds retained descriptors including the sampled compiler expansion, before a second large legal function', async () => {
    const samples = new Uint8Array(4_000_000), fn = stream(samples, '/FunctionType 0 /Domain [0 1] /Range [0 1] /BitsPerSample 8 /Size [4000000]');
    await withReader(['<< /BG 8 0 R >>', '<< /UCR 9 0 R >>', fn, fn], async (reader, object) => {
      const read = createPdfPrintStateReader(reader), first = await read(object(6));
      expect(await read(object(6), first)).toBe(first);
      await expect(read(object(7), first)).rejects.toMatchObject({ code: 'pdf_limit', message: expect.stringContaining('print function byte') });
      expect(await read(object(6), first)).toBe(first);
    });
  });

  it('keeps other unsupported page group spaces closed', async () => {
    const core = await createPdfDocumentCore(simplePdf('0 g 0 0 10 10 re f', { page: '/Group << /S /Transparency /CS /DeviceGray >>' }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('group blend color') }); }
    finally { core.destroy(); }
  });
});
