import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodePdfStream } from '../../src/pdf/streams.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdf, simplePdf, stream, show, options } from './fixtures.js';

async function decode(data, filter = '/FlateDecode') {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(data, `/Filter ${filter}`)] }), options);
  try { return await decodePdfStream(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0))); }
  finally { reader.destroy(); }
}

describe('empty Flate content streams', () => {
  it.each(['/FlateDecode', '/Fl'])('treats a zero-byte %s stream as empty content', async filter => {
    expect(await decode(new Uint8Array(), filter)).toEqual({ bytes: new Uint8Array(), format: 'raw' });
  });

  it('preserves following content in an array containing an empty filtered stream', async () => {
    const data = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 6 0 R] >>',
      stream('', '/Filter /FlateDecode'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      stream(deflateSync(Buffer.from(show('Content after empty stream'))), '/Filter /FlateDecode'),
    ]);
    const core = await createPdfDocumentCore(data, options);
    try { expect((await core.pagePayload(1)).items.map(item => item.str).join('')).toBe('Content after empty stream'); }
    finally { core.destroy(); }
  });

  it('still decodes a complete zlib encoding of empty content', async () => {
    expect((await decode(deflateSync(new Uint8Array()))).bytes).toHaveLength(0);
  });

  it('rejects truncated and checksum-damaged nonempty zlib data', async () => {
    const valid = deflateSync(Buffer.from('Required complete content'));
    const damaged = valid.slice(); damaged[damaged.length - 1] ^= 1;
    for (const input of [valid.subarray(0, 1), valid.subarray(0, valid.length - 1), damaged]) await expect(decode(input)).rejects.toBeDefined();
  });

  it('still rejects an unknown filter on an empty stream', async () => {
    await expect(decode(new Uint8Array(), '/UnknownDecode')).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
});
