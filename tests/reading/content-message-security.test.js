import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  extract: vi.fn(async () => ({ text: 'Private article text' })),
  highlight: vi.fn(async () => ({ ok: true })),
  loadExtract: vi.fn(),
  loadHighlight: vi.fn(),
}));
vi.mock('../../src/reader/extraction/content-extraction.js', () => {
  handlers.loadExtract();
  return { handleExtractMessage: handlers.extract };
});
vi.mock('../../src/reader/highlighting/content-highlight.js', () => {
  handlers.loadHighlight();
  return { handleHighlightMessage: handlers.highlight };
});

const extensionOrigin = 'chrome-extension://test';
const trustedEngine = { id: 'test', url: `${extensionOrigin}/src/reader-engine.html`, origin: extensionOrigin, frameId: 0 };
const deniedSenders = [
  ['missing metadata', {}],
  ['foreign extension', { ...trustedEngine, id: 'foreign' }],
  ['web content script', { ...trustedEngine, url: 'https://attacker.test/', origin: 'https://attacker.test', tab: { id: 9 } }],
  ['mismatched origin', { ...trustedEngine, origin: 'https://attacker.test' }],
  ['opaque origin', { ...trustedEngine, origin: 'null' }],
  ['extension child frame', { ...trustedEngine, frameId: 2 }],
  ['popup direct data access', { ...trustedEngine, url: `${extensionOrigin}/src/popup.html` }],
  ['PDF viewer direct data access', { ...trustedEngine, url: `${extensionOrigin}/src/pdf-viewer.html` }],
];
const commandTypes = [
  'pagenarratorPing', 'extract', 'getArticleChunk', 'closeArticleChunkStream',
  'setHighlightSettings', 'highlightChunk', 'highlightQueued', 'highlightWord',
  'highlightWordPlan', 'highlightPlanResync', 'getFlowLog', 'highlightSyntheticSpeech',
  'flashResumeSection', 'setHighlightPaused', 'clearHighlight',
];

describe('content listener authorization', () => {
  let listener;
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('chrome', { runtime: {
      id: 'test',
      getURL: (path) => `${extensionOrigin}/${path}`,
      getManifest: () => ({ background: { service_worker: 'service-worker-loader.js' } }),
      onMessage: { addListener: (callback) => { listener = callback; } },
    } });
    await import('../../src/content.js');
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(deniedSenders)('rejects %s before loading extraction or highlight code', async (_name, sender) => {
    const respond = vi.fn();
    for (const type of commandTypes) expect(listener({ type }, sender, respond), type).toBe(false);
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    expect(handlers.loadExtract).not.toHaveBeenCalled();
    expect(handlers.loadHighlight).not.toHaveBeenCalled();
    expect(handlers.extract).not.toHaveBeenCalled();
    expect(handlers.highlight).not.toHaveBeenCalled();
  });

  it.each([
    ['reader engine', trustedEngine],
    ['background relay', { id: 'test', url: `${extensionOrigin}/service-worker-loader.js`, origin: extensionOrigin }],
  ])('preserves lazy extraction and highlighting from the %s', async (_name, sender) => {
    const pingResponse = vi.fn();
    expect(listener({ type: 'pagenarratorPing' }, sender, pingResponse)).toBe(false);
    expect(pingResponse).toHaveBeenCalledWith({ ok: true });
    expect(handlers.loadExtract).not.toHaveBeenCalled();
    expect(handlers.loadHighlight).not.toHaveBeenCalled();
    const extractResponse = vi.fn();
    expect(listener({ type: 'extract' }, sender, extractResponse)).toBe(true);
    await vi.waitFor(() => expect(extractResponse).toHaveBeenCalledWith({ text: 'Private article text' }));
    const highlightResponse = vi.fn();
    expect(listener({ type: 'highlightChunk', text: 'Private article text' }, sender, highlightResponse)).toBe(true);
    await vi.waitFor(() => expect(highlightResponse).toHaveBeenCalledWith({ ok: true }));
    expect(handlers.extract).toHaveBeenCalledTimes(1);
    expect(handlers.highlight).toHaveBeenCalledTimes(1);
  });
});
