import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { assertPdfCmykContributionGroup } from '../../src/pdf/native-cmyk-contribution.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { options, simplePdf, stream } from './fixtures.js';

const ink = [.2, .4, .6, .8];
const path = () => ({ op: 'path', kind: 're', args: [0, 0, 10, 10] });
const paint = () => ({ op: 'paint', kind: 'f', fillAlpha: 1, blend: 'source-over', nativeCmykFill: [...ink] });
const descriptor = () => ({ op: 'group', backdropIndependent: true, isolated: false, nativeColorSpace: 'DeviceCMYK',
  alpha: 1, blend: 'source-over', colorProfile: new Uint8Array([1]), commands: [{ op: 'save' }, path(), paint(), { op: 'restore' }] });
const pdf = (content, state = '', form = '', outer = '') => simplePdf(`${outer} /F Do`, {
  page: '/Resources << /XObject << /F 6 0 R >> /ExtGState << /Outer 8 0 R >> >>',
  extra: [stream(content, `/Type /XObject /Subtype /Form /BBox [0 20 20 0] /Matrix [1 .1 .2 1 3 4]
    /Group << /S /Transparency /CS /DeviceCMYK /I false /K false >> /Resources << /ExtGState << /G 7 0 R >> >> ${form}`), `<< ${state} >>`, '<< /ca .5 >>'],
});
async function payload(bytes, run) {
  const core = await createPdfDocumentCore(bytes, options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
afterEach(() => vi.unstubAllGlobals());

describe('non-isolated Normal source contribution', () => {
  it('preserves I=false, owned profile and outer alpha with uniform direct ink fills', async () => {
    await payload(pdf('.2 .4 .6 .8 k /G gs 0 0 10 10 re f q 1 0 0 1 2 3 cm 0 0 5 5 re f Q', '/AIS false /OP false /op false /OPM 1 /SA true', '', '/Outer gs'), async (value, core) => {
      const group = value.commands.find(command => command.op === 'group');
      expect(group).toMatchObject({ backdropIndependent: true, isolated: false, alpha: .5, nativeColorSpace: 'DeviceCMYK' });
      expect(group.colorProfile).toEqual(await options.loadAsset('iccs/CGATS001Compat-v2-micro.icc'));
      expect(() => assertPdfCmykContributionGroup(group)).not.toThrow();
      const buffers = pdfPayloadBuffers(value); expect(buffers).toHaveLength(1);
      const clone = structuredClone(value, { transfer: buffers }); expect(group.colorProfile.byteLength).toBe(0);
      expect(() => assertPdfCmykContributionGroup(clone.commands.find(command => command.op === 'group'))).not.toThrow();
      core.cleanup(1); const fresh = (await core.pagePayload(1)).commands.find(command => command.op === 'group');
      expect(fresh.colorProfile).not.toBe(clone.commands.find(command => command.op === 'group').colorProfile);
      expect(fresh.colorProfile).toEqual(clone.commands.find(command => command.op === 'group').colorProfile);
    });
  });

  it.each([
    ['changed inks', '.2 .4 .6 .8 k 0 0 10 10 re f .3 .4 .6 .8 k 0 0 5 5 re f', ''],
    ['non-CMYK source', '1 0 0 rg 0 0 10 10 re f', ''],
    ['translucent fill', '.2 .4 .6 .8 k /G gs 0 0 10 10 re f', '/ca .5'],
    ['overprint', '.2 .4 .6 .8 k /G gs 0 0 10 10 re f', '/op true /OPM 1'],
    ['AIS', '.2 .4 .6 .8 k /G gs 0 0 10 10 re f', '/AIS true'],
    ['blend', '.2 .4 .6 .8 k /G gs 0 0 10 10 re f', '/BM /Multiply'],
    ['stroke', '.2 .4 .6 .8 k 0 0 10 10 re S', ''],
    ['text origin', '.2 .4 .6 .8 k BT ET 0 0 10 10 re f', ''],
    ['nested Form origin', '.2 .4 .6 .8 k /Missing Do 0 0 10 10 re f', ''],
    ['shading origin', '.2 .4 .6 .8 k /Missing sh 0 0 10 10 re f', ''],
    ['pattern source', '/Pattern cs', ''],
  ])('rejects %s before a payload escapes', async (_name, content, state) => {
    await expect(payload(pdf(content, state), () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('keeps ordinary no-Group output unchanged by contribution metadata', async () => {
    await payload(simplePdf('.2 .4 .6 .8 k 0 0 10 10 re f'), value => {
      expect(value.commands.some(command => command.backdropIndependent !== undefined)).toBe(false);
      expect(value.commands.some(command => command.op === 'group')).toBe(false);
    });
  });

  it.each([
    ['marker', group => { group.backdropIndependent = 'true'; }, 'pdf_corrupt'],
    ['isolation', group => { group.isolated = true; }, 'pdf_corrupt'],
    ['target', group => { group.nativeColorSpace = 'DeviceRGB'; }, 'pdf_corrupt'],
    ['profile', group => { group.colorProfile = null; }, 'pdf_corrupt'],
    ['transform', group => { group.commands.push({ op: 'transform', args: [1, 0, NaN, 1, 0, 0] }); }, 'pdf_corrupt'],
    ['path', group => { group.commands[1].args[2] = Infinity; }, 'pdf_corrupt'],
    ['sparse path', group => { delete group.commands[1].args[2]; }, 'pdf_corrupt'],
    ['missing current point', group => { group.commands[1] = { op: 'path', kind: 'v', args: [0, 0, 1, 1] }; }, 'pdf_corrupt'],
    ['overflowed transform', group => { group.commands.unshift({ op: 'transform', args: [1e300, 0, 0, 1, 0, 0] }, { op: 'transform', args: [1e300, 0, 0, 1, 0, 0] }); }, 'pdf_corrupt'],
    ['overflowed rectangle', group => { group.commands[1].args = [1e308, 0, 1e308, 1]; }, 'pdf_corrupt'],
    ['overflowed other rectangle corners', group => {
      group.commands.unshift({ op: 'transform', args: [1e308, 0, 1e308, 1, 0, 0] }); group.commands[2].args = [1, -1, -2, 2];
    }, 'pdf_corrupt'],
    ['restore', group => { group.commands.push({ op: 'restore' }); }, 'pdf_corrupt'],
    ['save', group => { group.commands.push({ op: 'save' }); }, 'pdf_corrupt'],
    ['sparse inks', group => { delete group.commands[2].nativeCmykFill[1]; }, 'pdf_corrupt'],
    ...[[NaN, 0, 0, 0], Array(4), [-1, 0, 0, 0]].map((nativeCmyk, i) => [`native color state ${i}`, group => {
      group.commands.unshift({ op: 'color', fill: true, nativeColorSpace: 'DeviceCMYK', nativeColor: [0, 0, 0], nativeCmyk });
    }, 'pdf_corrupt']),
    ['nonuniform inks', group => { const next = paint(); next.nativeCmykFill[0] = .9; group.commands.push(path(), next); }, 'pdf_unsupported'],
    ['alpha', group => { group.commands[2].fillAlpha = .5; }, 'pdf_unsupported'],
    ['overprint', group => { group.commands[2].nativeCmykFillBlend = 'overprint-nonzero'; }, 'pdf_unsupported'],
    ...['', false, 0, null].map(token => [`invalid fill token ${token}`, group => { group.commands[2].nativeCmykFillBlend = token; }, 'pdf_unsupported']),
    ['pattern', group => { group.commands[2].fillPattern = {}; }, 'pdf_unsupported'],
    ['mask', group => { group.softMask = {}; }, 'pdf_unsupported'],
    ['KO', group => { group.knockout = true; }, 'pdf_unsupported'],
    ['AIS', group => { group.alphaIsShape = true; }, 'pdf_unsupported'],
    ...['group', 'text', 'image', 'shading', 'lineStyle'].map(op => [op, group => { group.commands.push({ op }); }, 'pdf_unsupported']),
  ])('validates forged %s even with alpha0 before allocation', async (_name, mutate, code) => {
    const group = descriptor(); mutate(group); group.alpha = 0;
    const allocate = vi.fn(() => { throw new Error('unexpected allocation'); }); vi.stubGlobal('OffscreenCanvas', allocate);
    const ctx = { canvas: { width: 2, height: 2 }, save() {}, restore() {}, setTransform() {}, transform() {}, beginPath() {} };
    await expect(renderPdfDisplayList({ commands: [group], fonts: [] }, { canvasContext: ctx, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false }).promise).rejects.toMatchObject({ code });
    expect(allocate).not.toHaveBeenCalled();
  });

  it('cancels during complete span validation before any allocation', () => {
    const group = descriptor(), stop = vi.fn(() => { throw new Error('cancelled'); });
    expect(() => assertPdfCmykContributionGroup(group, stop)).toThrow('cancelled'); expect(stop).toHaveBeenCalledOnce();
  });
  it('keeps the existing graphics stack bound', () => {
    const group = descriptor(); group.commands.unshift(...Array.from({ length: 64 }, () => ({ op: 'save' })));
    expect(() => assertPdfCmykContributionGroup(group)).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
  });
});
