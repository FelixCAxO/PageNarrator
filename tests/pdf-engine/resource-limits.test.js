// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fonts from '../../src/pdf/fonts.js';
import * as streams from '../../src/pdf/streams.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { openPdfDocument } from '../../src/pdf/browser-pdf.js';
import { simplePdf, show, stream, options, loadAsset } from './fixtures.js';
import { symbolPdf } from './symbol-fixture.js';
import { miniatureCidCff } from './cmap-cff-fixture.js';
import { readCidWidths } from '../../src/pdf/cff-pdf-font.js';
import { readCidVerticalMetrics } from '../../src/pdf/cmap-font.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const MiB = 1024 * 1024;
function fontPage(count, aliases = false) {
  const entries = Array.from({ length: count }, (_value, i) => `/F${i} ${aliases ? 6 : i + 6} 0 R`).join(' ');
  const content = `BT ${Array.from({ length: count }, (_value, i) => `/F${i} 12 Tf`).join(' ')} ET`;
  return simplePdf(content, { page: `/Resources << /Font << ${entries} >> >>`, extra: Array(aliases ? 1 : count).fill('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') });
}
async function payload(bytes) {
  const core = await createPdfDocumentCore(bytes, options);
  try { return await core.pagePayload(1); } finally { core.destroy(); }
}
function fontLoader(length = () => 1) {
  // Byte lengths model large converted fonts without allocating their buffers in a unit test.
  return vi.spyOn(fonts, 'loadSimplePdfFont').mockImplementation(async (_reader, id) => ({ family: `font${id}`, bytes: { byteLength: length(id) }, ascent: 1, descent: 0 }));
}
function browserPayloads(pages, load = async face => face) {
  const constructed = [], retained = new Set();
  vi.stubGlobal('document', { fonts: { add: face => retained.add(face), delete: face => retained.delete(face) } });
  vi.stubGlobal('FontFace', class {
    constructor(family, source) { Object.assign(this, { family, source }); constructed.push(this); }
    load() { return load(this); }
  });
  vi.stubGlobal('Worker', class {
    postMessage({ id, method, args }) {
      const result = method === 'open' ? { numPages: pages.length, metadata: {} } : method === 'pageInfo' ? { view: [0, 0, 10, 10], rotate: 0 }
        : method === 'pagePayload' ? { fonts: pages[args[0] - 1], items: [], commands: [] } : null;
      queueMicrotask(() => this.onmessage?.({ data: { id, result } }));
    }
    terminate() {}
  });
  return { constructed, retained };
}
const face = (family, byteLength = 1, local = false) => ({ family, bytes: { byteLength }, ...(local ? { localFaces: ['Arial'] } : {}) });

describe('original PDF aggregate resource limits', () => {
  it('loads one resolved font once for hundreds of resource aliases', async () => {
    const load = fontLoader(), value = await payload(fontPage(300, true));
    expect(load).toHaveBeenCalledTimes(1); expect(value.fonts).toHaveLength(1);
  });

  it('admits 256 distinct page fonts and rejects the next before loading it', async () => {
    const load = fontLoader();
    expect((await payload(fontPage(256))).fonts).toHaveLength(256); load.mockClear();
    await expect(payload(fontPage(257))).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page font count limit exceeded.' });
    expect(load).toHaveBeenCalledTimes(256);
  });

  it('admits exactly 64 MiB of converted page fonts and rejects additional bytes', async () => {
    let loaded = 0; fontLoader(() => ++loaded <= 2 ? 32 * MiB : 1);
    expect((await payload(fontPage(2))).fonts).toHaveLength(2); loaded = 0;
    await expect(payload(fontPage(3))).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page font byte limit exceeded.' });
  });

  it('admits font metadata through the same page resource budget without charging aliases twice', async () => {
    const load = fontLoader();
    load.mockImplementation(async (_reader, id) => ({ family: `font${id}`, bytes: new Uint8Array(1), resourceBytes: 32 * MiB, ascent: 1, descent: 0 }));
    expect((await payload(fontPage(300, true))).fonts).toHaveLength(1); expect(load).toHaveBeenCalledTimes(1);
    expect((await payload(fontPage(2))).fonts).toHaveLength(2);
    await expect(payload(fontPage(3))).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF page font byte limit exceeded.' });
  });

  it('estimates retained valid and invalid Unicode records separately from actual font bytes', () => {
    const unicode = new Map([['41', 'fi']]); unicode.invalidCodes = new Map([['42', 'invalid']]);
    expect(fonts.pdfFontResourceBytes(new Uint8Array(4), unicode)).toBe(4 + 64 + 2 * (2 + 2) + 64 + 2 * (2 + 7));
    expect(fonts.pdfFontResourceBytes(new Uint8Array(4), null)).toBe(4);
  });

  it('carries Unicode metadata estimates and valid multi-codepoint text through every font loader', async () => {
    const simple = simplePdf(show('A'), { font: '/Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding /ToUnicode 6 0 R', extra: [stream('begincmap 1 beginbfchar <41> <00660069> endbfchar endcmap')] });
    const sources = [
      { data: symbolPdf({ format: 'type1', unicode: '00660069' }), code: [65], keyLength: 2 },
      { data: symbolPdf({ format: 'cff', unicode: '00660069' }), code: [65], keyLength: 2 },
      // The pinned Helvetica AFM retains 315 glyph names in the bounded metric map.
      { data: simple, code: [65], keyLength: 2, metricBytes: 24_276 },
    ];
    for (const cff of [false, true]) sources.push({ data: simplePdf('BT /F1 12 Tf <0108> Tj ET', {
      font: '/Type /Font /Subtype /Type0 /BaseFont /OriginalCID /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R',
      extra: [`<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /OriginalCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 >>`,
        `<< /Type /FontDescriptor /${cff ? 'FontFile3' : 'FontFile2'} 8 0 R >>`, stream(cff ? miniatureCidCff() : await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), cff ? '/Subtype /CIDFontType0C' : ''),
        stream('begincmap 1 beginbfchar <0108> <00660069> endbfchar endcmap')],
    }), code: [1, 8], keyLength: 4, cidBytes: 96 });
    sources.push({ data: simplePdf(show('A'), { font: '/Type /Font /Subtype /Type3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /FirstChar 65 /Widths [600] /Encoding << /Differences [65 /A] >> /CharProcs << /A 6 0 R >> /ToUnicode 7 0 R',
      extra: [stream('600 0 d0 0 0 600 700 re f'), stream('begincmap 1 beginbfchar <41> <00660069> endbfchar endcmap')] }), code: [65], keyLength: 2 });
    for (const { data, code, keyLength, cidBytes = 0, metricBytes = 0 } of sources) {
      const reader = await NativePdfReader.create(data, options);
      try {
        const font = await fonts.loadSimplePdfFont(reader, reader.checked(reader.api.pn_pdf_resolve(5, 0)), loadAsset);
        expect(font.decode(Uint8Array.from(code)).map(glyph => glyph.text).join('')).toBe('fi');
        expect(font.resourceBytes).toBe(font.bytes.byteLength + 64 + 2 * (keyLength + 2) + cidBytes + metricBytes);
      } finally { reader.destroy(); }
    }
  });

  it('counts retained embedded CID encoding parents, widths, vertical metrics and GID bytes', async () => {
    for (const cff of [false, true]) {
      const data = simplePdf('BT /F1 12 Tf <0108> Tj ET', {
        font: '/Type /Font /Subtype /Type0 /BaseFont /OriginalCID /Encoding 10 0 R /DescendantFonts [6 0 R] /ToUnicode 9 0 R',
        extra: [`<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /OriginalCID /FontDescriptor 7 0 R /W [264 [600] 7887 [500]] /W2 [264 [-1000 300 880] 7887 [-1000 250 880]] ${cff ? '' : '/CIDToGIDMap 11 0 R'} >>`,
          `<< /Type /FontDescriptor /${cff ? 'FontFile3' : 'FontFile2'} 8 0 R >>`, stream(cff ? miniatureCidCff() : await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), cff ? '/Subtype /CIDFontType0C' : ''),
          stream('begincmap 1 beginbfchar <0108> <00660069> endbfchar endcmap'),
          stream('begincmap 2 begincidchar <0108> 264 <0109> 7887 endcidchar endcmap', '/UseCMap /Identity-V'), stream(new Uint8Array(530))],
      });
      const reader = await NativePdfReader.create(data, options);
      try {
        const font = await fonts.loadSimplePdfFont(reader, reader.checked(reader.api.pn_pdf_resolve(5, 0)), loadAsset);
        expect(font.decode(Uint8Array.of(1, 8))[0]).toMatchObject({ text: 'fi', width: 600, vmetric: { advanceY: -1000, vx: 300, vy: 880 } });
        // Two 96-byte CMap objects/spaces + two 80-byte CID records; two widths;
        // two 96-byte vertical triples/defaults; one 76-byte ToUnicode record.
        expect(font.resourceBytes - font.bytes.byteLength).toBe(352 + 160 + 208 + 76 + (cff ? 0 : 530));
      } finally { reader.destroy(); }
    }
  });

  it('bounds repeated CID width and vertical ranges, including work shared by both tables', async () => {
    for (const [fields, read] of [
      [`/W [${'0 65535 500 '.repeat(8)}]`, (reader, id) => readCidWidths(reader, id)],
      [`/W2 [${'0 65535 -1000 500 880 '.repeat(8)}]`, (reader, id) => readCidVerticalMetrics(reader, id, () => 1000)],
      [`/W [${'0 65535 500 '.repeat(4)}] /W2 [${'0 65535 -1000 500 880 '.repeat(4)}]`, (reader, id) => {
        const budget = { used: 0 }; readCidWidths(reader, id, budget); return readCidVerticalMetrics(reader, id, () => 1000, budget);
      }],
    ]) {
      const reader = await NativePdfReader.create(simplePdf('', { extra: [`<< ${fields} >>`] }), options);
      try { expect(() => read(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))).toThrow(expect.objectContaining({ code: 'pdf_limit', message: 'CID metric mapping work limit exceeded.' })); }
      finally { reader.destroy(); }
    }
  });

  it('bounds repeated named ActualText even if outer replacements discard it', async () => {
    const text = 'A'.repeat(1000), body = '/Span /P BDC EMC\n'.repeat(2001);
    const data = simplePdf(body, { page: '/Resources << /Properties << /P << /ActualText (' + text + ') >> >> >>' });
    await expect(payload(data)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF ActualText work budget exceeded.' });
  });

  it('preserves empty and nested authoritative ActualText without double-counting replaced output', async () => {
    const data = simplePdf('BT /F1 12 Tf /Span << /ActualText (outer) >> BDC /Span << /ActualText (inner) >> BDC (A) Tj EMC EMC /Span << /ActualText () >> BDC (B) Tj EMC ET');
    expect((await payload(data)).items.map(item => item.str)).toEqual(['outer']);
  });

  it('stops before starting further content decodes after the combined budget is exceeded', async () => {
    let release; const pending = new Promise(resolve => { release = resolve; });
    const decode = vi.spyOn(streams, 'decodePdfStream').mockImplementation(() => pending);
    const core = await createPdfDocumentCore(simplePdf('', { contents: stream(''), page: '/Contents [6 0 R 7 0 R]', extra: [stream('first'), stream('must not be touched')] }), options);
    try {
      const failed = core.pagePayload(1);
      expect(decode).toHaveBeenCalledTimes(1);
      // The mandatory separator puts the first decoded chunk over the total limit.
      release({ bytes: { length: 32 * MiB } });
      await expect(failed).rejects.toMatchObject({ code: 'pdf_limit', message: 'Page content exceeds its 32 MiB limit.' });
      expect(decode).toHaveBeenCalledTimes(1);
    } finally { core.destroy(); }
  });

  it.each(['0041', '41'])('caps cumulative bfchar mappings, including invalid targets %s', async target => {
    const rows = Array.from({ length: 100000 }, (_value, i) => `<${i.toString(16).padStart(8, '0')}> <${target}>`).join('\n');
    const source = `begincmap 100000 beginbfchar\n${rows}\nendbfchar\n1 beginbfchar <000186a0> <0042> endbfchar endcmap`;
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
    try {
      const id = reader.checked(reader.api.pn_pdf_resolve(6, 0));
      await expect(fonts.readToUnicode(reader, id)).rejects.toMatchObject({ code: 'pdf_limit', message: 'ToUnicode entry limit exceeded.' });
      expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });

  it('counts overflow-invalid bfrange entries toward the same cumulative limit', async () => {
    const source = 'begincmap 1 beginbfrange <00000000> <0001869f> <ffff> endbfrange 1 beginbfrange <000186a0> <000186a0> <ffff> endbfrange endcmap';
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
    try { await expect(fonts.readToUnicode(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))).rejects.toMatchObject({ code: 'pdf_limit', message: 'ToUnicode entry limit exceeded.' }); }
    finally { reader.destroy(); }
  });

  it('bounds cumulative mapping work even when invalid ranges overwrite the same small set', async () => {
    // Empty targets make later range entries overflow without allocating long strings.
    const source = `begincmap ${'1 beginbfrange <0000> <07ff> <> endbfrange\n'.repeat(245)} endcmap`;
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
    try {
      await expect(fonts.readToUnicode(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))).rejects.toMatchObject({ code: 'pdf_limit', message: 'ToUnicode mapping work limit exceeded.' });
      expect(reader.temporary.size).toBe(0);
    } finally { reader.destroy(); }
  });

  it('rejects repeated long-target expansion from a small bfrange source', async () => {
    const source = `begincmap 1 beginbfrange <0000> <03e8> <${'0041'.repeat(2000)}> endbfrange endcmap`;
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
    try { await expect(fonts.readToUnicode(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))).rejects.toMatchObject({ code: 'pdf_limit', message: 'ToUnicode retained text limit exceeded.' }); }
    finally { reader.destroy(); }
  });

  it('credits replaced valid text and releases invalidated text at the exact retained-unit limit', async () => {
    const target = '0041'.repeat(2000), source = `begincmap 1 beginbfrange <0000> <03e7> <${target}> endbfrange 3 beginbfchar <0000> <${target}> <0001> <41> <03e8> <${target}> endbfchar endcmap`;
    const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(source)] }), options);
    try {
      const map = await fonts.readToUnicode(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)));
      expect(map.size).toBe(1000); expect(map.invalidCodes.size).toBe(1);
      expect([...map.values()].reduce((sum, text) => sum + text.length, 0)).toBe(2_000_000);
      expect(fonts.unicodeText(map, '0000')).toBe('A'.repeat(2000));
      expect(() => fonts.unicodeText(map, '0001')).toThrow(/Odd-length/);
    } finally { reader.destroy(); }
  });

  it.each(['42', '<d800>', '<dc00>'])('defers malformed target %s to its own source glyph without hiding valid text', async target => {
    const source = simplePdf(show('A'), { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R',
      extra: [stream(`begincmap 1 beginbfrange <41> <42> [<0058> ${target}] endbfrange endcmap`)] });
    expect((await payload(source)).items[0].str).toBe('X');
    const bad = simplePdf(show('B'), { font: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R',
      extra: [stream(`begincmap 1 beginbfrange <41> <42> [<0058> ${target}] endbfrange endcmap`)] });
    await expect(payload(bad)).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('preserves valid surrogate pairs and explicit empty Unicode mappings', () => {
    expect(fonts.utf16be(Uint8Array.of(0xd8, 0x3d, 0xde, 0x00))).toBe('😀');
    expect(fonts.utf16be(new Uint8Array())).toBe('');
  });

  it.each(['type1', 'cff'])('keeps unused invalid ToUnicode entries deferred through %s alias preparation', async format => {
    expect((await payload(symbolPdf({ format, unicode: 'd800', source: 'B' }))).items[0].str).toBe('A');
    await expect(payload(symbolPdf({ format, unicode: 'd800', source: 'A' }))).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('bounds distinct document families before constructing an extra FontFace and reuses admitted families', async () => {
    const known = Array.from({ length: 1024 }, (_value, i) => face(`font${i}`)), state = browserPayloads([known, [face('extra')], [known[0]]]);
    const document = await openPdfDocument(new Uint8Array(), { useWorker: true });
    try {
      await (await document.getPage(1)).ensureFonts(); expect(state.constructed).toHaveLength(1024);
      await expect((await document.getPage(2)).ensureFonts()).rejects.toMatchObject({ code: 'pdf_limit' }); expect(state.constructed).toHaveLength(1024);
      const page = await document.getPage(3); await Promise.all([page.ensureFonts(), page.ensureFonts()]); expect(state.constructed).toHaveLength(1024);
    } finally { document.destroy(); }
    expect(state.retained.size).toBe(0);
  });

  it('counts payload bytes once while retaining and releasing optional local faces', async () => {
    const known = Array.from({ length: 4 }, (_value, i) => face(`font${i}`, 32 * MiB, true)), state = browserPayloads([...known.map(value => [value]), [face('extra')], [known[0]]]);
    const document = await openPdfDocument(new Uint8Array(), { useWorker: true, useSystemFonts: true });
    try {
      for (let number = 1; number <= 4; number++) await (await document.getPage(number)).ensureFonts();
      expect(state.constructed).toHaveLength(8); expect(state.retained.size).toBe(8);
      await expect((await document.getPage(5)).ensureFonts()).rejects.toMatchObject({ code: 'pdf_limit' });
      await (await document.getPage(6)).ensureFonts(); expect(state.constructed).toHaveLength(8);
    } finally { document.destroy(); }
    expect(state.retained.size).toBe(0);
  });

  it('reserves in-flight font bytes once and releases a failed reservation before retrying', async () => {
    let rejectFirst; const pending = new Promise((_resolve, reject) => { rejectFirst = reject; });
    const state = browserPayloads([[face('pending', 128 * MiB)], [face('next')]], value => value.family === 'pending' ? pending : Promise.resolve(value));
    const document = await openPdfDocument(new Uint8Array(), { useWorker: true });
    try {
      const first = await document.getPage(1), loads = Promise.allSettled([first.ensureFonts(), first.ensureFonts()]);
      await vi.waitFor(() => expect(state.constructed).toHaveLength(1));
      const next = await document.getPage(2); await expect(next.ensureFonts()).rejects.toMatchObject({ code: 'pdf_limit' });
      expect(state.constructed).toHaveLength(1); rejectFirst(new Error('Invalid font data.'));
      expect((await loads).every(value => value.status === 'rejected' && value.reason.message === 'Invalid font data.')).toBe(true);
      await next.ensureFonts(); expect(state.constructed).toHaveLength(2); expect(state.retained.size).toBe(1);
    } finally { document.destroy(); }
    expect(state.retained.size).toBe(0);
  });
});
