// Test-only Node transport for the actual browser PDF worker implementation.
import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };
await import('../../src/pdf/pdf.worker.js');
parentPort.on('message', data => { void self.onmessage({ data }); });
