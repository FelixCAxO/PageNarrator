// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createOcrWorkerRuntime } from '../engines/ocr-worker-runtime.js';

let runtime, queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.catch(() => null).then(async () => {
    let canvas;
    try {
      if (!['recognize', 'recognizeLine'].includes(data.method) || !Number.isSafeInteger(data.id) || !data.bitmap
        || !Number.isInteger(data.bitmap.width) || !Number.isInteger(data.bitmap.height)
        || data.bitmap.width < 1 || data.bitmap.height < 1 || data.bitmap.width * data.bitmap.height > (data.method === 'recognizeLine' ? 1_048_576 : 4_000_000)) throw new Error('Invalid OCR worker request.');
      runtime ||= createOcrWorkerRuntime(data.runtimeRoot);
      const engine = await runtime;
      canvas = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
      canvas.getContext('2d').drawImage(data.bitmap, 0, 0);
      data.bitmap.close(); data.bitmap = null;
      const result = data.method === 'recognizeLine' ? await engine.recognizeLine(canvas) : await engine.recognize(canvas, { mode: data.mode });
      self.postMessage({ id: data.id, result });
    } catch (error) {
      self.postMessage({ id: data.id, error: { name: error.name, message: error.message } });
    } finally { data.bitmap?.close(); if (canvas) canvas.width = canvas.height = 0; }
  });
};
