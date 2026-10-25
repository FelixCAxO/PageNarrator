// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import * as documentCore from '../../src/pdf/document-core.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { buildPdfDisplayList } from '../../src/pdf/display-list.js';

vi.mock('../../src/pdf/display-list.js', () => ({ buildPdfDisplayList: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('destroys an acquired PDF reader if cancellation occurs at the async handoff', async () => {
  const controller = new AbortController(), reason = new Error('authored cancellation at reader handoff');
  const clearCrypt = vi.fn(), node = vi.fn(), bytes = new Uint8Array(), options = { signal: controller.signal };
  let reader;
  const create = vi.spyOn(NativePdfReader, 'create').mockImplementation(async (_bytes, { signal }) => {
    reader = new NativePdfReader({ pn_pdf_abi_version: () => 1, pn_pdf_clear_crypt: clearCrypt, pn_pdf_node: node }, signal);
    reader.trailer = 1; reader.temporary.set(-1, { kind: 'string' });
    queueMicrotask(() => controller.abort(reason));
    return reader;
  });
  await expect(createPdfDocumentCore(bytes, options)).rejects.toBe(reason);
  expect(create).toHaveBeenCalledExactlyOnceWith(bytes, options);
  expect(buildPdfDisplayList).not.toHaveBeenCalled();
  expect(node).not.toHaveBeenCalled(); // Cancellation precedes the first catalog/native read.
  expect(clearCrypt).toHaveBeenCalledTimes(1);
  expect(reader.closed).toBe(true); expect(reader.api).toBeNull(); expect(reader.temporary.size).toBe(0);
});

it('destroys a late core when the facade closes before its await continuation', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
  const controller = new AbortController(), reason = new Error('authored abort after core creation');
  const destroy = vi.fn(), getMetadata = vi.fn(async () => ({ info: {} }));
  const acquired = { numPages: 1, getMetadata, destroy };
  let resolveCore;
  const ready = new Promise(resolve => { resolveCore = resolve; });
  const create = vi.spyOn(documentCore, 'createPdfDocumentCore').mockReturnValue(ready);
  const bytes = new Uint8Array(), opening = openPdfDocument(bytes, { useWorker: false, signal: controller.signal });
  expect(create).toHaveBeenCalledTimes(1);
  resolveCore(acquired); controller.abort(reason);
  await expect(opening).rejects.toMatchObject({ name: 'PdfEngineError', code: 'pdf_closed', message: 'PDF document has been destroyed.' });
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(getMetadata).not.toHaveBeenCalled();
});
