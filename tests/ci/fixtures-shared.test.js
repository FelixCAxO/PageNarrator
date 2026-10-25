import { describe, expect, it, vi } from 'vitest';
import { createChromeMock } from '../fixtures/chrome-mock.js';
import {
  createMemoryCacheStorage,
  createMemoryStorage,
} from '../fixtures/storage-mocks.js';
import {
  cleanupGlobalDom,
  createVisibleEntry,
  installGlobalDom,
} from '../fixtures/jsdom-helpers.js';

describe('shared test fixtures', () => {
  it('supports shared Chrome storage and message events', async () => {
    const chrome = createChromeMock({ storage: { answer: 41 } });
    const listener = vi.fn();
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.onMessage.dispatch({ type: 'ping' });
    await chrome.storage.local.set({ answer: 42 });

    await expect(chrome.storage.local.get('answer')).resolves.toEqual({ answer: 42 });
    expect(listener).toHaveBeenCalledWith({ type: 'ping' });
  });

  it('provides one chrome.storage-compatible memory storage fixture', async () => {
    const storage = createMemoryStorage({ one: 1, two: 2 });

    await expect(storage.get('one')).resolves.toEqual({ one: 1 });
    await expect(storage.get(['one', 'missing'])).resolves.toEqual({ one: 1, missing: undefined });
    await expect(storage.get({ one: 0, missing: 3 })).resolves.toEqual({ one: 1, missing: 3 });

    await storage.set({ three: 3 });
    await storage.remove('two');
    expect(storage.values()).toEqual({ one: 1, three: 3 });

    await storage.clear();
    expect(storage.values()).toEqual({});
  });

  it('provides a cache-storage fixture with cache-like get/set/delete semantics', async () => {
    const cache = createMemoryCacheStorage({ key: { value: 1 } });

    await expect(cache.get('key')).resolves.toEqual({ value: 1 });
    await cache.set('next', { value: 2 });
    await cache.delete('key');

    expect(cache.values()).toEqual({ next: { value: 2 } });
  });

  it('installs and cleans up a global JSDOM with visible-entry helpers', () => {
    const dom = installGlobalDom('<main><p id="target">Hello</p></main>', {
      url: 'https://example.test/article',
    });
    const target = dom.window.document.getElementById('target');

    expect(globalThis.document).toBe(dom.window.document);
    expect(createVisibleEntry(target, { top: 20, bottom: 120 })).toMatchObject({
      target,
      isIntersecting: true,
      intersectionRect: { top: 20, bottom: 120, height: 100 },
    });

    cleanupGlobalDom();
    expect(globalThis.document).toBeUndefined();
  });
});
