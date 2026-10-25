// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { normalizeEnglishText } from '../../src/tts/kokoro/normalizer.js';

const cases = [
  ['negative fraction', 'The offset is -0.375.', 'the offset is minus zero point three seven five'],
  ['Unicode minus', 'Set the offset to −0.062.', 'set the offset to minus zero point zero six two'],
  ['leading zeros', 'The change is -000.4.', 'the change is minus zero point four'],
  ['signed decimal zero', 'The signed value is -0.00.', 'the signed value is minus zero point zero zero'],
  ['positive fraction', 'The offset is 0.375.', 'the offset is zero point three seven five'],
  ['negative whole part', 'The offset is -2.375.', 'the offset is minus two point three seven five'],
  ['integer zero', 'The integer is -0.', 'the integer is zero'],
  ['signed interval', 'Use -0.375–0.062.', 'use minus zero point three seven five to zero point zero six two'],
];

for (const dialect of ['en-us', 'en-gb', 'en']) {
  it.each(cases)(`preserves decimal signs in ${dialect}: %s`, (_name, input, spoken) => {
    expect(normalizeEnglishText(input, dialect)).toEqual([{ words: spoken.split(' '), punctuation: '.' }]);
  });
}

const currencyCases = [
  [
    'minus before dollars',
    '-$0.50',
    'minus zero dollars and fifty cents'
  ],
  [
    'minus after dollars',
    '$-0.50',
    'minus zero dollars and fifty cents'
  ],
  [
    'Unicode minus before pounds',
    '−£1.01',
    'minus one pound and one penny'
  ],
  [
    'minus after singular pounds',
    '£-1.02',
    'minus one pound and two pence'
  ],
  [
    'minus before euros',
    '-€2.10',
    'minus two euros and ten cents'
  ],
  [
    'minus after euros',
    '€-0.01',
    'minus zero euros and one cent'
  ],
  [
    'signed monetary zero',
    '-$000.00',
    'minus zero dollars'
  ],
  [
    'negative whole dollars',
    '$-12',
    'minus twelve dollars'
  ],
  [
    'positive singular dollar',
    '$1.01',
    'one dollar and one cent'
  ],
  [
    'positive plural pence',
    '£0.02',
    'zero pounds and two pence'
  ],
  [
    'positive one-digit cents',
    '€2.1',
    'two euros and ten cents'
  ],
  [
    'signed grouped amount',
    '-$1,000.50',
    'minus one thousand dollars and fifty cents'
  ]
];

for (const dialect of ['en-us', 'en-gb', 'en']) {
  it.each(currencyCases)(`preserves currency signs and units in ${dialect}: %s`, (_name, amount, spoken) => {
    expect(normalizeEnglishText(`The balance is ${amount}.`, dialect)).toEqual([{
      words: `the balance is ${spoken}`.split(' '), punctuation: '.',
    }]);
  });
}
