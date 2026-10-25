// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createPdfDocumentCore } from './document-core.js';
import { createPdfViewport } from './viewport.js';
import { renderPdfDisplayList } from './canvas-renderer.js';
import { PdfEngineError } from './native-reader.js';
import { pdfPayloadByteLength } from './payload-buffers.js';

/** Original browser document facade; unsupported input fails explicitly. */
export async function openPdfDocument(data, options = {}) {
  const fontPrefix = `pn${crypto.randomUUID().replace(/-/g, '')}`, faces = new Map(), pending = new Map(), pageCache = new Map(), payloadCache = new Map(), renders = new Set();
  const useSystemFonts = typeof options.useSystemFonts === 'boolean' ? options.useSystemFonts : !globalThis.process?.versions?.node;
  let closed = false, worker = null, core = null, sequence = 0, admittedFontBytes = 0;
  const check = () => { if (closed) throw new PdfEngineError('PDF document has been destroyed.', 'pdf_closed'); options.signal?.throwIfAborted(); };
  function rejectPending(error) { for (const { reject } of pending.values()) reject(error); pending.clear(); }
  function destroy() {
    if (closed) return; closed = true; for (const task of renders) task.cancel(); renders.clear(); worker?.terminate(); core?.destroy(); rejectPending(new PdfEngineError('PDF document has been destroyed.', 'pdf_closed'));
    for (const record of faces.values()) for (const face of [record.face, record.localFace]) if (face) globalThis.document?.fonts?.delete(face); faces.clear(); admittedFontBytes = 0; pageCache.clear(); payloadCache.clear();
    options.signal?.removeEventListener('abort', destroy);
  }
  options.signal?.addEventListener('abort', destroy, { once: true });
  const rpc = (method, ...args) => {
    check(); if (core) return Promise.resolve(core[method](...args));
    const id = ++sequence; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); try { worker.postMessage({ id, method, args }); } catch (error) { pending.delete(id); reject(error); } });
  };
  function pagePayload(pageNumber) {
    check();
    if (payloadCache.has(pageNumber)) { const record = payloadCache.get(pageNumber); payloadCache.delete(pageNumber); payloadCache.set(pageNumber, record); return record.promise; }
    const record = { bytes: 0, ready: false, promise: null };
    record.promise = rpc('pagePayload', pageNumber).then(payload => {
      check(); record.bytes = pdfPayloadByteLength(payload); record.ready = true;
      // In-flight requests remain deduplicated; resolved payloads have one bounded owner.
      let bytes = [...payloadCache.values()].reduce((sum, cached) => sum + cached.bytes, 0);
      for (const [number, cached] of payloadCache) {
        if ((payloadCache.size <= 5 && bytes <= 128 * 1024 * 1024) || cached === record || !cached.ready) continue;
        payloadCache.delete(number); bytes -= cached.bytes; if (core) core.cleanup(number);
      }
      return payload;
    }).catch(error => { if (payloadCache.get(pageNumber) === record) payloadCache.delete(pageNumber); throw error; });
    payloadCache.set(pageNumber, record); return record.promise;
  }
  async function loadFonts(fonts) {
    check();
    if (typeof FontFace !== 'function' || !globalThis.document?.fonts) throw new PdfEngineError('PDF font rendering needs browser FontFace support.', 'pdf_render');
    for (const font of fonts) {
      if (font.requiresLocalFace && !useSystemFonts) throw new PdfEngineError('Required local PDF CID font is unavailable.');
      if (!faces.has(font.family)) {
        if (faces.size >= 1024 || admittedFontBytes + font.bytes.byteLength > 128 * 1024 * 1024) throw new PdfEngineError('PDF document font resource limit exceeded.', 'pdf_limit');
        const record = { face: null, localFace: null, promise: null, bytes: font.bytes.byteLength };
        faces.set(font.family, record); admittedFontBytes += record.bytes;
        record.promise = (async () => {
          const face = await new FontFace(font.family, font.bytes).load(); check(); record.face = face; document.fonts.add(face);
          if (useSystemFonts && font.localFaces) {
            let localFace;
            try { localFace = await new FontFace(`${font.family}Local`, font.localFaces.map(name => `local("${name}")`).join(',')).load(); } catch { /* Optional local faces may use their validated licensed data. */ }
            check(); if (localFace) { record.localFace = localFace; document.fonts.add(localFace); }
          }
          if (font.requiresLocalFace && !record.localFace) throw new PdfEngineError('Required local PDF CID font is unavailable.');
        })().catch(error => {
          if (faces.get(font.family) === record) {
            faces.delete(font.family); admittedFontBytes -= record.bytes;
            for (const face of [record.face, record.localFace]) if (face) document.fonts.delete(face);
          }
          throw error;
        });
        // Admission can fail before the final Promise.all observes earlier loads.
        void record.promise.catch(() => null);
      }
    }
    await Promise.all(fonts.map(font => faces.get(font.family).promise)); check();
  }
  try {
    check(); let info;
    const useWorker = options.useWorker ?? (typeof Worker === 'function' && !options.loadAsset);
    if (useWorker) {
      worker = new Worker(new URL('./pdf.worker.js', import.meta.url), { type: 'module', name: 'PageNarrator original PDF parser' });
      worker.onmessage = ({ data: message }) => {
        const record = pending.get(message.id); if (!record) return; pending.delete(message.id);
        if (message.error) { const error = new PdfEngineError(message.error.message, message.error.code); error.name = message.error.name; record.reject(error); } else record.resolve(message.result);
      };
      const failed = () => { const error = new PdfEngineError('PDF worker was terminated.', 'pdf_worker'); rejectPending(error); destroy(); };
      worker.onerror = failed; worker.onmessageerror = failed;
      info = await rpc('open', data, { wasm: options.wasm, assetBaseUrl: options.assetBaseUrl, password: options.password, fontPrefix });
    } else {
      core = await createPdfDocumentCore(data, { ...options, fontPrefix });
      if (closed) { core.destroy(); check(); }
      info = { numPages: core.numPages, metadata: await core.getMetadata() };
    }
    check();
    return { numPages: info.numPages, async getMetadata() { check(); return info.metadata; },
      async getPage(pageNumber) {
        check(); if (pageCache.has(pageNumber)) return pageCache.get(pageNumber);
        const geometry = await rpc('pageInfo', pageNumber); check();
        const page = { pageNumber, view: geometry.view, rotate: geometry.rotate, userUnit: geometry.userUnit,
          getViewport(settings = {}) { check(); return createPdfViewport(geometry.view, { rotation: geometry.rotate, ...settings, userUnit: geometry.userUnit }); },
          async getTextContent() { const payload = await pagePayload(pageNumber); return { items: payload.items, unknownType3Glyphs: payload.inspection.unknownType3Glyphs || 0,
            styles: Object.fromEntries(payload.fonts.map(font => [font.family, { fontFamily: font.family, ascent: font.ascent, descent: font.descent, vertical: !!font.vertical }])) }; },
          async inspect() { return (await pagePayload(pageNumber)).inspection; },
          async ensureFonts() { await loadFonts((await pagePayload(pageNumber)).fonts); },
          getFontFamily(name) { check(); return faces.get(name)?.localFace?.family || name; },
          render(settings) {
            let inner = null, cancelled = false;
            const task = { cancel() { cancelled = true; inner?.cancel(); } }; renders.add(task);
            task.promise = (async () => {
              try {
              const payload = await pagePayload(pageNumber);
              inner = renderPdfDisplayList(payload, { ...settings, loadFonts, resolveFont: name => faces.get(name)?.localFace?.family,
                shouldCancel: () => closed || cancelled || settings?.shouldCancel?.() }); if (cancelled) inner.cancel(); await inner.promise;
              } finally { renders.delete(task); }
            })(); return task;
          },
          cleanup() { payloadCache.delete(pageNumber); if (!closed) void rpc('cleanup', pageNumber).catch(error => { if (error.code !== 'pdf_closed') destroy(); }); },
        };
        pageCache.set(pageNumber, page); while (pageCache.size > 16) pageCache.delete(pageCache.keys().next().value); return page;
      }, destroy };
  } catch (error) { destroy(); throw error; }
}

export async function renderPdfTextLayer({ page = null, textContentSource = null, container, viewport, shouldCancel = null }) {
  const check = () => { if (shouldCancel?.()) { const error = new Error('PDF text rendering cancelled.'); error.name = 'RenderingCancelledException'; throw error; } };
  check(); await page?.ensureFonts?.(); check();
  const { items, styles = {} } = textContentSource || await page.getTextContent(); check(); container.replaceChildren();
  container.setAttribute('data-main-rotation', String(viewport.rotation || 0));
  // Span matrices already include the full viewport; the legacy layer CSS must
  // not apply its container rotation a second time.
  container.style.transform = 'none';
  const canvas = container.ownerDocument.createElement('canvas'), context = canvas.getContext('2d');
  try {
  for (const [itemIndex, item] of items.entries()) {
    if (itemIndex && itemIndex % 128 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
    if (!item.str) continue;
    const fontFamily = page?.getFontFamily?.(item.fontName) || item.fontName;
    if (item.vertical) {
      if (!item.glyphs?.length || item.glyphs.map(glyph => glyph.text).join('') !== item.str) throw new PdfEngineError('Vertical text selection requires exact glyph/source associations.');
      for (const glyph of item.glyphs) {
        if (!glyph.text) continue;
        const [a, b, c, d, e, f] = item.transform, [x, y] = viewport.convertToViewportPoint(e + a * glyph.x + c * glyph.y, f + b * glyph.x + d * glyph.y);
        const p = viewport.transform, u = p[0] * a + p[2] * b, v = p[1] * a + p[3] * b;
        const w = p[0] * c + p[2] * d, z = p[1] * c + p[3] * d, height = Math.hypot(w, z), across = Math.hypot(u, v);
        if (!height || !across) continue;
        const span = container.ownerDocument.createElement('span'); span.textContent = glyph.text; span.dir = 'ltr'; span.setAttribute('data-pagenarrator-pdf-source-index', String(itemIndex));
        context.font = `${height}px "${fontFamily}"`;
        const naturalWidth = context.measureText(glyph.text).width, scaleX = naturalWidth ? glyph.width * height / naturalWidth : 1;
        const ascent = styles[item.fontName]?.ascent ?? 1;
        Object.assign(span.style, { position: 'absolute', whiteSpace: 'pre', lineHeight: '1', left: `${x + w * ascent}px`, top: `${y + z * ascent}px`,
          fontFamily: `"${fontFamily}"`, fontSize: `${height}px`, transformOrigin: '0 0',
          transform: `matrix(${u / height * scaleX},${v / height * scaleX},${-w / height},${-z / height},0,0)` });
        container.append(span);
      }
      continue;
    }
    const [a, b, c, d, e, f] = item.transform, [x, y] = viewport.convertToViewportPoint(e, f);
    const span = container.ownerDocument.createElement('span'); span.textContent = item.str; span.dir = item.dir; span.setAttribute('data-pagenarrator-pdf-source-index', String(itemIndex));
    const p = viewport.transform, u = p[0] * a + p[2] * b, v = p[1] * a + p[3] * b;
    const w = p[0] * c + p[2] * d, z = p[1] * c + p[3] * d, height = Math.hypot(w, z);
    if (!height || !Math.hypot(u, v)) continue;
    context.font = `${height}px "${fontFamily}"`;
    const measured = context.measureText(item.str), naturalWidth = measured.width;
    const ascent = Number.isFinite(measured.fontBoundingBoxAscent) ? (height + measured.fontBoundingBoxAscent - measured.fontBoundingBoxDescent) / (2 * height) : styles[item.fontName]?.ascent ?? 1;
    const projectedWidth = naturalWidth * Math.hypot(u, v) / height;
    const scaleX = projectedWidth ? item.width * viewport.scale * (viewport.userUnit ?? 1) / projectedWidth : 1;
    Object.assign(span.style, { position: 'absolute', whiteSpace: 'pre', lineHeight: '1', left: `${x + w * ascent}px`, top: `${y + z * ascent}px`,
      fontFamily: `"${fontFamily}"`, fontSize: `${height}px`, transformOrigin: '0 0',
      transform: `matrix(${u / height * scaleX},${v / height * scaleX},${-w / height},${-z / height},0,0)` });
    container.append(span);
  }
  check(); return { items };
  } finally { canvas.width = canvas.height = 0; }
}
