import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { decodePdfStream } from '../../src/pdf/streams.js';
import { simplePdf, stream, options } from './fixtures.js';

afterEach(() => vi.unstubAllGlobals());

// Node's DecompressionStream accepts trailing bytes. Chromium rejects them.
// Exercise that boundary using a real checksum-validating zlib decoder.
function strictDecompression(onDecode = () => {}) {
  let calls = 0;
  vi.stubGlobal('DecompressionStream', class {
    constructor() {
      calls++;
      const chunks = [];
      return new TransformStream({
        transform(chunk) { chunks.push(chunk); },
        flush(controller) {
          const input = Buffer.concat(chunks), decoded = inflateSync(input, { info: true });
          onDecode();
          if (decoded.engine.bytesWritten !== input.length) throw new TypeError('Trailing compressed bytes');
          controller.enqueue(decoded.buffer);
        },
      });
    }
  });
  return () => calls;
}

async function decode(data, { signal, imageSamples } = {}) {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(data, '/Filter /FlateDecode')] }), { ...options, signal });
  try { return (await decodePdfStream(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)), { image: !!imageSamples, imageSamples })).bytes; }
  finally { reader.destroy(); }
}

describe('checksum-validated Flate end-of-line compatibility', () => {
  it.each([{ eol: [10] }, { eol: [13] }, { eol: [13, 10] }])('accepts one producer-added EOL $eol after a complete stream', async ({ eol }) => {
    const calls = strictDecompression(), text = Buffer.from('Complete compressed PDF content');
    const input = Buffer.concat([deflateSync(text), Buffer.from(eol)]), original = Buffer.from(input);
    expect(await decode(input)).toEqual(new Uint8Array(text));
    expect(calls()).toBe(eol.length + 1); expect(input).toEqual(original);
  });

  it('preserves a checksum ending in CR when the extra EOL is LF', async () => {
    const calls = strictDecompression(), text = Buffer.from([12]), compressed = deflateSync(text);
    expect(compressed.at(-1)).toBe(13);
    expect(await decode(Buffer.concat([compressed, Buffer.from([10])]))).toEqual(new Uint8Array(text));
    expect(calls()).toBe(2);
  });

  it.each([9, 12])('does not trim a complete checksum ending with byte %i plus one', async value => {
    const calls = strictDecompression(), text = Buffer.from([value]), compressed = deflateSync(text);
    expect(compressed.at(-1)).toBe(value + 1);
    expect(await decode(compressed)).toEqual(new Uint8Array(text)); expect(calls()).toBe(1);
  });

  it('rejects damaged, truncated, junk-suffixed and EOL-only nonempty streams', async () => {
    strictDecompression();
    const valid = deflateSync(Buffer.from('Required checksum')), damaged = valid.slice(); damaged[damaged.length - 1] ^= 1;
    const invalid = [damaged, valid.subarray(0, valid.length - 1), valid.subarray(0, 3)];
    for (const data of invalid) await expect(decode(Buffer.concat([data, Buffer.from([10])]))).rejects.toBeDefined();
    for (const suffix of [[0], [32], [10, 10], [13, 13], [32, 10]]) await expect(decode(Buffer.concat([valid, Buffer.from(suffix)]))).rejects.toBeDefined();
    for (const data of [[10], [13], [13, 10], [10, 10, 10, 10, 10, 10, 10, 10, 10]]) await expect(decode(Buffer.from(data))).rejects.toBeDefined();
  });

  it('does not retry an exceeded decoded-image budget even when the checksum ends in LF', async () => {
    const calls = strictDecompression(), compressed = deflateSync(Buffer.from([0, 9]));
    expect(compressed.at(-1)).toBe(10);
    await expect(decode(compressed, { imageSamples: { bytes: 1, rows: 1 } })).rejects.toMatchObject({ code: 'pdf_limit' });
    expect(calls()).toBe(1);
  });

  it('does not retry after cancellation of the first decode', async () => {
    const controller = new AbortController(), calls = strictDecompression(() => controller.abort());
    const compressed = Buffer.concat([deflateSync(Buffer.from('Cancelled content')), Buffer.from([10])]);
    await expect(decode(compressed, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(1);
  });
});
