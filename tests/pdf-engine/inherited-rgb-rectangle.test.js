import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { buildPdfDisplayList } from '../../src/pdf/display-list.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { assertPdfInheritedRgbRectangle, PDF_INHERITED_RGB_RECTANGLE } from '../../src/pdf/inherited-rgb-rectangle.js';
import { createPdfImageLuminositySampler } from '../../src/pdf/image-luminosity-mask.js';
import { options, simplePdf, stream } from './fixtures.js';

const identity = [1, 0, 0, 1, 0, 0];
function fixture({ program = '.2 .4 .6 .8 k /G gs 0 0 10 10 re f', state = '', outer = '', outerOverprint = false, group = '', form = '' } = {}) {
  return simplePdf('/Outer gs /F Do', { page: '/Resources << /XObject << /F 6 0 R >> /ExtGState << /Outer 8 0 R >> >>', extra: [
    stream(program, `/Subtype /Form /BBox [0 20 20 0] /Matrix [1 .1 .2 1 3 4] /Group << /S /Transparency /CS /DeviceCMYK /I false ${group} >> /Resources << /ExtGState << /G 7 0 R >> >> ${form}`),
    `<< /BM /Multiply /ca .2 /CA .2 /AIS true /OP false /op false ${state} >>`, `<< /BM /Normal /ca .625 /AIS true /OP ${outerOverprint} /op ${outerOverprint} ${outer} >>`,
  ] });
}
async function payload(settings, run) {
  const core = await createPdfDocumentCore(fixture(settings), options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
const color = fill => ({ op: 'color', fill, value: 'rgb(0,0,0)', nativeColor: [0, 0, 0] });
function descriptor() {
  return { op: 'group', rgbCompatibility: PDF_INHERITED_RGB_RECTANGLE, declaredColorSpace: 'DeviceCMYK', effectiveColorSpace: 'DeviceRGB', isolated: false,
    colorProfile: null, alpha: 1, alphaIsShape: true, sourceAlphaIsShape: true, knockout: false, fillOverprint: false, strokeOverprint: false, sourceCmyk: [0, 0, 0, 1],
    blend: 'source-over', commands: [{ op: 'transform', args: [...identity] }, { op: 'save' }, color(true), color(false),
      { op: 'transform', args: [...identity] }, { op: 'path', kind: 're', args: [0, 0, 2, 2] }, { op: 'paint', kind: 'n', clip: 'nonzero' }, color(true),
      { op: 'path', kind: 're', args: [0, 0, 2, 2] }, { op: 'paint', kind: 'f', clip: null, fillAlpha: .2, strokeAlpha: .2, blend: 'multiply', lineWidth: 1, strokeAdjustment: false }, { op: 'restore' }] };
}
function mask() {
  return { type: 'Luminosity', deviceImage: { width: 2, height: 2, samples: new Uint8Array([0, 85, 170, 255]), matrix: [2, 0, 0, 2, 0, 0] },
    bbox: [0, 0, 2, 2], matrix: [...identity], backdrop: [0, 0, 0, 1] };
}
function context(canvas = { width: 2, height: 2 }, read = () => {}, put = () => {}) {
  return { canvas, save() {}, restore() {}, transform() {}, setTransform() {}, beginPath() {}, rect() {}, clip() {}, fill() {}, fillRect() {}, drawImage() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getLineDash: () => [], setLineDash() {},
    getContextAttributes: () => ({ colorType: 'float16', colorSpace: 'srgb' }),
    getImageData(_x, _y, width, height) { read(); return { width, height, data: new Float64Array(width * height * 4).fill(.5) }; },
    putImageData(...args) { put(...args); } };
}
function render(group, changes = {}) {
  return renderPdfDisplayList({ commands: [group], fonts: [] }, { canvasContext: context(), viewport: { transform: identity }, background: false, ...changes }).promise;
}
afterEach(() => vi.unstubAllGlobals());

describe('scoped inherited-RGB CMYK rectangle compatibility', () => {
  it('retains original declarations and converts its own source forward once', async () => {
    await payload({}, async (value, core) => {
      const group = value.commands.find(c => c.rgbCompatibility);
      expect(group).toMatchObject({ rgbCompatibility: PDF_INHERITED_RGB_RECTANGLE, declaredColorSpace: 'DeviceCMYK', effectiveColorSpace: 'DeviceRGB', isolated: false,
        colorProfile: null, alphaIsShape: true, sourceAlphaIsShape: true });
      expect(group.alpha).toBeCloseTo(.625, 14); group.sourceCmyk.forEach((v, i) => expect(v).toBeCloseTo([.2, .4, .6, .8][i], 14));
      const profile = parseIccProfile(await options.loadAsset('iccs/CGATS001Compat-v2-micro.icc'));
      const expected = profile.convert(group.sourceCmyk);
      group.commands[7].nativeColor.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 14));
      expect(group.commands[9].blend).toBe('multiply'); expect(() => assertPdfInheritedRgbRectangle(group)).not.toThrow();
      expect(value.items).toEqual([]); expect(value.inspection.hasRasterImage).toBe(false);
      expect(value.inspection.decodingWarnings).toContainEqual(expect.objectContaining({ compatibility: PDF_INHERITED_RGB_RECTANGLE }));
      expect(() => assertPdfInheritedRgbRectangle(structuredClone(group))).not.toThrow();
      core.cleanup(1); const again = (await core.pagePayload(1)).commands.find(c => c.rgbCompatibility);
      expect(again).toEqual(group);
    });
  });
  it('preserves the existing uniform Normal native-CMYK contribution family', async () => {
    // A distinct GS avoids duplicate dictionary keys in the authored PDF.
    const bytes = simplePdf('/F Do', { page: '/Resources << /XObject << /F 6 0 R >> >>', extra: [
      stream('.2 .4 .6 .8 k 0 0 10 10 re f', '/Subtype /Form /BBox [0 0 20 20] /Group << /S /Transparency /CS /DeviceCMYK /I false >> /Resources << >>'),
    ] });
    const core = await createPdfDocumentCore(bytes, options);
    try { const group = (await core.pagePayload(1)).commands.find(c => c.op === 'group'); expect(group.backdropIndependent).toBe(true); expect(group.rgbCompatibility).toBeUndefined(); }
    finally { core.destroy(); }
  });
  it.each([false, true])('releases every prepared token on %s boundary rejection', async rejected => {
    const bytes = fixture({ outerOverprint: rejected });
    const reader = await NativePdfReader.create(bytes, options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources');
      const content = vi.spyOn(reader, 'content');
      if (rejected) await expect(buildPdfDisplayList(reader, page, resources, options.loadAsset)).rejects.toMatchObject({ code: 'pdf_unsupported' });
      else await buildPdfDisplayList(reader, page, resources, options.loadAsset);
      expect(content).toHaveBeenCalledTimes(2); // Once for page, once for original Form.
      expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });
  it.each([
    ['second paint', { program: '.2 .4 .6 .8 k /G gs 0 0 10 10 re f 1 1 2 2 re f' }],
    ['nested origin', { program: '.2 .4 .6 .8 k /G gs /Missing Do 0 0 10 10 re f' }],
    ['text origin', { program: '.2 .4 .6 .8 k /G gs BT ET 0 0 10 10 re f' }],
    ['stroke', { program: '.2 .4 .6 .8 k /G gs 0 0 10 10 re S' }],
    ['trailing operand', { program: '.2 .4 .6 .8 k /G gs 0 0 10 10 re f 42' }],
  ])('does not broaden %s admission', async (_name, settings) => {
    await expect(payload(settings, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('rejects incorrect operand count before a payload escapes', async () => {
    await expect(payload({ program: '.2 .4 .6 .8 k /G gs 0 0 10 re f' }, () => {})).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  const mutations = [
    ['subtype', g => { g.rgbCompatibility = 'other'; }], ['declared CS', g => { g.declaredColorSpace = 'ICCBased4'; }],
    ['isolated', g => { g.isolated = true; }], ['native target', g => { g.nativeColorSpace = 'DeviceCMYK'; }],
    ['extra paint', g => { g.commands.push(g.commands[9]); }], ['order', g => { [g.commands[5], g.commands[8]] = [g.commands[8], g.commands[5]]; g.commands[5].kind = 'm'; }],
    ['source holes', g => { delete g.sourceCmyk[1]; }], ['path holes', g => { delete g.commands[8].args[2]; }],
    ['colour holes', g => { delete g.commands[7].nativeColor[0]; }], ['style mismatch', g => { g.commands[7].value = 'red'; }],
    ['native state', g => { g.commands[7].nativeCmyk = [0, 0, 0, 1]; }], ['OP token', g => { g.commands[9].nativeCmykFillBlend = 'overprint-nonzero'; }],
    ['NaN', g => { g.commands[9].fillAlpha = NaN; }], ['AIS', g => { g.sourceAlphaIsShape = 1; }],
    ['other corners overflow', g => { g.commands[0].args = [1e308, 0, 1e308, 1, 0, 0]; g.commands[5].args = [1, -1, -2, 2]; }],
    ...[false, 0, '', []].map((v, i) => [`falsy mask${i}`, g => { g.softMask = v; }]),
    ['mask holes', g => { g.softMask = mask(); g.softMask.backdrop = Array(4); }],
    ['mask samples', g => { g.softMask = mask(); g.softMask.deviceImage.samples = new Uint8Array(3); }],
    ['hidden mask owner', g => { g.softMask = mask(); g.softMask.deviceImage.samples = new Uint8Array(8).subarray(0, 4); }],
    ['inherited pattern', g => { g.commands[9] = Object.assign(Object.create({ fillPattern: {} }), g.commands[9]); }],
    ['nonenumerable pattern', g => { Object.defineProperty(g.commands[9], 'fillPattern', { value: {} }); }],
    ['mask singular', g => { g.softMask = mask(); g.softMask.matrix = [0, 0, 0, 0, 0, 0]; }],
  ];
  it.each(mutations)('preflights %s at alpha0 before allocating', async (_name, change) => {
    let allocated = 0; vi.stubGlobal('OffscreenCanvas', class { constructor() { allocated++; throw Error('unexpected allocation'); } });
    const group = descriptor(); group.alpha = 0; change(group);
    await expect(render(group)).rejects.toMatchObject({ code: expect.stringMatching(/^pdf_(corrupt|unsupported|limit)$/) });
    expect(allocated).toBe(0);
  });
  it('rejects caller-basis overflow before allocating', async () => {
    let allocated = 0; vi.stubGlobal('OffscreenCanvas', class { constructor() { allocated++; } });
    const group = descriptor(); group.alpha = 0; group.commands[5].args = [1, 1, 2, 2];
    await expect(render(group, { transform: [1e308, 0, 1e308, 1, 0, 0] })).rejects.toMatchObject({ code: 'pdf_corrupt' }); expect(allocated).toBe(0);
  });
  it('keeps valid alpha0 allocation-free after full validation', async () => {
    let allocated = 0; vi.stubGlobal('OffscreenCanvas', class { constructor() { allocated++; } });
    const group = descriptor(); group.alpha = 0; group.softMask = mask(); const budget = { pixels: 7 };
    await render(group, { surfaceBudget: budget }); expect(allocated).toBe(0); expect(budget).toEqual({ pixels: 7 });
  });
  it('charges adaptive masked readbacks against the shared owner and releases all bands', async () => {
    vi.stubGlobal('Float16Array', Float64Array); const initial = 16_000_000 - 8 - 6, budget = { pixels: initial }; let peak = 0, closed = false;
    const observe = () => { peak = Math.max(peak, budget.pixels); expect(budget.pixels).toBeLessThanOrEqual(16_000_000); };
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { this.width = width; this.height = height; this.context = context(this, observe); }
      getContext() { return this.context; } set width(value) { this._width = value; if (value === 0) closed = true; } get width() { return this._width; } });
    const group = descriptor(); group.softMask = mask(); const parent = context(undefined, observe); parent.drawImage = () => {};
    await render(group, { canvasContext: parent, surfaceBudget: budget });
    expect(peak).toBe(16_000_000); expect(budget.pixels).toBe(initial); expect(budget.shadingPixels).toBe(8); expect(closed).toBe(true);
  });
  it.each(['pixels', 'shadingPixels'])('refuses exhausted %s before allocating', async property => {
    let allocated = 0; vi.stubGlobal('OffscreenCanvas', class { constructor() { allocated++; } });
    const budget = { pixels: 0, [property]: property === 'pixels' ? 16_000_000 : 64_000_000 }, group = descriptor(); group.softMask = mask();
    await expect(render(group, { surfaceBudget: budget })).rejects.toMatchObject({ code: 'pdf_limit' }); expect(allocated).toBe(0);
  });
  it('refuses a near-cap page requiring millions of tiny bands before allocating', async () => {
    let allocated = 0; vi.stubGlobal('OffscreenCanvas', class { constructor() { allocated++; } });
    const group = descriptor(); group.softMask = mask(); const budget = { pixels: 2 * 2002 * 1998 };
    await expect(render(group, { canvasContext: context({ width: 2002, height: 1998 }), surfaceBudget: budget })).rejects.toMatchObject({ code: 'pdf_limit', message: expect.stringContaining('band limit') });
    expect(allocated).toBe(0); expect(budget.pixels).toBe(2 * 2002 * 1998);
  });
  it.each(['readback', 'cancel'])('releases reserved surface and scratch after %s', async failure => {
    vi.stubGlobal('Float16Array', Float64Array); const initial = 16_000_000 - 8 - 6, budget = { pixels: initial }; let stopped = false, closed = false, reads = 0;
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { this.width = width; this.height = height; this.context = context(this, () => { if (failure === 'readback' && ++reads > 1) throw Error('authored source readback failure'); }, () => { if (failure === 'cancel') stopped = true; }); }
      getContext() { return this.context; } set width(value) { this._width = value; if (value === 0) closed = true; } get width() { return this._width; } });
    const group = descriptor(); group.softMask = mask();
    const parent = context(undefined, () => { throw Error('parent readback is forbidden'); });
    await expect(render(group, { canvasContext: parent, surfaceBudget: budget, shouldCancel: () => stopped })).rejects.toMatchObject(failure === 'cancel' ? { name: 'RenderingCancelledException' } : { message: 'authored source readback failure' });
    expect(budget.pixels).toBe(initial); expect(closed).toBe(true);
  });
  it('folds exactly one Multiply source without copying or reading the parent backdrop', async () => {
    vi.stubGlobal('Float16Array', Float64Array); let sourceCopies = 0, parentCopies = 0, closed = false;
    vi.stubGlobal('OffscreenCanvas', class { constructor(width, height) { this.width = width; this.height = height; this.context = context(this); this.context.drawImage = () => { sourceCopies++; }; }
      getContext() { return this.context; } set width(value) { this._width = value; if (value === 0) closed = true; } get width() { return this._width; } });
    const parent = context(undefined, () => { throw Error('parent readback is forbidden'); });
    parent.drawImage = () => { parentCopies++; expect(parent.globalCompositeOperation).toBe('multiply'); expect(parent.globalAlpha).toBe(1); };
    const group = descriptor(); group.softMask = mask(); group.alpha = .625; const budget = { pixels: 0 };
    await render(group, { canvasContext: parent, surfaceBudget: budget });
    expect(sourceCopies).toBe(0); expect(parentCopies).toBe(1); expect(closed).toBe(true); expect(budget.pixels).toBe(0);
    expect(group.isolated).toBe(false); expect(group.commands[9].blend).toBe('multiply');
  });
  it('preserves the single-Multiply outer-factor algebra for transparent, partial and opaque backdrops', () => {
    const backdrop = [.2, .6, .8], source = [.1, .4, .9];
    for (const ab of [0, .4, 1]) for (const a of [0, 1e-6, .2, 1]) for (const k of [0, .375, 1]) for (const shape of [.25, 1]) {
      const ag = a * shape, foldedAlpha = ag * k;
      for (let c = 0; c < 3; c++) {
        const pb = backdrop[c] * ab, full = (1 - ag) * pb + ag * (1 - ab) * source[c] + ag * pb * source[c];
        const crossfade = (1 - k) * pb + k * full;
        const folded = (1 - foldedAlpha) * pb + foldedAlpha * (1 - ab) * source[c] + foldedAlpha * pb * source[c];
        expect(folded).toBeCloseTo(crossfade, 14);
      }
      expect(ab + (1 - ab) * foldedAlpha).toBeCloseTo((1 - k) * ab + k * (ab + (1 - ab) * ag), 14);
    }
  });
});

describe('native image-mask nearest sampling at affine boundaries', () => {
  // Two original constant columns make the half-open nearest-cell decision
  // explicit. These coordinates are exact binary rationals, not an epsilon.
  const cases = [
    ['axis half', [48.5, 0, 0, 32.5, 11.25, 13.75], 35, 26, 1],
    ['axis left neighbour', [48.5, 0, 0, 32.5, 11.25, 13.75], 34, 26, 0],
    ['axis right neighbour', [48.5, 0, 0, 32.5, 11.25, 13.75], 36, 26, 1],
    ['just below half', [48.5, 0, 0, 32.5, 11.2500001, 13.75], 35, 26, 0],
    ['just above half', [48.5, 0, 0, 32.5, 11.2499999, 13.75], 35, 26, 1],
    ['reflection half', [-48.5, 0, 0, 32.5, 59.75, 13.75], 35, 26, 1],
    ['rotation half', [0, 48.5, -32.5, 0, 60.25, 11.25], 43, 35, 1],
    ['rotation left neighbour', [0, 48.5, -32.5, 0, 60.25, 11.25], 43, 34, 0],
    ['rotation right neighbour', [0, 48.5, -32.5, 0, 60.25, 11.25], 43, 36, 1],
    ['shear half', [48.5, 0, 16, 32.5, 11.25, 14.25], 43, 30, 1],
    ['two-axis shear half', [48.5, 8, 16, 32.5, 11.25, 10.25], 43, 30, 1],
    ['shear left neighbour', [48.5, 8, 16, 32.5, 11.25, 10.25], 42, 30, 0],
    ['shear right neighbour', [48.5, 8, 16, 32.5, 11.25, 10.25], 44, 30, 1],
  ];
  it.each(cases)('preserves %s without coordinate snapping', (_name, matrix, left, top, expected) => {
    const value = { type: 'Luminosity', backdrop: [0, 0, 0, 1], bbox: [-100, -100, 100, 100], matrix: [...identity],
      deviceImage: { width: 2, height: 2, samples: Uint8Array.of(0, 255, 0, 255), matrix } };
    const result = createPdfImageLuminositySampler(value).sampleBand(left, top, 1, 1)[0];
    expect(result).toBeCloseTo(expected, 14);
  });
});
