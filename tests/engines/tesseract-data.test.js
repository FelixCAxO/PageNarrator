import { expect, it } from 'vitest';
import { decodeTesseractEnglishNetwork, decodeTesseractEnglishRecoder, tesseractDataComponents } from '../../src/engines/tesseract-data.js';

it('reads required archive components in order and refuses overlapping, missing and out-of-bounds offsets', () => {
  const data = new Uint8Array(236), view = new DataView(data.buffer);
  view.setInt32(0, 24, true);
  for (let index = 0; index < 24; index++) view.setBigInt64(4 + index * 8, -1n, true);
  [17, 21, 22, 23].forEach((index, i) => view.setBigInt64(4 + index * 8, BigInt(196 + i * 10), true));
  expect([...tesseractDataComponents(data)].map(([key, bytes]) => [key, bytes.length])).toEqual([[17, 10], [21, 10], [22, 10], [23, 10]]);
  view.setBigInt64(4 + 21 * 8, 196n, true); expect(() => tesseractDataComponents(data)).toThrow(/overlap|unordered/);
  view.setBigInt64(4 + 21 * 8, 999n, true); expect(() => tesseractDataComponents(data)).toThrow(/offset/);
  view.setBigInt64(4 + 21 * 8, -1n, true); expect(() => tesseractDataComponents(data)).toThrow(/lacks/);
});

function characterFixture() {
  const characters = ['NULL', 'Joined', '|Broken|0|1', ...Array.from({ length: 109 }, (_, i) => String.fromCodePoint(0x100 + i))];
  const text = new TextEncoder().encode(`112\n${characters.map(value => `${value} 0 Common 0\n`).join('')}`);
  const data = new Uint8Array(4 + 112 * 9), view = new DataView(data.buffer); view.setInt32(0, 112, true);
  for (let index = 0; index < 112; index++) {
    data[4 + index * 9] = 1; view.setInt32(5 + index * 9, 1, true);
    view.setInt32(9 + index * 9, index === 1 || index === 2 ? 110 : index ? index - 2 : 0, true);
  }
  return { text, data, view, characters };
}
it('maps the English recoder class identities including space and a shared CTC null', () => {
  const { text, data, characters } = characterFixture(), result = decodeTesseractEnglishRecoder(text, data);
  expect(result.length).toBe(111); expect(result[0]).toBe(' '); expect(result[110]).toBe(''); expect(result[1]).toBe(characters[3]);
});
it('refuses altered recoder identities, multi-code characters and trailing data', () => {
  const { text, data, view } = characterFixture();
  view.setInt32(5 + 3 * 9, 2, true); expect(() => decodeTesseractEnglishRecoder(text, data)).toThrow(/multi-code/);
  view.setInt32(5 + 3 * 9, 1, true); view.setInt32(9 + 3 * 9, 0, true); expect(() => decodeTesseractEnglishRecoder(text, data)).toThrow(/overlap/);
  const fresh = characterFixture(); expect(() => decodeTesseractEnglishRecoder(fresh.text, new Uint8Array([...fresh.data, 0]))).toThrow(/trailing/);
});
it('rejects truncated and unsupported serialized networks without allocating declared unbounded weights', () => {
  expect(() => decodeTesseractEnglishNetwork(Uint8Array.of(0))).toThrow(/Truncated/);
  const oversized = new Uint8Array(5); new DataView(oversized.buffer).setInt32(1, 0x7fffffff, true);
  expect(() => decodeTesseractEnglishNetwork(oversized)).toThrow(/bound/);
});
