import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRetestCorpus } from '../../scripts/prepare-language-retest.mjs';
import { getOmniVoiceLanguage } from '../../src/tts/omnivoice/languages.js';
import { summarizeLanguageSamples } from '../../scripts/report-language-retest.mjs';

const rollout = JSON.parse(readFileSync(new URL('../../config/language-rollout.json', import.meta.url), 'utf8'));

describe('requested language retest', () => {
  it('covers both requested lists and all four previously flagged languages', () => {
    expect(rollout.languages).toHaveLength(25);
    expect(new Set(rollout.languages.map(item => item.code)).size).toBe(25);
    for (const code of ['es', 'fr', 'nl', 'ja', 'sk', 'et', 'bg']) {
      expect(rollout.languages.some(item => item.code === code)).toBe(true);
    }
    for (const language of rollout.languages) expect(getOmniVoiceLanguage(language.code)).toBeTruthy();
    expect(rollout.languages.find(item => item.code === 'pt').locales).toEqual(['pt_BR', 'pt_PT']);
  });

  it('preserves distinct verbatim inputs and balances the two genders and variations', () => {
    const previous = { languages: [{ code: 'en', name: 'English', iso: 'eng', sourceId: 'source-0', text: 'The frozen control.', nativeText: true }] };
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: `source-${index}`, language_id: 'en',
      text: `Verbatim source sentence number ${index} with punctuation and names: Alice.` }));
    const corpus = buildRetestCorpus({ languages: rollout.languages.slice(0, 1), samplesPerLanguage: 8 }, previous, rows, 'source-hash');
    expect(corpus.languages).toHaveLength(8);
    expect(new Set(corpus.languages.map(item => item.text)).size).toBe(8);
    expect(new Set(corpus.languages.map(item => item.id)).size).toBe(8);
    expect(new Set(corpus.languages.map(item => item.sourceId)).size).toBe(8);
    expect(corpus.languages[0]).toMatchObject({ id: 'en-01', text: previous.languages[0].text, control: true });
    expect(corpus.languages.filter(item => item.omniVoice.gender === 'male')).toHaveLength(4);
    expect(corpus.languages.filter(item => item.omniVoice.variation === 2)).toHaveLength(4);
    for (const item of corpus.languages.slice(1)) {
      expect(rows.some(row => row.text === item.text && row.id === item.sourceId)).toBe(true);
      expect(item.sourceFileSha256).toBe('source-hash');
    }
    expect(buildRetestCorpus({ languages: rollout.languages.slice(0, 1), samplesPerLanguage: 8 }, previous, rows, 'source-hash')).toEqual(corpus);
    expect(() => buildRetestCorpus({ languages: rollout.languages.slice(0, 1), samplesPerLanguage: 8 }, previous, rows.slice(0, 2), 'hash'))
      .toThrow('Insufficient distinct native inputs');
  });

  it('keeps failed and missing samples in the pass denominator and weights CER by actual reference length', () => {
    const corpus = { languages: Array.from({ length: 4 }, () => ({ code: 'en', name: 'English' })) };
    const samples = [
      { code: 'en', status: 'automatic-sample-pass', recognition: { cer: .1, edits: 10, expectedCharacters: 100 }, signal: { dnsmos: { overall: 3 } } },
      { code: 'en', status: 'review-transcript', recognition: { cer: .5, edits: 10, expectedCharacters: 20 }, signal: { dnsmos: { overall: 2 } } },
      { code: 'en', status: 'synthesis-failed' },
    ];
    expect(summarizeLanguageSamples(corpus, samples)[0]).toMatchObject({ expected: 4, analyzed: 3, passes: 1,
      weightedCer: 20 / 120, worstCer: .5, meanDnsMos: 2.5, worstDnsMos: 2 });
  });
});
