import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import manifest from './fixtures/unicode-passwords/manifest.json' with { type: 'json' };
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { options } from './fixtures.js';

describe('original R6 Unicode preparation through encrypted PDF execution', () => {
  it.each(manifest.entries)('authenticates independently encrypted $id with normalized equivalents and owner credentials', async entry => {
    const data = new Uint8Array(await readFile(new URL(`./fixtures/unicode-passwords/${entry.file}`, import.meta.url)));
    expect(createHash('sha256').update(data).digest('hex')).toBe(entry.sha256);
    expect(entry.independentReadPassed).toBe(true);
    for (const password of [entry.password, ...entry.equivalents, entry.owner]) {
      const document = await openPdfDocument(data, { ...options, password });
      try {
        expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe('Original Unicode password fixture.');
        expect((await document.getMetadata()).info.Title).toBe('Unicode password source title');
      } finally { document.destroy(); }
    }
    const raw = new Uint8Array(Buffer.from(entry.preparedBytesHex, 'hex')), retained = raw.slice();
    const document = await openPdfDocument(data, { ...options, password: raw });
    try { expect(document.numPages).toBe(1); } finally { document.destroy(); }
    expect(raw).toEqual(retained);
  });
  it('preserves raw byte semantics and rejects prohibited text even beyond the 127-byte truncation boundary', async () => {
    const mapping = new Uint8Array(await readFile(new URL('./fixtures/unicode-passwords/mapping.pdf', import.meta.url)));
    await expect(openPdfDocument(mapping, { ...options, password: new TextEncoder().encode('I\u00adX') })).rejects.toMatchObject({ name: 'PasswordException', code: 'pdf_password' });
    const truncated = new Uint8Array(await readFile(new URL('./fixtures/unicode-passwords/truncate-bytes.pdf', import.meta.url)));
    await expect(openPdfDocument(truncated, { ...options, password: `${'A'.repeat(127)}\u0007` })).rejects.toMatchObject({ name: 'PasswordException', code: 'pdf_password' });
    await expect(openPdfDocument(truncated, { ...options, password: 'A'.repeat(127) })).rejects.toMatchObject({ code: 'pdf_password' });
  });
});
