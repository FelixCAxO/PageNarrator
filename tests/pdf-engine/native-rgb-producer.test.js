// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import * as images from '../../src/pdf/image-data.js';
import * as rgbPolicy from '../../src/pdf/native-rgb-image.js';
import { pdfPayloadBuffers } from '../../src/pdf/payload-buffers.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.restoreAllMocks());
const source = Uint8Array.of(17, 91, 153, 254, 1, 127);
const square = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >>';
const flat = commands => commands.flatMap(command => [command, ...(command.commands ? flat(command.commands) : [])]);
function fixture(content, setting = '/BG 8 0 R') {
  return simplePdf(content, {
    page: '/Group << /S /Transparency /CS /DeviceCMYK >> /Resources << /XObject << /I 6 0 R >> /ExtGState << /Custom 7 0 R /Default 9 0 R >> >>',
    extra: [stream(deflateSync(source), '/Subtype /Image /Width 2 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode'),
      `<< ${setting} >>`, square, '<< /BG2 /Default /UCR2 /Default >>'],
  });
}
async function withCore(data, run) {
  const core = await createPdfDocumentCore(data, options);
  try { return await run(core); } finally { core.destroy(); }
}
function observe() {
  const events = [], read = images.readPdfImage, defaults = rgbPolicy.assertPdfNativeRgbPrintDefaults, has = Map.prototype.has;
  vi.spyOn(rgbPolicy, 'assertPdfNativeRgbPrintDefaults').mockImplementation(print => { events.push('defaults'); return defaults(print); });
  vi.spyOn(images, 'readPdfImage').mockImplementation((...args) => { events.push('decode'); return read(...args); });
  vi.spyOn(Map.prototype, 'has').mockImplementation(function (key) {
    if (typeof key === 'string' && key.endsWith(':DeviceCMYK:')) events.push('cache');
    return has.call(this, key);
  });
  return events;
}

describe('native RGB producer print-state boundary', () => {
  it.each(['BG', 'UCR', 'BG2', 'UCR2'])('rejects custom /%s before looking up an already cached RGB source', async field => {
    const events = observe();
    await withCore(fixture('/I Do /Custom gs /I Do', `/${field} 8 0 R`), async core => {
      await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported', message: expect.stringContaining('custom black generation or undercolor removal') });
    });
    expect(events).toEqual(['defaults', 'cache', 'decode', 'defaults']);
    expect(images.readPdfImage).toHaveBeenCalledTimes(1);
  });

  it('rejects a first custom RGB Do before its cache lookup or decoder', async () => {
    const events = observe();
    await withCore(fixture('/Custom gs /I Do'), async core => {
      await expect(core.pagePayload(1)).rejects.toMatchObject({ code: 'pdf_unsupported' });
    });
    expect(events).toEqual(['defaults']); expect(images.readPdfImage).not.toHaveBeenCalled();
  });

  it.each(['q /Custom gs Q', '/Custom gs /Default gs'])('restores the default policy before a cached Do: %s', async between => {
    const events = observe();
    await withCore(fixture(`/I Do ${between} /I Do`), async core => {
      const payload = await core.pagePayload(1), paints = flat(payload.commands).filter(command => command.op === 'image');
      expect(paints).toHaveLength(2); expect(paints[0]).toMatchObject({ format: 'native-rgb', components: 3, bits: 8 });
      expect(paints[0].bytes).toBe(paints[1].bytes); expect(paints[0].bytes).toEqual(source);
    });
    expect(events).toEqual(['defaults', 'cache', 'decode', 'defaults', 'cache']);
  });

  it('transfers one raw RGB owner and rebuilds fresh source bytes after cleanup', async () => {
    await withCore(fixture('/I Do /I Do'), async core => {
      const payload = await core.pagePayload(1), paints = flat(payload.commands).filter(command => command.op === 'image');
      const buffers = pdfPayloadBuffers(payload); expect(buffers).toHaveLength(2);
      const clone = structuredClone(payload, { transfer: buffers }), copied = flat(clone.commands).filter(command => command.op === 'image');
      expect(paints[0].bytes.byteLength).toBe(0); expect(copied[0].bytes).toBe(copied[1].bytes); expect(copied[0].bytes).toEqual(source);
      core.cleanup(1); const fresh = flat((await core.pagePayload(1)).commands).filter(command => command.op === 'image');
      expect(fresh[0].bytes.buffer).not.toBe(copied[0].bytes.buffer); expect(fresh[0].bytes).toEqual(source);
    });
  });
});
