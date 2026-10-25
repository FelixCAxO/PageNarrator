import { describe, expect, it } from 'vitest';
import {
  LIVE_LANGUAGE_CODES,
  LIVE_LANGUAGE_PAGE_GROUPS,
  LIVE_PAGE_COUNT_PER_LANGUAGE,
  resolveLiveLanguageGroupPages,
  resolveLivePageUrl,
} from './live-language-pages.js';

describe('live language page fixtures', () => {
  it('keeps 50 public live page URLs for each launch language', () => {
    expect(LIVE_LANGUAGE_CODES).toEqual(['en', 'sv', 'de', 'fr', 'nl']);

    for (const group of LIVE_LANGUAGE_PAGE_GROUPS) {
      expect(group.pages).toHaveLength(LIVE_PAGE_COUNT_PER_LANGUAGE);
      expect(new Set(group.pages.map((page) => page.url)).size).toBe(LIVE_PAGE_COUNT_PER_LANGUAGE);

      for (const page of group.pages) {
        expect(page.languageCode).toBe(group.code);
        expect(page.url).toMatch(new RegExp(`^https://${group.code}\\.wikipedia\\.org/wiki/.+`));
      }
    }
  });

  it('resolves fallback launch-language pages through Wikipedia language links', async () => {
    const german = LIVE_LANGUAGE_PAGE_GROUPS.find((group) => group.code === 'de');
    const mathematics = german.pages.find((page) => page.name === 'Mathematics');
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          query: {
            pages: {
            18831: {
              title: 'Mathematics',
              langlinks: [{ lang: 'de', '*': 'Mathematik' }],
            },
            },
          },
        }),
      };
    };

    await expect(resolveLivePageUrl(mathematics, { fetchImpl })).resolves.toBe('https://de.wikipedia.org/wiki/Mathematik');
    expect(requestedUrls[0]).toContain('titles=Mathematics');
    expect(requestedUrls[0]).toContain('lllang=de');
  });

  it('resolves fallback launch-language pages in one batched language-link request', async () => {
    const german = LIVE_LANGUAGE_PAGE_GROUPS.find((group) => group.code === 'de');
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          query: {
            pages: {
              1: {
                title: 'Mathematics',
                langlinks: [{ lang: 'de', '*': 'Mathematik' }],
              },
              2: {
                title: 'Medicine',
                langlinks: [{ lang: 'de', '*': 'Medizin' }],
              },
            },
          },
        }),
      };
    };

    const resolved = await resolveLiveLanguageGroupPages({
      ...german,
      pages: german.pages.filter((page) => ['Mathematics', 'Medicine'].includes(page.name)),
    }, { fetchImpl });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('Mathematics%7CMedicine');
    expect(resolved.pages.map((page) => page.resolvedUrl)).toEqual([
      'https://de.wikipedia.org/wiki/Mathematik',
      'https://de.wikipedia.org/wiki/Medizin',
    ]);
  });

  it('keeps the checked fallback path when a language link is missing from the batched response', async () => {
    const german = LIVE_LANGUAGE_PAGE_GROUPS.find((group) => group.code === 'de');
    const pages = german.pages.filter((page) => ['Mathematics', 'Film'].includes(page.name));
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        query: {
          pages: {
            1: {
              title: 'Mathematics',
              langlinks: [{ lang: 'de', '*': 'Mathematik' }],
            },
            2: {
              title: 'Film',
              langlinks: [],
            },
          },
        },
      }),
    });

    const resolved = await resolveLiveLanguageGroupPages({
      ...german,
      pages,
    }, { fetchImpl });

    expect(resolved.pages.map((page) => page.resolvedUrl)).toEqual([
      'https://de.wikipedia.org/wiki/Mathematik',
      'https://de.wikipedia.org/wiki/Film',
    ]);
  });
});
