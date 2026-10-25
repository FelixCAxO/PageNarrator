import { describe, expect, it } from 'vitest';
import {
  detectPageLanguage,
  normalizeDetectionSample,
  shouldAutoSelectDetectedLanguage,
} from '../../src/lib/language-detection.js';

describe('language detection', () => {
  it('normalizes page text into a bounded Chrome detection sample', () => {
    const sample = normalizeDetectionSample(`  Hej\tvärlden 🚀\n\n<script>alert(1)</script> ${'ord '.repeat(900)}`);

    expect(sample).toMatch(/^Hej världen scriptalert\(1\)\/script ord/);
    expect(sample.length).toBeLessThanOrEqual(3000);
    expect(sample).not.toContain('🚀');
    expect(sample).not.toMatch(/\s{2,}/);
  });

  it('returns und without calling Chrome for samples that are too short', async () => {
    let called = false;
    const detected = await detectPageLanguage('Too short.', {
      i18n: {
        async detectLanguage() {
          called = true;
        },
      },
    });

    expect(called).toBe(false);
    expect(detected).toEqual({ code: 'und', percent: 0, margin: 0, reliable: false });
  });

  it('uses the highest-ranked Chrome language and requires at least 70 percent confidence with a 20 point margin', async () => {
    const detected = await detectPageLanguage('Det här är en svensk text. '.repeat(12), {
      i18n: {
        async detectLanguage(sample) {
          expect(sample.length).toBeGreaterThanOrEqual(80);
          return {
            languages: [
              { language: 'sv', percentage: 72 },
              { language: 'da', percentage: 18 },
            ],
          };
        },
      },
    });

    expect(detected).toEqual({ code: 'sv', percent: 72, margin: 54, reliable: true });
    expect(shouldAutoSelectDetectedLanguage(detected)).toBe(true);
  });

  it('marks weak, ambiguous, or unknown Chrome results as unreliable', async () => {
    const weak = await detectPageLanguage('Das ist ein deutscher Beispielsatz. '.repeat(8), {
      i18n: {
        async detectLanguage() {
          return { languages: [{ language: 'de', percentage: 42 }] };
        },
      },
    });

    const unknown = await detectPageLanguage('Mixed words from many places. '.repeat(8), {
      i18n: {
        async detectLanguage() {
          return { languages: [{ language: 'und', percentage: 99 }] };
        },
      },
    });

    const ambiguous = await detectPageLanguage('Mixed English und deutscher Text. '.repeat(8), {
      i18n: {
        async detectLanguage() {
          return {
            languages: [
              { language: 'de', percentage: 74 },
              { language: 'en', percentage: 61 },
            ],
          };
        },
      },
    });

    expect(weak).toEqual({ code: 'de', percent: 42, margin: 42, reliable: false });
    expect(unknown).toEqual({ code: 'und', percent: 99, margin: 99, reliable: false });
    expect(ambiguous).toEqual({ code: 'de', percent: 74, margin: 13, reliable: false });
    expect(shouldAutoSelectDetectedLanguage(weak)).toBe(false);
    expect(shouldAutoSelectDetectedLanguage(unknown)).toBe(false);
    expect(shouldAutoSelectDetectedLanguage(ambiguous)).toBe(false);
  });
});
