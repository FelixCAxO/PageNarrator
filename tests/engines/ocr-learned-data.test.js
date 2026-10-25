import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TesseractLineModel } from '../../src/engines/tesseract-line-model.js';

it('loads the packaged independent learned data and includes its original notice and full license', async () => {
  const directory = new URL('../../public/assets/ocr/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('english-lstm.json', directory), 'utf8'));
  expect(manifest.candidateOnly).toBe(false);
  expect(manifest.productionSelection).toBe('independent-line-verification');
  expect(manifest.source.license).toBe('Apache-2.0');
  expect(manifest.source.transformation).toContain('no DAWG dictionaries, legacy classifier or executable code');
  const notices = [];
  for (const entry of manifest.licenseFiles) {
    const bytes = await readFile(new URL(entry.path, directory));
    expect(bytes.byteLength).toBe(entry.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    notices.push(bytes.toString('utf8'));
  }
  expect(notices.some(value => value.includes('All data in the repository are licensed under the Apache'))).toBe(true);
  expect(notices.some(value => value.includes('Version 2.0, January 2004') && value.includes('END OF TERMS AND CONDITIONS'))).toBe(true);
  const weights = await readFile(new URL(manifest.weights.path, directory));
  const wasm = await readFile(new URL('../../public/native/ocr-lstm-engine.wasm', import.meta.url));
  const model = await TesseractLineModel.create(manifest, weights, wasm);
  try {
    const output = await model.runPixels(new Int8Array(36 * 12).fill(127), 12);
    expect(output.dims).toEqual([4, 111]);
    for (let frame = 0; frame < 4; frame++) {
      const probabilities = output.data.slice(frame * 111, (frame + 1) * 111);
      expect(probabilities.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
      expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    }
  } finally { await model.dispose(); }
  expect(model.engine.buffers.size).toBe(0); expect(model.engine.tensors.size).toBe(0);
});
