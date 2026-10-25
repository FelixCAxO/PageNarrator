// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { NativePdfReader, PdfEngineError } from './native-reader.js';
import { buildPdfDisplayList } from './display-list.js';
import { decodePdfString } from './pdf-string.js';
import { PDF_DATA_ASSET_PATH, pdfExtensionAssetUrl } from './assets.js';

export async function createPdfDocumentCore(bytes, options = {}) {
  const reader = await NativePdfReader.create(bytes, options);
  try {
    const catalog = reader.field(reader.trailer, 'Root');
    if (!catalog || reader.name(reader.field(catalog, 'Type')) !== 'Catalog') throw new PdfEngineError('Missing PDF catalog.', 'pdf_corrupt');
    const pages = reader.field(catalog, 'Pages'), numPages = pages && reader.number(reader.field(pages, 'Count'));
    if (!Number.isInteger(numPages) || numPages < 1 || numPages > 100000) throw new PdfEngineError('Invalid or excessive PDF page count.', 'pdf_limit');
    const info = reader.field(reader.trailer, 'Info'), titleId = info && reader.field(info, 'Title');
    const titleBytes = titleId ? reader.bytes(titleId) : null;
    const title = titleBytes ? decodePdfString(titleBytes) : '';
    const loadAsset = options.loadAsset || (async relative => {
      const base = options.assetBaseUrl || pdfExtensionAssetUrl(PDF_DATA_ASSET_PATH);
      if (!base) throw new PdfEngineError('PDF font data needs loadAsset or assetBaseUrl outside the extension.', 'pdf_configuration');
      const response = await fetch(new URL(relative, base), { signal: options.signal });
      if (!response.ok) throw new PdfEngineError(`Could not load PDF font data (${response.status}).`, 'pdf_network');
      const data = new Uint8Array(await response.arrayBuffer()); if (data.length > 2 * 1024 * 1024) throw new PdfEngineError('PDF font data limit exceeded.', 'pdf_limit'); return data;
    });
    const cached = new Map(); let closed = false;
    const check = () => { reader.check(); if (closed) throw new PdfEngineError('PDF document has been destroyed.', 'pdf_closed'); };
    function findPage(target) {
      const visited = new Set(); let remaining = target;
      function descend(id, inherited, depth) {
        if (depth > 64) throw new PdfEngineError('PDF page-tree depth limit exceeded.', 'pdf_limit');
        const resolved = reader.node(id).id; if (visited.has(resolved)) throw new PdfEngineError('Cyclic PDF page tree.', 'pdf_corrupt'); visited.add(resolved);
        const attrs = { ...inherited };
        for (const name of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) { const value = reader.field(id, name); if (value) attrs[name] = value; }
        const type = reader.name(reader.field(id, 'Type'));
        if (type === 'Page') { if (--remaining === 0) return { id, attrs }; return null; }
        if (type !== 'Pages') throw new PdfEngineError('Invalid PDF page-tree node.', 'pdf_corrupt');
        const kids = reader.field(id, 'Kids'); if (!kids) throw new PdfEngineError('Missing PDF page children.', 'pdf_corrupt');
        for (const child of reader.array(kids)) {
          const childType = reader.name(reader.field(child, 'Type')), count = childType === 'Pages' ? reader.number(reader.field(child, 'Count')) : 1;
          if (!Number.isInteger(count) || count < 1 || count > numPages) throw new PdfEngineError('Invalid PDF subtree count.', 'pdf_corrupt');
          if (remaining > count) remaining -= count; else { const found = descend(child, attrs, depth + 1); if (found) return found; }
        }
        return null;
      }
      const found = descend(pages, {}, 0); if (!found) throw new PdfEngineError('PDF page count does not match its tree.', 'pdf_corrupt'); return found;
    }
    function pageInfo(pageNumber) {
      check(); if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > numPages) throw new RangeError('PDF page number is out of range.');
      const { id, attrs } = findPage(pageNumber);
      if (!attrs.MediaBox) throw new PdfEngineError('Missing PDF page box.', 'pdf_corrupt');
      const box = name => reader.array(attrs[name]).map(value => reader.number(value, NaN));
      let view = box('MediaBox'); if (view.length !== 4 || view.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid PDF MediaBox.', 'pdf_corrupt');
      if (attrs.CropBox) { const crop = box('CropBox'); if (crop.length !== 4 || crop.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid PDF CropBox.', 'pdf_corrupt'); view = [Math.max(view[0], crop[0]), Math.max(view[1], crop[1]), Math.min(view[2], crop[2]), Math.min(view[3], crop[3])]; }
      const rotate = (reader.number(attrs.Rotate, 0) % 360 + 360) % 360;
      if (view[2] <= view[0] || view[3] <= view[1] || ![0, 90, 180, 270].includes(rotate)) throw new PdfEngineError('Invalid PDF page geometry.', 'pdf_corrupt');
      const unit = reader.field(id, 'UserUnit'), userUnit = unit ? reader.number(unit, NaN) : 1;
      if (!Number.isFinite(userUnit) || userUnit <= 0) throw new PdfEngineError('Invalid PDF UserUnit.', 'pdf_corrupt');
      return { pageNumber, view, rotate, userUnit, id, resources: attrs.Resources };
    }
    async function pagePayload(pageNumber) {
      check(); if (cached.has(pageNumber)) { const hit = cached.get(pageNumber); cached.delete(pageNumber); cached.set(pageNumber, hit); return hit; }
      const info = pageInfo(pageNumber), promise = buildPdfDisplayList(reader, info.id, info.resources, loadAsset, info.view, options.fontPrefix);
      cached.set(pageNumber, promise); while (cached.size > 5) cached.delete(cached.keys().next().value);
      try { const value = await promise; check(); return value; } catch (error) { if (cached.get(pageNumber) === promise) cached.delete(pageNumber); throw error; }
    }
    return { numPages, getMetadata: async () => ({ info: { Title: title } }), pageInfo, pagePayload,
      cleanup(pageNumber) { cached.delete(pageNumber); }, destroy() { closed = true; cached.clear(); reader.destroy(); } };
  } catch (error) { reader.destroy(); throw error; }
}
