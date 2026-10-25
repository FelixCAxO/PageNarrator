import { JSDOM } from 'jsdom';
import { buildReadingModel, renderReadingModelForSpeech } from "../../src/lib/reading-model.js";

export function createDocument(html) {
  return new JSDOM(html, { url: 'https://example.test/article' }).window.document;
}

export function read(html) {
  return renderReadingModelForSpeech(buildReadingModel(createDocument(html)));
}
