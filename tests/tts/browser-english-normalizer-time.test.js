// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { normalizeEnglishText } from '../../src/tts/kokoro/normalizer.js';

for (const dialect of ['en-us', 'en-gb', 'en']) {
  it.each([
    ['2 p.m.', 'two pee em'],
    ['2PM.', 'two pee em'],
    ['9:05 a.m.', 'nine oh five ay em'],
    ['09:15 A.M.', 'nine fifteen ay em'],
    ['12:00 PM.', "twelve o'clock pee em"],
  ])(`reads clock meridiems without an internal sentence break in ${dialect}: %s`, (clock, spoken) => {
    expect(normalizeEnglishText(`The appointment is at ${clock}`, dialect)).toEqual([
      { words: `the appointment is at ${spoken}`.split(' '), punctuation: '.' },
    ]);
  });

  it(`preserves ordinary am and unrelated word endings in ${dialect}`, () => {
    expect(normalizeEnglishText('I am ready. The 2PMI label is unchanged.', dialect)).toEqual([
      { words: ['i', 'am', 'ready'], punctuation: '.' },
      { words: ['the', 'two', 'pmi', 'label', 'is', 'unchanged'], punctuation: '.' },
    ]);
  });
}
