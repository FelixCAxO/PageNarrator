import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { resolvePdfColorSpace, deviceRgb } from '../../src/pdf/color-spaces.js';
import { parseIccProfile } from '../../src/pdf/icc-color.js';
import { convertPdfColor } from '../../src/pdf/icc-blend.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { syntheticRgbProfile } from './icc-fixture.js';
import { options, pdf, simplePdf, stream } from './fixtures.js';

const rgb = values => `rgb(${values.map(n => Math.round(Math.max(0, Math.min(1, n)) * 255)).join(',')})`;
const profile = syntheticRgbProfile();
function fixture({ group = '<< /S /Transparency /CS /AliasA >>', formGroup = '<< /S /Transparency /CS /AliasB >>', annotations = false, twoPages = false, defaultRgb = false } = {}) {
  const resources = `/Resources << /ColorSpace << /AliasA [/ICCBased 7 0 R] /AliasB [/ICCBased 7 0 R] ${defaultRgb ? '/DefaultRGB [/ICCBased 7 0 R]' : ''} >> /XObject << /F 6 0 R /I 9 0 R /S 10 0 R >> /ExtGState << /Half 8 0 R >> >>`;
  const page = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R ${resources} ${group === undefined ? '' : '/Group ' + group} ${annotations ? '/Annots [11 0 R 13 0 R 14 0 R]' : ''} >>`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [3 0 R ${twoPages ? '16 0 R' : ''}] /Count ${twoPages ? 2 : 1} /MediaBox [0 0 100 100] >>`, page,
    stream('.25 .45 .7 rg /I Do /F Do /S Do /Half gs 1 0 0 rg 0 0 5 5 re f'), 'null',
    stream('/I Do 0 0 8 8 re f', `/Subtype /Form /BBox [0 0 10 10] /Group ${formGroup}`),
    stream(profile, '/N 3'), '<< /ca .5 /BM /Multiply >>',
    stream(Uint8Array.of(55, 120, 210), '/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB'),
    stream('/I Do', '/Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /I true /CS /AliasA >>'),
    '<< /Subtype /Square /Rect [20 30 40 50] /AP << /N 12 0 R >> >>',
    stream('0 0 1 1 re f .2 .4 .8 rg 1 1 2 2 re f /I Do', '/Subtype /Form /BBox [0 0 5 5]'),
    '<< /Subtype /Link /Rect [60 30 90 50] /C [.2 .4 .8] /Border [0 0 2] >>',
    '<< /Subtype /Unknown /F 2 >>', 'null', page,
  ]);
}
async function payloadOf(bytes, run) {
  const core = await createPdfDocumentCore(bytes, options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}
const imageCommands = commands => commands.flatMap(c => c.op === 'image' ? [c] : c.commands ? imageCommands(c.commands) : []);

describe('declared RGB page transparency group', () => {
  it.each(['', '/I false', '/I true'])('honors the page profile and isolates direct output regardless of %s', async isolation => {
    await payloadOf(fixture({ group: `<< /S /Transparency /CS /AliasA ${isolation} >>` }), payload => {
      expect(payload.commands).toHaveLength(1);
      const page = payload.commands[0]; expect(page).toMatchObject({ op: 'group', alpha: 1, blend: 'source-over', isolated: true });
      expect(page.colorProfile).toEqual(profile);
      const value = convertPdfColor(deviceRgb(), [.25, .45, .7], parseIccProfile(profile));
      const command = page.commands.find(c => c.op === 'color' && c.fill && c.value === rgb(value));
      expect(command).toBeDefined(); value.forEach((n, i) => expect(command.nativeColor[i]).toBeCloseTo(n, 14));
      expect(imageCommands(page.commands)[0].pixels).not.toEqual(Uint8ClampedArray.of(55, 120, 210, 255));
    });
  });

  it('interns repeated stream aliases for non-isolated Forms, nested profiles and image cache keys', async () => {
    await payloadOf(fixture(), payload => {
      const page = payload.commands[0], nested = page.commands.find(c => c.op === 'group');
      expect(nested.colorProfile).toBe(page.colorProfile);
      const images = imageCommands(page.commands); expect(images).toHaveLength(3);
      expect(images[0].pixels).toBe(images[1].pixels); expect(images[1].pixels).toBe(images[2].pixels);
      expect(pdfPayloadBuffers(payload).filter(buffer => buffer === page.colorProfile.buffer)).toHaveLength(1);
    });
  });

  it('exposes the same resolved stream identity through different colour-space aliases', async () => {
    const reader = await NativePdfReader.create(fixture(), options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources');
      const a = await resolvePdfColorSpace(reader, resources, 'AliasA', options.loadAsset), b = await resolvePdfColorSpace(reader, resources, 'AliasB', options.loadAsset);
      expect(a.profileIdentity).toBe(b.profileIdentity); expect(a.profileBytes).not.toBe(b.profileBytes);
    } finally { reader.destroy(); }
  });

  it('decodes/parses an aliased ICC stream only once in an explicitly build-local memo', async () => {
    const reader = await NativePdfReader.create(fixture(), options);
    try {
      const page = reader.checked(reader.api.pn_pdf_resolve(3, 0)), resources = reader.field(page, 'Resources'), profileId = reader.checked(reader.api.pn_pdf_resolve(7, 0));
      const read = reader.bytes.bind(reader); let profileReads = 0;
      reader.bytes = value => { if ((typeof value === 'number' ? reader.node(value) : value).id === profileId) profileReads++; return read(value); };
      const memo = new Map(), a = await resolvePdfColorSpace(reader, resources, 'AliasA', options.loadAsset, 0, memo), b = await resolvePdfColorSpace(reader, resources, 'AliasB', options.loadAsset, 0, memo);
      expect(profileReads).toBe(1); expect(memo.size).toBe(1); expect(a).toBe(b); expect(a.profile).toBe(b.profile); expect(a.profileBytes).toBe(b.profileBytes);
    } finally { reader.destroy(); }
  });

  it('keeps fresh annotation states and converted link colours inside the page group', async () => {
    await payloadOf(fixture({ annotations: true }), payload => {
      const page = payload.commands[0], commands = page.commands;
      expect(commands).toContainEqual({ op: 'transform', args: [4, 0, 0, 4, 20, 30] });
      const index = commands.findIndex(c => c.op === 'transform' && c.args[4] === 20 && c.args[5] === 30);
      expect(commands.slice(index - 2, index)).toEqual([{ op: 'color', fill: true, value: 'rgb(0,0,0)', nativeColor: [0, 0, 0] }, { op: 'color', fill: false, value: 'rgb(0,0,0)', nativeColor: [0, 0, 0] }]);
      const annotationPaint = commands.slice(index).find(c => c.op === 'paint' && c.kind === 'f');
      expect(annotationPaint).toMatchObject({ fillAlpha: 1, strokeAlpha: 1, blend: 'source-over' });
      const nativeColor = convertPdfColor(deviceRgb(), [.2, .4, .8], parseIccProfile(profile)), value = rgb(nativeColor);
      expect(commands).toContainEqual({ op: 'color', fill: false, value, nativeColor });
      expect(commands).toContainEqual({ op: 'color', fill: true, value, nativeColor });
      const images = imageCommands(commands); expect(images.at(-1).pixels).toBe(images[0].pixels);
    });
  });

  it('does not reuse detached profile or image bytes across pages or cleanup/recompile', async () => {
    await payloadOf(fixture({ twoPages: true }), async (first, core) => {
      const clone = structuredClone(first, { transfer: pdfPayloadBuffers(first) });
      expect(first.commands[0].colorProfile.byteLength).toBe(0);
      expect(clone.commands[0].colorProfile).toEqual(profile);
      expect(clone.commands[0].commands.find(c => c.op === 'group').colorProfile).toBe(clone.commands[0].colorProfile);
      const second = await core.pagePayload(2); expect(second.commands[0].colorProfile).toEqual(profile);
      core.cleanup(1); const recompiled = await core.pagePayload(1); expect(recompiled.commands[0].colorProfile).toEqual(profile);
      expect(imageCommands(recompiled.commands).map(c => [...c.pixels])).toEqual(imageCommands(clone.commands).map(c => [...c.pixels]));
    });
  });

  it('honors DefaultRGB remapping on the declared page blending space', async () => {
    await payloadOf(fixture({ group: '<< /S /Transparency /CS /DeviceRGB >>', defaultRgb: true }), payload => expect(payload.commands[0].colorProfile).toEqual(profile));
  });

  it('keeps the no-Group path and optional null Group entries unwrapped', async () => {
    for (const page of ['', '/Group null']) await payloadOf(simplePdf('.2 .4 .8 rg 0 0 10 10 re f', { page }), payload => {
      expect(payload.commands.some(c => c.op === 'group')).toBe(false);
      expect(payload.commands).toContainEqual({ op: 'color', fill: true, value: 'rgb(51,102,204)', nativeColor: [.2, .4, .8] });
    });
  });

  it('treats optional null CS/I/K as absent and optional annotation Group null as ordinary appearance', async () => {
    const bytes = simplePdf('/F Do', { page: '/Group << /S /Transparency /CS null /I null /K null >> /Resources << /XObject << /F 6 0 R >> >> /Annots [7 0 R]', extra: [
      stream('0 0 2 2 re f', '/Subtype /Form /BBox [0 0 5 5] /Group null'),
      '<< /Subtype /Square /Rect [10 10 20 20] /AP << /N 8 0 R >> >>', stream('0 0 1 1 re f', '/Subtype /Form /BBox [0 0 1 1] /Group null'),
    ] });
    await payloadOf(bytes, payload => expect(payload.commands[0]).toMatchObject({ op: 'group', isolated: true, colorProfile: null }));
  });

  it('treats null DefaultRGB as absent but still rejects a null required ICC stream', async () => {
    await payloadOf(simplePdf('', { page: '/Group << /S /Transparency /CS /DeviceRGB >> /Resources << /ColorSpace << /DefaultRGB null >> >>' }), payload => expect(payload.commands[0].colorProfile).toBeNull());
    await expect(payloadOf(simplePdf('', { page: '/Group << /S /Transparency /CS [/ICCBased null] >>' }), () => {})).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('treats optional null ICC Range/Group Type as absent and rejects malformed ICC array shape', async () => {
    const page = '/Group << /Type null /S /Transparency /CS [/ICCBased 6 0 R] >>';
    await payloadOf(simplePdf('', { page, extra: [stream(profile, '/N 3 /Range null')] }), payload => expect(payload.commands[0].colorProfile).toEqual(profile));
    await expect(payloadOf(simplePdf('', { page: '/Group << /S /Transparency /CS [/ICCBased 6 0 R null] >>', extra: [stream(profile, '/N 3')] }), () => {})).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it.each([
    ['42', 'pdf_corrupt'], ['<< >>', 'pdf_corrupt'], ['<< /S null >>', 'pdf_corrupt'], ['<< /S 2 >>', 'pdf_corrupt'], ['<< /Type 2 /S /Transparency >>', 'pdf_corrupt'],
    ['<< /S /Other >>', 'pdf_unsupported'], ['<< /S /Transparency /I 0 >>', 'pdf_corrupt'], ['<< /S /Transparency /K 0 >>', 'pdf_corrupt'],
    ['<< /S /Transparency /K true >>', 'pdf_unsupported'],
    ['<< /S /Transparency /CS /DeviceGray >>', 'pdf_unsupported'],
  ])('rejects malformed or unsupported declared page group %s', async (group, code) => {
    const core = await createPdfDocumentCore(simplePdf('', { page: '/Group ' + group }), options);
    try { await expect(core.pagePayload(1)).rejects.toMatchObject({ code }); } finally { core.destroy(); }
  });

  it('still rejects a genuinely different non-isolated blend space and forward-only ICC target', async () => {
    await expect(payloadOf(fixture({ formGroup: '<< /S /Transparency /CS /DeviceRGB >>' }), () => {})).rejects.toThrow(/Non-isolated.*change blend/);
    const bytes = simplePdf('', { page: '/Group << /S /Transparency /CS [/ICCBased 6 0 R] >>', extra: [stream(syntheticRgbProfile({ curve: { samples: [0, 40000, 10000, 65535] } }), '/N 3')] });
    await expect(payloadOf(bytes, () => {})).rejects.toThrow(/group blend color space/);
  });

  it.each([
    ['<< /S /Transparency /I 0 >>', 'pdf_corrupt'], ['<< /S /Transparency /K 0 >>', 'pdf_corrupt'],
    ['<< /S /Transparency /K true >>', 'pdf_unsupported'], ['<< /S /Other >>', 'pdf_unsupported'],
  ])('preserves malformed/unsupported Form diagnostics for %s', async (formGroup, code) => {
    await expect(payloadOf(fixture({ formGroup }), () => {})).rejects.toMatchObject({ code });
  });

  it('keeps annotation appearance groups explicitly unsupported', async () => {
    const bytes = simplePdf('', { page: '/Group << /S /Transparency /CS /DeviceRGB >> /Annots [6 0 R]', extra: [
      '<< /Subtype /Square /Rect [0 0 10 10] /AP << /N 7 0 R >> >>',
      stream('0 0 1 1 re f', '/Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /I true /CS /DeviceRGB >>'),
    ] });
    await expect(payloadOf(bytes, () => {})).rejects.toThrow(/annotation transparency groups/);
  });

  it('retains the existing16Mpixel group surface budget before allocating the page surface', async () => {
    const canvasContext = { canvas: { width: 4001, height: 4000 }, save() {}, restore() {}, setTransform() {}, transform() {}, beginPath() {} };
    const task = renderPdfDisplayList({ fonts: [], commands: [{ op: 'group', isolated: true, alpha: 1, blend: 'source-over', colorProfile: profile, commands: [] }] },
      { canvasContext, viewport: { transform: [1, 0, 0, 1, 0, 0] }, background: false });
    await expect(task.promise).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF transparency surface budget exceeded.' });
  });
});

function budgetPdf(count, profiles) {
  const commands = [], names = [], objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 10 10] >>', '', '', 'null'];
  for (let i = 0; i < count; i++) {
    const id = objects.length + 1; names.push(`/F${i} ${id} 0 R`); commands.push(`/F${i} Do`);
    objects.push(stream('0 0 1 1 re f', `/Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /I true /CS [/ICCBased ${id + 1} 0 R] >>`));
    objects.push(stream(deflateSync(profiles[i % profiles.length]), '/N 3 /Filter /FlateDecode'));
  }
  objects[2] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << ${names.join(' ')} >> >> >>`;
  objects[3] = stream(commands.join(' ')); return pdf(objects);
}
describe('page-local blend-profile resource admission', () => {
  it('allows256 distinct profiles and rejects the next without charging repeated identities', async () => {
    await payloadOf(budgetPdf(256, [profile]), payload => expect(payload.commands.filter(c => c.op === 'group')).toHaveLength(256));
    await expect(payloadOf(budgetPdf(257, [profile]), () => {})).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page blend profile budget exceeded.' });
  });
  it('allows the32MiB retained-byte boundary and rejects another small profile', async () => {
    const padded = new Uint8Array(16 * 1024 * 1024); padded.set(profile); new DataView(padded.buffer).setUint32(0, padded.length);
    await payloadOf(budgetPdf(2, [padded]), payload => expect(payload.commands.filter(c => c.op === 'group')).toHaveLength(2));
    await expect(payloadOf(budgetPdf(3, [padded, padded, profile]), () => {})).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page blend profile budget exceeded.' });
  });
});
