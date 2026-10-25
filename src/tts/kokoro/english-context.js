// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded cues for frequent English homographs; not a general POS parser.
const DETERMINER = /^(?:a|an|the|this|that|these|those|each|every|another|my|your|his|her|our|their)$/;
const VERB_CUE = /^(?:to|will|shall|can|could|may|might|must|should|would|please|do|does|did)$/;
const PERFECT_ADVERB = /^(?:not|never|ever|already|just|only|also|even|yet|recently|previously|carefully|thoroughly|fully|quickly)$/;
const PERFECT_FOCUS_OR_NEGATION = /^(?:not|only|just|also|even)$/;
const READ_OBJECT_PRONOUN = /^(?:it|them|me|us|you|him|hers|ours|theirs)$/;
const COPULA = /^(?:am|is|are|was|were|be|been|being|seem|seems|stay|stays|remain|remains|very|too|quite)$/;

/** @param {string[]} words @param {number} index @param {string} dialect @returns {string} */
export function contextualEnglishPhones(words, index, dialect) {
  const word = words[index], previous = words[index - 1] ?? '', before = words.slice(Math.max(0, index - 3), index), uk = dialect !== 'en-us';
  if (word === 'read') {
    const nearby = words.slice(Math.max(0, index - 6), index + 7);
    // A perfect auxiliary requires the participle, including after a modal.
    if (/^(?:had|has|have|having)$/.test(previous)) return 'ɹˈɛd';
    // Focus/negation alone before a bare complement can also follow lexical have.
    let auxiliary = index - 1, focusOnly = true;
    for (let count = 0; count < 3 && PERFECT_ADVERB.test(words[auxiliary] ?? ''); count++) {
      focusOnly &&= PERFECT_FOCUS_OR_NEGATION.test(words[auxiliary]);
      auxiliary--;
    }
    const next = words[index + 1] ?? '';
    if (/^(?:had|has|have|having)$/.test(words[auxiliary] ?? '')
      && (!focusOnly || !next || DETERMINER.test(next) || READ_OBJECT_PRONOUN.test(next))) return 'ɹˈɛd';
    // Auxiliaries select the infinitive even in a past-tense question/negative.
    if (before.some(value => VERB_CUE.test(value))) return 'ɹˈiːd';
    if (/^(?:had|has|have|having|already|yesterday)$/.test(previous)
      || nearby.some(value => /^(?:yesterday|previously)$/.test(value))
      || nearby.some((value, i) => value === 'last' && /^(?:night|week|month|year)$/.test(nearby[i + 1] ?? ''))) return 'ɹˈɛd';
    return '';
  }
  if (word === 'record') {
    if (DETERMINER.test(previous)) return uk ? 'ɹˈɛkɔːd' : 'ɹˈɛkɚd';
    if (before.some(value => VERB_CUE.test(value)) || index === 0 && DETERMINER.test(words[index + 1] ?? '')) return uk ? 'ɹɪkˈɔːd' : 'ɹɪkˈɔːɹd';
    return '';
  }
  if (word === 'close') {
    if (COPULA.test(previous) || words[index + 1] === 'to') return uk ? 'klˈəʊs' : 'klˈoʊs';
    if (before.some(value => VERB_CUE.test(value)) || index === 0 && DETERMINER.test(words[index + 1] ?? '')) return uk ? 'klˈəʊz' : 'klˈoʊz';
  }
  return '';
}
