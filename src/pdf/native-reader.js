// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const KINDS = ['null', 'boolean', 'number', 'name', 'string', 'array', 'dictionary', 'reference', 'stream', 'operator'];
const ERRORS = ['success', 'Invalid PDF syntax', 'PDF resource limit exceeded', 'This PDF cross-reference representation is not implemented yet',
  'This PDF crypt filter is not implemented yet', 'Missing PDF object', 'Cyclic PDF object reference', 'Invalid encrypted PDF object'];

export class PdfEngineError extends Error {
  constructor(message, code = 'pdf_unsupported') { super(message); this.name = 'PdfEngineError'; this.code = code; }
}

export class NativePdfReader {
  static async create(data, { wasm, signal, password = '' } = {}) {
    if (!(data instanceof Uint8Array) || data.length > 128 * 1024 * 1024) throw new PdfEngineError('PDF input must contain at most 128 MiB of bytes.', 'pdf_limit');
    signal?.throwIfAborted();
    if (!wasm) throw new PdfEngineError('PDF parser bytes or a compiled module must be supplied.', 'pdf_configuration');
    const compiled = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
    if (WebAssembly.Module.imports(compiled).length) throw new PdfEngineError('PDF parser must not import a runtime.');
    const instance = await WebAssembly.instantiate(compiled);
    const reader = new NativePdfReader(instance.exports, signal);
    try {
      const pointer = reader.copy(data);
      reader.trailer = reader.checked(reader.api.pn_pdf_init(pointer, data.length));
      const { decodePdfStream } = await import('./streams.js');
      for (let pending = reader.api.pn_pdf_pending_xref(); pending; pending = reader.api.pn_pdf_pending_xref()) {
        const decoded = (await decodePdfStream(reader, pending)).bytes;
        reader.trailer = reader.checked(reader.api.pn_pdf_supply_xref(reader.copy(decoded), decoded.length));
      }
      const { initializePdfEncryption } = await import('./encryption.js');
      await initializePdfEncryption(reader, password);
      for (let container = reader.api.pn_pdf_object_stream(0); container; container = reader.api.pn_pdf_object_stream(container)) {
        const stream = reader.checked(reader.api.pn_pdf_resolve(container, 0)), decoded = (await decodePdfStream(reader, stream)).bytes;
        reader.checked(reader.api.pn_pdf_supply_objects(container, reader.copy(decoded), decoded.length));
      }
      return reader;
    } catch (error) { reader.destroy(); throw error; }
  }

  constructor(api, signal) {
    if (api.pn_pdf_abi_version() !== 1) throw new PdfEngineError('Unsupported PDF parser ABI.');
    this.api = api; this.signal = signal; this.closed = false; this.trailer = 0; this.temporary = new Map(); this.nextTemporary = -1;
  }

  check() { if (this.closed) throw new PdfEngineError('PDF document has been destroyed.', 'pdf_closed'); this.signal?.throwIfAborted(); }
  checked(value) {
    this.check(); const code = this.api.pn_pdf_error();
    if (code || !value) throw new PdfEngineError(code ? ERRORS[code] || 'Invalid PDF parser result.' : 'Invalid PDF parser result.', code === 2 ? 'pdf_limit' : code === 1 || code === 7 ? 'pdf_corrupt' : 'pdf_unsupported');
    return value;
  }
  copy(data) {
    this.check(); const pointer = this.checked(this.api.pn_pdf_alloc(data.length));
    new Uint8Array(this.api.memory.buffer, pointer, data.length).set(data); return pointer;
  }
  node(id, { resolve = true } = {}) {
    if (id < 0) { this.check(); const value = this.temporary.get(id); if (!value) throw new PdfEngineError('Expired PDF content token.', 'pdf_closed'); return value; }
    let seen = null, remaining = 64;
    for (;;) {
      this.check(); const pointer = this.checked(this.api.pn_pdf_node(id));
      const v = new DataView(this.api.memory.buffer, pointer, 32);
      const result = { id, kind: KINDS[v.getUint32(0, true)], offset: v.getUint32(4, true), length: v.getUint32(8, true),
        first: v.getUint32(12, true), next: v.getUint32(16, true), aux: v.getUint32(20, true), number: v.getFloat64(24, true) };
      if (!resolve || result.kind !== 'reference') return result;
      seen ??= new Set();
      if (seen.has(id)) throw new PdfEngineError('Cyclic PDF object reference.', 'pdf_corrupt');
      if (!remaining--) throw new PdfEngineError('PDF object reference depth limit exceeded.', 'pdf_limit');
      seen.add(id); id = this.checked(this.api.pn_pdf_resolve(result.aux, result.length));
    }
  }
  bytes(value) { const n = typeof value === 'number' ? this.node(value) : value; return n.bytes ?? new Uint8Array(this.api.memory.buffer, n.offset, n.length).slice(); }
  text(value) { return Array.from(this.bytes(value), byte => String.fromCharCode(byte)).join(''); }
  name(value) { if (!value) return null; const n = this.node(value); return n.kind === 'name' || n.kind === 'operator' ? this.text(n) : null; }
  number(value, fallback = null) { if (!value) return fallback; const n = this.node(value); return n.kind === 'number' ? n.number : fallback; }
  array(value) {
    const n = this.node(value); if (n.kind !== 'array') throw new PdfEngineError('Expected PDF array.', 'pdf_corrupt');
    const result = []; for (let id = n.first; id; id = this.node(id, { resolve: false }).next) result.push(id); return result;
  }
  dictionary(value) {
    let n = this.node(value); if (n.kind === 'stream') n = this.node(n.first);
    if (n.kind !== 'dictionary') throw new PdfEngineError('Expected PDF dictionary.', 'pdf_corrupt');
    const result = new Map();
    for (let id = n.first; id;) {
      const key = this.node(id, { resolve: false }), val = key.next;
      if (key.kind !== 'name' || !val) throw new PdfEngineError('Invalid PDF dictionary.', 'pdf_corrupt');
      result.set(this.text(key), val); id = this.node(val, { resolve: false }).next;
    }
    return result;
  }
  field(value, key) { return value ? this.dictionary(value).get(key) || 0 : 0; }
  content(bytes) {
    this.api.pn_pdf_mark(); const ids = new Set(), mapped = new Map(), pending = []; let inputPointer;
    const clone = id => {
      if (!id) return 0; if (mapped.has(id)) return mapped.get(id);
      const n = this.node(id, { resolve: false }), copied = { ...n, id: this.nextTemporary-- };
      if (['name', 'operator', 'string'].includes(n.kind)) copied.bytes = this.bytes(n);
      if (n.kind === 'stream' && n.aux & 1) {
        const start = n.offset - inputPointer;
        if (start < 0 || start + n.length > bytes.length) throw new PdfEngineError('Invalid inline image data range.', 'pdf_corrupt');
        copied.inlineDataOffset = start;
        copied.inlineSeparated = !!(n.aux & 2);
        copied.bytes = bytes.subarray(start, start + n.length);
      }
      this.temporary.set(copied.id, copied); ids.add(copied.id); mapped.set(id, copied.id); pending.push(copied); return copied.id;
    };
    try {
      inputPointer = this.copy(bytes);
      const parsed = this.checked(this.api.pn_pdf_parse_content(inputPointer, bytes.length));
      const root = clone(parsed);
      for (let i = 0; i < pending.length; i++) { const copied = pending[i]; copied.first = clone(copied.first); copied.next = clone(copied.next); }
      const result = this.array(root); Object.defineProperty(result, 'contentIds', { value: ids }); return result;
    } catch (error) { for (const id of ids) this.temporary.delete(id); throw error; }
    finally { this.api.pn_pdf_rewind(); }
  }
  releaseContent(tokens) { for (const id of tokens.contentIds ?? []) this.temporary.delete(id); }
  destroy() { this.api?.pn_pdf_clear_crypt(); this.closed = true; this.api = null; this.temporary.clear(); }
}
