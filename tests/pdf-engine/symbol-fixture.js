// Original geometric outlines and original Type1/CFF writers; no upstream icon artwork.
import { simplePdf, stream } from './fixtures.js';
const join = parts => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const number = n => n >= -107 && n <= 107 ? [n + 139] : n >= 108 ? [247 + ((n - 108) >> 8), (n - 108) & 255] : [251 + ((-n - 108) >> 8), (-n - 108) & 255];
const triangle = [139, 139, 21, ...number(400), 139, 5, 139, ...number(500), 5, ...number(-400), ...number(-500), 5];
function type1(name, glyphName) {
  const clear = Buffer.from(`/FontName /${name} def /FontMatrix [.001 0 0 .001 0 0] def currentfile eexec\n`);
  const outline = [139, ...number(600), 13, ...triangle, 9, 14];
  const plain = Buffer.concat([Buffer.alloc(4), Buffer.from('/lenIV -1 def /CharStrings 3 dict dup begin /.notdef 4 RD '),
    Buffer.from([139, 139, 13, 14]), Buffer.from(` ND /${glyphName} ${outline.length} RD `), Buffer.from(outline),
    Buffer.from(` ND /A ${outline.length} RD `), Buffer.from(outline), Buffer.from(' ND end closefile')]);
  let seed = 55665;
  const encrypted = Uint8Array.from(plain, value => { const cipher = value ^ seed >> 8; seed = ((cipher + seed) * 52845 + 22719) & 65535; return cipher; });
  return { bytes: Buffer.concat([clear, encrypted]), dictionary: `/Length1 ${clear.length} /Length2 ${encrypted.length}` };
}
function cff(name, glyphName) {
  const integer = n => Uint8Array.of(29, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255);
  const dict = (values, op) => join([...values.map(integer), Uint8Array.of(op)]);
  const index = parts => {
    if (!parts.length) return Uint8Array.of(0, 0);
    const offsets = [1]; for (const part of parts) offsets.push(offsets.at(-1) + part.length);
    if (offsets.at(-1) > 255) throw new Error('Original miniature CFF overflow.');
    return join([Uint8Array.of(0, parts.length, 1, ...offsets), ...parts]);
  };
  const header = Uint8Array.of(1, 0, 4, 4), names = index([Buffer.from(name)]), strings = index([Buffer.from(glyphName), Buffer.from('A')]), globals = index([]);
  const charset = Uint8Array.of(0, 1, 135, 1, 136), glyphs = index([Uint8Array.of(14), Uint8Array.from([...triangle, 14]), Uint8Array.from([...triangle, 14])]), privateDict = dict([600], 20);
  const top = (charsetAt, glyphsAt, privateAt) => join([dict([charsetAt], 15), dict([glyphsAt], 17), dict([privateDict.length, privateAt], 18)]);
  const start = header.length + names.length + index([top(0, 0, 0)]).length + strings.length + globals.length;
  return { bytes: join([header, names, index([top(start, start + charset.length, start + charset.length + glyphs.length)]), strings, globals, charset, glyphs, privateDict]), dictionary: '/Subtype /Type1C' };
}
export function symbolPdf({ family = 'ABCDEF+FontAwesome5Brands-Regular', glyph = 'github', unicode = null, actual = null, format = 'type1', mixed = false, source = 'A' } = {}) {
  const font = format === 'cff' ? cff(family, glyph) : type1(family, glyph), field = format === 'cff' ? 'FontFile3' : 'FontFile';
  const content = `BT /F1 20 Tf 1 0 0 1 54 700 Tm ${actual ? `/Span << /ActualText (${actual}) >> BDC ` : ''}${mixed === 'before' ? '(B) Tj ' : ''}(${source}) Tj${mixed === true ? ' (B) Tj' : ''}${actual ? ' EMC' : ''} ET`;
  return simplePdf(content, { font: `/Type /Font /Subtype /Type1 /BaseFont /${family} /FontDescriptor 6 0 R /Encoding << /Differences [65 /${glyph} /A] >>${unicode !== null ? ' /ToUnicode 8 0 R' : ''}`,
    extra: [`<< /Type /FontDescriptor /FontName /${family} /${field} 7 0 R >>`, stream(font.bytes, font.dictionary),
      ...(unicode !== null ? [stream(`begincmap 1 beginbfchar <41> <${unicode}> endbfchar endcmap`)] : [])] });
}
