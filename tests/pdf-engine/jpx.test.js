import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fixtures from '../fixtures/jpx-lossless.json';
import lossyFixtures from '../fixtures/jpx-irreversible.json';
import channelFixtures from '../fixtures/jpx-channel-mapping.json';
import styleFixtures from '../fixtures/jpx-coding-styles.json';
import precisionFixtures from '../fixtures/jpx-precision.json';
import tilePartFixtures from '../fixtures/jpx-tile-parts.json';
import originFixtures from '../fixtures/jpx-origins.json';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodeJpx, parseJpxContainer } from '../../src/pdf/jpx.js';
import { PacketBits, TagTree, codingPassCount } from '../../src/pdf/jpx-bitstream.js';
import { simplePdf, options } from './fixtures.js';

for (const item of [...fixtures.cases, ...channelFixtures.cases, ...styleFixtures.cases, ...precisionFixtures.cases, ...tilePartFixtures.cases, ...originFixtures.cases]) it(`decodes independent JPEG2000 ${item.id} pixels exactly`, async () => {
  const reader = await NativePdfReader.create(simplePdf(''), options), encoded = new Uint8Array(Buffer.from(item.encoded, 'base64'));
  expect(createHash('sha256').update(encoded).digest('hex')).toBe(item.encodedSha256);
  try {
    const result = decodeJpx(reader, encoded);
    expect(result).toMatchObject({ width: item.width, height: item.height, components: item.components, bits: item.bits, format: 'raw' });
    expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(item.expectedSha256);
    expect(result.bytes).toEqual(new Uint8Array(Buffer.from(item.expected, 'base64')));
    if (item.sourcePrecision) expect(result.sourcePrecision).toEqual(item.sourcePrecision);
    if (item.sourceSigned) expect(result.sourceSigned).toEqual(item.sourceSigned);
  } finally { reader.destroy(); }
});

for (const item of lossyFixtures.cases) it(`matches independent irreversible JPEG2000 ${item.id} reconstruction`, async () => {
  const reader = await NativePdfReader.create(simplePdf(''), options), encoded = new Uint8Array(Buffer.from(item.encoded, 'base64'));
  expect(createHash('sha256').update(encoded).digest('hex')).toBe(item.encodedSha256);
  const expected = new Uint8Array(Buffer.from(item.expected, 'base64'));
  expect(createHash('sha256').update(expected).digest('hex')).toBe(item.expectedSha256);
  try {
    const result = decodeJpx(reader, encoded);
    expect(result).toMatchObject({ width: item.width, height: item.height, components: item.components, bits: item.bits, format: 'raw' });
    expect(result.bytes.length).toBe(expected.length);
    let error = 0;
    for (let at = 0; at < expected.length; at += item.bits / 8) {
      const sample = bytes => item.bits === 16 ? bytes[at] * 256 + bytes[at + 1] : bytes[at];
      error = Math.max(error, Math.abs(sample(result.bytes) - sample(expected)));
    }
    expect(error).toBeLessThanOrEqual(item.maxSampleError);
  } finally { reader.destroy(); }
});

it('bounds malformed boxes and packet headers before reading out of range', () => {
  expect(() => parseJpxContainer(Uint8Array.of(0))).toThrow(/input/);
  expect(() => parseJpxContainer(Uint8Array.of(0, 0, 0, 32, 106, 112, 50, 104))).toThrow(/container/);
  expect(() => new PacketBits(Uint8Array.of(255, 128), 0, 2).read(9)).toThrow(/stuffing/);
  expect(() => new TagTree(0, 1)).toThrow(/dimensions/);
  const tree = new TagTree(1, 1), bits = new PacketBits(Uint8Array.of(0b00100000), 0, 1);
  expect(tree.decode(0, 1, bits)).toBe(false); expect(tree.decode(0, 2, bits)).toBe(false); expect(tree.decode(0, 3, bits)).toBe(true);
  expect(tree.decode(0, 4, bits)).toBe(true);
});

it('reads all JPEG2000 coding-pass prefix lengths', () => {
  const bits = text => new PacketBits(Uint8Array.from({ length: Math.ceil(text.length / 8) }, (_, i) => parseInt(text.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2)), 0, Math.ceil(text.length / 8));
  for (const [encoded, expected] of [['0', 1], ['10', 2], ['1100', 3], ['1101', 4], ['1110', 5], ['111100000', 6], ['111100001', 7]]) {
    expect(codingPassCount(bits(encoded))).toBe(expected);
  }
});
