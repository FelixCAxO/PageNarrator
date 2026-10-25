import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import fixtures from '../fixtures/article-extraction-heldout.json';
import { parseArticleDocument } from '../../src/engines/article-extractor.js';
import { buildReadingModel, getDomWordIndexForSpeechWord, renderReadingModelForSpeechChunks } from '../../src/lib/reading-model.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';

for (const item of fixtures.cases) {
  it(`preserves the frozen ${item.id} source text without page mutation`, () => {
    const document = new JSDOM(item.html).window.document, before = document.documentElement.outerHTML;
    expect(parseArticleDocument(document)?.textContent).toBe(item.blocks.join('\n\n'));
    expect(document.documentElement.outerHTML).toBe(before);
  });
  if (item.alignment) it(`keeps every mapped ${item.id} speech token attached to the original word`, () => {
    const document = new JSDOM(item.html).window.document;
    const chunks = renderReadingModelForSpeechChunks(buildReadingModel(document));
    expect(chunks.length).toBeGreaterThan(0);
    let mapped = 0;
    const unmapped = [];
    for (const chunk of chunks) {
      const source = tokenizeSpokenWords(chunk.anchorText), speech = tokenizeSpokenWords(chunk.speech);
      for (let index = 0; index < speech.length; index++) {
        const domIndex = getDomWordIndexForSpeechWord(chunk, index);
        if (domIndex >= 0) { expect(source[domIndex]?.text, `${chunk.type} ${speech[index].text}`).toBe(speech[index].text); mapped++; }
        else unmapped.push([chunk.type, speech[index].text]);
      }
    }
    expect(mapped).toBeGreaterThan(10);
    // Table size announcements and repeated column labels have no new DOM word.
    // Every other spoken word in these source fixtures must retain its anchor.
    expect(unmapped).toEqual(item.id === 'table-cells' ? [
      ['table', 'Table'], ['table', '2'], ['table', 'columns'], ['table', 'and'],
      ['table-row', 'Stage'], ['table-row', 'Time'], ['table-row', 'Stage'], ['table-row', 'Time'],
    ] : []);
  });
}
