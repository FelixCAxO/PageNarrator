import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getReaderEngineElements } from '../../src/lib/reader-engine-dom.js';
import { createReaderEngineController } from '../../src/ui/reader-engine/reader-engine-controller.js';
import { createScrollFollower } from '../../src/lib/page-highlighter-scroll-follow.js';

const readerHtml = readFileSync(new URL('../../src/reader-engine.html', import.meta.url), 'utf8');

describe('reader keyboard shortcuts', () => {
  it.each(['read-btn', 'prev-btn', 'stop-btn', 'next-btn'])('does not advertise an unbound bare-key shortcut on %s', (id) => {
    const dom = new JSDOM(readerHtml);
    try {
      const button = dom.window.document.getElementById(id);
      expect(button).not.toBeNull();
      expect(button.getAttribute('aria-keyshortcuts')).toBeNull();
      expect(button.getAttribute('title')).toBe(id === 'prev-btn' ? 'Previous section' : null);
    } finally {
      dom.window.close();
    }
  });

  it('keeps typing and browser keys out of the real reader controller while retaining Enter navigation', () => {
    const dom = new JSDOM(readerHtml);
    try {
      const document = dom.window.document;
      const els = getReaderEngineElements(document);
      const actions = Object.fromEntries([
        'handlePrimaryAction', 'stopReading', 'skipToPreviousChunk', 'skipToNextChunk',
        'jumpToFirstChunk', 'jumpToLastLoadedChunk', 'handleQueueSearchInput', 'jumpToEnteredChunk',
      ].map((name) => [name, vi.fn()]));
      createReaderEngineController().bind({ els, document, actions });
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      document.body.append(editable);

      for (const target of [document.body, els.read, els.queueSearchInput, els.queueJumpInput, editable]) {
        for (const key of [' ', 'j', 'ArrowLeft', 'l', 'ArrowRight', 's', '+', '=', '-', '_', 'Home', 'End', '?', '/']) {
          for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
            expect(target.dispatchEvent(event)).toBe(true);
            expect(event.defaultPrevented).toBe(false);
          }
        }
      }
      for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();

      const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      els.queueJumpInput.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(actions.jumpToEnteredChunk).toHaveBeenCalledOnce();
    } finally {
      dom.window.close();
    }
  });

  it.each(['https://www.youtube.com/watch?v=1', 'https://music.youtube.com/watch?v=1', 'https://open.spotify.com/track/1'])('leaves host Space handling intact on %s', (url) => {
    const dom = new JSDOM('<!doctype html><body><p>Currently narrated text.</p></body>', { url });
    const document = dom.window.document;
    const follower = createScrollFollower({ win: dom.window, documentRef: document });
    try {
      const hostPlayback = vi.fn();
      document.addEventListener('keydown', hostPlayback);
      const paragraph = document.querySelector('p');
      follower.follow(() => ({ top: 200, bottom: 240, left: 0, right: 200, width: 200, height: 40 }), paragraph, 0.35);
      const event = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      expect(document.body.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(hostPlayback).toHaveBeenCalledOnce();
      expect(hostPlayback).toHaveBeenCalledWith(event);
    } finally {
      follower.dispose();
      dom.window.close();
    }
  });

  it('does not expose global playback commands outside the UI', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.commands).toBeUndefined();
  });
});
