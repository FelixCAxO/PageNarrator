import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  PDF_NOISE_SELECTOR,
  WEB_NOISE_SELECTOR,
  getNoiseSelector,
} from '../../src/lib/dom-selectors.js';

describe('shared DOM noise selectors', () => {
  it('recognizes hashed social signup panels by their email form while retaining ordinary prose', () => {
    const document = new JSDOM(`<main>
      <section id="social-signup-generated"><p>Receive updates.</p><form><input type="email"></form></section>
      <section id="social-signup-research"><p>Social signup research describes community participation.</p></section>
      <section id="social-signup-other"><form><input type="text"></form><p>Text-only community research.</p></section>
    </main>`).window.document;
    const widget = document.querySelector('#social-signup-generated');
    for (const surface of ['article', 'web']) expect(widget.matches(getNoiseSelector({ surface }))).toBe(true);
    for (const surface of ['pdf', 'highlighter']) expect(widget.matches(getNoiseSelector({ surface }))).toBe(false);
    for (const element of document.querySelectorAll('#social-signup-research,#social-signup-other')) expect(element.matches(WEB_NOISE_SELECTOR)).toBe(false);
    widget.querySelector('form').remove();
    expect(widget.matches(WEB_NOISE_SELECTOR)).toBe(false);
  });

  it('excludes labeled image navigation cards without excluding linked article prose', () => {
    const document = new JSDOM(`<main>
      <a id="card" href="/related" aria-label="Read more"><img alt=""><h3>Related guide</h3></a>
      <a id="prose" href="/guide" aria-label="Guide"><img alt=""><h3>Guide</h3><p>Useful article prose.</p></a>
      <a id="heading" href="#section" aria-label="Section"><h3>Article section</h3></a>
    </main>`).window.document;
    for (const surface of ['article', 'web']) expect(document.querySelector('#card').matches(getNoiseSelector({ surface }))).toBe(true);
    for (const surface of ['pdf', 'highlighter']) expect(document.querySelector('#card').matches(getNoiseSelector({ surface }))).toBe(false);
    for (const element of document.querySelectorAll('#prose,#heading')) expect(element.matches(WEB_NOISE_SELECTOR)).toBe(false);
  });

  it('excludes media fallback and a social widget only on article surfaces', () => {
    const document = new JSDOM('<video></video><audio></audio><div id="social"><a><img alt="Example Logo"></a></div><div id="social-science"></div><figcaption></figcaption>').window.document;
    for (const element of document.querySelectorAll('video,audio,#social')) {
      for (const surface of ['article', 'web']) expect(element.matches(getNoiseSelector({ surface }))).toBe(true);
      for (const surface of ['pdf', 'highlighter']) expect(element.matches(getNoiseSelector({ surface }))).toBe(false);
    }
    for (const element of document.querySelectorAll('#social-science,figcaption')) expect(element.matches(WEB_NOISE_SELECTOR)).toBe(false);
    const prose = new JSDOM('<section id="social"><p>Social policy remains meaningful prose.</p><a><img alt="Example Logo"></a></section>').window.document;
    expect(prose.querySelector('#social').matches(WEB_NOISE_SELECTOR)).toBe(false);
  });

  it('excludes explicit print/share actions on web surfaces without changing PDF matching', () => {
    const document = new JSDOM('<a data-action="print"></a><a data-action="SHARE"></a><a data-action="shareholder"></a>').window.document;
    for (const element of [...document.querySelectorAll('a')].slice(0, 2)) {
      for (const surface of ['article', 'web']) expect(element.matches(getNoiseSelector({ surface }))).toBe(true);
      for (const surface of ['pdf', 'highlighter']) expect(element.matches(getNoiseSelector({ surface }))).toBe(false);
    }
    expect(document.querySelector('[data-action="shareholder"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
  });

  it('keeps shared page chrome exclusions in every reader surface', () => {
    for (const selector of ['script', 'style', 'nav', '[aria-hidden="true"]', '.mw-editsection', 'sup.reference']) {
      expect(WEB_NOISE_SELECTOR.split(',')).toContain(selector);
      expect(PDF_NOISE_SELECTOR.split(',')).toContain(selector);
    }
  });

  it('does not classify ordinary reference-class prose as page chrome', () => {
    const document = new JSDOM('<p class="reference">Read <a class="reference internal" href="/guide">the guide</a>.</p>').window.document;
    for (const element of document.querySelectorAll('p, a')) {
      expect(element.matches(WEB_NOISE_SELECTOR)).toBe(false);
      expect(element.matches(PDF_NOISE_SELECTOR)).toBe(false);
    }
  });

  it('keeps web-only article clutter out of PDF text-layer matching', () => {
    expect(WEB_NOISE_SELECTOR.split(',')).toContain('.comment');
    expect(WEB_NOISE_SELECTOR.split(',')).toContain('.social');
    expect(PDF_NOISE_SELECTOR.split(',')).not.toContain('.comment');
    expect(PDF_NOISE_SELECTOR.split(',')).not.toContain('.social');
  });

  it('keeps article extraction form controls excluded without hiding page-highlighter form labels', () => {
    expect(getNoiseSelector({ surface: 'article' }).split(',')).toContain('form');
    expect(getNoiseSelector({ surface: 'highlighter' }).split(',')).not.toContain('form');
  });

  it('matches real share and social widget class patterns on web surfaces', () => {
    const document = new JSDOM(`
      <main>
        <div class="c-article-share-box"></div>
        <div class="article-share-tools"></div>
        <div class="entry-share"></div>
        <div class="post-share"></div>
        <div class="social-icons"></div>
        <div class="social-science"></div>
        <div class="political-social-analysis"></div>
        <div class="anti-social-behavior-analysis"></div>
        <div class="political_social_analysis"></div>
        <div class="anti_social_behavior_analysis"></div>
        <div class="social_science"></div>
        <div class="market-share-analysis"></div>
        <div class="share-price-analysis"></div>
        <div class="shareholder-analysis"></div>
        <div class="timeshare-analysis"></div>
        <div data-component="timeshare-analysis"></div>
        <div data-component="article-share"></div>
        <div data-component="shareholder-analysis"></div>
        <div data-component="market-share-analysis"></div>
        <div data-component="market share analysis"></div>
        <div data-testid="share-toolbar"></div>
        <div data-testid="shareholder-research"></div>
        <div data-testid="share-price-analysis"></div>
        <div data-testid="market share analysis"></div>
        <div data-test-id="market share analysis"></div>
        <div data-track="stock share analysis"></div>
      </main>
    `).window.document;

    expect(document.querySelector('.c-article-share-box').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('.article-share-tools').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('.entry-share').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('.post-share').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('.social-icons').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('.social-science').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.political-social-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.anti-social-behavior-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.political_social_analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.anti_social_behavior_analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.social_science').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.market-share-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.share-price-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.shareholder-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('.timeshare-analysis').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-component="timeshare-analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-component="article-share"]').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('[data-component="shareholder-analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-component="market-share-analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-component="market share analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-testid="share-toolbar"]').matches(WEB_NOISE_SELECTOR)).toBe(true);
    expect(document.querySelector('[data-testid="shareholder-research"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-testid="share-price-analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-testid="market share analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-test-id="market share analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
    expect(document.querySelector('[data-track="stock share analysis"]').matches(WEB_NOISE_SELECTOR)).toBe(false);
  });
});
