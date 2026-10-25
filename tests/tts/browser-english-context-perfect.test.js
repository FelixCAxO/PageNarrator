// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contextualEnglishPhones } from '../../src/tts/kokoro/english-context.js';
import { normalizeEnglishText } from '../../src/tts/kokoro/normalizer.js';

describe.each(['en-us', 'en-gb', 'en'])('perfect read context in %s', dialect => {
  it.each(['will', 'could', 'should', 'must', 'may', 'would'])('keeps the participle after %s have', modal => {
    const words = normalizeEnglishText(`The visitor ${modal} have read the notice.`, dialect)[0].words;
    expect(contextualEnglishPhones(words, words.indexOf('read'), dialect)).toBe('ɹˈɛd');
  });

  it.each([
    ['The visitor will read the notice.', 'ɹˈiːd'],
    ['The visitor did not read the notice yesterday.', 'ɹˈiːd'],
    ['The visitor will have to read the notice.', 'ɹˈiːd'],
    ['The visitor can read the notice.', 'ɹˈiːd'],
    ['The visitor will have time to read the notice.', 'ɹˈiːd'],
    ['Having read the notice, the visitor waited.', 'ɹˈɛd'],
    ['The visitor has read the notice.', 'ɹˈɛd'],
  ])('preserves the existing cue for %s', (source, expected) => {
    const words = normalizeEnglishText(source, dialect)[0].words;
    expect(contextualEnglishPhones(words, words.indexOf('read'), dialect)).toBe(expected);
  });
});

describe.each(['en-us', 'en-gb', 'en'])('bounded perfect adverbs in %s', dialect => {
  it.each([
    ["They have not read the notice.", "ɹˈɛd"],
    ["They have never read the notice.", "ɹˈɛd"],
    ["If they have ever read the notice, they know.", "ɹˈɛd"],
    ["They have already read the notice.", "ɹˈɛd"],
    ["They have just read the notice.", "ɹˈɛd"],
    ["They have only read the notice.", "ɹˈɛd"],
    ["They have also read the notice.", "ɹˈɛd"],
    ["They have even read the notice.", "ɹˈɛd"],
    ["They have not yet read the notice.", "ɹˈɛd"],
    ["They have recently read the notice.", "ɹˈɛd"],
    ["They have previously read the notice.", "ɹˈɛd"],
    ["They have carefully read the notice.", "ɹˈɛd"],
    ["They have thoroughly read the notice.", "ɹˈɛd"],
    ["They have fully read the notice.", "ɹˈɛd"],
    ["They have quickly read the notice.", "ɹˈɛd"],
    ["They could have already read the notice.", "ɹˈɛd"],
    ["They should have only just read the notice.", "ɹˈɛd"],
    ["They had not yet read the notice.", "ɹˈɛd"],
    ["Having carefully read the notice, they waited.", "ɹˈɛd"],
    ["They haven't ever read the notice.", "ɹˈɛd"],
    ["They have not ever fully read the notice.", "ɹˈɛd"],
  ])('keeps the participle in %s', (source, expected) => {
    const words = normalizeEnglishText(source, dialect)[0].words;
    expect(contextualEnglishPhones(words, words.indexOf('read'), dialect)).toBe(expected);
  });

  it.each([
    ["They could already read the notice.", "ɹˈiːd"],
    ["They will just read the notice.", "ɹˈiːd"],
    ["They did not read the notice yesterday.", "ɹˈiːd"],
    ["They have time to read the notice.", "ɹˈiːd"],
    ["They will have someone read the notice.", "ɹˈiːd"],
    ["They have family read the notice.", ""],
    ["They have friends who read the notice.", ""],
    ["They have a plan and read the notice.", ""],
    ["They have just paused and read daily.", ""],
    ["They have also only ever carefully read the notice.", ""],
    ["Have they just read the notice?", ""],
    ["They have silently read the notice.", ""],
  ])('does not cross a base cue or unsupported phrase in %s', (source, expected) => {
    const words = normalizeEnglishText(source, dialect)[0].words;
    expect(contextualEnglishPhones(words, words.indexOf('read'), dialect)).toBe(expected);
  });

  it.each([",", ";", ":", ".", "!", "?", "—", "…"])('does not cross the %s clause boundary', punctuation => {
    const clauses = normalizeEnglishText(`Keep what they have${punctuation} just read the notice.`, dialect);
    expect(clauses).toHaveLength(2);
    const words = clauses[1].words;
    expect(words).toEqual(['just', 'read', 'the', 'notice']);
    expect(contextualEnglishPhones(words, 1, dialect)).toBe('');
  });

  it('preserves clause words and their order during context lookup', () => {
    const clauses = normalizeEnglishText('They have just read the note; they will read it.', dialect);
    const snapshot = structuredClone(clauses);
    for (const clause of clauses) { Object.freeze(clause.words); Object.freeze(clause); }
    Object.freeze(clauses);
    expect(clauses.map(clause => clause.words.map((_, index) => contextualEnglishPhones(clause.words, index, dialect))))
      .toEqual([["", "", "", "ɹˈɛd", "", ""], ["", "", "ɹˈiːd", ""]]);
    expect(clauses).toEqual(snapshot);
  });

  it('leaves other homograph cues and dialect vowels unchanged', () => {
    const clauses = normalizeEnglishText('Please record the record; it is close to us.', dialect);
    const uk = dialect !== 'en-us';
    expect(contextualEnglishPhones(clauses[0].words, 1, dialect)).toBe(uk ? 'ɹɪkˈɔːd' : 'ɹɪkˈɔːɹd');
    expect(contextualEnglishPhones(clauses[0].words, 3, dialect)).toBe(uk ? 'ɹˈɛkɔːd' : 'ɹˈɛkɚd');
    expect(contextualEnglishPhones(clauses[1].words, 2, dialect)).toBe(uk ? 'klˈəʊs' : 'klˈoʊs');
  });
});

describe.each(['en-us', 'en-gb', 'en'])('conservative interposed perfect cue in %s', dialect => {
  it.each([
    ["These accounts have only read access to the repository, not write access.", ""],
    ["These accounts have only read and write permissions.", ""],
    ["Those terminals have just read access to the archive.", ""],
    ["Those accounts have also read permissions.", ""],
    ["The guest has even read access.", ""],
    ["They had only read access before the change.", ""],
    ["They have not only read access.", ""],
    ["They have also only read and write permissions.", ""],
    ["They have only read source code.", ""],
    ["They have already read access logs.", "ɹˈɛd"],
    ["They have recently read permission requests.", "ɹˈɛd"],
    ["They have only just read.", "ɹˈɛd"],
    ["They have just read it.", "ɹˈɛd"],
    ["They have only read those notes.", "ɹˈɛd"],
  ])('preserves the bounded decision for %s', (source, expected) => {
    const words = normalizeEnglishText(source, dialect)[0].words;
    expect(contextualEnglishPhones(words, words.indexOf('read'), dialect)).toBe(expected);
  });
});
