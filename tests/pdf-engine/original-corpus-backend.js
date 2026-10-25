// Development-only adapter: the unchanged corpus assertions exercise the original engine.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import { getDocument as loadOriginal } from '../../src/pdf/pdf-engine.js';
import { options } from './fixtures.js';
export { TextLayer, isPageNarratorPdfEngine } from '../../src/pdf/pdf-engine.js';

const records = [];
export function getDocument(input) {
  const params = typeof input === 'string' ? { url: input } : input instanceof Uint8Array || input instanceof ArrayBuffer ? { data: input } : input;
  const data = params.data instanceof ArrayBuffer ? new Uint8Array(params.data) : params.data;
  const record = { sourceSha256: data && createHash('sha256').update(data).digest('hex'), sourceBytes: data?.length, opened: false, closed: false };
  records.push(record);
  const task = loadOriginal({ ...params, ...options, disableWorker: true });
  task.promise = task.promise.then(document => {
    record.opened = true; record.pageCount = document.numPages;
    const destroy = document.destroy;
    document.destroy = () => { record.closed = true; return destroy(); };
    return document;
  }, error => { record.error = { code: error.code, message: error.message }; throw error; });
  return task;
}
afterAll(async () => {
  const destination = process.env.PN_PDF_ORIGINAL_CORPUS_AUDIT_DIR;
  if (destination) {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, `${randomUUID()}.json`), `${JSON.stringify({ backend: 'PageNarrator original C++/WASM parser and browser facade, CPU core mode', wasmSha256: createHash('sha256').update(options.wasm).digest('hex'), records }, null, 2)}\n`);
  }
  expect(records.filter(record => record.opened && !record.closed), 'Original corpus documents must be destroyed.').toEqual([]);
});
