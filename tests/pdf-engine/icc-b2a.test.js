import { describe, expect, it } from 'vitest';
import { parseIccProfile, labToXyz } from '../../src/pdf/icc-color.js';
import { syntheticCmykB2aProfile, syntheticB2aExpected } from './icc-b2a-fixture.js';
import { loadAsset } from './fixtures.js';
const near = (actual, expected) => { expect(actual).toHaveLength(expected.length); actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 6)); };
const tagRow = (bytes, name) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i < view.getUint32(128); i++) { const row = 132 + i * 12; if (String.fromCharCode(...bytes.subarray(row, row + 4)) === name) return { row, at: view.getUint32(row + 4), size: view.getUint32(row + 8), view }; }
};
const editInverse = (change, options = { sixteen: true }) => {
  const bytes = syntheticCmykB2aProfile(options), tag = tagRow(bytes, 'B2A0'); change(bytes, tag); return bytes;
};
const expectCorrupt = bytes => { expect(() => parseIccProfile(bytes)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' })); };
describe('explicit CMYK Lab B2A0 inverse', () => {
  it.each([{ version: 2, sixteen: false }, { version: 4, sixteen: false }, { version: 2, sixteen: true }, { version: 4, sixteen: true }])('uses all four affine output channels and tag-specific Lab encoding: %j', options => {
    const profile = parseIccProfile(syntheticCmykB2aProfile(options)); expect(profile.fromXyz).toBeTypeOf('function');
    for (const lab of [[0, -128, -128], [100, 127, 127], [50, 0, 0], [25, -64, 32], [75, 64, -32]]) near(profile.fromXyz(labToXyz(lab)), syntheticB2aExpected(lab, options.sixteen));
  });
  it('leaves forward-only CGATS and missing/unsupported B2A formats without an invented inverse', async () => {
    const cgats = parseIccProfile(await loadAsset('iccs/CGATS001Compat-v2-micro.icc')); expect(cgats.fromXyz).toBeUndefined(); expect(cgats.toXyz([0, 0, 0, 0]).every(Number.isFinite)).toBe(true);
    for (const options of [{ inverse: false }, { inverseType: 'mBA ' }]) { const profile = parseIccProfile(syntheticCmykB2aProfile(options)); expect(profile.fromXyz).toBeUndefined(); expect(profile.toXyz([0, 0, 0, 0]).every(Number.isFinite)).toBe(true); }
  });
  it('preserves the existing forward lookup with or without a B2A tag', () => {
    for (const version of [2, 4]) {
      const forward = parseIccProfile(syntheticCmykB2aProfile({ version, inverse: false }));
      const both = parseIccProfile(syntheticCmykB2aProfile({ version, sixteen: true }));
      for (const inks of [[0, 0, 0, 0], [.2, .4, .7, .9], [1, 1, 1, 1]]) expect(both.toXyz(inks)).toEqual(forward.toXyz(inks));
    }
  });
  it('executes input tables before the CLUT and output tables afterward', () => {
    const bytes = editInverse((bytes, { at }) => {
      // Reverse L before the affine CLUT; reverse only its magenta result after it.
      for (let i = 0; i < 256; i++) bytes[at + 48 + i] = 255 - i;
      const outputs = at + 48 + 3 * 256 + 8 * 4;
      for (let i = 0; i < 256; i++) bytes[outputs + 256 + i] = 255 - i;
    }, { sixteen: false });
    const actual = parseIccProfile(bytes).fromXyz(labToXyz([25, -64, 32]));
    const expected = syntheticB2aExpected([75, -64, 32]); expected[1] = 1 - expected[1]; near(actual, expected);
  });
  it('clamps outside encoded Lab range at the LUT input without clipping XYZ first', () => {
    const profile = parseIccProfile(syntheticCmykB2aProfile());
    for (const lab of [[-10, -200, -200], [120, 200, 200], [50, -200, 200]]) near(profile.fromXyz(labToXyz(lab)), syntheticB2aExpected(lab));
    near(profile.fromXyz(new Float64Array(labToXyz([50, 0, 0]))), syntheticB2aExpected([50, 0, 0]));
  });
  it.each([null, [], [0, 0], [0, 0, 0, 0], [0, 0, NaN], [0, Infinity, 0], ['0', 0, 0], [-Number.MAX_VALUE, -Number.MAX_VALUE, 0]])('rejects invalid inverse input %j', values => {
    const profile = parseIccProfile(syntheticCmykB2aProfile()); expect(() => profile.fromXyz(values)).toThrow(expect.objectContaining({ code: 'pdf_corrupt' }));
  });
  it('does not use a nonidentity XYZ-only matrix on a Lab PCS inverse', () => {
    for (const matrix of [[1, .25, 0, 0, 1, 0, 0, 0, 1], [2, 0, 0, 0, 1, 0, 0, 0, 1]]) {
      const profile = parseIccProfile(syntheticCmykB2aProfile({ matrix }));
      expect(profile.fromXyz).toBeUndefined(); expect(profile.toXyz([0, 0, 0, 0]).every(Number.isFinite)).toBe(true);
    }
  });
  it.each([[8, 2], [9, 3], [10, 0], [10, 1], [10, 34], [10, 255]])('rejects malformed or excessive inverse dimensions at byte %i=%i', (offset, value) => {
    expectCorrupt(editInverse((bytes, { at }) => { bytes[at + offset] = value; }));
  });
  it.each([[48, 0], [48, 1], [48, 4097], [48, 65535], [50, 0], [50, 1], [50, 4097], [50, 65535]])('bounds LUT16 table count at byte %i=%i', (offset, value) => {
    expectCorrupt(editInverse((bytes, { at, view }) => view.setUint16(at + offset, value)));
  });
  it.each([8, 47, 48, 51, 52, 64])('checks tag-local bounds before reading truncated inverse data size %i', size => {
    expectCorrupt(editInverse((bytes, { row, view }) => view.setUint32(row + 8, size)));
  });
  it('does not read the final output entry from bytes outside the declared tag', () => {
    expectCorrupt(editInverse((bytes, { row, size, view }) => view.setUint32(row + 8, size - 1)));
  });
  it('accepts the maximum declared 4096-entry LUT16 tables', () => {
    const original = syntheticCmykB2aProfile({ sixteen: true }), { row, at, view } = tagRow(original, 'B2A0');
    const count = 4096, size = 52 + 7 * count * 2 + 8 * 4 * 2, bytes = new Uint8Array(at + size), revised = new DataView(bytes.buffer);
    bytes.set(original.subarray(0, at + 52)); revised.setUint32(0, bytes.length); revised.setUint32(row + 8, size); revised.setUint16(at + 48, count); revised.setUint16(at + 50, count);
    for (let c = 0; c < 3; c++) for (let i = 0; i < count; i++) revised.setUint16(at + 52 + (c * count + i) * 2, Math.round(i / (count - 1) * 65535));
    const clut = at + 52 + 3 * count * 2; bytes.set(original.subarray(at + 64, at + 64 + 64), clut);
    const outputs = clut + 64;
    for (let c = 0; c < 4; c++) for (let i = 0; i < count; i++) revised.setUint16(outputs + (c * count + i) * 2, Math.round(i / (count - 1) * 65535));
    expect(view.getUint16(at + 48)).toBe(2);
    const actual = parseIccProfile(bytes).fromXyz(labToXyz([50, 0, 0])), expected = syntheticB2aExpected([50, 0, 0], true);
    actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThan(1 / 65535));
  });
  it('honors a typed view offset without reading neighbouring bytes', () => {
    const original = syntheticCmykB2aProfile({ sixteen: true }), envelope = new Uint8Array(original.length + 16).fill(0xa5); envelope.set(original, 8);
    const profile = parseIccProfile(envelope.subarray(8, -8)); near(profile.fromXyz(labToXyz([50, 0, 0])), syntheticB2aExpected([50, 0, 0], true));
    expect([...envelope.subarray(0, 8), ...envelope.subarray(-8)]).toEqual(Array(16).fill(0xa5));
  });
});
