import { describe, expect, it } from 'vitest';
import { extractTranslationStrings, validateTranslatedCatalog, mergeTranslationCatalog } from '../../scripts/prepare-translations.mjs';

describe('translation preparation', () => {
  it('finds visible text, accessible labels and dynamic placeholders without executing source', () => {
    const html = extractTranslationStrings('popup.html', '<body><button title="Start narration">Read <b>page</b></button><input placeholder="Search"><script>throw new Error("never execute")</script></body>');
    expect(html.map(item => item.message)).toEqual(['Read', 'Start narration', 'page', 'Search']);
    const js = extractTranslationStrings('popup.js', 'element.textContent = `Detected ${language} (${percent}%).`; const options = { message: "Choose a voice" }; import x from "not-visible";');
    expect(js).toHaveLength(2);
    expect(js[0]).toMatchObject({ message: 'Detected $value1$ ($value2$%).', placeholders: {
      value1: { content: '$1', example: 'language' }, value2: { content: '$2', example: 'percent' },
    } });
  });

  it('rejects missing messages and altered substitution tokens', () => {
    const source = { detected: { message: 'Detected $language$.', placeholders: { language: { content: '$1' } } } };
    expect(validateTranslatedCatalog(source, { detected: { ...source.detected, message: '$language$ erkannt.' } })).toEqual([]);
    expect(validateTranslatedCatalog(source, { detected: { ...source.detected, message: 'Erkannt.' } })).toEqual(['detected: changed placeholders']);
    expect(validateTranslatedCatalog(source, { detected: { ...source.detected, message: '' } })).toEqual(['detected: missing translation']);
  });

  it('preserves translator work when new messages arrive and retains obsolete candidates separately', () => {
    expect(mergeTranslationCatalog({ read: { message: 'Read' }, stop: { message: 'Stop' } },
      { read: { message: 'Läs' }, old: { message: 'Äldre' } }, 'sv')).toEqual({
      messages: { read: { message: 'Läs' }, stop: { message: '' } }, obsolete: { old: { message: 'Äldre' } },
    });
  });
});
