import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { renderPdfDisplayList } from '../../src/pdf/canvas-renderer.js';
import { createPdfViewport } from '../../src/pdf/viewport.js';
import { decodeAsciiHex, decodeAscii85, decodeRunLength, applyPredictor } from '../../src/pdf/streams.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { pdf, stream, simplePdf, show, bytes, wasm, loadAsset, options } from './fixtures.js';
const text = 'Independent browser PDF rendering preserves source text and its geometry.';
function compressedPdf({ hybrid = false } = {}) {
  const values = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const ids = [1, 2, 3, 5], offsets = []; let body = '';
  for (const value of values) { offsets.push(body.length); body += `${value} `; }
  const header = ids.map((id, i) => `${id} ${offsets[i]}`).join(' ') + ' ';
  let output = '%PDF-1.7\n'; const actual = new Map();
  const append = (id, value) => { actual.set(id, Buffer.byteLength(output, 'latin1')); output += `${id} 0 obj\n${value}\nendobj\n`; };
  append(4, stream(deflateSync(Buffer.from(show(text))), '/Filter /FlateDecode'));
  append(6, stream(deflateSync(Buffer.from(header + body)), `/Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode`));
  const xrefOffset = Buffer.byteLength(output, 'latin1'), xref = Buffer.alloc(8 * 7);
  for (let id = 0; id < 8; id++) {
    const offset = id * 7, index = ids.indexOf(id), type = id === 0 ? 0 : index >= 0 ? 2 : 1;
    xref[offset] = type; xref.writeUInt32BE(index >= 0 ? 6 : id === 7 ? xrefOffset : actual.get(id) || 0, offset + 1);
    xref.writeUInt16BE(id === 0 ? 65535 : index >= 0 ? index : 0, offset + 5);
  }
  append(7, stream(deflateSync(xref), '/Type /XRef /W [1 4 2] /Size 8 /Root 1 0 R /Filter /FlateDecode'));
  if (hybrid) {
    const classic = Buffer.byteLength(output, 'latin1'); output += 'xref\n0 8\n0000000000 65535 f \n';
    for (let id = 1; id < 8; id++) output += `${String(actual.get(id) || 0).padStart(10, '0')} 00000 ${actual.has(id) ? 'n' : 'f'} \n`;
    return bytes(`${output}trailer\n<< /Size 8 /Root 1 0 R /XRefStm ${xrefOffset} >>\nstartxref\n${classic}\n%%EOF\n`);
  }
  return bytes(`${output}startxref\n${xrefOffset}\n%%EOF\n`);
}
function manyXrefObjects(entries) {
  let output = '%PDF-1.7\n'; const offsets = new Map(), pageNumber = entries - 1;
  const append = (number, value) => { offsets.set(number, Buffer.byteLength(output, 'latin1')); output += `${number} 0 obj\n${value}\nendobj\n`; };
  append(1, '<< /Type /Catalog /Pages 2 0 R >>'); append(2, `<< /Type /Pages /Count 1 /Kids [${pageNumber} 0 R] >>`); append(pageNumber, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
  const xrefOffset = Buffer.byteLength(output, 'latin1'), xref = Buffer.alloc(entries * 7); offsets.set(3, xrefOffset);
  for (let number = 0; number < entries; number++) { const at = number * 7, offset = offsets.get(number); xref[at] = offset ? 1 : 0; xref.writeUInt32BE(offset || (number + 1 < entries && !offsets.has(number + 1) ? number + 1 : 0), at + 1); xref.writeUInt16BE(number ? 0 : 65535, at + 5); }
  append(3, stream(deflateSync(xref), `/Type /XRef /W [1 4 2] /Size ${entries} /Root 1 0 R /Filter /FlateDecode`)); return bytes(`${output}startxref\n${xrefOffset}\n%%EOF\n`);
}

function indirectLengthChain(count, ending = 'number') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'];
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? i + 5 : ending === 'cycle' ? 4 : ending === 'missing' ? count + 5 : count + 4;
    objects.push(`<< /Length ${next} 0 R >>\nstream\n\nendstream`);
  }
  if (ending === 'number') objects.push('0');
  return pdf(objects);
}
describe('original bounded C++/WASM PDF reader', () => {
  it('native resolution depth rejects a deep acyclic stream-Length chain with a controlled limit', async () => {
    const reader = await NativePdfReader.create(indirectLengthChain(4096), options);
    try {
      let failure;
      try { reader.checked(reader.api.pn_pdf_resolve(4, 0)); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: 'PdfEngineError', code: 'pdf_limit' });
      expect(reader.api.pn_pdf_error()).toBe(2);
    } finally { reader.destroy(); }
  });
  it('native resolution depth preserves syntax errors for short wrong-type Length chains', async () => {
    const reader = await NativePdfReader.create(indirectLengthChain(2), options);
    try { expect(reader.api.pn_pdf_resolve(4, 0)).toBe(0); expect(reader.api.pn_pdf_error()).toBe(1); }
    finally { reader.destroy(); }
  });
  it('native resolution depth checks cached values before charging another active frame', async () => {
    const reader = await NativePdfReader.create(indirectLengthChain(64), options);
    try {
      expect(reader.node(reader.checked(reader.api.pn_pdf_resolve(68, 0))).number).toBe(0);
      expect(reader.api.pn_pdf_resolve(4, 0)).toBe(0); expect(reader.api.pn_pdf_error()).toBe(1);
    } finally { reader.destroy(); }
  });
  it('native resolution depth preserves missing and cycle precedence at the active limit', async () => {
    for (const [ending, code] of [['missing', 5], ['cycle', 6]]) {
      const reader = await NativePdfReader.create(indirectLengthChain(64, ending), options);
      try { expect(reader.api.pn_pdf_resolve(4, 0)).toBe(0); expect(reader.api.pn_pdf_error()).toBe(code); }
      finally { reader.destroy(); }
    }
  });
  it('native resolution depth is balanced across sequential valid indirect lengths and cache hits', async () => {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
    for (let i = 0; i < 96; i++) objects.push(`<< /Length ${objects.length + 2} 0 R >>\nstream\n\nendstream`, '0');
    const reader = await NativePdfReader.create(pdf(objects), options);
    try {
      for (let i = 0; i < 96; i++) {
        const id = 4 + i * 2, value = reader.checked(reader.api.pn_pdf_resolve(id, 0));
        expect(reader.node(value)).toMatchObject({ kind: 'stream', length: 0 });
        expect(reader.api.pn_pdf_resolve(id, 0)).toBe(value);
      }
      expect(reader.api.pn_pdf_error()).toBe(0);
    } finally { reader.destroy(); }
  });
  it('native resolution depth has no stale state when reopening after a rejected document', async () => {
    const rejected = await NativePdfReader.create(indirectLengthChain(65), options);
    try { expect(rejected.api.pn_pdf_resolve(4, 0)).toBe(0); expect(rejected.api.pn_pdf_error()).toBe(2); }
    finally { rejected.destroy(); }
    const reader = await NativePdfReader.create(indirectLengthChain(1), options);
    try {
      expect(reader.node(reader.checked(reader.api.pn_pdf_resolve(4, 0)))).toMatchObject({ kind: 'stream', length: 0 });
      expect(reader.api.pn_pdf_error()).toBe(0);
    } finally { reader.destroy(); }
  });
  it('pins compiled bytes to the original source and imports no runtime', async () => {
    const metadata = JSON.parse(await readFile(new URL('../../native/pdf.json', import.meta.url), 'utf8'));
    const hash = value => createHash('sha256').update(value).digest('hex');
    expect(hash(wasm)).toBe(metadata.wasmSha256);
    expect(hash(await readFile(new URL('../../native/pdf.cpp', import.meta.url)))).toBe(metadata.sourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-type1.cpp', import.meta.url)))).toBe(metadata.fontSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-codecs.cpp', import.meta.url)))).toBe(metadata.codecSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-fax.cpp', import.meta.url)))).toBe(metadata.faxSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-jbig2.cpp', import.meta.url)))).toBe(metadata.jbigSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-mq.h', import.meta.url)))).toBe(metadata.mqSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-crypto.cpp', import.meta.url)))).toBe(metadata.cryptoSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-crypto.h', import.meta.url)))).toBe(metadata.cryptoHeaderSha256);
    expect(hash(await readFile(new URL('../../native/pdf-jpx.cpp', import.meta.url)))).toBe(metadata.jpxSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-inline.cpp', import.meta.url)))).toBe(metadata.inlineSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-cff-path.cpp', import.meta.url)))).toBe(metadata.cffPathSourceSha256);
    expect(hash(await readFile(new URL('../../native/pdf-ttf-path.cpp', import.meta.url)))).toBe(metadata.ttfPathSourceSha256);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(wasm))).toEqual([]);
  });
  it('opens real generated bytes, exposes pages and returns independent text geometry', async () => {
    const document = await openPdfDocument(buildPdfBytes([{ text }]), options);
    try {
      expect(document.numPages).toBe(1); const page = await document.getPage(1), result = await page.getTextContent();
      expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ str: text, transform: [12, 0, 0, 12, 54, 700], height: 12 });
      expect(result.items[0].width).toBeGreaterThan(200); expect(page.getViewport({ scale: 2 })).toMatchObject({ width: 1224, height: 1584 });
      expect(await page.inspect()).toMatchObject({ hasRasterImage: false, hasRenderableNonText: false });
      await expect(document.getPage(2)).rejects.toThrow(/out of range/);
    } finally { document.destroy(); }
    await expect(document.getPage(1)).rejects.toMatchObject({ code: 'pdf_closed' });
  });
  it('opens valid blank pages without a resource dictionary', async () => {
    const data = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']);
    const document = await openPdfDocument(data, options);
    try { expect((await (await document.getPage(1)).getTextContent()).items).toEqual([]); } finally { document.destroy(); }
  });
  it('matches reference text transforms and widths across independent deterministic generated PDFs', async () => {
    for (let i = 0; i < 32; i++) {
      const data = buildPdfBytes([{ text: `Example ${i}: punctuation, caf\u00e9, (brackets) and 2026.`, x: 20 + i, y: 500 - i, fontSize: 8 + i % 12 }]);
      const own = await openPdfDocument(data, options), task = reference.getDocument({ data: data.slice(), useSystemFonts: true });
      try {
        const expected = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(item => item.str);
        const actual = (await (await own.getPage(1)).getTextContent()).items;
        expect(actual.map(item => item.str)).toEqual(expected.map(item => item.str));
        for (let j = 0; j < actual.length; j++) { expect(actual[j].transform).toEqual(expected[j].transform); expect(Math.abs(actual[j].width - expected[j].width)).toBeLessThan(.1); }
      } finally { own.destroy(); await task.destroy(); }
    }
  });
  it('decodes Flate contents through the browser platform API', async () => {
    const document = await openPdfDocument(simplePdf('', { contents: stream(deflateSync(Buffer.from(show(text))), '/Filter /FlateDecode') }), options);
    try { expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe(text); } finally { document.destroy(); }
  });
  it('reads stream xrefs and Flate-compressed object streams with no legacy parser', async () => {
    const document = await openPdfDocument(compressedPdf(), options);
    try { expect(document.numPages).toBe(1); expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe(text); } finally { document.destroy(); }
  });
  it('opens more than100,000 xref objects and resolves the last page with an independent reader', async () => {
    const data = manyXrefObjects(110000), own = await openPdfDocument(data, options), task = reference.getDocument({ data: data.slice() });
    try { expect(own.numPages).toBe((await task.promise).numPages); expect((await (await own.getPage(1)).getTextContent()).items).toEqual([]); expect((await (await task.promise).getPage(1)).view).toEqual([0, 0, 612, 792]); } finally { own.destroy(); await task.destroy(); }
    await expect(NativePdfReader.create(manyXrefObjects(500001), options)).rejects.toMatchObject({ code: 'pdf_limit' });
  });
  it('resolves the maximum deliberate bucket collision chain with bounded records', async () => {
    const original = Buffer.from(simplePdf('')).toString('latin1'), previous = Number(original.match(/startxref\n(\d+)/)[1]), offsets = []; let output = original;
    for (let i = 1; i < 39; i++) { const number = 1 + i * 262144; offsets.push([number, output.length, i]); output += `${number} 0 obj\n${i}\nendobj\n`; }
    const at = output.length; output += 'xref\n' + offsets.map(([number, offset]) => `${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 9961474 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${at}\n%%EOF\n`;
    const reader = await NativePdfReader.create(bytes(output), options);
    try { for (const [number, , value] of offsets) expect(reader.node(reader.checked(reader.api.pn_pdf_resolve(number, 0))).number).toBe(value); } finally { reader.destroy(); }
  });
  it('lets hybrid stream entries replace same-revision classic placeholders', async () => {
    const document = await openPdfDocument(compressedPdf({ hybrid: true }), options);
    try { expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe(text); } finally { document.destroy(); }
  });
  it('interprets a newer unknown xref type as null without reviving an older object', async () => {
    const original = Buffer.from(simplePdf(show(text))).toString('latin1'), previous = Number(original.match(/startxref\n(\d+)/)[1]), at = original.length;
    const encoded = Uint8Array.of(9, 0, 0, 0, 1, 0, 0), object = `6 0 obj\n${stream(encoded, `/Type /XRef /W [1 4 2] /Index [5 1] /Size 7 /Root 1 0 R /Prev ${previous}`)}\nendobj\n`;
    const reader = await NativePdfReader.create(bytes(`${original}${object}startxref\n${at}\n%%EOF\n`), options);
    try { expect(reader.node(reader.checked(reader.api.pn_pdf_resolve(5, 0))).kind).toBe('null'); expect(reader.node(reader.checked(reader.api.pn_pdf_resolve(5, 17))).kind).toBe('null'); } finally { reader.destroy(); }
  });
  it('uses the latest incremental object revision and follows Prev xref links', async () => {
    const original = Buffer.from(simplePdf(show(text))).toString('latin1'), previous = Number(original.match(/startxref\n(\d+)/)[1]);
    const replacement = '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Rotate 90 >>\nendobj\n';
    const xref = original.length + replacement.length;
    const updated = bytes(`${original}${replacement}xref\n3 1\n${String(original.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`);
    const document = await openPdfDocument(updated, options);
    try { expect((await document.getPage(1)).rotate).toBe(90); expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe(text); } finally { document.destroy(); }
  });
  it('decodes PDF name escapes, literal escapes, nested parentheses and odd hex strings', async () => {
    const reader = await NativePdfReader.create(simplePdf(show(text)), options);
    try {
      const tokens = reader.content(bytes('/A#20B (a\\n\\050b\\051\\\r\nc) <4142F>'));
      expect(reader.name(tokens[0])).toBe('A B'); expect([...reader.bytes(tokens[1])]).toEqual([...bytes('a\n(b)c')]);
      expect([...reader.bytes(tokens[2])]).toEqual([65, 66, 240]); reader.releaseContent(tokens); expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });
  it('rewinds temporary native content allocations and releases large sibling lists without recursion', async () => {
    const reader = await NativePdfReader.create(simplePdf(show(text)), options);
    try {
      for (let i = 0; i < 5; i++) { const tokens = reader.content(bytes('1 '.repeat(20000))); expect(tokens).toHaveLength(20000); reader.releaseContent(tokens); }
      expect(reader.temporary.size).toBe(0); expect(reader.api.memory.buffer.byteLength).toBeLessThan(12 * 1024 * 1024);
    } finally { reader.destroy(); }
  });
  it('reads inherited resources, crop boxes, rotations and late pages without compiling earlier pages', async () => {
    const document = await openPdfDocument(simplePdf(show(text), { page: '/CropBox [10 20 500 700] /Rotate 90' }), options);
    try { const page = await document.getPage(1); expect(page.view).toEqual([10, 20, 500, 700]); expect(page.getViewport()).toMatchObject({ rotation: 90, width: 680, height: 490 }); } finally { document.destroy(); }
    const pages = Array.from({ length: 1000 }, (_, i) => ({ items: [{ text: `Page ${i + 1}` }] }));
    const book = await openPdfDocument(buildPdfBytes(pages), options);
    try { expect(book.numPages).toBe(1000); expect((await (await book.getPage(1000)).getTextContent()).items[0].str).toBe('Page 1000'); } finally { book.destroy(); }
  });
  it('applies ToUnicode bfchar and bfrange mappings without executing CMap code', async () => {
    const cmap = 'begincmap 1 beginbfchar <41> <0058> endbfchar 1 beginbfrange <42> <43> [<0059><005A>] endbfrange endcmap';
    const data = simplePdf(show('ABC'), { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R', extra: [stream(cmap)] });
    const document = await openPdfDocument(data, options);
    try { expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe('XYZ'); } finally { document.destroy(); }
  });
  it('increments each ToUnicode range target from immutable source bytes', async () => {
    const cmap = 'begincmap 1 beginbfrange <41> <46> <FFF8> endbfrange endcmap';
    const data = simplePdf(show('ABCDEF'), { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R', extra: [stream(cmap)] });
    const document = await openPdfDocument(data, options);
    try { expect((await (await document.getPage(1)).getTextContent()).items[0].str).toBe('\ufff8\ufff9\ufffa\ufffb\ufffc\ufffd'); } finally { document.destroy(); }
  });
  it('builds vector, clipping and transformed text display instructions', async () => {
    const core = await createPdfDocumentCore(simplePdf(`q 2 0 0 2 10 20 cm .2 .4 .6 rg 0 0 100 40 re W n ${show('Vector text')} Q`), options);
    try { const p = await core.pagePayload(1); expect(p.items[0].transform).toEqual([24, 0, 0, 24, 118, 1420]); expect(p.commands.some(c => c.op === 'paint' && c.clip === 'nonzero')).toBe(true); expect(p.inspection.hasRenderableNonText).toBe(true); } finally { core.destroy(); }
  });
  it('detects and decodes a real raw-image XObject for OCR rendering', async () => {
    const core = await createPdfDocumentCore(buildPdfBytes([{ text: '' }], { isImageOnly: true }), options);
    try { const p = await core.pagePayload(1); expect(p.inspection.hasRasterImage).toBe(true); expect([...p.commands.find(c => c.op === 'image').pixels]).toEqual([0, 0, 0, 255]); } finally { core.destroy(); }
  });
  it('renders static annotation appearances and honors invisible links and hidden flags', async () => {
    const appearance = stream('1 0 0 rg 0 0 10 10 re f', '/Subtype /Form /BBox [0 0 10 10]');
    const data = simplePdf(show('Body text'), { page: '/Annots [6 0 R 7 0 R 8 0 R]', extra: [
      '<< /Type /Annot /Subtype /Link /Rect [10 10 20 20] /Border [0 0 0] >>',
      '<< /Type /Annot /Subtype /Square /Rect [20 30 40 50] /AP << /N 9 0 R >> >>',
      '<< /Type /Annot /Subtype /Unknown /F 2 /Rect [0 0 1 1] >>', appearance] });
    const core = await createPdfDocumentCore(data, options);
    try { const p = await core.pagePayload(1); expect(p.commands).toContainEqual({ op: 'transform', args: [2, 0, 0, 2, 20, 30] }); expect(p.items.map(item => item.str)).toEqual(['Body text']); } finally { core.destroy(); }
  });
  it('applies explicit widths, TJ kerning, character spacing and line moves', async () => {
    const data = simplePdf('BT /F1 10 Tf 2 Tc 4 Tw 100 Tz 14 TL 1 0 0 1 20 700 Tm [(A) 100 (B)] TJ T* (A B) Tj ET', {
      font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /Widths [250]'});
    const core = await createPdfDocumentCore(data, options);
    try { const payload = await core.pagePayload(1), items = payload.items, painted = payload.commands.filter(c => c.op === 'text'); expect(items.map(item => item.str)).toEqual(['AB', 'A B']); expect(painted[1].matrix[4]).toBeCloseTo(20 + 6.669921875 + 2 - 1); expect(items[1].transform[5]).toBe(686); expect(items[0].hasEOL).toBe(true); } finally { core.destroy(); }
  });
  it('converts CMYK paint with the licensed profile instead of ignoring the color operator', async () => {
    const core = await createPdfDocumentCore(simplePdf('0 0 0 1 k 0 0 20 30 re f'), options);
    try {
      const payload = await core.pagePayload(1), command = payload.commands.find(c => c.op === 'color');
      expect(command).toMatchObject({ fill: true });
      const rgb = command.value.match(/\d+/g).map(Number); expect(rgb).toHaveLength(3); expect(Math.max(...rgb)).toBeLessThan(60);
      expect(payload.commands).toContainEqual(expect.objectContaining({ op: 'paint', kind: 'f' }));
    } finally { core.destroy(); }
  });
  it('executes Type3 CharProcs while keeping source Unicode and text geometry', async () => {
    const data = simplePdf(show('AA'), {
      font: '/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding << /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /CharProcs << /A 6 0 R >>',
      extra: [stream('600 0 0 0 600 700 d1 0 0 600 700 re f')],
    });
    const core = await createPdfDocumentCore(data, options);
    try {
      const payload = await core.pagePayload(1); expect(payload.items).toHaveLength(1);
      expect(payload.items[0].str).toBe('AA'); expect(payload.items[0].width).toBeCloseTo(14.4, 10);
      const transforms = payload.commands.filter(c => c.op === 'setPdfTransform').map(c => c.args);
      expect(transforms).toHaveLength(2);
      for (let i = 0; i < 2; i++) transforms[i].forEach((value, j) => expect(value).toBeCloseTo([[.012, 0, 0, .012, 54, 700], [.012, 0, 0, .012, 61.2, 700]][i][j], 10));
      expect(payload.commands.filter(c => c.op === 'path' && c.kind === 're')).toHaveLength(2);
    } finally { core.destroy(); }
    const malformed = await openPdfDocument(simplePdf(show('x'), { font: '/Type /Font /Subtype /Type3 /BaseFont /Unknown' }), options);
    try { await expect((await malformed.getPage(1)).getTextContent()).rejects.toMatchObject({ code: 'pdf_corrupt' }); } finally { malformed.destroy(); }
  });
  it('rejects corrupt, excessive-depth and cyclic page trees with explicit errors', async () => {
    await expect(openPdfDocument(bytes('not a PDF at all'), options)).rejects.toMatchObject({ code: 'pdf_corrupt' });
    const cyclic = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [2 0 R] >>']);
    const document = await openPdfDocument(cyclic, options); try { await expect(document.getPage(1)).rejects.toThrow(/Cyclic/); } finally { document.destroy(); }
    const nested = await openPdfDocument(simplePdf(show(text), { page: `/Bad ${'['.repeat(70)}0${']'.repeat(70)}` }), options);
    try { await expect(nested.getPage(1)).rejects.toMatchObject({ code: 'pdf_limit' }); } finally { nested.destroy(); }
  });
  it('distinguishes unsupported execution from malformed image filters instead of returning partial success', async () => {
    for (const [data, code] of [[simplePdf('/Sh0 sh'), 'pdf_corrupt'], [simplePdf('/Sh0 sh', { page: '/Resources << /Shading << /Sh0 6 0 R >> >>', extra: ['<< /ShadingType 4 /ColorSpace /DeviceGray /Coords [0 0 0 10 10 20] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>'] }), 'pdf_unsupported'], [simplePdf(show('x'), { font: '/Type /Font /Subtype /MMType1 /BaseFont /Unknown' }), 'pdf_unsupported'], [simplePdf('', { contents: stream('x', '/Filter /JPXDecode') }), 'pdf_corrupt']]) {
      const document = await openPdfDocument(data, options); try { await expect((await document.getPage(1)).getTextContent()).rejects.toMatchObject({ code }); } finally { document.destroy(); }
    }
    await expect(openPdfDocument(pdf(['<< /Type /Catalog /Pages 2 0 R >>'], '/Root 1 0 R /Encrypt 1 0 R'), options)).rejects.toMatchObject({ code: 'pdf_unsupported' });
  });
  it('honors cancellation before opening', async () => {
    const controller = new AbortController(); controller.abort(); await expect(openPdfDocument(buildPdfBytes([{ text }]), { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('original PDF stream decoders and geometry', () => {
  it('decodes ASCIIHex, ASCII85 and RunLength with malformed-input guards', () => {
    expect([...decodeAsciiHex(bytes('61 62 6>'))]).toEqual([97, 98, 96]);
    expect(new TextDecoder().decode(decodeAscii85(bytes('87cURD_*#TDfTZ)+T~>')))).toBe('Hello, world!');
    expect([...decodeAscii85(bytes('z~>'))]).toEqual([0, 0, 0, 0]);
    expect([...decodeRunLength(Uint8Array.of(1, 65, 66, 254, 67, 128))]).toEqual([65, 66, 67, 67, 67]);
    expect(() => decodeAscii85(bytes('!~>'))).toThrow(); expect(() => decodeAsciiHex(bytes('zz'))).toThrow(); expect(() => decodeRunLength(Uint8Array.of(2, 1))).toThrow();
  });
  it('reverses PNG and TIFF predictors including packed samples', () => {
    expect([...applyPredictor(Uint8Array.of(1, 10, 10, 10, 2, 1, 2, 3), { predictor: 15, columns: 3 })]).toEqual([10, 20, 30, 11, 22, 33]);
    expect([...applyPredictor(Uint8Array.of(10, 10, 10), { predictor: 2, columns: 3 })]).toEqual([10, 20, 30]);
    expect([...applyPredictor(Uint8Array.of(0b01110100), { predictor: 2, bits: 2, columns: 4 })]).toEqual([0b01000101]);
    expect(() => applyPredictor(Uint8Array.of(5, 1), { predictor: 15 })).toThrow();
  });
  it.each([0, 90, 180, 270])('round-trips source coordinates through %i-degree crop and scale', rotation => {
    const view = createPdfViewport([10, 20, 200, 300], { rotation, scale: 1.5, offsetX: 4, offsetY: 7 });
    for (const point of [[10, 20], [200, 300], [40, 90]]) expect(view.convertToPdfPoint(...view.convertToViewportPoint(...point))).toEqual(point);
  });
  it('reads actual licensed TrueType metrics and bounds font table offsets', async () => {
    const font = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), metrics = readTrueTypeMetrics(font);
    expect(metrics.width(65)).toBeGreaterThan(600); expect(metrics.width(105)).toBeLessThan(300);
    expect(() => readTrueTypeMetrics(font.subarray(0, 30))).toThrow(/Truncated|Invalid/);
  });
  it('executes original vector/text commands and restores canvas state when cancelled', async () => {
    const calls = [], ctx = { canvas: { width: 100, height: 100 } };
    for (const name of ['save', 'restore', 'setTransform', 'fillRect', 'transform', 'beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'rect', 'closePath', 'fill', 'stroke', 'clip', 'scale', 'fillText']) ctx[name] = (...args) => calls.push([name, ...args]);
    const payload = { fonts: [], commands: [{ op: 'path', kind: 're', args: [0, 0, 10, 20] }, { op: 'paint', kind: 'f', clip: null },
      { op: 'text', glyphs: [{ text: 'A', x: 0 }], matrix: [12, 0, 0, 12, 10, 40], font: 'own', fill: 'black' }] };
    await renderPdfDisplayList(payload, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 100, 100]) }).promise;
    expect(calls).toContainEqual(['rect', 0, 0, 10, 20]); expect(calls).toContainEqual(['fillText', 'A', 0, 0]);
    expect(calls.filter(c => c[0] === 'save').length).toBe(calls.filter(c => c[0] === 'restore').length);
    const task = renderPdfDisplayList(payload, { canvasContext: ctx, viewport: createPdfViewport([0, 0, 100, 100]) }); task.cancel(); await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
  });
});
