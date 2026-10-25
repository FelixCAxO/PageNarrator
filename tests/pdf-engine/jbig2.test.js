import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as reference from 'pdfjs-dist/legacy/build/pdf.mjs';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { decodeFax, decodePdfStream } from '../../src/pdf/streams.js';
import { decodeJbig2, readJbig2Segments } from '../../src/pdf/jbig2.js';
import { decodeJbig2Generic, decodeJbig2Refinement, decodeJbig2GrayPlanes, withJbig2Arithmetic } from '../../src/pdf/jbig2-arithmetic.js';
import { simplePdf, stream, options } from './fixtures.js';
import original from './fixtures/jbig2-original.json';
import { Jbig2Bits, Jbig2HuffmanTable, customHuffmanTable, standardHuffmanTable } from '../../src/pdf/jbig2-huffman.js';
const concat = (...pieces) => new Uint8Array(Buffer.concat(pieces.map(piece => Buffer.from(piece))));
const u32 = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
const bits = value => Uint8Array.from({ length: Math.ceil(value.length / 8) }, (_, i) => parseInt(value.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2));
const signature = Uint8Array.of(0x97, 0x4a, 0x42, 0x32, 13, 10, 26, 10);
function segment(number, type, page, data = [], { refs = [], longCount = false, largePage = false, headerOnly = false, unknownLength = false } = {}) {
  const retain = [0, 4, 16, 20, 36, 40].includes(type) ? 1 : 0;
  const count = longCount ? concat(u32(0xe0000000 + refs.length), Uint8Array.from({ length: Math.ceil((refs.length + 1) / 8) }, (_, i) => i ? 0 : retain)) : Uint8Array.of(refs.length << 5 | retain);
  const encodedRefs = refs.map(ref => number <= 256 ? Uint8Array.of(ref) : number <= 65536 ? Uint8Array.of(ref >> 8, ref) : u32(ref));
  return concat(u32(number), Uint8Array.of(type | (largePage ? 64 : 0)), count, ...encodedRefs, largePage ? u32(page) : Uint8Array.of(page), u32(unknownLength ? 0xffffffff : data.length), headerOnly ? [] : data);
}
const pageInfo = (width = 8, height = 2, flags = 0, stripe = 0) => concat(u32(width), u32(height), u32(0), u32(0), Uint8Array.of(flags, stripe >> 8, stripe));
const region = ({ width = 8, height = 2, x = 0, y = 0, operator = 0, flags = 1, encoded = '001101101111' } = {}) => concat(u32(width), u32(height), u32(x), u32(y), Uint8Array.of(operator, flags), bits(encoded));
const basic = (regionData = region(), info = pageInfo()) => concat(segment(1, 48, 1, info), segment(2, 38, 1, regionData), segment(3, 49, 1));
const arithmeticVector = Uint8Array.from(Buffer.from(original.singleContext.encodedHex, 'hex'));
const defaultAdaptive = [[3, -1, -3, -1, 2, -2, -2, -2], [3, -1], [2, -1], [2, -1]];
const wasmUrl = fileURLToPath(new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url)).replaceAll('\\', '/');
async function withDecoder(run) {
  const reader = await NativePdfReader.create(simplePdf(''), options);
  try { return await run((bytes, extra = {}) => decodeJbig2(bytes, { ...extra, decodeMmr: (data, parameters) => decodeFax(reader, data, parameters), decodeArithmetic: (data, parameters) => decodeJbig2Generic(reader, data, parameters), decodeRefinement: (data, parameters) => decodeJbig2Refinement(reader, data, parameters), decodeGrayPlanes: (data, parameters) => decodeJbig2GrayPlanes(reader, data, parameters), withArithmetic: (data, run, retained) => withJbig2Arithmetic(reader, data, run, retained) })); } finally { reader.destroy(); }
}
async function compareBitmap(encoded, width, height, { globals = null, blackPixels = null } = {}) {
  const data = simplePdf('q 170 0 0 110 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(encoded, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode${globals ? ' /DecodeParms << /JBIG2Globals 7 0 R >>' : ''}`), ...(globals ? [stream(globals)] : [])] });
  const core = await createPdfDocumentCore(data, options), task = reference.getDocument({ data: data.slice(), wasmUrl });
  try {
    const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image'), page = await (await task.promise).getPage(1), list = await page.getOperatorList(), position = list.fnArray.findIndex(fn => fn === reference.OPS.paintImageXObject || fn === reference.OPS.paintInlineImageXObject);
    expect(position).toBeGreaterThanOrEqual(0); const args = list.argsArray[position], oracle = list.fnArray[position] === reference.OPS.paintInlineImageXObject ? args[0] : await new Promise(resolve => page.objs.get(args[0], resolve));
    expect(oracle.width).toBe(width); expect(oracle.height).toBe(height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const expected = oracle.kind === 1 ? oracle.data[y * Math.ceil(width / 8) + (x >> 3)] & 128 >> (x & 7) ? 255 : 0 : oracle.data[(y * width + x) * (oracle.kind === 3 ? 4 : 3)];
      if (blackPixels) expect(expected, `independent source pixel ${x},${y}`).toBe(blackPixels[y * Math.ceil(width / 8) + (x >> 3)] & 128 >> (x & 7) ? 0 : 255);
      expect(image.pixels[(y * width + x) * 4], `pixel ${x},${y}`).toBe(expected);
    }
  } finally { core.destroy(); await task.destroy(); }
}
const external = name => Uint8Array.from(Buffer.from(original.external[name].hex, 'hex'));
it.each(['generic-17x11', 'generic-32x24', 'generic-32x24-tpgd'])('matches authored %s pixels encoded externally and independently decoded', async id => {
  const file = external(`${id}.jb2`), input = original.inputs.find(input => input.id === id.replace('-tpgd', ''));
  // PDF 7.4.7 removes the standalone header and both terminal segments.
  await compareBitmap(file.subarray(13, -22), input.width, input.height, { blackPixels: Buffer.from(input.blackPackedHex, 'hex') });
});
it('matches every authored symbol/text page pixel through external encoder globals', async () => {
  const input = original.inputs.find(input => input.id === 'symbols-320x144');
  await compareBitmap(external('symbols.0000'), input.width, input.height, { globals: external('symbols.sym'), blackPixels: Buffer.from(input.blackPackedHex, 'hex') });
});
const u16 = value => [value >> 8, value];
const b1 = value => value < 16 ? '0' + value.toString(2).padStart(4, '0') : value < 272 ? '10' + (value - 16).toString(2).padStart(8, '0') : value < 65808 ? '110' + (value - 272).toString(2).padStart(16, '0') : '111' + (value - 65808).toString(2).padStart(32, '0');
const firstSymbol = () => concat(u16(1), u32(1), u32(1), bits('1110100' + '1110010' + '111111' + b1(0)),
  Uint8Array.from(Buffer.from(original.refinements[0].referenceHex, 'hex')), bits(b1(0) + b1(1)));
const refinedSymbol = template => Uint8Array.from(Buffer.from(original.refinements[template].encodedHex, 'hex'));
function singleSymbolText({ width = 5, refinement = false, template = 0, payload = refinedSymbol(template) } = {}) {
  const flags = 1 | 16 | (refinement ? 2 | template << 15 : 0), lengths = '0000' + '0001' + '0000'.repeat(33), prefix = bits(lengths + '0');
  const position = '00' + '000000000' + '0';
  const body = refinement ? concat(bits(position + '1' + '0000' + b1(payload.length)), payload, bits('01')) : bits(position + '01');
  return concat(u32(width), u32(8), u32(0), u32(0), [0], u16(flags), u16(0), refinement && !template ? [255, 255, 255, 255] : [], u32(1), prefix, body);
}
describe('original Huffman instance and dictionary refinement', () => {
  it('rejects a declared refinement payload with unconsumed arithmetic bytes', async () => withDecoder(decode => {
    const data = concat(segment(0, 0, 0, firstSymbol()), segment(1, 48, 1, pageInfo(8, 8)), segment(2, 7, 1, singleSymbolText({ refinement: true, payload: arithmeticVector }), { refs: [0] }), segment(3, 49, 1));
    expect(() => decode(data)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  }));
  it.each([0, 1])('matches independent Huffman instance refinement with template %i', async template => {
    const data = concat(segment(0, 0, 0, firstSymbol()), segment(1, 48, 1, pageInfo(8, 8)), segment(2, 7, 1, singleSymbolText({ refinement: true, template }), { refs: [0] }), segment(3, 49, 1));
    await compareBitmap(data, 8, 8, { blackPixels: Buffer.from(original.refinements[template].targetHex, 'hex') });
  });
  it.each([0, 1])('matches independent Huffman refined dictionary symbols with template %i', async template => {
    const shortRefinement = refinedSymbol(template);
    const dictionary = concat(u16(3 | template << 12), template ? [] : [255, 255, 255, 255], u32(1), u32(1), bits('1110100' + '1110010' + b1(1) + '0' + '00' + b1(shortRefinement.length)), shortRefinement, bits('111111' + b1(1) + b1(1)));
    const data = concat(segment(0, 0, 0, firstSymbol()), segment(1, 48, 1, pageInfo(8, 8)), segment(2, 0, 1, dictionary, { refs: [0] }), segment(3, 7, 1, singleSymbolText(), { refs: [2] }), segment(4, 49, 1));
    await compareBitmap(data, 8, 8, { blackPixels: Buffer.from(original.refinements[template].targetHex, 'hex') });
  });
  it('matches independent Huffman aggregation with shared symbol placement state', async () => {
    const aggregate = '00' + '000000000' + '00' + '000' + '00' + '01';
    const dictionary = concat(u16(0x1003), u32(1), u32(1), bits('1110100' + '1110110' + b1(2) + aggregate + '111111' + b1(1) + b1(1)));
    const data = concat(segment(0, 0, 0, firstSymbol()), segment(1, 48, 1, pageInfo(12, 8)), segment(2, 0, 1, dictionary, { refs: [0] }), segment(3, 7, 1, singleSymbolText({ width: 9 }), { refs: [2] }), segment(4, 49, 1));
    await compareBitmap(data, 12, 8);
  });
});
describe('bounded JBIG2 symbol graphs and canonical table input', () => {
  it('matches the normative custom Table B.1 encoding and guards malformed prefixes', () => {
    const custom = customHuffmanTable(Uint8Array.from(Buffer.from('42000000000001011049238180', 'hex')));
    for (const value of [0, 15, 16, 271, 272, 65807, 65808, 2147483647]) { expect(custom.decode(new Jbig2Bits(bits(b1(value))))).toBe(value); expect(standardHuffmanTable(1).decode(new Jbig2Bits(bits(b1(value))))).toBe(value); }
    expect(standardHuffmanTable(2).decode(new Jbig2Bits(bits('111111')))).toBeNull();
    expect(() => new Jbig2HuffmanTable([[0, 1, 0], [1, 1, 0], [2, 1, 0]])).toThrow(/Oversubscribed/);
    expect(() => custom.decode(new Jbig2Bits(Uint8Array.of(255)))).toThrow(/Truncated/);
  });
  const reexport = count => concat(u16(1), u32(count), u32(0), bits(b1(0) + b1(count)));
  it('rejects deep dictionary chains before recursive decoding can exhaust the JS stack', async () => withDecoder(decode => {
    const pieces = [segment(0, 0, 0, firstSymbol())];
    for (let i = 1; i < 70; i++) pieces.push(segment(i, 0, 0, reexport(1), { refs: [i - 1] }));
    pieces.push(segment(70, 48, 1, pageInfo(8, 8)), segment(71, 7, 1, singleSymbolText(), { refs: [69] }), segment(72, 49, 1));
    expect(() => decode(concat(...pieces))).toThrow(expect.objectContaining({ code: 'pdf_limit', message: expect.stringMatching(/reference depth/) }));
  }));
  it('bounds concatenated imports before allocating a hostile duplicated symbol graph', async () => withDecoder(decode => {
    const pieces = [segment(0, 0, 0, firstSymbol()), segment(1, 0, 0, firstSymbol())]; let previous = [0, 1], number = 2;
    for (let level = 1; level <= 15; level++) { const next = []; for (let i = 0; i < 2; i++) { next.push(number); pieces.push(segment(number++, 0, 0, reexport(2 ** level), { refs: previous })); } previous = next; }
    pieces.push(segment(number, 0, 0, reexport(65536), { refs: previous })); const full = number++;
    pieces.push(segment(number, 0, 0, reexport(98304), { refs: [full, previous[0]] })); const excessive = number++;
    pieces.push(segment(number++, 48, 1, pageInfo(8, 8)), segment(number++, 7, 1, singleSymbolText(), { refs: [excessive] }), segment(number, 49, 1));
    expect(() => decode(concat(...pieces))).toThrow(expect.objectContaining({ code: 'pdf_limit', message: expect.stringMatching(/imported symbol count/) }));
  }));
  it('counts text instances cumulatively even when a later region is wholly off page', async () => withDecoder(decode => {
    const excessive = singleSymbolText().slice(), view = new DataView(excessive.buffer); view.setUint32(21, 1_000_000); view.setUint32(8, 1000);
    const data = concat(segment(0, 0, 0, firstSymbol()), segment(1, 48, 1, pageInfo(8, 8)), segment(2, 7, 1, singleSymbolText(), { refs: [0] }), segment(3, 7, 1, excessive, { refs: [0] }), segment(4, 49, 1));
    expect(() => decode(data)).toThrow(expect.objectContaining({ code: 'pdf_limit', message: expect.stringMatching(/cumulative text instance/) }));
  }));
  it('caps retained bitmap statistics across many individually small dictionaries', async () => withDecoder(decode => {
    const dictionary = readJbig2Segments(external('symbols.sym')).segments.find(segment => segment.type === 0).data.slice(), flags = new DataView(dictionary.buffer);
    flags.setUint16(0, flags.getUint16(0) | 512);
    const pieces = Array.from({ length: 257 }, (_, i) => segment(i, 0, 0, dictionary)); pieces.push(segment(257, 48, 1, pageInfo(8, 8)), segment(258, 7, 1, singleSymbolText(), { refs: Array.from({ length: 257 }, (_, i) => i), longCount: true }), segment(259, 49, 1));
    expect(() => decode(concat(...pieces))).toThrow(expect.objectContaining({ code: 'pdf_limit', message: expect.stringMatching(/coding context byte/) }));
  }));
});
describe('original JBIG2 container and MMR bitmap execution', () => {
  it('decodes embedded MMR generic regions with optional EOFB and PDF sample polarity', async () => withDecoder(decode => {
    expect(decode(basic())).toEqual({ bytes: Uint8Array.of(240, 240), width: 8, height: 2 });
    expect(decode(basic(region({ encoded: '001101101111000000000001000000000001' })))).toEqual({ bytes: Uint8Array.of(240, 240), width: 8, height: 2 });
  }));
  it('reads sequential and random-access standalone organizations independently', async () => withDecoder(decode => {
    const info = pageInfo(), generic = region(), eof = segment(4, 51, 0);
    const sequential = concat(signature, [1], u32(1), basic(), eof);
    const random = concat(signature, [0], u32(1), segment(1, 48, 1, info, { headerOnly: true }), segment(2, 38, 1, generic, { headerOnly: true }), segment(3, 49, 1), eof, info, generic);
    expect(decode(sequential).bytes).toEqual(Uint8Array.of(240, 240)); expect(decode(random).bytes).toEqual(Uint8Array.of(240, 240));
    expect(() => decode(concat(random, [0]))).toThrow(/Unexpected bytes/);
    expect(() => decode(concat(signature, [1], u32(1), segment(1, 48, 1, info)))).toThrow(/end-of-page/);
  }));
  it.each([0, 1, 2, 3, 4])('composes overlapping regions with external combination operator %i', async operator => withDecoder(decode => {
    const data = concat(segment(1, 48, 1, pageInfo(8, 2, 64)), segment(2, 38, 1, region()), segment(3, 38, 1, region({ operator, x: 2 })), segment(4, 49, 1));
    const expectedBlack = [15, 3, 12, 51, 3][operator];
    expect(decode(data).bytes).toEqual(Uint8Array.of(255 ^ expectedBlack, 255 ^ expectedBlack));
  }));
  it('uses the page default pixel and page operator when an override is forbidden', async () => withDecoder(decode => {
    expect(decode(basic(region({ operator: 4 }), pageInfo(8, 2, 4 | 8))).bytes).toEqual(Uint8Array.of(240, 240));
    expect(decode(concat(segment(1, 48, 1, pageInfo(3, 1)), segment(2, 49, 1))).bytes).toEqual(Uint8Array.of(255));
  }));
  it('checks declared bitmap height, dimensions, forbidden MMR extensions and cancellation', async () => withDecoder(decode => {
    expect(() => decode(basic(region({ height: 3, encoded: '0011011011000000000001000000000001' })))).toThrow(/declared height/);
    expect(() => decode(basic(region({ encoded: '00000011110000111100000010' })))).toThrow(/Invalid/);
    expect(() => decode(basic(region({ width: 0 })))).toThrow(/Empty/);
    expect(() => decode(basic(region({ width: 100000, height: 100000 })))).toThrow(/limit/);
    expect(() => decodeJbig2(basic(), { check: () => { throw new Error('cancelled'); } })).toThrow(/cancelled/);
  }));
  it('distinguishes malformed containers from unsupported extended adaptive templates', async () => withDecoder(decode => {
    expect(() => decode(Uint8Array.of(0))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(basic(region({ flags: 16 })))).toThrow(expect.objectContaining({ code: 'pdf_unsupported' }));
    expect(() => decode(basic(region({ flags: 0 })))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(basic(region({ flags: 3 })))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(concat(segment(1, 48, 1, pageInfo()), segment(1, 38, 1, region())))).toThrow(/Duplicate/);
    expect(() => decode(concat(segment(1, 38, 1, region()), segment(2, 48, 1, pageInfo())))).toThrow(/precedes/);
  }));
  it('parses all normative reference-number widths, long counts, and large page associations', () => {
    for (const number of [256, 257, 65536, 65537]) {
      const refs = [0, 1, 2, 3, 4]; const parsed = readJbig2Segments(segment(number, 0, 513, [], { refs, longCount: true, largePage: true })).segments[0];
      expect(parsed.refs).toEqual(refs); expect(parsed.page).toBe(513); expect(parsed.number).toBe(number);
    }
    const invalid = segment(1, 48, 1, pageInfo()); invalid[5] = 0xa0;
    expect(() => readJbig2Segments(invalid)).toThrow(/count/);
    expect(() => readJbig2Segments(segment(2, 38, 1, region(), { refs: [1] }))).toThrow(/forbidden references/);
  });
  it('validates global references and rejects necessary extensions instead of ignoring them', async () => withDecoder(decode => {
    const globals = segment(0, 62, 0, concat(u32(0), [65, 66]));
    expect(decode(basic(), { globals }).bytes).toEqual(Uint8Array.of(240, 240));
    expect(() => decode(basic(), { globals: segment(0, 62, 0, u32(0x80000001)) })).toThrow(/necessary/);
    expect(() => decode(basic(), { globals: segment(0, 0, 1) })).toThrow(/page-specific/);
    expect(() => decode(concat(segment(1, 48, 1, pageInfo()), segment(2, 7, 1, [], { refs: [0] })))).toThrow(/Missing/);
  }));
  it('executes actual JBIG2-filtered PDF image pixels matching an independent decoder', async () => {
    const global = segment(0, 62, 0, u32(0)), globalHex = Buffer.from(global).toString('hex') + '>';
    const data = simplePdf('q 80 0 0 40 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [stream(basic(), '/Type /XObject /Subtype /Image /Width 8 /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 7 0 R >>'), stream(globalHex, '/Filter /ASCIIHexDecode')] });
    const core = await createPdfDocumentCore(data, options), task = reference.getDocument({ data: data.slice(), wasmUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/wasm/', import.meta.url)).replaceAll('\\', '/') });
    try {
      const image = (await core.pagePayload(1)).commands.find(command => command.op === 'image'), page = await (await task.promise).getPage(1), list = await page.getOperatorList();
      const position = list.fnArray.findIndex(fn => fn === reference.OPS.paintImageXObject || fn === reference.OPS.paintInlineImageXObject); expect(position).toBeGreaterThanOrEqual(0);
      const args = list.argsArray[position], oracle = list.fnArray[position] === reference.OPS.paintInlineImageXObject ? args[0] : await new Promise(resolve => page.objs.get(args[0], resolve));
      expect(oracle.width).toBe(8); expect(oracle.height).toBe(2);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { const expected = x < 4 ? 255 : 0; expect(image.pixels[(y * 8 + x) * 4]).toBe(expected); expect(oracle.kind === 1 ? oracle.data[y] & 128 >> x ? 255 : 0 : oracle.data[(y * 8 + x) * (oracle.kind === 3 ? 4 : 3)]).toBe(expected); }
    } finally { core.destroy(); await task.destroy(); }
  });
  it('rejects cyclic JBIG2Globals and contradictory PDF image dimensions', async () => {
    for (const [width, globals] of [[8, '/JBIG2Globals 6 0 R'], [9, '']]) {
      const data = simplePdf('', { extra: [stream(basic(), `/Type /XObject /Subtype /Image /Width ${width} /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << ${globals} >>`)] }), reader = await NativePdfReader.create(data, options);
      try { const id = reader.checked(reader.api.pn_pdf_resolve(6, 0)); await expect(decodePdfStream(reader, id, { image: true })).rejects.toThrow(globals ? /Cyclic/ : /dimensions disagree/); } finally { reader.destroy(); }
    }
  });
});

describe('original JBIG2 streaming segment and striped-page boundaries', () => {
  const unknownMmr = (rows = 2, declaredHeight = 20) => concat(region({ height: declaredHeight, encoded: '001101101111000000000001000000000001' }), [0, 0], u32(rows));
  it('finds MMR unknown segment boundaries, preserves EOFB and applies the final row count', async () => {
    const data = concat(segment(1, 48, 1, pageInfo()), segment(2, 38, 1, unknownMmr(), { unknownLength: true }), segment(3, 49, 1));
    await withDecoder(decode => { expect(decode(data).bytes).toEqual(Uint8Array.of(240, 240)); }); await compareBitmap(data, 8, 2);
    const random = concat(signature, [0], u32(1), segment(1, 48, 1, pageInfo(), { headerOnly: true }), segment(2, 38, 1, unknownMmr(), { unknownLength: true, headerOnly: true }), segment(3, 49, 1), segment(4, 51, 0), pageInfo(), unknownMmr());
    await withDecoder(decode => { expect(decode(random).bytes).toEqual(Uint8Array.of(240, 240)); });
  });
  it.each([0, 1, 2, 3])('finds arithmetic unknown segment boundaries for template %i', async template => {
    const encoded = concat(u32(17), u32(20), u32(0), u32(0), [0, template << 1], Uint8Array.from(defaultAdaptive[template]), arithmeticVector, u32(11));
    const data = concat(segment(1, 48, 1, pageInfo(17, 11)), segment(2, 38, 1, encoded, { unknownLength: true }), segment(3, 49, 1));
    await compareBitmap(data, 17, 11);
  });
  it('determines unknown page height from consecutive completed stripes', async () => {
    const data = concat(segment(1, 48, 1, pageInfo(8, 0xffffffff, 0, 0x8002)), segment(2, 38, 1, region()), segment(3, 50, 1, u32(1)), segment(4, 38, 1, region({ y: 2 })), segment(5, 50, 1, u32(3)), segment(6, 49, 1));
    await withDecoder(decode => { expect(decode(data)).toEqual({ bytes: Uint8Array.of(240, 240, 240, 240), width: 8, height: 4 }); }); await compareBitmap(data, 8, 4);
  });
  it('rejects missing terminators, excess rows, short stripes and page modifications after the final stripe', async () => withDecoder(decode => {
    const known = payload => concat(segment(1, 48, 1, pageInfo()), segment(2, 38, 1, payload, { unknownLength: true }), segment(3, 49, 1));
    expect(() => decode(known(region()))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(known(unknownMmr(3, 2)))).toThrow(/row count/);
    expect(() => decode(known(concat(region(), [0, 0], u32(2))))).toThrow(/unterminated/);
    const info = segment(1, 48, 1, pageInfo(8, 0xffffffff, 0, 0x8002));
    expect(() => decode(concat(info, segment(2, 38, 1, region()), segment(3, 49, 1)))).toThrow(/final stripe/);
    expect(() => decode(concat(segment(1, 48, 1, pageInfo(8, 4, 0, 0x8002)), segment(2, 38, 1, region()), segment(3, 50, 1, u32(0)), segment(4, 49, 1)))).toThrow(/stripe end/);
    expect(() => decode(concat(info, segment(2, 50, 1, u32(1)), segment(3, 38, 1, region({ y: 2 })), segment(4, 49, 1)))).toThrow(/final stripe/);
    const invalid = segment(2, 39, 1, unknownMmr(), { unknownLength: true }); expect(() => readJbig2Segments(invalid)).toThrow(/invalid type/);
  }));
});

const eoFb = '000000000001000000000001';
const patternTwo = (template = null) => concat([template === null ? 1 : template << 1, 4, 4], u32(1), template === null ? bits('0011011011' + '11'.repeat(3)) : arithmeticVector);
function halftone({ width = 16, height = 8, gridWidth = 4, gridHeight = 2, x = 0, y = 0, rx = 1024, ry = 0, operator = 0, defaultPixel = 0, template = null, skip = false, planes = [bits('00101111111' + eoFb)] } = {}) {
  return concat(u32(width), u32(height), u32(0), u32(0), [0, (template === null ? 1 : template << 1 | (skip ? 8 : 0)) | operator << 4 | defaultPixel << 7], u32(gridWidth), u32(gridHeight), u32(x), u32(y), [rx >> 8, rx, ry >> 8, ry], ...planes);
}
describe('original JBIG2 pattern dictionaries and MMR halftone grids', () => {
  it('executes a global two-pattern dictionary and independent halftone bitmap pixels', async () => {
    const dictionary = segment(0, 16, 0, patternTwo()), main = concat(segment(1, 48, 1, pageInfo(16, 8)), segment(2, 22, 1, halftone(), { refs: [0] }), segment(3, 49, 1));
    await withDecoder(decode => { expect(decode(main, { globals: dictionary }).bytes).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i & 1 ? 0 : 255)); });
    await compareBitmap(concat(dictionary, main), 16, 8);
  });
  it('decodes multiple MMR gray-code bitplanes with exact byte-boundary advancement', async () => {
    const dictionary = concat([1, 2, 2], u32(3), bits('00110001100100011111' + '1111'));
    const grid = halftone({ width: 8, height: 4, rx: 512, planes: [bits('00101111111' + eoFb), bits('001000111111111' + eoFb)] });
    const data = concat(segment(0, 16, 0, dictionary), segment(1, 48, 1, pageInfo(8, 4)), segment(2, 23, 1, grid, { refs: [0] }), segment(3, 49, 1));
    await withDecoder(decode => { expect(decode(data).bytes).toEqual(Uint8Array.of(228, 228, 228, 228)); }); await compareBitmap(data, 8, 4);
  });
  it.each([0, 1, 2, 3])('executes arithmetic pattern dictionaries with template %i and MMR grid indices', async template => {
    const data = concat(segment(0, 16, 0, patternTwo(template)), segment(1, 48, 1, pageInfo(16, 8)), segment(2, 22, 1, halftone(), { refs: [0] }), segment(3, 49, 1));
    await compareBitmap(data, 16, 8);
  });
  it.each([0, 1, 2, 3, 4])('clips signed halftone origins and composes internal operator %i', async operator => {
    const data = concat(segment(0, 16, 0, patternTwo()), segment(1, 48, 1, pageInfo(16, 8)), segment(2, 22, 1, halftone({ x: -512, y: 512, rx: 768, ry: 256, operator, defaultPixel: 1 }), { refs: [0] }), segment(3, 49, 1));
    await compareBitmap(data, 16, 8);
  });
  it('rejects missing EOFB, invalid gray indices and forbidden MMR skip flags', async () => withDecoder(decode => {
    const make = (dictionary, grid) => concat(segment(0, 16, 0, dictionary), segment(1, 48, 1, pageInfo(16, 8)), segment(2, 22, 1, grid, { refs: [0] }), segment(3, 49, 1));
    expect(() => decode(make(patternTwo(), halftone({ planes: [bits('00101111111')] })))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    const flagged = halftone(); flagged[17] |= 8; expect(() => decode(make(patternTwo(), flagged))).toThrow(/flags/);
    const wrong = concat([1, 4, 4], u32(2), bits('0011011011' + '11'.repeat(3))); expect(() => decode(make(wrong, halftone({ planes: [bits('00101111111' + eoFb), bits('001000111111111' + eoFb)] })))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  }));
});

describe('original JBIG2 arithmetic gray-planes and shared coding state', () => {
  it.each(Array.from({ length: 16 }, (_, i) => ({ template: i >> 2, skip: !!(i & 2), twoPlanes: !!(i & 1) })))('matches independent halftone pixels for template $template, skip $skip, multiple planes $twoPlanes', async ({ template, skip, twoPlanes }) => {
    const dictionary = twoPlanes ? concat([1, 2, 2], u32(3), bits('00110001100100011111' + '1111')) : patternTwo();
    const grid = halftone({ width: 40, height: 25, gridWidth: 17, gridHeight: 11, x: -1024, y: 2048, rx: 768, ry: 256, template, skip, planes: [arithmeticVector] });
    const data = concat(segment(0, 16, 0, dictionary), segment(1, 48, 1, pageInfo(40, 25)), segment(2, 22, 1, grid, { refs: [0] }), segment(3, 49, 1));
    await compareBitmap(data, 40, 25);
  });
  it('requires arithmetic termination before decoding gray planes', async () => withDecoder(decode => {
    const make = encoded => concat(segment(0, 16, 0, patternTwo()), segment(1, 48, 1, pageInfo(16, 8)), segment(2, 22, 1, halftone({ template: 0, planes: [encoded] }), { refs: [0] }), segment(3, 49, 1));
    expect(() => decode(make(arithmeticVector.subarray(0, -1)))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(make([]))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  }));
  it('bounds the native gray-plane count independently of its caller', async () => {
    const reader = await NativePdfReader.create(simplePdf(''), options);
    try { expect(() => decodeJbig2GrayPlanes(reader, arithmeticVector, { width: 1, height: 1, template: 0, planes: 17 })).toThrow(expect.objectContaining({ code: 'pdf_limit' })); } finally { reader.destroy(); }
  });
});

describe('original C++ MQ arithmetic decoder', () => {
  it('matches every authored source bit through the independent fixture MQ encoder', async () => {
    const input = arithmeticVector;
    const expected = Uint8Array.from(Buffer.from(original.singleContext.sourceHex, 'hex'));
    const reader = await NativePdfReader.create(simplePdf(''), options); reader.api.pn_pdf_mark();
    try {
      const source = reader.copy(input), output = reader.checked(reader.api.pn_pdf_alloc(32)), address = reader.api.pn_pdf_mq_bits(source, input.length, 256, 0, output, 32), result = new DataView(reader.api.memory.buffer);
      expect(result.getUint32(address, true)).toBe(0); expect(result.getUint32(address + 4, true)).toBe(32);
      expect(new Uint8Array(reader.api.memory.buffer, output, 32).slice()).toEqual(expected);
    } finally { reader.api.pn_pdf_rewind(); reader.destroy(); }
  });
  it.each(Array.from({ length: 8 }, (_, i) => ({ template: i >> 1, typical: !!(i & 1) })))('matches independent generic bitmap execution for template $template, prediction $typical', async ({ template, typical }) => {
    const width = 17, height = 11, generic = concat(u32(width), u32(height), u32(0), u32(0), [0, template << 1 | (typical ? 8 : 0)], Uint8Array.from(defaultAdaptive[template]), arithmeticVector);
    const encoded = basic(generic, pageInfo(width, height));
    await compareBitmap(encoded, width, height);
  });
  it('checks adaptive coordinates and arithmetic termination without silent pixel recovery', async () => withDecoder(decode => {
    const make = (coordinates, payload) => basic(concat(u32(8), u32(2), u32(0), u32(0), [0, 6], coordinates, payload));
    expect(() => decode(make([0, 0], arithmeticVector))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(() => decode(make([2, 255], arithmeticVector.subarray(0, -1)))).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
    expect(decode(make([128, 128], arithmeticVector)).bytes.length).toBe(2);
  }));
  it.each([0, 1, 2, 3])('matches non-default adaptive locations with prediction for template %i', async template => {
    const adaptive = [[1, -1, -1, -1, 0, -2, 0, -2], [-1, 0], [-2, -2], [-5, 0]][template];
    const generic = concat(u32(17), u32(11), u32(0), u32(0), [0, template << 1 | 8], Uint8Array.from(adaptive), arithmeticVector);
    await compareBitmap(basic(generic, pageInfo(17, 11)), 17, 11);
  });
});

const refinement = ({ width = 17, height = 11, operator = 0, template = 0, typical = false } = {}) => concat(u32(width), u32(height), u32(0), u32(0), [operator, template | (typical ? 2 : 0)], template ? [] : [255, 255, 255, 255], arithmeticVector);
const arithmeticRegion = (width = 17, height = 11) => concat(u32(width), u32(height), u32(0), u32(0), [0, 6], [2, 255], arithmeticVector);
describe('original C++ JBIG2 refinement and auxiliary buffers', () => {
  it.each(Array.from({ length: 8 }, (_, i) => ({ template: i >> 2, typical: !!(i & 2), auxiliary: !!(i & 1) })))('matches independent refinement for template $template, prediction $typical, auxiliary $auxiliary', async ({ template, typical, auxiliary }) => {
    const info = segment(1, 48, 1, pageInfo(17, 11, 2 | (auxiliary ? 32 : 0))), initial = segment(2, auxiliary ? 36 : 38, 1, arithmeticRegion());
    const refined = segment(3, 42, 1, refinement({ template, typical, operator: auxiliary ? 0 : 4 }), { refs: auxiliary ? [2] : [] });
    await compareBitmap(concat(info, initial, refined, segment(4, 49, 1)), 17, 11);
  });
  it('transfers auxiliary ownership through intermediate refinements before final drawing', async () => {
    const data = concat(segment(1, 48, 1, pageInfo(17, 11, 34)), segment(2, 36, 1, arithmeticRegion()), segment(3, 40, 1, refinement(), { refs: [2] }), segment(4, 43, 1, refinement({ template: 1, typical: true }), { refs: [3] }), segment(5, 49, 1));
    await compareBitmap(data, 17, 11);
  });
  it('rejects unconsumed, mismatched, reused and page-forbidden refinement buffers', async () => withDecoder(decode => {
    const info = segment(1, 48, 1, pageInfo(17, 11, 34)), initial = segment(2, 36, 1, arithmeticRegion());
    expect(() => decode(concat(info, initial, segment(3, 49, 1)))).toThrow(/unconsumed/);
    expect(() => decode(concat(info, initial, segment(3, 42, 1, refinement({ width: 16 }), { refs: [2] })))).toThrow(/geometry/);
    expect(() => decode(concat(info, initial, segment(3, 42, 1, refinement(), { refs: [2] }), segment(4, 42, 1, refinement(), { refs: [2] })))).toThrow(/unavailable/);
    expect(() => decode(concat(segment(1, 48, 1, pageInfo(17, 11)), segment(2, 42, 1, refinement({ operator: 4 }))))).toThrow(/forbidden/);
    expect(() => decode(concat(info, segment(2, 40, 1, refinement())))).toThrow(/reference count/);
    expect(() => decode(concat(info, segment(2, 42, 1, refinement())))).toThrow(/REPLACE/);
  }));
});
