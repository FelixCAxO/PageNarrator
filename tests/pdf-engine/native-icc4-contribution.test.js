import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { assertPdfIcc4ContributionGroup, pdfIcc4SourceValues, PDF_ICC4_CONTRIBUTION } from '../../src/pdf/native-icc4-contribution.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { syntheticCmykB2aProfile } from './icc-b2a-fixture.js';
import { simplePdf, stream, options } from './fixtures.js';

const ink = [.2, .4, .6, .8], profile = syntheticCmykB2aProfile();
const fill = '.2 .4 .6 .8 k 0 0 10 10 re f';
function fixture({ program = fill, outer = '/Outer gs /F Do', child = fill, group = '', childGroup = '/Group << /S /Transparency /CS /Other /I false >>', extraState = '', different = false, metadata = '' } = {}) {
  const alternate = profile.slice(); if (different) alternate[alternate.length - 1] ^= 1;
  return simplePdf(outer, { page: '/Resources << /XObject << /F 6 0 R /Child 8 0 R /Image 9 0 R >> /ColorSpace << /DefaultCMYK [/ICCBased 7 0 R] /CS [/ICCBased 7 0 R] /Other [/ICCBased 10 0 R] >> /ExtGState << /Outer 11 0 R /G 12 0 R >> >>', extra: [
    stream(program, `/Subtype /Form /BBox [0 20 20 0] /Group << /S /Transparency /CS /CS /I false ${group} >>`),
    stream(profile, '/N 4'), stream(child, '/Subtype /Form /BBox [0 0 20 20] ' + childGroup),
    stream(deflateSync(Buffer.from([17, 53, 107, 211])), '/Subtype /Image /Width 1 /Height 1 /ColorSpace /Other /BitsPerComponent 8 /Filter /FlateDecode'),
    stream(alternate, '/N 4 ' + metadata), '<< /ca .5 /BM /Multiply >>', `<< ${extraState} >>`,
  ] });
}
async function payload(settings, run) {
  const core = await createPdfDocumentCore(fixture(settings), options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
const path = () => ({ op: 'path', kind: 're', args: [0, 0, 10, 10] });
const paint = () => ({ op: 'paint', kind: 'f', fillAlpha: 1, blend: 'source-over', nativeCmykFill: [...ink] });
const descriptor = () => ({ op: 'group', sourceContribution: PDF_ICC4_CONTRIBUTION, nativeColorSpace: 'ICCBased4', colorProfile: profile,
  isolated: false, alpha: 1, blend: 'source-over', commands: [{ op: 'save' }, path(), paint(), { op: 'restore' }] });

describe('same-profile Normal ICC4 source contributions', () => {
  it('keeps original isolation and outer blend, canonicalizes image/child profiles and transfers once', async () => {
    await payload({ program: fill + ' /Child Do q 2 0 0 2 0 0 cm /Image Do Q' }, async (value, core) => {
      const group = value.commands.find(c => c.sourceContribution);
      expect(group).toMatchObject({ nativeColorSpace: 'ICCBased4', isolated: false, alpha: .5, blend: 'multiply' });
      const child = group.commands.find(c => c.sourceContribution), image = group.commands.find(c => c.op === 'image');
      expect(child.isolated).toBe(false); expect(child.colorProfile).toBe(group.colorProfile);
      expect(image).toMatchObject({ format: 'native-icc4', components: 4, alpha: 1 });
      expect(image.colorSpace.profileBytes).toBe(group.colorProfile); expect(image.bytes).toEqual(Uint8Array.from([17, 53, 107, 211]));
      group.commands.find(c => c.nativeCmykFill).nativeCmykFill.forEach((v, i) => expect(v).toBeCloseTo(ink[i], 14));
      const buffers = pdfPayloadBuffers(value); expect(buffers).toHaveLength(2);
      const clone = structuredClone(value, { transfer: buffers }); expect(buffers.every(b => b.byteLength === 0)).toBe(true);
      const copied = clone.commands.find(c => c.sourceContribution); expect(() => assertPdfIcc4ContributionGroup(copied)).not.toThrow();
      core.cleanup(1); const rebuilt = (await core.pagePayload(1)).commands.find(c => c.sourceContribution);
      expect(rebuilt.colorProfile).toEqual(copied.colorProfile); expect(rebuilt.colorProfile).not.toBe(copied.colorProfile);
    });
  });

  it('preserves distinct opaque source colours and the AIS product in a graph with no knockout observers', async () => {
    await payload({ program: `/G gs ${fill} .8 .6 .4 .2 k 0 0 5 5 re f`, extraState: '/AIS true /OP false /op false' }, value => {
      const group = value.commands.find(c => c.sourceContribution);
      group.commands.filter(c => c.nativeCmykFill).forEach((c, row) => c.nativeCmykFill.forEach((v, i) => expect(v).toBeCloseTo((row ? [...ink].reverse() : ink)[i], 14)));
    });
  });

  it.each([
    ['text origin', 'BT ET ' + fill, ''], ['ordinary Form', fill + ' /Child Do', '', ''],
    ['shading origin', '/Unknown sh', ''], ['stroke', fill.replace(' re f', ' re S'), ''],
    ['internal Multiply', '/G gs ' + fill, '/BM /Multiply'], ['overprint then reset', '/G gs /Outer gs ' + fill, '/op true'],
    ['elementary opacity', '/G gs ' + fill, '/ca .5'], ['raw RGB', '1 0 0 rg 0 0 5 5 re f', ''],
  ])('rejects %s before returning a producer payload', async (_label, program, extraState, childGroup) => {
    await expect(payload({ program, extraState, ...(childGroup !== undefined ? { childGroup } : {}) }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('validates each byte-identical profile stream metadata before canonical reuse', async () => {
    await expect(payload({ program: fill + ' /Image Do', metadata: '/Range [0 1 0 1 0 1 0 2]' }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('refuses a source contribution invoked inside a text object before payload escape', async () => {
    await expect(payload({ outer: 'BT /F Do ET' }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported', message: 'This PDF normal ICC4 contribution boundary is not implemented.' });
  });
  it('refuses a different ICC image profile before cache/lease reuse', async () => {
    await expect(payload({ program: fill + ' /Image Do', different: true }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('does not infer an ICC4 source conversion from numerically equal profile bytes', () => {
    expect(pdfIcc4SourceValues({ name: 'ICCBased', components: 4, profileBytes: profile }, ink, profile)).toEqual(ink);
    expect(() => pdfIcc4SourceValues({ name: 'ICCBased', components: 4, profileBytes: profile.slice() }, ink, profile)).toThrow();
  });
  it('preflights recursive live/work caps without mutating either ledger', () => {
    for (const budget of [{ pixels: 16_000_000 }, { pixels: 0, shadingPixels: 64_000_000 }]) {
      const before = { ...budget };
      expect(() => assertPdfIcc4ContributionGroup(descriptor(), { surfaceBudget: budget, deviceExtent: [0, 0, 10, 10] })).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
      expect(budget).toEqual(before);
    }
    const cancelled = new Error('cancelled'), check = vi.fn(() => { throw cancelled; });
    expect(() => assertPdfIcc4ContributionGroup(descriptor(), { check })).toThrow(cancelled); expect(check).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['old marker conflict', g => { g.backdropIndependent = true; }],
    ['inherited-RGB marker conflict', g => { g.rgbCompatibility = 'inherited-rgb-cmyk-rectangle-v1'; }, 'pdf_corrupt'],
    ['nested inherited-RGB marker conflict', g => { const child = descriptor(); child.rgbCompatibility = 'inherited-rgb-cmyk-rectangle-v1'; g.commands.push(child); }, 'pdf_corrupt'],
    ['nested undefined inherited-RGB marker', g => { const child = descriptor(); child.rgbCompatibility = undefined; g.commands.push(child); }, 'pdf_corrupt'],
    ['inherited family-marker property', g => { const child = Object.assign(Object.create({ rgbCompatibility: undefined }), descriptor()); g.commands.push(child); }, 'pdf_corrupt'],
    ['wrong marker', g => { g.sourceContribution = true; }], ['wrong target', g => { g.nativeColorSpace = 'DeviceCMYK'; }],
    ['sparse inks', g => { delete g.commands[2].nativeCmykFill[0]; }], ['sparse matrix', g => { g.commands.unshift({ op: 'transform', args: Array(6) }); }],
    ['overflowed rectangle corners', g => { g.commands.unshift({ op: 'transform', args: [1e308, 0, 1e308, 1, 0, 0] }); g.commands[2].args = [1, -1, -2, 2]; }],
    ['cycle', g => { g.commands.push(g); }], ['nested blend', g => { const child = descriptor(); child.blend = 'multiply'; g.commands.push(child); }],
    ['colour override', g => { g.commands.unshift({ op: 'color', fill: true, nativeColorSpace: 'ICCBased4', nativeColor: [0, 0, 0], nativeCmyk: [NaN, 0, 0, 0] }); }],
    ['falsy paint blend', g => { g.commands[2].nativeCmykFillBlend = false; }], ['sparse image matrix', g => { g.commands.push({ op: 'image', format: 'native-icc4', colorSpace: { profileBytes: profile }, alpha: 1, matrix: Array(6) }); }],
    ...[false, 0, ''].map(mask => [`falsy declared mask ${JSON.stringify(mask)}`, g => { g.softMask = mask; }]),
  ])('rejects %s at alpha0 before any Canvas surface allocation', async (_label, mutate, expectedCode) => {
    const group = descriptor(); group.alpha = 0; mutate(group);
    const allocation = vi.fn(); vi.stubGlobal('OffscreenCanvas', allocation);
    const ctx = { canvas: { width: 10, height: 10 }, save() {}, restore() {}, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      setTransform() {}, transform() {}, beginPath() {} };
    const budget = { pixels: 0 };
    try { const rendering = renderPdfDisplayList({ commands: [group], fonts: [] }, { canvasContext: ctx, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false, surfaceBudget: budget }).promise;
      if (expectedCode) await expect(rendering).rejects.toMatchObject({ code: expectedCode });
      else await expect(rendering).rejects.toBeDefined();
      expect(allocation).not.toHaveBeenCalled(); expect(budget.pixels).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
