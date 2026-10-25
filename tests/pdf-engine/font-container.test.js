import { expect, it } from 'vitest';
import { remapTrueTypeCmap, privateGlyphCode } from '../../src/pdf/font-container.js';
import { readTrueTypeMetrics } from '../../src/pdf/font-metrics.js';
import { loadAsset } from './fixtures.js';

function tables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), result = new Map();
  for (let i = 0; i < view.getUint16(4); i++) { const row = 12 + i * 16, start = view.getUint32(row + 8); result.set(String.fromCharCode(...bytes.subarray(row, row + 4)), bytes.subarray(start, start + view.getUint32(row + 12))); }
  return result;
}
function omitTable(bytes, name) {
  const out = bytes.slice(), view = new DataView(out.buffer), count = view.getUint16(4), records = [];
  for (let i = 0; i < count; i++) { const row = 12 + i * 16; if (String.fromCharCode(...out.subarray(row, row + 4)) !== name) records.push(out.slice(row, row + 16)); }
  view.setUint16(4, records.length); records.forEach((record, i) => out.set(record, 12 + i * 16)); return out;
}

it('completes required browser metrics for a PDF TrueType subset while preserving outlines, hints and naming records', async () => {
  const source = omitTable(await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), 'OS/2'), original = source.slice(), metrics = readTrueTypeMetrics(source);
  const gid = metrics.glyphId(65), converted = remapTrueTypeCmap(source, metrics.glyphCount, new Map([[65, gid]])), before = tables(source), after = tables(converted);
  expect(source).toEqual(original); expect(after.get('OS/2')).toHaveLength(78);
  for (const tag of ['glyf', 'loca', 'hmtx', 'hhea', 'maxp', 'name', 'post', 'fpgm', 'prep', 'cvt ']) if (before.has(tag)) expect(after.get(tag), tag).toEqual(before.get(tag));
  const os2 = new DataView(after.get('OS/2').buffer, after.get('OS/2').byteOffset, 78), head = new DataView(before.get('head').buffer, before.get('head').byteOffset, 54);
  expect(os2.getUint16(0)).toBe(0); expect(os2.getInt16(68)).toBe(Math.round(metrics.ascent * metrics.units)); expect(os2.getInt16(70)).toBe(Math.round(metrics.descent * metrics.units));
  expect(os2.getUint16(74)).toBe(Math.max(0, head.getInt16(42))); expect(os2.getUint16(76)).toBe(Math.max(0, -head.getInt16(38)));
  expect(os2.getUint16(64)).toBe(65); expect(os2.getUint16(66)).toBe(65535);
  const actual = readTrueTypeMetrics(converted); expect(actual.glyphId(65)).toBe(gid); expect(actual.glyphId(privateGlyphCode(gid))).toBe(gid); expect(actual.width(65)).toBe(metrics.width(65));
});

it('keeps existing OS/2 embedding flags and license/name records byte-identical', async () => {
  const source = await loadAsset('standard_fonts/LiberationSans-Bold.ttf'), before = tables(source), metrics = readTrueTypeMetrics(source), after = tables(remapTrueTypeCmap(source, metrics.glyphCount));
  expect(after.get('OS/2')).toEqual(before.get('OS/2')); expect(after.get('name')).toEqual(before.get('name'));
});

it('permits absent cmap only when requested while retaining metrics and rejecting malformed present tables', async () => {
  const source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), original = readTrueTypeMetrics(source), absent = omitTable(source, 'cmap');
  const metrics = readTrueTypeMetrics(absent, { requireCmap: false });
  expect(metrics.glyphCount).toBe(original.glyphCount); expect(metrics.widthByGlyph(36)).toBe(original.widthByGlyph(36));
  expect(metrics.unicodeForGlyph(36)).toBeUndefined(); expect(metrics.isUnicode).toBe(false);
  expect(() => metrics.widthByGlyph(original.glyphCount)).toThrow(/glyph index/);
  expect(() => readTrueTypeMetrics(absent)).toThrow(/Missing font cmap/);
  const malformed = source.slice(), view = new DataView(malformed.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const row = 12 + i * 16;
    if (String.fromCharCode(...malformed.subarray(row, row + 4)) === 'cmap') view.setUint32(row + 12, 2);
  }
  expect(() => readTrueTypeMetrics(malformed, { requireCmap: false })).toThrow(/Missing font cmap/);
  const noMetrics = omitTable(absent, 'hmtx');
  expect(() => readTrueTypeMetrics(noMetrics, { requireCmap: false })).toThrow(/Missing font hmtx/);
});

it.each([{ omitted: ['post'] }, { omitted: ['post', 'OS/2'] }])('completes missing printer metadata without changing glyphs, hints or existing font metadata: $omitted', async ({ omitted }) => {
  let source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf');
  for (const tag of omitted) source = omitTable(source, tag);
  const original = source.slice(), metrics = readTrueTypeMetrics(source), before = tables(source);
  const gid = metrics.glyphId(65), converted = remapTrueTypeCmap(source, metrics.glyphCount, new Map([[65, gid]])), after = tables(converted);
  expect(source).toEqual(original);
  expect(after.get('post')).toHaveLength(32);
  const post = after.get('post'); expect(new DataView(post.buffer, post.byteOffset, post.length).getUint32(0)).toBe(0x30000);
  for (const [tag, bytes] of before) if (!['head', 'cmap'].includes(tag)) expect(after.get(tag), tag).toEqual(bytes);
  const actual = readTrueTypeMetrics(converted);
  expect(actual.glyphId(65)).toBe(gid); expect(actual.glyphId(privateGlyphCode(gid))).toBe(gid);
  expect(actual.width(65)).toBe(metrics.width(65)); expect(actual.ascent).toBe(metrics.ascent); expect(actual.descent).toBe(metrics.descent);
  // Verify the entire rebuilt sfnt checksum, not only the new table's header.
  let checksum = 0; const view = new DataView(converted.buffer, converted.byteOffset, converted.length);
  for (let at = 0; at < converted.length; at += 4) checksum = (checksum + view.getUint32(at)) >>> 0;
  expect(checksum).toBe(0xb1b0afba);
});

it('derives bold and italic style from the subset head and refuses an inconsistent glyph count', async () => {
  const source = omitTable(await loadAsset('standard_fonts/LiberationSans-BoldItalic.ttf'), 'OS/2'), metrics = readTrueTypeMetrics(source), os2 = tables(remapTrueTypeCmap(source, metrics.glyphCount)).get('OS/2');
  const view = new DataView(os2.buffer, os2.byteOffset, os2.length); expect(view.getUint16(4)).toBe(700); expect(view.getUint16(62)).toBe(33);
  expect(() => remapTrueTypeCmap(source, metrics.glyphCount - 1)).toThrow(/Invalid subset font metrics/);
});

it.each([{ omitted: ['name'] }, { omitted: ['name', 'OS/2', 'post'] }])('adds only missing browser naming metadata to a PDF subset: $omitted', async ({ omitted }) => {
  let source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf');
  for (const tag of omitted) source = omitTable(source, tag);
  const original = source.slice(), metrics = readTrueTypeMetrics(source), before = tables(source), gid = metrics.glyphId(65);
  const converted = remapTrueTypeCmap(source, metrics.glyphCount, new Map([[65, gid]])), after = tables(converted), name = after.get('name');
  expect(source).toEqual(original); expect(name).toBeDefined();
  for (const [tag, bytes] of before) if (!['head', 'cmap'].includes(tag)) expect(after.get(tag), tag).toEqual(bytes);
  const view = new DataView(name.buffer, name.byteOffset, name.length), strings = new Map();
  expect(view.getUint16(0)).toBe(0); expect(view.getUint16(2)).toBe(4);
  for (let i = 0; i < view.getUint16(2); i++) {
    const row = 6 + i * 12, start = view.getUint16(4) + view.getUint16(row + 10), length = view.getUint16(row + 8);
    expect([view.getUint16(row), view.getUint16(row + 2), view.getUint16(row + 4)]).toEqual([3, 1, 0x409]);
    expect(start + length).toBeLessThanOrEqual(name.length);
    let text = ''; for (let at = start; at < start + length; at += 2) text += String.fromCharCode(view.getUint16(at));
    strings.set(view.getUint16(row + 6), text);
  }
  expect([...strings.keys()]).toEqual([1, 2, 4, 6]); expect(strings.get(2)).toBe('Regular');
  expect(strings.get(6)).toMatch(/^[A-Za-z0-9-]{1,63}$/); expect(strings.get(1)).toBe(strings.get(6)); expect(strings.get(4)).toBe(strings.get(6));
  const actual = readTrueTypeMetrics(converted);
  expect(actual.glyphId(65)).toBe(gid); expect(actual.glyphId(privateGlyphCode(gid))).toBe(gid); expect(actual.width(65)).toBe(metrics.width(65));
  let sum = 0; const sfnt = new DataView(converted.buffer, converted.byteOffset, converted.length);
  for (let at = 0; at < converted.length; at += 4) sum = (sum + sfnt.getUint32(at)) >>> 0;
  expect(sum).toBe(0xb1b0afba);
});

it('preserves a present malformed name table instead of silently replacing it', async () => {
  const source = await loadAsset('standard_fonts/LiberationSans-Regular.ttf'), name = tables(source).get('name');
  new DataView(name.buffer, name.byteOffset, name.length).setUint16(0, 0xffff);
  const original = source.slice(), metrics = readTrueTypeMetrics(source), converted = remapTrueTypeCmap(source, metrics.glyphCount);
  expect(source).toEqual(original); expect(tables(converted).get('name')).toEqual(name);
});
