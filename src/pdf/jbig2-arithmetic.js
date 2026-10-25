// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
export function withJbig2Arithmetic(reader, bytes, run, retained = null) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), state = reader.checked(reader.api.pn_pdf_alloc(reader.api.pn_jbig2_arith_size())), contextCache = new Map();
    if (reader.api.pn_jbig2_arith_start(state, input, bytes.length)) throw new PdfEngineError('Invalid JBIG2 arithmetic segment termination.', 'pdf_corrupt');
    const context = (key, length = 1024) => { if (contextCache.has(key)) return contextCache.get(key); const address = reader.checked(reader.api.pn_pdf_alloc(length)); new Uint8Array(reader.api.memory.buffer, address, length).set(retained?.[key] || new Uint8Array(length)); contextCache.set(key, address); return address; };
    const value = address => { const view = new DataView(reader.api.memory.buffer), status = view.getUint32(address, true); if (status === 4) return null; if (status) throw new PdfEngineError('Invalid JBIG2 arithmetic integer.', status === 2 ? 'pdf_limit' : 'pdf_corrupt'); return view.getInt32(address + 4, true); };
    const output = run({
      integer(key) { reader.check(); return value(reader.api.pn_jbig2_arith_integer(state, context(key))); },
      id(bits) { reader.check(); return value(reader.api.pn_jbig2_arith_id(state, bits, context('ID', Math.max(2, 2 ** bits * 2)))); },
      generic(width, height, template, adaptive) {
        reader.check(); const capacity = Math.ceil(width / 8) * height, coordinates = reader.copy(new Uint8Array(Int32Array.from(adaptive).buffer)), target = reader.checked(reader.api.pn_pdf_alloc(capacity));
        const address = reader.api.pn_jbig2_arith_generic(state, width, height, template, coordinates, target, capacity, context('GB', 131072)), view = new DataView(reader.api.memory.buffer), status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
        if (status) throw new PdfEngineError('Invalid JBIG2 arithmetic symbol bitmap.', status === 2 ? 'pdf_limit' : 'pdf_corrupt'); return new Uint8Array(reader.api.memory.buffer, target, length).slice();
      },
      refine(width, height, template, adaptive, reference, dx, dy, requireComplete = false) {
        reader.check(); const capacity = Math.ceil(width / 8) * height, coordinates = reader.copy(Uint8Array.from(adaptive, value => value & 255)), previous = reader.copy(reference.bytes), target = reader.checked(reader.api.pn_pdf_alloc(capacity));
        const address = reader.api.pn_jbig2_arith_refine(state, width, height, template, 0, coordinates, previous, reference.width, reference.height, dx, dy, target, capacity, context('GR', 16384)), view = new DataView(reader.api.memory.buffer), status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
        if (status) throw new PdfEngineError('Invalid JBIG2 arithmetic refined symbol.', status === 2 ? 'pdf_limit' : 'pdf_corrupt');
        if (requireComplete && view.getUint32(address + 8, true) !== bytes.length) throw new PdfEngineError('JBIG2 refinement consumed byte count differs from its Huffman declaration.', 'pdf_corrupt'); return new Uint8Array(reader.api.memory.buffer, target, length).slice();
      },
      retain() { const result = {}; for (const key of ['GB', 'GR']) { const pointer = contextCache.get(key); if (pointer) result[key] = new Uint8Array(reader.api.memory.buffer, pointer, key === 'GB' ? 131072 : 16384).slice(); } return result; },
    });
    if (output?.then) throw new TypeError('A JBIG2 arithmetic stream must execute synchronously.'); reader.check(); return output;
  } finally { reader.api.pn_pdf_rewind(); }
}
export function decodeJbig2GrayPlanes(reader, bytes, { width, height, template, planes, skip }) {
  reader.check(); const capacity = Math.ceil(width / 8) * height * planes;
  reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), mask = skip ? reader.copy(skip) : 0, output = reader.checked(reader.api.pn_pdf_alloc(capacity)), contexts = reader.checked(reader.api.pn_pdf_alloc(131072));
    const address = reader.api.pn_jbig2_halftone(input, bytes.length, width, height, template, planes, mask, output, capacity, contexts), view = new DataView(reader.api.memory.buffer);
    const status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
    if (status) throw new PdfEngineError(status === 2 ? 'JBIG2 gray-plane resource limit exceeded.' : 'Invalid JBIG2 arithmetic gray-planes.', status === 2 ? 'pdf_limit' : 'pdf_corrupt');
    reader.check(); return new Uint8Array(reader.api.memory.buffer, output, length).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
export function decodeJbig2Generic(reader, bytes, { width, height, template, typical, adaptive }) {
  reader.check(); const capacity = Math.ceil(width / 8) * height;
  reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), coordinates = reader.copy(new Uint8Array(Int32Array.from(adaptive).buffer)), output = reader.checked(reader.api.pn_pdf_alloc(capacity)), contexts = reader.checked(reader.api.pn_pdf_alloc(131072));
    const address = reader.api.pn_jbig2_generic(input, bytes.length, width, height, template, typical ? 1 : 0, coordinates, output, capacity, contexts), view = new DataView(reader.api.memory.buffer);
    const status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
    if (status) throw new PdfEngineError(status === 2 ? 'JBIG2 arithmetic bitmap resource limit exceeded.' : 'Invalid JBIG2 arithmetic bitmap.', status === 2 ? 'pdf_limit' : 'pdf_corrupt');
    return new Uint8Array(reader.api.memory.buffer, output, length).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
export function decodeJbig2Refinement(reader, bytes, { width, height, template, typical, adaptive, reference, referenceWidth, referenceHeight, dx = 0, dy = 0 }) {
  reader.check(); const capacity = Math.ceil(width / 8) * height;
  reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), coordinates = reader.copy(Uint8Array.from(adaptive, value => value & 255)), previous = reader.copy(reference), output = reader.checked(reader.api.pn_pdf_alloc(capacity)), contexts = reader.checked(reader.api.pn_pdf_alloc(16384));
    const address = reader.api.pn_jbig2_refine(input, bytes.length, width, height, template, typical ? 1 : 0, coordinates, previous, referenceWidth, referenceHeight, dx, dy, output, capacity, contexts), view = new DataView(reader.api.memory.buffer);
    const status = view.getUint32(address, true), length = view.getUint32(address + 4, true);
    if (status) throw new PdfEngineError(status === 2 ? 'JBIG2 refinement bitmap resource limit exceeded.' : 'Invalid JBIG2 refinement bitmap.', status === 2 ? 'pdf_limit' : 'pdf_corrupt');
    return new Uint8Array(reader.api.memory.buffer, output, length).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
