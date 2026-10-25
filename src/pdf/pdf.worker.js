// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createPdfDocumentCore } from './document-core.js';
import { pdfPayloadBuffers } from './payload-buffers.js';
let ready = null, payloadQueue = Promise.resolve();
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    if (method === 'open') {
      if (ready) throw new Error('PDF worker has already been opened.');
      ready = createPdfDocumentCore(args[0], args[1]); const core = await ready;
      self.postMessage({ id, result: { numPages: core.numPages, metadata: await core.getMetadata() } }); return;
    }
    if (!ready || !['pageInfo', 'pagePayload', 'cleanup'].includes(method)) throw new Error('Invalid PDF worker request.');
    const core = await ready;
    if (method === 'pagePayload') {
      const request = payloadQueue.then(async () => {
        const result = await core.pagePayload(...args);
        // The browser cache owns the transferred bytes. A later request recompiles
        // rather than reusing detached buffers from the worker's page cache.
        core.cleanup(args[0]); self.postMessage({ id, result }, pdfPayloadBuffers(result));
      });
      payloadQueue = request.catch(() => null); await request;
    } else { const result = await core[method](...args); self.postMessage({ id, result }); }
  } catch (error) { self.postMessage({ id, error: { message: error.message, name: error.name, code: error.code } }); }
};
