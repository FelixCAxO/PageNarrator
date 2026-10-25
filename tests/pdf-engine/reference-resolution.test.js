// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { options, pdf } from './fixtures.js';

async function withReader(objects, run) {
  const reader = await NativePdfReader.create(pdf(objects), options);
  try { await run(reader, reader.field(reader.trailer, 'Root')); } finally { reader.destroy(); }
}

describe('bounded original PDF reference resolution', () => {
  it.each([['self', ['1 0 R']], ['two objects', ['2 0 R', '1 0 R']]])('rejects a %s cycle without exhausting the JavaScript stack', async (_name, objects) => {
    await withReader(objects, (reader, root) => {
      expect(reader.node(root, { resolve: false })).toMatchObject({ kind: 'reference', aux: 1 });
      expect(() => reader.node(root)).toThrow(expect.objectContaining({ name: 'PdfEngineError', code: 'pdf_corrupt', message: 'Cyclic PDF object reference.' }));
      expect(reader.node(root, { resolve: false })).toMatchObject({ kind: 'reference', aux: 1 });
    });
  });

  it('allows exactly 64 reference hops and preserves the resolved dictionary identity', async () => {
    const objects = Array.from({ length: 63 }, (_value, i) => `${i + 2} 0 R`); objects.push('<< /Type /Catalog >>');
    await withReader(objects, (reader, root) => {
      const resolved = reader.node(root);
      expect(resolved.kind).toBe('dictionary'); expect(reader.name(reader.field(resolved.id, 'Type'))).toBe('Catalog');
      expect(reader.node(root).id).toBe(resolved.id);
    });
  });

  it('rejects a longer acyclic chain explicitly', async () => {
    const objects = Array.from({ length: 64 }, (_value, i) => `${i + 2} 0 R`); objects.push('<< /Type /Catalog >>');
    await withReader(objects, (reader, root) => expect(() => reader.node(root)).toThrow(expect.objectContaining({ name: 'PdfEngineError', code: 'pdf_limit', message: 'PDF object reference depth limit exceeded.' })));
  });
});
