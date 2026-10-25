import { describe, expect, it } from 'vitest';
import { parsePdfCalculator, compilePdfCalculator, PDF_CALCULATOR_LIMITS } from '../../src/pdf/calculator-function.js';
import { readPdfFunction, compilePdfFunction } from '../../src/pdf/pdf-functions.js';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../../src/pdf/document-core.js';
import { simplePdf, stream, options } from './fixtures.js';

const calculate = (body, outputs = 1, source = []) => {
  const result = new Array(outputs);
  compilePdfCalculator(`{${body}}`, source.flatMap(() => [-100, 100]), outputs)(source, result); return result;
};
const truth = body => calculate(`${body} {1} {0} ifelse`)[0];
async function descriptor(program, dictionary = '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1 0 1]') {
  const reader = await NativePdfReader.create(simplePdf('', { extra: [stream(program, dictionary)] }), options);
  try { return await readPdfFunction(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0))); } finally { reader.destroy(); }
}

describe('bounded PDF calculator syntax and typed arithmetic (ISO 32000-1 7.10.5/Annex B)', () => {
  it.each([
    ['3 4 add', 7], ['3 4 sub', -1], ['3.5 -2 mul', -7], ['4 2 div', 2], ['-5 2 idiv', -2], ['-5 2 mod', -1],
    ['-4 abs', 4], ['3 neg', -3], ['-4.8 ceiling', -4], ['-4.8 floor', -5], ['-6.5 round', -6], ['6.5 round', 7], ['-4.8 truncate', -4],
    ['9 sqrt', 3], ['90 sin', 1], ['180 cos', -1], ['-1 0 atan', 270], ['9 .5 exp', 3], ['1 ln', 0], ['100 log', 2],
    ['4.8 cvi not', -5], ['4 cvr .5 add', 4.5], ['6 3 and', 2], ['6 3 or', 7], ['6 3 xor', 5], ['0 not', -1],
    ['7 3 bitshift', 56], ['142 -3 bitshift', 17], ['-1 -1 bitshift', 2147483647], ['-1 0 bitshift', -1], ['1 32 bitshift', 0], ['1 -32 bitshift', 0],
  ])('evaluates the normative numeric operation %s', (body, expected) => { expect(calculate(body)[0]).toBeCloseTo(expected, 12); });

  it.each([
    ['true false and', 0], ['true false or', 1], ['true true xor', 0], ['false not', 1],
    ['1 1.0 eq', 1], ['true 1 eq', 0], ['true 1 ne', 1], ['2 1 gt', 1], ['2 2 ge', 1], ['1 2 lt', 1], ['2 2 le', 1],
  ])('distinguishes numeric and boolean operands in %s', (body, expected) => { expect(truth(body)).toBe(expected); });

  it.each([
    ['2 3 pop', [2]], ['3 dup', [3, 3]], ['1 2 exch', [2, 1]], ['1 2 2 copy', [1, 2, 1, 2]],
    ['1 2 1 index', [1, 2, 1]], ['1 2 3 3 1 roll', [3, 1, 2]], ['1 2 3 3 -1 roll', [2, 3, 1]],
    ['1 2 3 3 -7 roll', [2, 3, 1]], ['1 0 copy', [1]], ['1 0 999 roll', [1]],
  ])('implements bounded stack rearrangement %s', (body, expected) => { expect(calculate(body, expected.length)).toEqual(expected); });

  it('treats branches purely as syntax and executes only the selected branch', () => {
    expect(calculate('true {7} if')).toEqual([7]); expect(calculate('false {1 0 div} if 9')).toEqual([9]);
    expect(calculate('false {1 0 div} {true {3} {4} ifelse} ifelse')).toEqual([3]);
    expect(calculate('% arbitrary comment\r\n +.5\t.5 add % trailing\n')).toEqual([1]);
    expect(() => parsePdfCalculator('{true {1} dup if}')).toThrow(/expression requires/);
    expect(() => parsePdfCalculator('{{1}}')).toThrow(/expression requires/);
  });

  it('preserves real versus integer types after conversion, rounding and overflow', () => {
    expect(calculate('2147483647 1 add 2147483648 eq {1} {0} ifelse')).toEqual([1]);
    expect(calculate('-2147483648 neg 2147483648 eq {1} {0} ifelse')).toEqual([1]);
    for (const body of ['4 2 div not', '1.0 not', '4 cvr not', '1.5 floor not', '2147483647 1 add not', '-2147483648 abs not']) expect(() => calculate(body)).toThrow(/integer operand/);
    for (const body of ['2147483648 cvi', '-2147483648 -1 idiv']) expect(() => calculate(body)).toThrow(/out of range/);
  });

  it.each(['1 0 div', '1 0 idiv', '1 0 mod', '-1 sqrt', '0 ln', '-1 log', '0 0 atan', '-1 .5 exp', '10 1000 exp',
    'true 1 add', 'true 1 and', '1.0 2 idiv', '1 true gt', '1 {2} if', 'pop', '0 index', '-1 copy', '1 2 roll', '1 -1 0 roll'])('rejects undefined, mistyped or invalid stack execution: %s', body => {
    const result = [1234]; const run = compilePdfCalculator(`{${body}}`, [], 1); expect(() => run([], result)).toThrow(); expect(result).toEqual([1234]);
  });

  it.each(['1 2 add', '{1} 2', '{1', '{} }', '{1e2}', '{16#FF}', '{/x}', '{(text)}', '{[1]}', '{<<>>}', '{exec}', '{globalThis}', '{true if}', '{true {1} ifelse}'])('rejects syntax outside the complete numeric language: %s', program => {
    expect(() => parsePdfCalculator(program)).toThrow();
  });

  it('enforces program/token/nesting/stack/evaluation work limits without host execution', () => {
    expect(() => parsePdfCalculator(`{%${'x'.repeat(PDF_CALCULATOR_LIMITS.bytes)}\n}`)).toThrow(/byte.*limit/);
    expect(() => parsePdfCalculator(`{${'0 '.repeat(PDF_CALCULATOR_LIMITS.tokens)}}`)).toThrow(/token.*limit/);
    expect(() => parsePdfCalculator(`{${'true {'.repeat(34)}0${'} if '.repeat(34)}}`)).toThrow(/depth.*limit/);
    expect(() => calculate('0 '.repeat(PDF_CALCULATOR_LIMITS.stack + 1))).toThrow(/stack.*limit/);
    const work = '0 '.repeat(128) + '128 copy 128 copy 128 copy 128 copy 128 copy';
    expect(() => calculate(work)).toThrow(/stack.*limit/);
    // Rolling charges moved elements, not only the short operator tokens; reserve two operands.
    const expensive = '0 '.repeat(254) + '254 1 roll '.repeat(400);
    expect(() => calculate(expensive)).toThrow(/step.*limit/);
  });
});

describe('calculator functions in the existing PDF function and colour paths', () => {
  it('replays both actual private-program shapes without retaining third-party inputs', async () => {
    for (const source of ['{0 0 0 4 -1 roll}\n', '{0 0 0 4 -1 roll }']) {
      const value = await descriptor(source), serialized = structuredClone(value), run = compilePdfFunction(serialized);
      for (const tint of [-1, 0, .25, .5, 1, 2]) expect(run([tint])).toEqual([0, 0, 0, Math.max(0, Math.min(1, tint))]);
      const output = new Float64Array(6).fill(1234); expect(run(new Float32Array([.5]), output)).toBe(output); expect([...output]).toEqual([0, 0, 0, .5, 1234, 1234]);
    }
  });

  it('clips Domain before execution and Range after execution, with exact numeric output count', async () => {
    const run = compilePdfFunction(await descriptor('{2 mul}', '/FunctionType 4 /Domain [-1 1] /Range [0 1]'));
    expect(run([-5])).toEqual([0]); expect(run([.25])).toEqual([.5]); expect(run([5])).toEqual([1]);
    for (const program of ['{pop}', '{1}', '{pop true}']) {
      const fn = compilePdfFunction(await descriptor(program, '/FunctionType 4 /Domain [0 1] /Range [0 1]'));
      const target = [1234]; expect(() => fn([.5], target)).toThrow(/output count/); expect(target).toEqual([1234]);
    }
    expect(compilePdfFunction(await descriptor('{}', '/FunctionType 4 /Domain [0 1] /Range [0 1]'))([.3])).toEqual([.3]);
  });

  it('requires a stream and Range and rejects forbidden program syntax while reading', async () => {
    await expect(descriptor('{}', '/FunctionType 4 /Domain [0 1]')).rejects.toMatchObject({ code: 'pdf_corrupt' });
    const reader = await NativePdfReader.create(simplePdf('', { extra: ['<< /FunctionType 4 /Domain [0 1] /Range [0 1] >>'] }), options);
    try { await expect(readPdfFunction(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0)))).rejects.toMatchObject({ code: 'pdf_corrupt' }); } finally { reader.destroy(); }
    await expect(descriptor('{systemdict}')).rejects.toMatchObject({ code: 'pdf_corrupt' });
  });

  it('uses the calculator tint through real Separation path and image payloads', async () => {
    const bytes = simplePdf('/Ink cs .5 scn 0 0 10 10 re f /I Do', { page: '/Resources << /ColorSpace << /Ink [/Separation /Black /DeviceRGB 6 0 R] >> /XObject << /I 7 0 R >> >>', extra: [
      stream('{dup dup}', '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]'),
      stream(Uint8Array.of(0, 255), '/Subtype /Image /Width 2 /Height 1 /ColorSpace [/Separation /Black /DeviceRGB 6 0 R] /BitsPerComponent 8'),
    ] });
    const core = await createPdfDocumentCore(bytes, options);
    try {
      const payload = await core.pagePayload(1); expect(payload.commands.find(c => c.op === 'color' && c.fill)?.value).toBe('rgb(255,255,255)');
      expect(payload.commands.filter(c => c.op === 'color' && c.fill).at(-1).value).toBe('rgb(128,128,128)');
      expect([...payload.commands.find(c => c.op === 'image').pixels]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    } finally { core.destroy(); }
  });
});
