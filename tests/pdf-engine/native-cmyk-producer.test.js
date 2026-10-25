import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options } from './fixtures.js';

const group = '/Group << /S /Transparency /CS /DeviceCMYK >>';
const square = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>';
const flat = commands => commands.flatMap(command => [command, ...(command.commands ? flat(command.commands) : [])]);
const paints = payload => flat(payload.commands).filter(command => command.op === 'paint' && command.kind !== 'n');
const near = (actual, expected) => { expect(actual).toHaveLength(expected.length); actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 14)); };
async function payload(content, settings, run) {
  const core = await createPdfDocumentCore(simplePdf(content, { ...settings, page: group + ' ' + (settings?.page || '') }), options);
  try { return await run(await core.pagePayload(1), core); } finally { core.destroy(); }
}

describe('bounded native CMYK producer admission', () => {
  it.each(['', '/I false', '/I true', '/I null'])('retains native4ink paints and isolates direct page output: %s', flag => {
    const corePromise = createPdfDocumentCore(simplePdf('.2 .3 .4 .5 k 0 0 10 10 re f', { page: `/Group << /S /Transparency /CS /DeviceCMYK ${flag} >>` }), options);
    return corePromise.then(async core => { try {
      const value = await core.pagePayload(1), outer = value.commands[0];
      expect(outer).toMatchObject({ op: 'group', nativeColorSpace: 'DeviceCMYK', isolated: true });
      expect(outer.colorProfile).toEqual(await options.loadAsset('iccs/CGATS001Compat-v2-micro.icc'));
      near(paints(value)[0].nativeCmykFill, [.2, .3, .4, .5]);
    } finally { core.destroy(); } });
  });

  it('uses BG/UCR at actual fill/stroke/text paints after source selection, with q/Q restoration', async () => {
    await payload('.2 .7 .4 rg .2 .7 .4 RG q /G gs 0 0 10 10 re B BT /F1 12 Tf (Ink) Tj ET Q 20 0 10 10 re f', {
      page: '/Resources << /Font << /F1 5 0 R >> /ExtGState << /G 6 0 R >> >>', extra: ['<< /BG 7 0 R >>', square],
    }, value => {
      const p = paints(value); near(p[0].nativeCmykFill, [.5, 0, .3, .09]); near(p[0].nativeCmykStroke, [.5, 0, .3, .09]);
      near(flat(value.commands).find(command => command.op === 'text').nativeCmyk, [.5, 0, .3, .09]); near(p[1].nativeCmykFill, [.5, 0, .3, .3]);
      expect(flat(value.commands).filter(command => command.op === 'color').every(command => command.nativeCmyk === undefined)).toBe(true);
      expect(flat(value.commands).some(command => command.printState || command.blackGeneration)).toBe(false);
    });
  });

  it('computes inherited source colours with the print state at Form Do and inside the Form', async () => {
    await payload('.2 .7 .4 rg /G gs /F Do', { page: '/Resources << /ExtGState << /G 6 0 R >> /XObject << /F 8 0 R >> >>',
      extra: ['<< /BG 7 0 R >>', square, stream('0 0 10 10 re f', '/Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /CS /DeviceCMYK /I true >>')],
    }, value => near(paints(value)[0].nativeCmykFill, [.5, 0, .3, .09]));
  });

  it('maps Gray only toK and All to each native ink, retaining initial black', async () => {
    await payload('0 0 10 10 re f .25 g 10 0 10 10 re f /All cs .3 scn 20 0 10 10 re f', {
      page: '/Resources << /ColorSpace << /All [/Separation /All /DeviceRGB 6 0 R] >> >>', extra: [square],
    }, value => { const p = paints(value); expect(p[0].nativeCmykFill).toEqual([0, 0, 0, 1]); expect(p[1].nativeCmykFill).toEqual([0, 0, 0, .75]); near(p[2].nativeCmykFill, [.3, .3, .3, .3]); });
  });

  it('keeps the same owned forward profile for same-target child groups and rebuilds after transfer', async () => {
    await payload('/G gs /F Do', { page: '/Resources << /ExtGState << /G 6 0 R >> /XObject << /F 7 0 R >> >>',
      extra: ['<< /ca .5 >>', stream('.2 .3 .4 .5 k 0 0 10 10 re f', '/Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /CS /DeviceCMYK /I false >>')],
    }, async (value, core) => {
      const groups = flat(value.commands).filter(command => command.op === 'group'); expect(groups).toHaveLength(2); expect(groups[1].colorProfile).toBe(groups[0].colorProfile); expect(groups[1].isolated).toBe(false);
      const transfers = pdfPayloadBuffers(value); expect(transfers).toHaveLength(1);
      const clone = structuredClone(value, { transfer: transfers }); expect(groups[0].colorProfile.byteLength).toBe(0);
      const copied = flat(clone.commands).filter(command => command.op === 'group'); expect(copied[1].colorProfile).toBe(copied[0].colorProfile);
      core.cleanup(1); const fresh = await core.pagePayload(1); expect(fresh.commands[0].colorProfile.byteLength).toBe(8464); near(paints(fresh)[0].nativeCmykFill, [.2, .3, .4, .5]);
    });
  });

  it('retains one owned native image and alpha buffer across paints, transfer and cleanup rebuild', async () => {
    const fixtures = new URL('./fixtures/jpeg-original/', import.meta.url), controls = JSON.parse(await readFile(new URL('colour-controls.json', fixtures), 'utf8'));
    const source = controls.streams.find(source => source.marker === 0), jpeg = await readFile(new URL(source.id + '.jpg', fixtures));
    const alpha = Uint8Array.from({ length: source.width * source.height }, (_, i) => i % 256);
    await payload('q 20 0 0 10 2 3 cm /I Do Q /I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
      stream(jpeg, `/Subtype /Image /Width ${source.width} /Height ${source.height} /BitsPerComponent 8 /ColorSpace /DeviceCMYK /Filter /DCTDecode /SMask 7 0 R`),
      stream(deflateSync(alpha), `/Subtype /Image /Width ${source.width} /Height ${source.height} /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode`),
    ] }, async (value, core) => {
      const images = flat(value.commands).filter(command => command.op === 'image'); expect(images).toHaveLength(2);
      expect(images[0]).toMatchObject({ format: 'native-cmyk', matrix: [20, 0, 0, 10, 2, 3], blend: 'source-over', alpha: 1 });
      expect(images[1].matrix).toEqual([1, 0, 0, 1, 0, 0]); expect(images[0].bytes).toBe(images[1].bytes); expect(images[0].softMask.bytes).toBe(images[1].softMask.bytes);
      expect(images[0].softMask.bytes).toEqual(alpha); expect(images[0].bytes).toHaveLength(source.width * source.height * 4); expect(images[0].pixels).toBeUndefined();
      const buffers = pdfPayloadBuffers(value); expect(buffers).toHaveLength(3);
      const clone = structuredClone(value, { transfer: buffers }); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      const copied = flat(clone.commands).filter(command => command.op === 'image'); expect(copied[0].bytes).toBe(copied[1].bytes); expect(copied[0].softMask.bytes).toEqual(alpha);
      core.cleanup(1); const fresh = flat((await core.pagePayload(1)).commands).filter(command => command.op === 'image');
      expect(fresh[0].bytes).not.toBe(copied[0].bytes); expect(fresh[0].bytes).toEqual(copied[0].bytes); expect(fresh[0].softMask.bytes).toEqual(alpha);
    });
  });

  it('starts an annotation appearance afresh instead of inheriting page colour/print state', async () => {
    await payload('1 0 0 rg /G gs 0 0 10 10 re f', { page: '/Resources << /ExtGState << /G 6 0 R >> >> /Annots [8 0 R 10 0 R]',
      extra: ['<< /BG 7 0 R >>', square, '<< /Subtype /Square /Rect [10 10 20 20] /AP << /N 9 0 R >> >>', stream('0 0 1 1 re f .2 .7 .4 rg 0 0 .5 .5 re f', '/Subtype /Form /BBox [0 0 1 1]'), '<< /Subtype /Link /Rect [20 20 30 30] /C [.2 .7 .4] /Border [0 0 1] >>'],
    }, value => { const p = paints(value); expect(p[1].nativeCmykFill).toEqual([0, 0, 0, 1]); near(p[2].nativeCmykFill, [.5, 0, .3, .3]); near(p[3].nativeCmykStroke, [.5, 0, .3, .3]); });
  });

  it.each(['/OP true', '/op true', '/AIS true', '/BM /Multiply'])('rejects unsupported native ink state before returning a paint payload: %s', setting => payload('/G gs 0 0 10 10 re f', {
    page: '/Resources << /ExtGState << /G 6 0 R >> >>', extra: [`<< ${setting} >>`],
  }, () => {}).then(() => { throw new Error('Expected refusal.'); }, error => expect(error).toMatchObject({ code: 'pdf_unsupported' })));

  it('respects separate fill/stroke overprint and q/Q when checking actually painted channels', async () => {
    await payload('/G gs 0 0 10 10 re f q /R gs 10 0 10 10 re f Q 20 0 10 10 re f', {
      page: '/Resources << /ExtGState << /G 6 0 R /R 7 0 R >> >>', extra: ['<< /OP true /op false >>', '<< /OP false >>'],
    }, value => expect(paints(value)).toHaveLength(3));
    await expect(payload('/G gs 0 0 10 10 re S', { page: '/Resources << /ExtGState << /G 6 0 R >> >>', extra: ['<< /OP true /op false >>'] }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });

  it('refuses image/shading/target changes instead of converting their current RGB output back to inks', async () => {
    await expect(payload('/I Do', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(Uint8Array.of(1, 2, 3, 4), '/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceCMYK')] }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('native PDF image source format') });
    await expect(payload('/S sh', { page: '/Resources << /Shading << /S 6 0 R >> >>', extra: ['<< >>'] }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('Native PDF shading') });
    await expect(payload('/F Do', { page: '/Resources << /XObject << /F 6 0 R >> >>', extra: [stream('0 0 1 1 re f', '/Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /CS /DeviceRGB /I true >>')] }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('colour-space changes') });
  });

  it('honors source DefaultGray and rejects a calibrated replacement at its first actual native paint', async () => {
    await expect(payload('0 0 10 10 re f', { page: '/Resources << /ColorSpace << /DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] >>] >> >>' }, () => {})).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('CalGray') });
    await payload('.2 .3 .4 .5 k 0 0 10 10 re f', { page: '/Resources << /ColorSpace << /DefaultGray [/CalGray << /WhitePoint [.9642 1 .8249] >>] >> >>' }, value => near(paints(value)[0].nativeCmykFill, [.2, .3, .4, .5]));
  });
});
