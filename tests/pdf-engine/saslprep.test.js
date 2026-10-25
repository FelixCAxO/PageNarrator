import { describe, expect, it } from 'vitest';
import oracle from './fixtures/saslprep-python.json' with { type: 'json' };
import { normalizePdfUnicode32, preparePdfPassword } from '../../src/pdf/saslprep.js';

describe('original bounded Unicode3.2 PDF password preparation', () => {
  it('implements the RFC4013 mapping, case preservation, prohibited output and bidi examples', () => {
    expect(preparePdfPassword('I\u00adX')).toBe('IX'); expect(preparePdfPassword('\u2168')).toBe('IX');
    expect(preparePdfPassword('\u00aa')).toBe('a'); expect(preparePdfPassword('USER')).toBe('USER');
    expect(preparePdfPassword('x\u00a0\u1680\u200by')).toBe('x  y');
    expect(preparePdfPassword('\u0627\u0031\u0627')).toBe('\u0627\u0031\u0627');
    for (const value of ['\u0007', '\u0627\u0031', '\u0627x\u0627', '\ue000', '\ud800', '\u0221', '\u{1f600}']) expect(() => preparePdfPassword(value)).toThrow(expect.objectContaining({ name: 'PasswordException', code: 'pdf_password' }));
  });
  it('uses historical Unicode3.2 mappings and corrected canonical blocking instead of the current browser Unicode tables', () => {
    expect(normalizePdfUnicode32('\u{2f868}')).toBe('\u{2136a}');
    expect(normalizePdfUnicode32('\u212b\u0323')).toBe('\u1ea0\u030a');
    expect(normalizePdfUnicode32('\u1100\u1161\u11a8')).toBe('\uac01');
    expect(normalizePdfUnicode32('\u1100\u0300\u1161')).toBe('\u1100\u0300\u1161');
    expect(normalizePdfUnicode32('\u0b47\u0300\u0b3e')).toBe('\u0b47\u0300\u0b3e');
  });
  it('matches independently generated Python Unicode3.2/stringprep sequences without copying its implementation', () => {
    expect(oracle.unicodeVersion).toBe('3.2.0'); expect(oracle.samples).toHaveLength(1039);
    for (const sample of oracle.samples) {
      expect(normalizePdfUnicode32(sample.input)).toBe(sample.nfkc);
      if (sample.invalid) expect(() => preparePdfPassword(sample.input)).toThrow(expect.objectContaining({ code: 'pdf_password' }));
      else expect(preparePdfPassword(sample.input)).toBe(sample.prepared);
    }
  });
  it('bounds large input and decomposition expansion while accepting a long combining run without quadratic insertion', () => {
    expect(() => preparePdfPassword('x'.repeat(65537))).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
    expect(() => normalizePdfUnicode32('\ufdfa'.repeat(16384))).toThrow(expect.objectContaining({ code: 'pdf_limit' }));
    const long = `a${'\u0315\u0300'.repeat(8192)}`, normalized = normalizePdfUnicode32(long);
    expect(normalized.startsWith('\u00e0')).toBe(true); expect([...normalized]).toHaveLength(16384);
  });
});
