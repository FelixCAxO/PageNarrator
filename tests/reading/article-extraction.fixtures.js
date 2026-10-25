import { JSDOM } from 'jsdom';

export function createDocument(html, { selection } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/article' });
  if (selection) {
    dom.window.getSelection = () => ({ toString: () => selection });
  } else {
    dom.window.getSelection = () => ({ toString: () => '' });
  }
  return dom.window.document;
}
