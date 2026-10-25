// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export async function createPdfOcrWorker({ runtime = globalThis.chrome?.runtime,
  createWorker = () => new Worker(new URL('./pdf-ocr-worker.js', import.meta.url), { type: 'module' }),
  createBitmap = source => createImageBitmap(source) } = {}) {
  if (!runtime?.getURL) throw new Error('PDF OCR requires the extension runtime.');
  const worker = createWorker();
  let closed = false, busy = false, nextId = 0;
  const pending = new Map();
  function terminate() {
    if (closed) return;
    closed = true; worker.terminate();
    for (const { reject } of pending.values()) reject(new Error('PDF OCR worker closed.'));
    pending.clear();
  }
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
    else request.resolve(data.result);
  };
  worker.onerror = terminate;
  worker.onmessageerror = terminate;
  async function request(method, canvas, { mode = 'page' } = {}) {
      if (closed) throw new Error('PDF OCR worker closed.');
      if (busy) throw new Error('PDF OCR worker already has an active recognition.');
      if (!['page', 'crop'].includes(mode) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)
        || canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > (method === 'recognizeLine' ? 1_048_576 : 4_000_000)) throw new RangeError('Invalid OCR image or retry mode.');
      busy = true;
      let bitmap;
      try {
        bitmap = await createBitmap(canvas);
        if (closed) throw new Error('PDF OCR worker closed.');
        return await new Promise((resolve, reject) => {
          const id = ++nextId; pending.set(id, { resolve, reject });
          try { worker.postMessage({ id, method, bitmap, mode, runtimeRoot: runtime.getURL('') }, [bitmap]); bitmap = null; }
          catch (error) { pending.delete(id); reject(error); }
        });
      } finally { bitmap?.close(); busy = false; }
  }
  return {
    recognize(canvas, options) { return request('recognize', canvas, options); },
    recognizeLine(canvas) { return request('recognizeLine', canvas); },
    terminate,
  };
}
