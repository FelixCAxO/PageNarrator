import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
it('pins bundled OCR model bytes and records modifications and licensing', () => {
  const models = JSON.parse(readFileSync('public/assets/ocr/models.json', 'utf8'));
  expect(models.map(m=>m.file)).toEqual(['uvdoc.onnx','tiny-det.onnx','small-rec.onnx','small-rec-alphabet.json']);
  for (const model of models) {
    const bytes=readFileSync(`public/assets/ocr/${model.file}`);
    expect(bytes.length).toBe(model.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(model.sha256);
    expect(model.source.license).toBe('apache-2.0');
    expect(model.source.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(model.modification.length).toBeGreaterThan(0);
  }
});
