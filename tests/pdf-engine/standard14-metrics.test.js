// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseStandard14Widths, loadStandard14Widths } from '../../src/pdf/standard14-metrics.js';
import { loadSimplePdfFont } from '../../src/pdf/fonts.js';
import { retainedStandard14Entries, STANDARD14_DATA_FILES } from '../../scripts/lib/pdf-standard14-data.mjs';

vi.mock('../../src/pdf/font-metrics.js', () => ({ readTrueTypeMetrics: () => ({ isUnicode: true, glyphCount: 512,
  glyphId: code => code < 512 ? code : 0, widthByGlyph: () => 777.25, width: () => 777.25, ascent: .9, descent: -.2 }) }));
vi.mock('../../src/pdf/font-container.js', () => ({ remapTrueTypeCmap: bytes => bytes, privateGlyphCode: gid => 0xe000 + gid,
  buildCffOpenType() { throw new Error('Actual font construction is outside authored controls'); } }));
vi.mock('../../src/pdf/streams.js', () => ({ decodePdfStream: async (_reader, stream) => ({ bytes: stream.authoredBytes ?? Uint8Array.of(0) }) }));
vi.mock('../../src/pdf/cff-pdf-font.js', () => ({ loadCffPdfFont: async () => ({ authoredCffMarker: true }),
  readCidWidths() { throw new Error('Actual CID font interpretation is outside authored controls'); } }));

const encode = text => new TextEncoder().encode(text);
const afm = (name = 'Helvetica', rows = ['C 65 ; WX 501 ; N A ; B 0 0 0 0 ;', 'C 88 ; WX 903 ; N X ; B 0 0 0 0 ;', 'C 32 ; WX 0 ; N space ; B 0 0 0 0 ;']) =>
  `StartFontMetrics 4.1\nFontName ${name}\nStartCharMetrics ${rows.length}\n${rows.join('\n')}\nEndCharMetrics\nEndFontMetrics\n`;

describe('bounded original AFM glyph-name widths', () => {
  it('reads authored integer/fraction/zero widths by glyph name, ignoring unrelated fields', () => {
    const widths = parseStandard14Widths(encode(afm('Helvetica', ['N A ; WX 501.5 ; C -1 ; B 0 0 0 0 ;', 'C 32 ; WX 0 ; N space ;'])), 'Helvetica');
    expect([...widths]).toEqual([['A', 501.5], ['space', 0]]);
  });
  it('refuses wrong/missing font identity, count and terminator', () => {
    for (const text of [afm().replace('FontName Helvetica', 'FontName Other'), afm().replace('FontName Helvetica\n', ''),
      afm().replace('StartCharMetrics 3', 'StartCharMetrics 4'), afm().replace('EndCharMetrics', 'NoEnd'), afm().replace('EndFontMetrics', '')]) {
      expect(() => parseStandard14Widths(encode(text), 'Helvetica')).toThrow();
    }
  });
  it('refuses duplicate glyphs, duplicate fields and non-finite/negative/excess widths', () => {
    for (const rows of [['WX 4 ; N A ;', 'WX 5 ; N A ;'], ['WX 4 ; WX 5 ; N A ;'], ['WX 4 ; N A ; N B ;'],
      ['WX NaN ; N A ;'], ['WX -1 ; N A ;'], ['WX 10001 ; N A ;'], ['WX 1e3 ; N A ;']]) {
      expect(() => parseStandard14Widths(encode(afm('Helvetica', rows)), 'Helvetica')).toThrow();
    }
  });
  it('enforces byte, line, glyph count and ASCII budgets before parsing', () => {
    expect(() => parseStandard14Widths(new Uint8Array(131073), 'Helvetica')).toThrow(/byte limit/);
    expect(() => parseStandard14Widths(encode(afm().replace('StartCharMetrics 3', 'StartCharMetrics 513')), 'Helvetica')).toThrow(/glyph limit/);
    expect(() => parseStandard14Widths(encode(afm() + '\n'.repeat(8193)), 'Helvetica')).toThrow(/line limit/);
    expect(() => parseStandard14Widths(encode(afm().replace('FontName', 'éFontName')), 'Helvetica')).toThrow(/ASCII/);
  });
  it.each([['LiberationSans-Regular.ttf', 'Helvetica'], ['LiberationSans-Bold.ttf', 'Helvetica-Bold'],
    ['LiberationSans-Italic.ttf', 'Helvetica-Oblique'], ['LiberationSans-BoldItalic.ttf', 'Helvetica-BoldOblique']])('loads only the canonical data for %s', async (asset, name) => {
    const load = vi.fn(async () => encode(afm(name))); const widths = await loadStandard14Widths(asset, load);
    expect(load).toHaveBeenCalledExactlyOnceWith(`standard14_metrics/${name}.afm`); expect(widths.get('A')).toBe(501);
  });
  it('does not acquire unknown metric assets or prototype properties', async () => {
    const load = vi.fn(); expect(await loadStandard14Widths('Other.ttf', load)).toBeNull(); expect(await loadStandard14Widths('toString', load)).toBeNull(); expect(load).not.toHaveBeenCalled();
  });
});

function authoredFont({ base = 'Helvetica', subtype = 'Type1', widths = null, embedded = false, unicode = false, differences = false } = {}) {
  const name = value => ({ kind: 'name', value }), number = value => ({ kind: 'number', number: value });
  const font = { kind: 'dictionary', fields: { Subtype: name(subtype), BaseFont: name(base), Encoding: differences ? { kind: 'dictionary', fields: {
    BaseEncoding: name('WinAnsiEncoding'), Differences: { kind: 'array', values: [number(65), name('X')] },
  } } : name('WinAnsiEncoding') } };
  if (widths) { font.fields.FirstChar = number(65); font.fields.Widths = { kind: 'array', values: widths.map(number) }; }
  if (embedded) font.fields.FontDescriptor = { kind: 'dictionary', fields: { FontFile2: { kind: 'stream' } } };
  if (unicode) font.fields.ToUnicode = { kind: 'stream', authoredBytes: encode('begincmap 1 beginbfchar <41> <0058> endbfchar endcmap') };
  const resolve = id => id === 1 ? font : id;
  const reader = { field(id, key) { return resolve(id)?.fields?.[key] ?? 0; }, node: resolve, name: id => resolve(id)?.value ?? '', text: node => node.value,
    number: (id, fallback = 0) => resolve(id)?.kind === 'number' ? resolve(id).number : fallback, array: id => resolve(id).values };
  const load = vi.fn(async asset => asset.endsWith('.afm') ? encode(afm(path.basename(asset, '.afm'))) : Uint8Array.of(1));
  return { reader, load };
}
describe('actual simple-font loader priority with authored metadata and mocked font programs', () => {
  it.each(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Arial', 'ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'Arial-BoldItalicMT'])('uses encoded canonical advances for unembedded %s', async base => {
    const { reader, load } = authoredFont({ base }); const font = await loadSimplePdfFont(reader, 1, load);
    expect(font.decode(Uint8Array.of(65, 32)).map(g => g.width)).toEqual([501, 0]); expect(font.resourceBytes).toBeGreaterThan(font.bytes.byteLength);
  });
  it('keeps explicit Widths including zero and partial/out-of-range behavior untouched', async () => {
    for (const widths of [[0], [432], []]) {
      const { reader, load } = authoredFont({ widths }); const font = await loadSimplePdfFont(reader, 1, load);
      expect(font.decode(Uint8Array.of(65))[0].width).toBe(widths.length ? widths[0] : 777.25);
      expect(font.decode(Uint8Array.of(66))[0].width).toBe(777.25); expect(load.mock.calls.some(([asset]) => asset.endsWith('.afm'))).toBe(false);
    }
  });
  it('does not replace an embedded Helvetica/Arial program width', async () => {
    const { reader, load } = authoredFont({ base: 'ArialMT', subtype: 'TrueType', embedded: true }); const font = await loadSimplePdfFont(reader, 1, load);
    expect(font.decode(Uint8Array.of(65))[0].width).toBe(777.25); expect(load).not.toHaveBeenCalled();
  });
  it('uses encoding glyph A for advance when ToUnicode returns X', async () => {
    const { reader, load } = authoredFont({ unicode: true }); const font = await loadSimplePdfFont(reader, 1, load); const value = font.decode(Uint8Array.of(65))[0];
    expect(value.text).toBe('X'); expect(value.width).toBe(501);
  });
  it.each(['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats'])('retains the existing CFF route for %s', async base => {
    const { reader, load } = authoredFont({ base }); expect((await loadSimplePdfFont(reader, 1, load)).authoredCffMarker).toBe(true);
    expect(load.mock.calls.some(([asset]) => asset.endsWith('.afm'))).toBe(false);
  });
  it('uses the declared Differences glyph for canonical advance and painting', async () => {
    const { reader, load } = authoredFont({ differences: true }); const font = await loadSimplePdfFont(reader, 1, load);
    expect(font.decode(Uint8Array.of(65))[0]).toMatchObject({ text: 'X', width: 903, renderText: String.fromCodePoint(0xe000 + 88) });
    expect(load.mock.calls.some(([asset]) => asset === 'standard14_metrics/Helvetica.afm')).toBe(true);
  });
});

function dataFixture() {
  const repository = 'https://github.com/apache/pdfbox', commit = 'e314c402afd4cac4d60d6d16dbe6525d83637ba8', url = `https://raw.githubusercontent.com/apache/pdfbox/${commit}/`;
  const bodies = new Map(STANDARD14_DATA_FILES.map(name => [name, Buffer.from(name)]));
  bodies.set('LICENSE_ADOBE_AFM.txt', Buffer.from('unchanged permission\n'));
  const source = { schemaVersion: 1, executableCode: false, repository, commit, files: STANDARD14_DATA_FILES.map(name => ({ path: name,
    role: name.endsWith('.afm') ? 'font-metrics' : 'license', bytes: bodies.get(name).length, sha256: createHash('sha256').update(bodies.get(name)).digest('hex'),
    source: name.endsWith('.afm') ? url + 'pdfbox/src/main/resources/org/apache/pdfbox/resources/afm/' + name : url + 'LICENSE.txt', license: 'LICENSE_ADOBE_AFM.txt' })),
    upstreamLicense: { source: url + 'LICENSE.txt', bytes: 18741, sha256: '1301d8415a4868d82aeeec594849cf7679f1ead4636a9603dc46875f5713157e' },
    adobePermissionExcerpt: { source: 'APACHE-PDFBOX-SOURCE-LICENSE.txt', startByte: 7, endByte: 28, sha256: createHash('sha256').update(bodies.get('LICENSE_ADOBE_AFM.txt')).digest('hex') } };
  const read = async file => path.basename(file) === 'SOURCE.json' ? Buffer.from(JSON.stringify(source)) : bodies.get(path.basename(file));
  return { source, bodies, read };
}
describe('fresh-import retained-data verification with authored bytes only', () => {
  it('returns all five exact assets/notices plus source manifest without acquisition or font parsing', async () => {
    const fixture = dataFixture(); const entries = await retainedStandard14Entries('authored', fixture.read);
    expect(entries).toHaveLength(6); expect(entries.at(-1).path).toBe('standard14_metrics/SOURCE.json');
  });
  it('rejects byte drift and missing data before any import copy', async () => {
    const fixture = dataFixture(); fixture.bodies.set('Helvetica.afm', Buffer.from('drift'));
    await expect(retainedStandard14Entries('authored', fixture.read)).rejects.toThrow();
    fixture.bodies.delete('Helvetica.afm'); await expect(retainedStandard14Entries('authored', fixture.read)).rejects.toThrow();
  });
  it('rejects missing, duplicate or traversing records', async () => {
    for (const change of [s => s.files.pop(), s => s.files.push(s.files[0]), s => { s.files[0].path = '../bad'; }]) {
      const fixture = dataFixture(); change(fixture.source); await expect(retainedStandard14Entries('authored', fixture.read)).rejects.toThrow();
    }
  });
  it('rejects stale source provenance and modified permission excerpt', async () => {
    const fixture = dataFixture(); fixture.source.commit = 'other'; await expect(retainedStandard14Entries('authored', fixture.read)).rejects.toThrow();
    const bad = dataFixture(); bad.source.adobePermissionExcerpt.startByte++; await expect(retainedStandard14Entries('authored', bad.read)).rejects.toThrow();
    const wrong = dataFixture(); wrong.source.adobePermissionExcerpt.source = 'Other.txt'; await expect(retainedStandard14Entries('authored', wrong.read)).rejects.toThrow();
  });
});
