import { describe, expect, it } from 'vitest';
import { iterateArticleSpeechChunks } from "../../src/lib/article-extraction.js";

describe('article extraction priority', () => {
  it.each([
    { type: 'page-title', heading: 'Short title', small: true },
    { type: 'heading', heading: 'Short heading', small: true },
    { type: 'heading', heading: 'Short heading', small: true, maxLen: 320, targetMinLen: 180 },
    { type: 'heading', heading: 'Short heading', small: true, maxLen: 240, targetMinLen: 120 },
    { type: 'paragraph', heading: 'Short paragraph', small: false },
    { type: 'heading', heading: 'A long descriptive heading '.repeat(12).trim(), small: false },
  ])('keeps the paragraph after a short $type quick to preload (small: $small)', async ({ type, heading, small, maxLen = 480, targetMinLen = 260 }) => {
    const body = `${'Opening words describe the reading experience '.repeat(5).trim()}. Another sentence describes the rest of the paragraph.`;
    const paragraph = {
      type: 'paragraph', speech: body, anchorId: 'body', anchorText: body,
      domWordOffset: 0, globalDomWordStartIndex: 7,
    };
    const chunks = [];
    for await (const chunk of iterateArticleSpeechChunks({ chunks: [
      { type, speech: heading }, paragraph, { ...paragraph, anchorId: 'later' },
    ] }, { maxLen, targetMinLen })) chunks.push(chunk);
    const openingBody = chunks.filter((chunk) => chunk.anchorId === 'body');
    expect(openingBody[0].speech.length <= 120).toBe(small);
    expect(openingBody.map((chunk) => chunk.speech).join(' ')).toBe(body);
    let wordsBefore = 0;
    for (const chunk of openingBody) {
      expect(chunk.anchorText).toBe(body);
      expect(chunk.domWordOffset).toBe(wordsBefore);
      expect(chunk.globalDomWordStartIndex).toBe(7 + wordsBefore);
      wordsBefore += chunk.speech.split(/\s+/).length;
    }
    const laterBody = chunks.filter((chunk) => chunk.anchorId === 'later');
    expect(laterBody[0].speech.length).toBeGreaterThan(120);
    expect(laterBody.map((chunk) => chunk.speech).join(' ')).toBe(body);
  });

  it('shortens only the first buffered body chunk in a very long opening sentence', async () => {
    const body = `${'A long opening paragraph needs steady narration without extra tiny chunks '.repeat(60).trim()}.`;
    const collect = async (headingType) => {
      const chunks = [];
      for await (const chunk of iterateArticleSpeechChunks({ chunks: [
        { type: headingType, speech: 'Opening' }, { type: 'paragraph', speech: body },
      ] }, { maxLen: 480, targetMinLen: 260 })) chunks.push(chunk);
      return chunks.slice(1);
    };
    const regular = await collect('paragraph');
    const opening = await collect('heading');
    expect(opening[0].speech.length).toBeLessThanOrEqual(120);
    expect(opening.length).toBeLessThanOrEqual(regular.length + 4);
    expect(opening.at(-1).speech).toBe(regular.at(-1).speech);
    expect(opening.map((chunk) => chunk.speech).join(' ')).toBe(body);
  });

  it('chunks iterable article blocks one block at a time', async () => {
    let pulls = 0;
    const blocks = {
      [Symbol.iterator]() {
        return {
          next() {
            pulls += 1;
            if (pulls === 1) return { done: false, value: 'First streamed block' };
            if (pulls === 2) return { done: false, value: 'Second streamed block' };
            return { done: true, value: undefined };
          },
        };
      },
    };

    const iterator = iterateArticleSpeechChunks({
      title: 'Streaming Story',
      chunks: blocks,
    }, { maxLen: 80, targetMinLen: 48 })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: 'First streamed block',
    });
    expect(pulls).toBe(1);
  });
});
