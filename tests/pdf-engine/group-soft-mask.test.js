import { describe, expect, it } from 'vitest';
import { NativePdfReader, PdfEngineError } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { createPdfGroupSoftMaskContext, readPdfGroupSoftMask, createPdfGroupSoftMaskSampler } from '../../src/pdf/group-soft-mask.js';
import { pdfPayloadBuffers, pdfPayloadByteLength } from '../../src/pdf/payload-buffers.js';
import { radialParameter } from '../../src/pdf/shading.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { simplePdf, stream, options } from './fixtures.js';

const IDENTITY = [1, 0, 0, 1, 0, 0], profileBytes = syntheticRgbProfile();
const program = 'q /Perceptual ri /R gs 1 0 0 1 0 0 cm BX /S sh EX Q';
const exponential = (c0 = [.5, .5, .5], c1 = c0) => ({ type: 2, domain: [0, 1], range: null, inputs: 1, outputs: c0.length, c0, c1, exponent: 1 });
const descriptor = (overrides = {}) => ({ type: 'Luminosity', profileBytes, backdrop: [0, 0, 0], bbox: [-32768, 32767, 32767, -32768], matrix: IDENTITY,
  shading: { type: 2, coords: [0, 0, 240, 0], domain: [0, 1], box: null, extend: [true, true], functions: [exponential()], colorSpace: { name: 'ICCBased', profileBytes }, matrix: IDENTITY }, ...overrides });
function fixture({ artwork = program, dictionary = '', group = '/S /Transparency /CS [/ICCBased 8 0 R]', form = '', content = '', page = '',
  shader = '/ShadingType 2 /ColorSpace [/ICCBased 8 0 R] /Coords [0 0 240 0] /Extend [true true]',
  fn = '<< /FunctionType 2 /Domain [0 1] /C0 [.5 .5 .5] /C1 [.5 .5 .5] /N 1 >>',
  gs = '/BM /Normal /ca 1 /CA 1 /SMask /None', extra = [] } = {}) {
  return simplePdf(content, { page, extra: [
    `<< /S /Luminosity /G 7 0 R ${dictionary} >>`,
    stream(artwork, `/Type /XObject /Subtype /Form /BBox [0 0 240 140] /Group << ${group} >> /Resources << /ExtGState << /R 11 0 R >> /Shading << /S 9 0 R >> >> ${form}`),
    stream(profileBytes, '/N 3'), `<< ${shader} /Function 10 0 R >>`, fn, `<< ${gs} >>`, ...extra,
  ] });
}
async function readMask(changes, run = value => value, { ctm = IDENTITY, configure = () => {}, depth = 0 } = {}) {
  const reader = await NativePdfReader.create(fixture(changes), options);
  let operations = 0;
  const context = createPdfGroupSoftMaskContext(new Map(), () => { operations++; });
  try {
    configure(context);
    const id = reader.checked(reader.api.pn_pdf_resolve(6, 0));
    return await run(await readPdfGroupSoftMask(reader, id, 0, options.loadAsset, ctm, context, depth), { reader, context, id, operations: () => operations });
  } finally { reader.destroy(); }
}

describe('bounded single-axial luminosity-mask reader', () => {
  it('retains cloneable program data, captures gs CTM×G.Matrix and shares ICC admission', async () => {
    await readMask({ form: '/Matrix [2 0 0 3 4 5]' }, (mask, { context, operations }) => {
      expect(mask).toMatchObject({ type: 'Luminosity', matrix: [2, 0, 0, 3, 14, 25], backdrop: [0, 0, 0], bbox: [0, 0, 240, 140] });
      expect(mask.profileBytes).toBe(mask.shading.colorSpace.profileBytes);
      expect(context.profiles.size).toBe(1); expect(operations()).toBeGreaterThan(8);
      expect(structuredClone(mask)).toEqual(mask);
    }, { ctm: [1, 0, 0, 1, 10, 20] });
  });
  it('handles optional null as absent, including flags/Matrix/backdrop/transfer/Type', async () => {
    await readMask({ dictionary: '/Type null /BC null /TR null', form: '/Type null /Matrix null',
      group: '/Type null /S /Transparency /CS [/ICCBased 8 0 R] /I null /K null' }, mask => {
      expect(mask.matrix).toEqual(IDENTITY); expect(mask.backdrop).toEqual([0, 0, 0]);
    });
  });
  it('memoizes only G artwork while each establishment captures its own coordinates/backdrop', async () => {
    await readMask({}, async (mask, { context, reader, id, operations }) => {
      const before = operations(), bytes = context.programBytes;
      const other = await readPdfGroupSoftMask(reader, id, 0, options.loadAsset, [1, 0, 0, 1, 30, 40], context);
      expect(other.matrix).toEqual([1, 0, 0, 1, 30, 40]); expect(mask.matrix).toEqual(IDENTITY);
      expect(other.shading).toBe(mask.shading); expect(operations()).toBe(before); expect(context.programBytes).toBe(bytes);
    });
  });
  it.each([
    [{ artwork: program + ' 0 0 10 10 re f' }, 'pdf_unsupported'],
    [{ artwork: program.replace('/S sh', '/Other Do') }, 'pdf_unsupported'],
    [{ artwork: program.replace('1 0 0 1 0 0 cm', '1 0 cm') }, 'pdf_corrupt'],
    [{ artwork: program.slice(0, -2) }, 'pdf_corrupt'],
    [{ group: '/S /Transparency /CS /DeviceCMYK' }, 'pdf_unsupported'],
    [{ group: '/S /Transparency /CS [/ICCBased 8 0 R] /K true' }, 'pdf_unsupported'],
    [{ group: '/S /Transparency /CS [/ICCBased 8 0 R] /I 1' }, 'pdf_corrupt'],
    [{ dictionary: '/BC [0 0]' }, 'pdf_corrupt'],
    [{ dictionary: '/TR << /FunctionType 2 /Domain [0 1] /N 1 >>' }, 'pdf_unsupported'],
    [{ shader: '/ShadingType 3 /ColorSpace /DeviceGray /Coords [0 0 0 1 0 1] /Extend [true true]', fn: '<< /FunctionType 2 /Domain [0 1] /N 1 >>' }, 'pdf_unsupported'],
    [{ shader: '/ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Extend [false true]', fn: '<< /FunctionType 2 /Domain [0 1] /N 1 >>' }, 'pdf_unsupported'],
    [{ gs: '/ca .5' }, 'pdf_unsupported'],
    [{ gs: '/ca 2' }, 'pdf_corrupt'],
    [{ gs: '/SMask << /S /Luminosity >>' }, 'pdf_unsupported'],
    [{ gs: '/SA 1' }, 'pdf_corrupt'],
    [{ gs: '/TR /Identity' }, 'pdf_unsupported'],
  ])('keeps malformed/unsupported artwork explicit (%j)', async (changes, code) => {
    await expect(readMask(changes)).rejects.toMatchObject({ code });
  });
  it('recursively excludes calculator functions hidden under stitching nodes', async () => {
    await expect(readMask({ fn: '<< /FunctionType 3 /Domain [0 1] /Functions [12 0 R] /Bounds [] /Encode [0 1] >>',
      extra: [stream('{ pop .5 .5 .5 }', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]')] })).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('charges shared operations and imposes resource/aggregate-byte/depth restrictions before rendering', async () => {
    await expect(readMask({}, undefined, { depth: 17 })).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(readMask({}, undefined, { configure: context => { for (let i = 0; i < 255; i++) context.resources.add(`prior:${i}`); } })).rejects.toMatchObject({ code: 'pdf_limit' });
    await expect(readMask({}, undefined, { configure: context => { context.programBytes = 32 * 1024 * 1024 - 1; } })).rejects.toMatchObject({ code: 'pdf_limit' });
    let visits = 0;
    await expect(readMask({}, undefined, { configure: context => { context.chargeOperation = () => { if (++visits > 4) throw new PdfEngineError('Shared operation budget.', 'pdf_limit'); }; } })).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(visits).toBe(5);
  });
});

function groupFixture(content, { target = '0 0 20 20 re f 10 0 20 20 re f', targetGroup = '/Group << /S /Transparency /I true >>', alpha = 1, ais = false } = {}) {
  return fixture({ content, page: '/Resources << /Font << /F1 5 0 R >> /ExtGState << /M 12 0 R /C 14 0 R /D 15 0 R >> /XObject << /T 13 0 R /J 16 0 R /I 17 0 R >> /Shading << /S 9 0 R >> >>', extra: [
    `<< /SMask 6 0 R /ca ${alpha} /AIS ${ais} >>`,
    stream(target, `/Subtype /Form /BBox [0 0 100 100] ${targetGroup}`),
    '<< /SMask /None >>', '<< /SMask null /AIS null >>',
    stream('0 0 20 20 re f', '/Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >>'),
    stream(Uint8Array.of(255, 0, 0), '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
  ] });
}
async function payload(bytes, run) {
  const core = await createPdfDocumentCore(bytes, options);
  try { return await run(await core.pagePayload(1)); } finally { core.destroy(); }
}
const groups = commands => commands.flatMap(c => c.op === 'group' ? [c, ...groups(c.commands)] : []);
describe('group-only graphics-state mask integration', () => {
  it('captures establishment CTM, groups once and resets child alpha/mask rather than double-applying', async () => {
    await payload(groupFixture('/M gs 3 0 0 3 10 20 cm /T Do', { alpha: .5 }), result => {
      const [group] = groups(result.commands);
      expect(group.alpha).toBe(.5); expect(group.softMask.matrix).toEqual(IDENTITY);
      expect(group.commands[0]).toEqual({ op: 'transform', args: [3, 0, 0, 3, 10, 20] });
      const paints = group.commands.filter(c => c.op === 'paint' && c.kind === 'f'); expect(paints).toHaveLength(2);
      expect(paints.every(c => c.fillAlpha === 1 && !c.softMask)).toBe(true); expect(result.items).toEqual([]);
    });
  });
  it('forces nonisolated groups even at ca1 and inherits/restores None and optional-null correctly', async () => {
    await payload(groupFixture('/M gs q /C gs /T Do Q /D gs /T Do', { targetGroup: '/Group << /S /Transparency /I false >>' }), result => {
      const found = groups(result.commands); expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ isolated: false, alpha: 1, softMask: { type: 'Luminosity' } });
    });
  });
  it('allows independently masked child groups after resetting the inherited outer mask', async () => {
    await payload(groupFixture('/M gs /T Do', { target: '/M gs /J Do' }), result => {
      const found = groups(result.commands); expect(found).toHaveLength(2);
      expect(found.every(c => c.softMask?.type === 'Luminosity')).toBe(true);
      expect(found[0].softMask.shading).toBe(found[1].softMask.shading);
    });
  });
  it('keeps clipping-only operations and invisible native text outside the elementary-paint refusal', async () => {
    await payload(groupFixture('/M gs 0 0 40 40 re W n BT /F1 10 Tf 3 Tr (invisible) Tj ET /T Do'), result => {
      expect(result.items.map(item => item.str).join('')).toBe('invisible'); expect(groups(result.commands)).toHaveLength(1);
    });
  });
  it.each(['0 0 1 1 re f', 'BT /F1 10 Tf (visible) Tj ET', '/I Do', '/S sh'])('rejects elementary masked paints: %s', async paint => {
    const core = await createPdfDocumentCore(groupFixture(`/M gs ${paint}`), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported' }); } finally { core.destroy(); }
  });
  it('does not reinterpret an ordinary Form as a group to bypass per-paint mask semantics', async () => {
    const core = await createPdfDocumentCore(groupFixture('/M gs /T Do', { targetGroup: '' }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported' }); } finally { core.destroy(); }
  });
  it('validates AIS but gives the same group descriptor for either no-knockout alpha source', async () => {
    const values = [];
    for (const ais of [false, true]) await payload(groupFixture('/M gs /T Do', { ais }), result => { values.push(groups(result.commands)[0]); });
    expect(values[0]).toEqual(values[1]);
    const bad = await createPdfDocumentCore(groupFixture('/M gs /T Do', { ais: 1 }), options);
    try { await expect(bad.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_corrupt' }); } finally { bad.destroy(); }
  });
});

describe('native-ICC scalar luminosity samples', () => {
  it('uses linear XYZ Y rather than encoded gray or display RGB luminosity', () => {
    const factors = createPdfGroupSoftMaskSampler(descriptor()).sampleBand(0, 0, 3, 2);
    expect(factors).toBeInstanceOf(Float64Array);
    for (const value of factors) expect(value).toBeCloseTo(.25, 12);
  });
  it('uses BC outside/reversed BBox and mixes encoded ICC coverage before nonlinear Y', () => {
    const input = descriptor({ bbox: [.5, 0, 1.5, 1], backdrop: [.25, .25, .25] });
    const normal = createPdfGroupSoftMaskSampler(input).sampleBand(0, 0, 3, 1);
    expect(normal[0]).toBeCloseTo(.375 ** 2, 12); expect(normal[1]).toBeCloseTo(.375 ** 2, 12);
    expect(normal[2]).toBeCloseTo(.25 ** 2, 12);
    expect(normal[0]).not.toBeCloseTo((.5 ** 2 + .25 ** 2) / 2, 6);
    const reversed = createPdfGroupSoftMaskSampler({ ...input, bbox: [1.5, 1, .5, 0] }).sampleBand(0, 0, 3, 1);
    expect(reversed).toEqual(normal);
  });
  it('honors independent starting×caller×viewport factors and captured gs matrix', () => {
    const mask = descriptor({ matrix: [1, .25, .1, 1, 25, 8], bbox: [20, 20, 140, 100],
      shading: { ...descriptor().shading, functions: [exponential([0, 0, 0], [1, 1, 1])] } });
    const sampler = createPdfGroupSoftMaskSampler(mask, { pageTransform: [1, .25, .125, -1.125, -7.5, 172.5] });
    // Independently frozen Fraction inversion and raw-ICC Y oracle, before implementation.
    for (const [x, y, expected] of [[93, 101, 12823561 / 208224900], [132, 111, 35868121 / 208224900], [172, 66, 3236401 / 11088900], [18, 169, 0], [198, 142, 0]]) {
      expect(sampler.sampleBand(x, y, 1, 1)[0]).toBeCloseTo(expected, 10);
    }
  });
  it('shares the exact existing shading pixel-work limit and bounds band allocations', () => {
    const surfaceBudget = { pixels: 123, shadingPixels: 63_999_999 }, sampler = createPdfGroupSoftMaskSampler(descriptor(), { surfaceBudget });
    expect(sampler.sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(.25, 12);
    expect(() => sampler.sampleBand(0, 0, 1, 1)).toThrow(/pixel-work budget/);
    expect(surfaceBudget).toEqual({ pixels: 123, shadingPixels: 64_000_000 });
    expect(() => sampler.sampleBand(0, 0, 262145, 1)).toThrow(/sample band/);
    expect(() => sampler.sampleBand(0, 0, 1, 0)).toThrow(/sample band/);
  });
  it('checks cancellation within a band without retaining a surface', () => {
    let checks = 0; const surfaceBudget = { pixels: 0 };
    const sampler = createPdfGroupSoftMaskSampler(descriptor(), { surfaceBudget, cancellation: () => { if (++checks === 4) throw new Error('cancelled'); } });
    expect(() => sampler.sampleBand(0, 0, 10000, 1)).toThrow('cancelled'); expect(surfaceBudget.pixels).toBe(0);
  });
  it.each([
    { matrix: [0, 0, 0, 0, 0, 0] }, { matrix: [1e308, 0, 0, 1e308, 0, 0] },
    { bbox: [0, 0, NaN, 1] }, { backdrop: [0] },
    { shading: { ...descriptor().shading, functions: [exponential([.5])] } },
  ])('rejects invalid runtime descriptor %j', changed => {
    expect(() => createPdfGroupSoftMaskSampler(descriptor(changed))).toThrow();
  });
  it('transfers each nested/shared mask ICC and function buffer once, with bounded descriptor cycles', () => {
    const samples = Uint8Array.of(0, 255), bytes = syntheticRgbProfile();
    const shading = { colorSpace: { name: 'ICCBased', profileBytes: bytes }, functions: [{ type: 3, functions: [{ type: 0, samples }] }] };
    const softMask = { profileBytes: bytes, shading }, group = { op: 'group', softMask, commands: [] };
    group.commands.push({ op: 'group', softMask, commands: [group] });
    const payload = { commands: [group, group], fonts: [] }, buffers = pdfPayloadBuffers(payload);
    expect(buffers).toHaveLength(2); expect(new Set(buffers).size).toBe(2); expect(pdfPayloadByteLength(payload)).toBe(bytes.byteLength + samples.byteLength);
    const clone = structuredClone(payload, { transfer: buffers });
    expect(bytes.byteLength).toBe(0); expect(samples.byteLength).toBe(0);
    expect(clone.commands[0].softMask.profileBytes).toEqual(syntheticRgbProfile());
    expect([...clone.commands[0].softMask.shading.functions[0].functions[0].samples]).toEqual([0, 255]);
    expect(clone.commands[0]).toBe(clone.commands[0].commands[0].commands[0]);
  });
});

const radialDescriptor = (shading = {}, other = {}) => descriptor({ ...other, shading: {
  ...descriptor().shading, type: 3, coords: [0, 0, 0, 0, 0, 1], matrix: [2, 0, 0, 2, .5, .5],
  functions: [exponential([0, 0, 0], [1, 1, 1])], ...shading,
} });
describe('shared concentric radial mask parameter', () => {
  it('reads the actual zero-start-radius geometry through the same strict artwork grammar', async () => {
    await readMask({ shader: '/ShadingType 3 /ColorSpace [/ICCBased 8 0 R] /Coords [0 0 0 0 0 1] /Extend [true true]' }, mask => {
      expect(mask.shading).toMatchObject({ type: 3, coords: [0, 0, 0, 0, 0, 1] });
      expect(mask.profileBytes).toBe(mask.shading.colorSpace.profileBytes);
      expect(createPdfGroupSoftMaskSampler(mask).sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(.25, 12);
    });
  });
  it('reuses the existing circle root selection while the independent expectation is hypot/radius', () => {
    const parameter = radialParameter([2, 3, 0, 2, 3, 10], [true, true]);
    expect(parameter(2, 3)).toBe(0); expect(parameter(5, 7)).toBe(.5); expect(parameter(14, 8)).toBe(1.3);
    const values = createPdfGroupSoftMaskSampler(radialDescriptor()).sampleBand(0, 0, 4, 1);
    [0, .25, 1, 1].forEach((value, i) => expect(values[i]).toBeCloseTo(value, 12));
  });
  it('keeps the actual-shaped stitching boundaries/encoding before native ICC Y', () => {
    const one = exponential([1, 1, 1]), fall = { ...exponential([1, 1, 1], [0, 0, 0]), exponent: 1.54712 }, zero = exponential([0, 0, 0]);
    const fn = { type: 3, domain: [0, 1], range: null, inputs: 1, outputs: 3, bounds: [.28, .9], encode: [0, 1, 0, 1, 1, 0], functions: [one, fall, zero] };
    const sampler = createPdfGroupSoftMaskSampler(radialDescriptor({ matrix: [100, 0, 0, 100, .5, .5], functions: [fn] }));
    expect(sampler.sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(1, 12); expect(sampler.sampleBand(28, 0, 1, 1)[0]).toBeCloseTo(1, 12);
    expect(sampler.sampleBand(59, 0, 1, 1)[0]).toBeCloseTo((1 - .5 ** 1.54712) ** 2, 12);
    expect(sampler.sampleBand(90, 0, 1, 1)[0]).toBe(0); expect(sampler.sampleBand(120, 0, 1, 1)[0]).toBe(0);
  });
  it('inverts a reflected/sheared circle into an ellipse without a device-space radius shortcut', () => {
    const sampler = createPdfGroupSoftMaskSampler(radialDescriptor({ matrix: [2, 1, .5, -3, .5, .5] }));
    expect(sampler.sampleBand(0, 0, 1, 1)[0]).toBeCloseTo(0, 12);
    // Independent linear solve at pixel(1,1): (u,v)=(7/13,-2/13); gamma2 Y is radius squared.
    expect(sampler.sampleBand(1, 1, 1, 1)[0]).toBeCloseTo(53 / 169, 12);
    expect(sampler.sampleBand(2, 1, 1, 1)[0]).toBeCloseTo(1, 12);
  });
  it('retains the captured mask basis independently of viewport/caller placement', () => {
    const sampler = createPdfGroupSoftMaskSampler(radialDescriptor({}, { matrix: [1, 0, 0, 1, 30, 40] }), { pageTransform: [1, 0, 0, 1, 10, 20] });
    const values = sampler.sampleBand(40, 60, 2, 1); expect(values[0]).toBeCloseTo(0, 12); expect(values[1]).toBeCloseTo(.25, 12);
  });
  it('keeps finite-BBox BC coverage in encoded ICC before nonlinear radial-mask Y', () => {
    const sampler = createPdfGroupSoftMaskSampler(radialDescriptor({ functions: [exponential()] }, { bbox: [.5, 0, 1.5, 1], backdrop: [.25, .25, .25] }));
    const values = sampler.sampleBand(0, 0, 3, 1);
    expect(values[0]).toBeCloseTo(.375 ** 2, 12); expect(values[1]).toBeCloseTo(.375 ** 2, 12); expect(values[2]).toBeCloseTo(.25 ** 2, 12);
  });
  it.each([
    [[0, 0, -1, 0, 0, 1], 'pdf_corrupt'], [[0, 0, 0, 0, 0, -1], 'pdf_corrupt'],
    [[0, 0, 0, 0, 0, NaN], 'pdf_corrupt'], [[0, 0, 0, 1], 'pdf_corrupt'],
    [[0, 0, 0, 0, 0, 0], 'pdf_unsupported'], [[0, 0, 0, 1, 0, 1], 'pdf_unsupported'],
    [[0, 0, 1, 0, 0, 2], 'pdf_unsupported'], [[0, 0, 0, 0, 0, 1e-200], 'pdf_limit'],
    [[0, 0, 0, 0, 0, 1e200], 'pdf_limit'],
  ])('rejects malformed/out-of-scope radial descriptor before outside-BC fallback: %j', (coords, code) => {
    try { createPdfGroupSoftMaskSampler(radialDescriptor({ coords }, { bbox: [1000, 1000, 1001, 1001] })); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ code }); }
  });
  it('charges radial samples to the same cumulative shading work allowance', () => {
    const surfaceBudget = { pixels: 0, shadingPixels: 63_999_999 }, sampler = createPdfGroupSoftMaskSampler(radialDescriptor(), { surfaceBudget });
    sampler.sampleBand(0, 0, 1, 1);
    expect(() => sampler.sampleBand(0, 0, 1, 1)).toThrow(/pixel-work budget/); expect(surfaceBudget.shadingPixels).toBe(64_000_000);
  });
});
