// Original miniature CID-keyed CFF test data, written against Adobe TN5176/5177.
// The two visible glyphs have original geometric outlines; no third-party font code.
import { simplePdf, stream } from './fixtures.js';
const join = parts => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const integer = n => Uint8Array.of(29, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255);
function index(parts) {
  if (!parts.length) return Uint8Array.of(0, 0);
  const offsets = [1]; for (const part of parts) offsets.push(offsets.at(-1) + part.length);
  if (offsets.at(-1) > 255) throw new Error('Miniature original CFF fixture overflow.');
  return join([Uint8Array.of(0, parts.length, 1, ...offsets), ...parts]);
}
const dict = (values, op) => join([...values.map(integer), Uint8Array.from(op)]);
const number = n => n >= -107 && n <= 107 ? [n + 139] : n >= 108 && n <= 1131 ? [247 + ((n - 108) >> 8), (n - 108) & 255] : n <= -108 && n >= -1131 ? [251 + ((-n - 108) >> 8), (-n - 108) & 255] : [28, n >> 8 & 255, n & 255];
const charstring = commands => Uint8Array.from(commands.flatMap(([values, op]) => [...values.flatMap(number), op]));

export function miniatureCidCff() {
  const header = Uint8Array.of(1, 0, 4, 4), name = index([Buffer.from('OriginalCID')]), strings = index([Buffer.from('Adobe'), Buffer.from('Japan1')]), globals = index([]);
  const charset = Uint8Array.of(0, 1, 8, 30, 207); // GID1->CID264; GID2->CID7887.
  const glyphs = index([Uint8Array.of(14), charstring([[[100, 0], 21], [[200, 700, 200, -700, -80, 0, -50, 200, -140, 0, -50, -200], 5], [[], 14]]),
    charstring([[[200, 100], 21], [[180, 0, -100, -180, -80, 180], 5], [[], 14]])]);
  const fdSelect = Uint8Array.of(0, 0, 0, 0), privateDict = dict([1000], [20]);
  const top = (charsetAt, glyphsAt, fdArrayAt, fdSelectAt) => join([dict([391, 392, 0], [12, 30]), dict([7888], [12, 34]), dict([charsetAt], [15]), dict([glyphsAt], [17]), dict([fdArrayAt], [12, 36]), dict([fdSelectAt], [12, 37])]);
  const topLength = index([top(0, 0, 0, 0)]).length, start = header.length + name.length + topLength + strings.length + globals.length;
  const glyphsAt = start + charset.length, fdSelectAt = glyphsAt + glyphs.length, fdArrayAt = fdSelectAt + fdSelect.length;
  const fdArrayLength = index([dict([privateDict.length, 0], [18])]).length, privateAt = fdArrayAt + fdArrayLength;
  return join([header, name, index([top(start, glyphsAt, fdArrayAt, fdSelectAt)]), strings, globals, charset, glyphs, fdSelect,
    index([dict([privateDict.length, privateAt], [18])]), privateDict]);
}

export function verticalCidCffPdf() {
  return simplePdf('BT /F1 30 Tf 1 0 0 1 400 700 Tm <41814141> Tj 1 0 0 1 340 700 Tm <418141> Tj ET', {
    font: '/Type /Font /Subtype /Type0 /BaseFont /OriginalCID /Encoding /90ms-RKSJ-V /DescendantFonts [6 0 R]',
    extra: ['<< /Type /Font /Subtype /CIDFontType0 /BaseFont /OriginalCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 7 >> /FontDescriptor 7 0 R /DW 1000 /W [264 [600] 7887 [500]] /DW2 [880 -1000] /W2 [264 [-1000 300 880] 7887 [-1000 250 880]] >>',
      '<< /Type /FontDescriptor /FontName /OriginalCID /Flags 4 /FontBBox [0 -200 1000 1000] /Ascent 1000 /Descent -200 /StemV 80 /FontFile3 8 0 R >>',
      stream(miniatureCidCff(), '/Subtype /CIDFontType0C')] });
}
