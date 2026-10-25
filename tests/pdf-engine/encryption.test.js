import { describe, expect, it } from 'vitest';
import { createHash, createCipheriv } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { decodePdfStream } from '../../src/pdf/streams.js';
import { pdfMd5, pdfRc4, pdfAesDecrypt } from '../../src/pdf/encryption.js';
import { simplePdf, options, stream, bytes } from './fixtures.js';
const hex = value => Uint8Array.from(Buffer.from(value, 'hex'));
describe('original bounded C++ PDF crypto primitives', () => {
  it('matches RFC1321 digest vectors and independent block-boundary digests', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try {
      for (const text of ['', 'a', 'abc', 'message digest', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789']) {
        const input = new TextEncoder().encode(text); expect(pdfMd5(reader, input)).toEqual(hex(createHash('md5').update(input).digest('hex')));
      }
      for (const length of [55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024]) {
        const input = Uint8Array.from({ length }, (_, i) => i * 73 & 255); expect(pdfMd5(reader, input)).toEqual(hex(createHash('md5').update(input).digest('hex')));
      }
    } finally { reader.destroy(); }
  });
  it('matches the RFC6229 40-bit RC4 vector and retains input bytes', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options), key = hex('0102030405'), zeros = new Uint8Array(32);
    try {
      expect(pdfRc4(reader, key, zeros)).toEqual(hex('b2396305f03dc027ccc3524a0a1118a86982944f18fc82d589c403a47a0d0919'));
      expect(zeros).toEqual(new Uint8Array(32)); expect(pdfRc4(reader, key, pdfRc4(reader, key, hex('000102030405060708090a0b0c0d0e0f')))).toEqual(hex('000102030405060708090a0b0c0d0e0f'));
      expect(() => pdfRc4(reader, new Uint8Array(), zeros)).toThrow(/Invalid/);
    } finally { reader.destroy(); }
  });
  it.each([16, 24, 32])('matches independent AES-CBC blocks using a %i-byte key', async length => {
    const reader = await NativePdfReader.create(simplePdf(''), options), key = Uint8Array.from({ length }, (_, i) => i * 7 + 3 & 255), iv = hex('000102030405060708090a0b0c0d0e0f');
    try {
      for (const blocks of [0, 1, 2, 9]) {
        const input = Uint8Array.from({ length: blocks * 16 }, (_, i) => i * 19 & 255), cipher = createCipheriv(`aes-${length * 8}-cbc`, key, iv); cipher.setAutoPadding(false);
        const encoded = new Uint8Array(Buffer.concat([cipher.update(input), cipher.final()])); expect(pdfAesDecrypt(reader, key, iv, encoded)).toEqual(input);
      }
      expect(() => pdfAesDecrypt(reader, key, iv, new Uint8Array(15))).toThrow(/Invalid/);
    } finally { reader.destroy(); }
  });
});
describe('original standard PDF security handler', () => {
  it.each(['encrypted-r2.pdf', 'encrypted-r3.pdf', 'encrypted-r4.pdf', 'encrypted-r4-objects.pdf', 'encrypted-r5.pdf', 'encrypted-r6.pdf'])('opens %s with an empty user password and independent content/metadata parity', async name => {
    const data = new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url))), original = data.slice(), document = await openPdfDocument(data, options), task = reference.getDocument({ data: data.slice(), useSystemFonts: true });
    try {
      expect(document.numPages).toBe(1); const expected = await task.promise, actualText = (await (await document.getPage(1)).getTextContent()).items.map(i => i.str).join('');
      expect(actualText).toBe('Original encrypted PDF fixture.'); expect(actualText).toBe((await (await expected.getPage(1)).getTextContent()).items.map(i => i.str).join(''));
      expect((await document.getMetadata()).info.Title).toBe('Encrypted source title'); expect((await expected.getMetadata()).info.Title).toBe('Encrypted source title'); expect(data).toEqual(original);
    } finally { document.destroy(); await task.destroy(); }
  });
  it.each(['encrypted-r4-password.pdf', 'encrypted-r5-password.pdf', 'encrypted-r6-password.pdf'])('rejects missing/wrong passwords and accepts valid user/owner authentication for %s', async name => {
    const data = new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
    await expect(openPdfDocument(data, options)).rejects.toMatchObject({ name: 'PasswordException', code: 'pdf_password' });
    await expect(openPdfDocument(data, { ...options, password: 'incorrect' })).rejects.toMatchObject({ code: 'pdf_password' });
    for (const password of ['pn-user', 'pn-owner']) {
      const document = await openPdfDocument(data, { ...options, password });
      try { expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe('Original encrypted PDF fixture.'); } finally { document.destroy(); }
    }
  });
  it('rejects tampered AES-256 permissions and incorrect Unicode passwords', async () => {
    const source = await readFile(new URL('./fixtures/encrypted-r6.pdf', import.meta.url)), text = source.toString('latin1'), match = /\/Perms\s*<([\da-f]+)>/iu.exec(text);
    expect(match).not.toBeNull(); const offset = match.index + match[0].indexOf('<') + 1, changed = source.slice(); changed[offset] = changed[offset] === 48 ? 49 : 48;
    await expect(openPdfDocument(new Uint8Array(changed), options)).rejects.toMatchObject({ code: 'pdf_corrupt', message: expect.stringContaining('permissions validation') });
    await expect(openPdfDocument(new Uint8Array(source), { ...options, password: '\u00e9' })).rejects.toMatchObject({ name: 'PasswordException', code: 'pdf_password' });
  });
});

const fileKey = hex('00112233445566778899aabbccddeeff'), iv = hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
function encryptObject(number, value, pad = true) {
  const object = Uint8Array.of(number, number >> 8, number >> 16, 0, 0, 115, 65, 108, 84), key = createHash('md5').update(fileKey).update(object).digest();
  const cipher = createCipheriv('aes-128-cbc', key, iv); cipher.setAutoPadding(pad);
  return new Uint8Array(Buffer.concat([iv, cipher.update(value), cipher.final()]));
}
async function installTestPolicy(reader, { metadata = true } = {}) {
  const dictionary = reader.checked(reader.api.pn_pdf_resolve(8, 0)); reader.api.pn_pdf_mark();
  try { reader.checked(reader.api.pn_pdf_set_crypt(reader.copy(fileKey), fileKey.length, 2, 2, 2, 8, dictionary, metadata ? 1 : 0)); reader.security = { revision: 4 }; } finally { reader.api.pn_pdf_rewind(); }
}
describe('original encrypted PDF object boundaries', () => {
  it('decrypts nested strings/streams once, skips clear metadata and signature contents', async () => {
    const content = bytes('BT /F1 12 Tf (Bounded decryption) Tj ET'), title = encryptObject(6, bytes('Source title'));
    const data = simplePdf('', { contents: stream(encryptObject(4, content)), extra: [`<< /Title <${Buffer.from(title).toString('hex')}> /Nested [<${Buffer.from(title).toString('hex')}>] >>`, stream('<metadata>clear</metadata>', '/Type /Metadata /Subtype /XML'), '<< /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>', '<< /Type /Sig /Contents <DEADBEEF> >>'] });
    const reader = await NativePdfReader.create(data, options);
    try {
      await installTestPolicy(reader, { metadata: false }); const resolve = number => reader.checked(reader.api.pn_pdf_resolve(number, 0));
      expect((await decodePdfStream(reader, resolve(4))).bytes).toEqual(content);
      const object = resolve(6); expect(reader.text(reader.field(object, 'Title'))).toBe('Source title'); expect(reader.text(reader.array(reader.field(object, 'Nested'))[0])).toBe('Source title');
      expect(new TextDecoder().decode((await decodePdfStream(reader, resolve(7))).bytes)).toBe('<metadata>clear</metadata>');
      expect(reader.bytes(reader.field(resolve(9), 'Contents'))).toEqual(hex('deadbeef'));
    } finally { reader.destroy(); }
  });
  it.each(['Identity', 'StdCF'])('honors an explicit /Crypt filter selecting /%s', async name => {
    const content = bytes('Explicit crypt-filter source'), compressed = deflateSync(content), encoded = name === 'Identity' ? compressed : encryptObject(4, compressed);
    const data = simplePdf('', { contents: stream(encoded, `/Filter [/Crypt /FlateDecode] /DecodeParms [<< /Name /${name} >> null]`), extra: ['null', 'null', '<< /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>'] }), reader = await NativePdfReader.create(data, options);
    try { await installTestPolicy(reader); expect((await decodePdfStream(reader, reader.checked(reader.api.pn_pdf_resolve(4, 0)))).bytes).toEqual(content); } finally { reader.destroy(); }
  });
  it('rejects AES padding corruption and a crypt filter after another decoder', async () => {
    const bad = encryptObject(6, new Uint8Array(16), false), reader = await NativePdfReader.create(simplePdf('', { extra: [`<< /Value <${Buffer.from(bad).toString('hex')}> >>`, 'null', '<< /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>'] }), options);
    try { await installTestPolicy(reader); expect(() => reader.checked(reader.api.pn_pdf_resolve(6, 0))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' })); } finally { reader.destroy(); }
    const wrong = await NativePdfReader.create(simplePdf('', { contents: stream('x', '/Filter [/FlateDecode /Crypt]'), extra: ['null', 'null', '<< /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> >>'] }), options);
    try { await installTestPolicy(wrong); expect(() => wrong.checked(wrong.api.pn_pdf_resolve(4, 0))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' })); } finally { wrong.destroy(); }
  });
});
