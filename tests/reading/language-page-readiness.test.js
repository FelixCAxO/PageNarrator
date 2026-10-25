import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { extractReadableArticle } from '../../src/lib/reading-model.js';
import { estimateWordTimings } from '../../src/lib/speech-audio.js';
import { createWordHighlightTracker } from '../../src/lib/speech-playback.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { getVoiceOptions, getVoicesForDetectedLanguage } from '../../src/lib/voice-registry.js';

const PAGE_COUNT_PER_LANGUAGE = 50;

const LANGUAGE_FIXTURES = Object.freeze([
  {
    code: 'en',
    label: 'English',
    title: 'Civic Reading Brief',
    section: 'Local reporting',
    paragraphs: [
      'The city library opened a new reading room while local reporters explained how families use the service after work.',
      'Teachers described the pilot program, residents compared travel times, and the newsroom published a clear timeline for the decision.',
      'Editors checked the figures against public records before the article summarized the next meeting and the budget vote.',
    ],
    quote: 'Clear pages should become clear audio.',
    items: ['Open the article page', 'Follow the highlighted words', 'Finish the spoken queue'],
  },
  {
    code: 'sv',
    label: 'Swedish',
    title: 'Läsning i vardagen',
    section: 'Nyheter från kommunen',
    paragraphs: [
      'Biblioteket öppnade ett nytt läsrum medan lokala reportrar beskrev hur familjer använder tjänsten efter arbetet.',
      'Lärare förklarade försöket, invånare jämförde restider och redaktionen publicerade en tydlig tidslinje för beslutet.',
      'Journalister kontrollerade siffrorna mot offentliga handlingar innan artikeln sammanfattade nästa möte och budgetomröstningen.',
    ],
    quote: 'Tydliga sidor ska bli tydligt ljud.',
    items: ['Öppna artikelsidan', 'Följ de markerade orden', 'Avsluta den upplästa kön'],
  },
  {
    code: 'de',
    label: 'German',
    title: 'Lesen im Alltag',
    section: 'Nachrichten aus der Kommune',
    paragraphs: [
      'Die Bibliothek eroeffnete einen neuen Leseraum, waehrend lokale Reporter erklaerten, wie Familien den Dienst nach der Arbeit nutzen.',
      'Lehrkraefte beschrieben das Pilotprogramm, Einwohner verglichen Reisezeiten und die Redaktion veroeffentlichte eine klare Zeitleiste fuer die Entscheidung.',
      'Journalisten prueften die Zahlen anhand oeffentlicher Akten, bevor der Artikel die naechste Sitzung und die Haushaltsabstimmung zusammenfasste.',
    ],
    quote: 'Klare Seiten sollen zu klarer Sprache werden.',
    items: ['Artikelseite oeffnen', 'Markierte Woerter verfolgen', 'Gesprochene Warteschlange beenden'],
  },
  {
    code: 'fr',
    label: 'French',
    title: 'Lecture en ville',
    section: 'Reportage local',
    paragraphs: [
      'La bibliotheque a ouvert une nouvelle salle de lecture pendant que les journalistes locaux expliquaient comment les familles utilisent le service apres le travail.',
      'Les enseignantes ont decrit le programme pilote, les habitants ont compare les temps de trajet et la redaction a publie une chronologie claire de la decision.',
      'Les journalistes ont verifie les chiffres dans les dossiers publics avant que l article resume la prochaine reunion et le vote du budget.',
    ],
    quote: 'Les pages claires doivent devenir un son clair.',
    items: ['Ouvrir la page de l article', 'Suivre les mots marques', 'Terminer la file de lecture'],
  },
  {
    code: 'nl',
    label: 'Dutch',
    title: 'Lezen in de stad',
    section: 'Lokaal verslag',
    paragraphs: [
      'De bibliotheek opende een nieuwe leeszaal terwijl lokale verslaggevers uitlegden hoe gezinnen de dienst na het werk gebruiken.',
      'Leraren beschreven het proefprogramma, bewoners vergeleken reistijden en de redactie publiceerde een duidelijke tijdlijn voor het besluit.',
      'Journalisten controleerden de cijfers in openbare dossiers voordat het artikel de volgende vergadering en de begrotingsstemming samenvatte.',
    ],
    quote: 'Duidelijke pagina s moeten duidelijke audio worden.',
    items: ['Open de artikelpagina', 'Volg de gemarkeerde woorden', 'Rond de voorgelezen wachtrij af'],
  },
]);

const LAUNCH_LANGUAGE_CODES = Object.freeze(['en']);
const LAUNCH_LANGUAGE_FIXTURES = Object.freeze(
  LANGUAGE_FIXTURES.filter(({ code }) => LAUNCH_LANGUAGE_CODES.includes(code)),
);

const INSTALLED_DOWNLOADABLE_VOICE_IDS = new Set(
  getVoiceOptions({ includeDownloadable: true })
    .filter((voice) => voice.status === 'downloadable')
    .map((voice) => voice.id),
);

const LANGUAGE_PAGE_CASES = LAUNCH_LANGUAGE_FIXTURES.flatMap((fixture) => (
  Array.from({ length: PAGE_COUNT_PER_LANGUAGE }, (_, index) => buildLanguagePageCase(fixture, index + 1))
));

function buildLanguagePageCase(fixture, pageNumber) {
  const paragraph = fixture.paragraphs[(pageNumber - 1) % fixture.paragraphs.length];
  const followup = fixture.paragraphs[pageNumber % fixture.paragraphs.length];
  return {
    ...fixture,
    pageNumber,
    html: `
      <!doctype html>
      <html lang="${fixture.code}">
        <head><title>${escapeHtml(fixture.title)} ${pageNumber}</title></head>
        <body>
          <header>Cookie panel and navigation should never be narrated.</header>
          <main>
            <article>
              <h1>${escapeHtml(fixture.title)} ${pageNumber}</h1>
              <p>${escapeHtml(paragraph)}</p>
              <h2>${escapeHtml(fixture.section)}</h2>
              <p>${escapeHtml(followup)} ${pageNumber}.</p>
              <blockquote>${escapeHtml(fixture.quote)}</blockquote>
              <ol>
                ${fixture.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
              </ol>
            </article>
          </main>
          <aside>Related links should stay outside the reading queue.</aside>
          <footer>Footer contact links should never be narrated.</footer>
        </body>
      </html>
    `,
  };
}

function createVisualDom(html, pageNumber) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: `https://language-${pageNumber}.example.test/article`,
  });
  const { document } = dom.window;
  Object.defineProperty(dom.window, 'innerHeight', { value: 900, configurable: true });
  dom.window.scrollBy = () => {};

  for (const [index, element] of Array.from(document.querySelectorAll('main, article, h1, h2, p, blockquote, ol, li')).entries()) {
    const top = 80 + index * 42;
    element.getBoundingClientRect = () => ({
      top,
      left: 72,
      right: 672,
      bottom: top + 32,
      width: 600,
      height: 32,
    });
  }

  const originalCreateRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = originalCreateRange();
    range.getBoundingClientRect = () => ({
      top: 120,
      left: 96,
      right: 596,
      bottom: 150,
      width: 500,
      height: 30,
    });
    range.getClientRects = () => [range.getBoundingClientRect()];
    return range;
  };

  return dom;
}

function installHighlightCapture() {
  const captured = [];
  globalThis.Highlight = class TestHighlight {
    constructor(range) {
      this.range = range;
    }
  };
  globalThis.CSS = {
    highlights: {
      set(name, highlight) {
        captured.push({ name, text: highlight.range.toString() });
      },
      delete() {},
    },
  };
  return captured;
}

function latestCurrentWord(captured) {
  return [...captured].reverse().find((entry) => entry.name === 'pagenarrator-word-0') || null;
}

function normalizeWord(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('language page readiness', () => {
  afterEach(() => {
    delete globalThis.CSS;
    delete globalThis.Highlight;
  });

  it.each(LAUNCH_LANGUAGE_FIXTURES)('keeps at least 50 same-flow readable page fixtures for $label', ({ code }) => {
    expect(LANGUAGE_PAGE_CASES.filter((page) => page.code === code)).toHaveLength(PAGE_COUNT_PER_LANGUAGE);
  });

  it('keeps every launch language in the readiness matrix', () => {
    expect(LAUNCH_LANGUAGE_FIXTURES.map(({ code }) => code)).toEqual(LAUNCH_LANGUAGE_CODES);
  });

  it('keeps readiness fixtures scoped to currently supported languages', () => {
    expect(LAUNCH_LANGUAGE_FIXTURES.map(({ code }) => code)).toEqual(LAUNCH_LANGUAGE_CODES);
  });

  it.each(LANGUAGE_PAGE_CASES)('reads, outlines, and marks every spoken word for $label page $pageNumber', ({ code, html, pageNumber, title }) => {
    const availability = getVoicesForDetectedLanguage(code, INSTALLED_DOWNLOADABLE_VOICE_IDS);
    const playableVoices = [...availability.installed, ...availability.bundled, ...availability.downloadable];
    expect(playableVoices.length, `${code} should have a playable TTS path`).toBeGreaterThan(0);

    const dom = createVisualDom(html, pageNumber);
    const captured = installHighlightCapture();
    const article = extractReadableArticle(dom.window.document);
    const highlighter = createPageHighlighter(dom.window.document);
    const textBackedChunks = article.chunks.filter((chunk) => chunk.anchorId && chunk.anchorText);

    expect(article.title).toContain(title);
    expect(article.text.length).toBeGreaterThan(180);
    expect(article.text).not.toMatch(/Cookie panel|Related links|Footer contact/i);
    expect(textBackedChunks.length).toBeGreaterThanOrEqual(6);

    for (const chunk of textBackedChunks) {
      const tokens = tokenizeSpokenWords(chunk.anchorText);
      expect(tokens.length, `${chunk.type} should expose DOM words`).toBeGreaterThan(0);
      expect(highlighter.highlightChunkByAnchor(chunk.anchorId, chunk.anchorText)).toEqual({ ok: true });

      const overlay = dom.window.document.querySelector('[data-pagenarrator-region="active"]');
      expect(overlay, `${chunk.type} should draw an active yellow outline`).not.toBeNull();
      expect(overlay.style.display).toBe('block');
      expect(Number.parseInt(overlay.style.width, 10)).toBeGreaterThan(0);
      expect(Number.parseInt(overlay.style.height, 10)).toBeGreaterThan(0);

      const durationSeconds = Math.max(1.2, tokens.length * 0.22);
      const timings = estimateWordTimings(chunk.anchorText, durationSeconds, { languageCode: code });
      const tracker = createWordHighlightTracker(timings, 0);

      expect(timings).toHaveLength(tokens.length);
      expect(Math.abs(timings.at(-1).end - durationSeconds)).toBeLessThanOrEqual(0.01);

      for (const [index, timing] of timings.entries()) {
        const crossed = tracker.update(timing.start + 0.001);
        expect(crossed, `${chunk.type} should emit word index ${index}`).toContain(index);

        for (const wordIndex of crossed) {
          expect(highlighter.highlightWord(wordIndex)).toEqual({ ok: true });
        }

        expect(normalizeWord(latestCurrentWord(captured)?.text)).toBe(normalizeWord(tokens[index].text));
      }
    }
  });
});
