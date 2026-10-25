import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getVoiceOptions, getVoicesForDetectedLanguage } from '../../src/lib/voice-registry.js';
import {
  LIVE_LANGUAGE_CODES,
  LIVE_LANGUAGE_PAGE_GROUPS,
  LIVE_PAGE_COUNT_PER_LANGUAGE,
  resolveLiveLanguageGroupPages,
  resolveLivePageUrl,
} from './live-language-pages.js';
import { CdpConnection } from './cdp-connection.js';
import {
  createLiveExtensionPagesEvidence,
  writeLiveExtensionPagesEvidence,
} from '../../scripts/run-live-tests.mjs';
import { resolveCandidateCommitSha } from '../../scripts/run-verification-gate.mjs';

const RUN_LIVE_TESTS = process.env.PAGENARRATOR_LIVETEST === '1';
const LIVE_TEST_TIMEOUT_MS = Number(process.env.PAGENARRATOR_LIVETEST_TIMEOUT_MS || 7_200_000);
const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const CHROME_EXE = process.env.PAGENARRATOR_CHROME
  || path.join(ROOT_DIR, '.chrome-for-testing', 'chrome-win64', 'chrome.exe');
const LIVE_EVIDENCE_PATH = process.env.PAGENARRATOR_LIVE_EVIDENCE_PATH
  || path.join(ROOT_DIR, 'artifacts', 'live-extension-pages.json');
const MAX_CHUNKS_PER_PAGE = Number(process.env.PAGENARRATOR_LIVETEST_MAX_CHUNKS || 1);
const MAX_PAGES_PER_LANGUAGE = Number(process.env.PAGENARRATOR_LIVETEST_MAX_PAGES_PER_LANGUAGE || LIVE_PAGE_COUNT_PER_LANGUAGE);
const LANGUAGE_FILTER = new Set(
  String(process.env.PAGENARRATOR_LIVETEST_LANGUAGES || LIVE_LANGUAGE_CODES.join(','))
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean),
);
const HEADLESS_ARGS = process.env.PAGENARRATOR_HEADED === '1' ? [] : ['--headless=new'];

function getBuiltContentScriptFiles() {
  if (!RUN_LIVE_TESTS) return [];
  return ['src/content.js'];
}

const CONTENT_SCRIPT_FILES = getBuiltContentScriptFiles();

const INSTALLED_DOWNLOADABLE_VOICE_IDS = new Set(
  getVoiceOptions({ includeDownloadable: true })
    .filter((voice) => voice.status === 'downloadable')
    .map((voice) => voice.id),
);

function getSelectedLiveLanguageGroups() {
  return LIVE_LANGUAGE_PAGE_GROUPS
    .filter((group) => LANGUAGE_FILTER.has(group.code))
    .map((group) => ({
      ...group,
      pages: group.pages.slice(0, MAX_PAGES_PER_LANGUAGE),
    }));
}

const WORD_HIGHLIGHT_TEXT_CHUNK_TYPES = new Set([
  'heading',
  'paragraph',
  'quote',
  'list-item',
  'caption',
  'table-row',
]);
const liveEvidenceState = { languages: [] };
let languagePagesEvidencePassed = false;

function writeCurrentLiveEvidence() {
  if (!RUN_LIVE_TESTS) return;
  writeLiveExtensionPagesEvidence(createLiveExtensionPagesEvidence({
    chromePath: CHROME_EXE,
    commitSha: resolveCandidateCommitSha(),
    zeroFailures: languagePagesEvidencePassed,
    config: {
      maxChunksPerPage: MAX_CHUNKS_PER_PAGE,
      maxPagesPerLanguage: MAX_PAGES_PER_LANGUAGE,
      languages: [...LANGUAGE_FILTER],
    },
    languages: liveEvidenceState.languages,
  }), {
    evidencePath: LIVE_EVIDENCE_PATH,
  });
}

async function waitFor(condition, message, timeoutMs = 30_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    value = await condition();
    if (value) return value;
    await delay(250);
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function evaluateExpression(cdp, sessionId, expression, options = {}) {
  return cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...options,
  }, sessionId);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function speechContainsAnchorText(chunk) {
  const anchorText = normalizeText(chunk.anchorText);
  if (!anchorText) return true;
  return normalizeText(chunk.speech).toLowerCase().includes(anchorText.toLowerCase());
}

function domWordAt(text, index) {
  const words = normalizeText(text).match(/\S+/g) || [];
  return words[Math.max(0, Math.min(words.length - 1, index))] || '';
}

function wordKey(value) {
  return normalizeText(value).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

function getChunkDomWordOffset(chunk) {
  const offset = Number.isFinite(Number(chunk?.globalDomWordStartIndex))
    ? Number(chunk.globalDomWordStartIndex)
    : Number(chunk?.domWordOffset);
  return Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
}

async function detectTextLanguage(cdp, serviceWorkerSessionId, text) {
  const sample = normalizeText(text).slice(0, 5000);
  const expression = `
    (async () => {
      return chrome.i18n.detectLanguage(${JSON.stringify(sample)});
    })()
  `;
  const result = await evaluateExpression(cdp, serviceWorkerSessionId, expression);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Language detection failed');
  }
  return result.result.value;
}

async function prepareLiveExtension(extensionDir) {
  await cp(DIST_DIR, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = Array.from(new Set([
    ...(manifest.host_permissions || []),
    'https://*.wikipedia.org/*',
  ]));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function sendContentMessage(cdp, serviceWorkerSessionId, message, targetUrl) {
  const expression = `
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const targetUrl = ${JSON.stringify(targetUrl || '')};
        const tab = targetUrl
          ? tabs.find((candidate) => candidate.url === targetUrl)
            || tabs.find((candidate) => candidate.url && targetUrl.startsWith(candidate.url))
            || tabs.find((candidate) => candidate.url && candidate.url.startsWith(targetUrl))
            || tabs.find((candidate) => candidate.active)
          : tabs.find((candidate) => candidate.active);
        if (!tab?.id) {
          throw new Error('No matching tab for PageNarrator live test');
        }
        try {
          return { ok: true, value: await chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}) };
        } catch (error) {
          const files = ${JSON.stringify(CONTENT_SCRIPT_FILES)};
          if (!files.length) throw error;
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
          for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
              return { ok: true, value: await chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}) };
            } catch (retryError) {
              if (attempt === 19) throw retryError;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }
      } catch (error) {
        const tabs = await chrome.tabs.query({});
        return {
          ok: false,
          error: error.message,
          debug: {
            targetUrl: ${JSON.stringify(targetUrl || '')},
            tabs: tabs.map((candidate) => ({ id: candidate.id, active: candidate.active, url: candidate.url, title: candidate.title })),
            message: ${JSON.stringify(message)},
            files: ${JSON.stringify(CONTENT_SCRIPT_FILES)},
          },
        };
      }
    })()
  `;
  const result = await evaluateExpression(cdp, serviceWorkerSessionId, expression);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Content message failed');
  }
  const payload = result.result.value;
  if (!payload?.ok) {
    throw new Error(`${payload?.error || 'Content message failed'} ${JSON.stringify(payload?.debug || {})}`);
  }
  return payload.value;
}

async function inspectPageHighlight(cdp, pageSessionId, chunk) {
  const expression = `
    (() => {
      const anchor = ${JSON.stringify(chunk.anchorId)}
        ? document.querySelector('[data-pagenarrator-id="${String(chunk.anchorId).replaceAll('"', '\\"')}"]')
        : null;
      const region = document.querySelector('[data-pagenarrator-region="active"]');
      const wordHighlight = CSS.highlights?.get('pagenarrator-word-0');
      const highlightedWord = wordHighlight ? Array.from(wordHighlight).map((range) => range.toString()).join(' ') : '';
      const anchorStyle = anchor ? getComputedStyle(anchor) : null;
      const regionStyle = region ? getComputedStyle(region) : null;
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        anchorText: anchor ? anchor.innerText || anchor.textContent || '' : '',
        anchorHighlighted: Boolean(anchor?.classList.contains('pagenarrator-current-block')),
        anchorBackground: anchorStyle?.backgroundColor || '',
        anchorBoxShadow: anchorStyle?.boxShadow || '',
        highlightStyleText: document.querySelector('#pagenarrator-highlight-styles')?.textContent || '',
        highlightAreaRgb: rootStyle.getPropertyValue('--pn-highlight-area-rgb').trim(),
        regionPresent: Boolean(region),
        regionBackground: regionStyle?.backgroundColor || '',
        regionBorder: regionStyle?.borderColor || '',
        highlightedWord,
      };
    })()
  `;
  const result = await evaluateExpression(cdp, pageSessionId, expression);
  return result.result.value;
}

async function hasVisibleHighlightAnchor(cdp, pageSessionId, chunk) {
  const expression = `
    (() => {
      const anchor = ${JSON.stringify(chunk.anchorId)}
        ? document.querySelector('[data-pagenarrator-id="${String(chunk.anchorId).replaceAll('"', '\\"')}"]')
        : null;
      if (!anchor) return false;
      const elementRects = Array.from(anchor.getClientRects?.() || []);
      if (elementRects.some((rect) => rect.width > 0 && rect.height > 0)) return true;

      const range = document.createRange();
      range.selectNodeContents(anchor);
      const rangeRects = Array.from(range.getClientRects?.() || []);
      return rangeRects.some((rect) => rect.width > 0 && rect.height > 0);
    })()
  `;
  const result = await evaluateExpression(cdp, pageSessionId, expression);
  return Boolean(result.result.value);
}

async function selectVisibleHighlightableChunks(cdp, pageSessionId, chunks, limit) {
  const selected = [];
  for (const chunk of chunks) {
    if (await hasVisibleHighlightAnchor(cdp, pageSessionId, chunk)) {
      selected.push(chunk);
      if (limit > 0 && selected.length >= limit) break;
    }
  }
  return selected;
}

describe.skipIf(!RUN_LIVE_TESTS)('live Chrome extension transcription and highlights', () => {
  let chromeProcess;
  let userDataDir;
  let liveExtensionDir;
  let cdp;
  let serviceWorkerSessionId;

  beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(tmpdir(), 'pagenarrator-live-'));
    liveExtensionDir = path.join(userDataDir, 'extension');
    await prepareLiveExtension(liveExtensionDir);

    chromeProcess = spawn(CHROME_EXE, [
      '--remote-debugging-pipe',
      '--mute-audio',
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${liveExtensionDir}`,
      `--load-extension=${liveExtensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-popup-blocking',
      '--disable-sync',
      ...HEADLESS_ARGS,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

    cdp = new CdpConnection(chromeProcess);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const serviceWorkerTarget = await waitFor(async () => {
      const targets = await cdp.send('Target.getTargets');
      return targets.targetInfos.find((target) => (
        target.type === 'service_worker'
        && target.url.startsWith('chrome-extension://')
        && target.url.endsWith('/service-worker-loader.js')
      ));
    }, 'PageNarrator service worker was not started');

    const attached = await cdp.send('Target.attachToTarget', {
      targetId: serviceWorkerTarget.targetId,
      flatten: true,
    });
    serviceWorkerSessionId = attached.sessionId;
    await cdp.send('Runtime.enable', {}, serviceWorkerSessionId);
  }, 30_000);

  afterAll(async () => {
    writeCurrentLiveEvidence();
    cdp?.close();
    if (chromeProcess && !chromeProcess.killed) {
      const exited = new Promise((resolve) => chromeProcess.once('exit', resolve));
      chromeProcess.kill();
      await Promise.race([exited, delay(5_000)]);
    }
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  it('transcribes 50 live public pages per launch language and highlights sampled reading queue items', async () => {
    const languageGroups = getSelectedLiveLanguageGroups();
    expect(languageGroups.length).toBeGreaterThan(0);

    for (const selectedGroup of languageGroups) {
      const group = await resolveLiveLanguageGroupPages(selectedGroup);
      expect(group.pages).toHaveLength(Math.min(MAX_PAGES_PER_LANGUAGE, LIVE_PAGE_COUNT_PER_LANGUAGE));
      const availability = getVoicesForDetectedLanguage(group.code, INSTALLED_DOWNLOADABLE_VOICE_IDS);
      const playableVoices = [...availability.installed, ...availability.bundled, ...availability.downloadable];
      expect(playableVoices.length, `${group.label} should have a readable TTS path`).toBeGreaterThan(0);
      const languageEvidence = {
        code: group.code,
        label: group.label,
        expectedPageCount: Math.min(MAX_PAGES_PER_LANGUAGE, LIVE_PAGE_COUNT_PER_LANGUAGE),
        pages: [],
      };
      liveEvidenceState.languages.push(languageEvidence);

      for (const page of group.pages) {
        const label = `${group.label} ${page.name}`;
        const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: created.targetId,
          flatten: true,
        });
        const pageSessionId = attached.sessionId;
        await cdp.send('Target.activateTarget', { targetId: created.targetId });
        await cdp.send('Page.enable', {}, pageSessionId);
        await cdp.send('Runtime.enable', {}, pageSessionId);
        const resolvedPageUrl = page.resolvedUrl || await resolveLivePageUrl(page);
        await cdp.send('Page.navigate', { url: resolvedPageUrl }, pageSessionId);
        await waitFor(
          async () => {
            const result = await evaluateExpression(cdp, pageSessionId, 'document.readyState');
            return ['interactive', 'complete'].includes(result.result.value);
          },
          `${label} did not finish initial navigation`,
          45_000,
        );
        const currentUrlResult = await evaluateExpression(cdp, pageSessionId, 'location.href');
        const currentUrl = currentUrlResult.result.value;

        let lastPingError;
        await waitFor(
          async () => {
            try {
              return await sendContentMessage(cdp, serviceWorkerSessionId, { type: 'pagenarratorPing' }, currentUrl);
            } catch (error) {
              lastPingError = error;
              return null;
            }
          },
          () => `${label} content script did not respond: ${lastPingError?.message || 'no error captured'}`,
          30_000,
        );

        const extraction = await sendContentMessage(cdp, serviceWorkerSessionId, { type: 'extract' }, currentUrl);
        expect(extraction, label).toMatchObject({ source: expect.any(String), text: expect.any(String) });
        expect(normalizeText(extraction.text).length, `${label} transcript length`).toBeGreaterThan(120);
        expect(extraction.text, `${label} transcript should avoid script noise`).not.toMatch(/<script|<\/script>|cookie consent settings/i);

        const detected = await detectTextLanguage(cdp, serviceWorkerSessionId, extraction.text);
        expect(
          detected.languages?.some((language) => language.language === group.code && language.percentage >= 20),
          `${label} should detect ${group.code}: ${JSON.stringify(detected.languages || [])}`,
        ).toBe(true);

        const highlightableChunks = (extraction.chunks || [])
          .filter((chunk) => (
            chunk.anchorId
            && chunk.speech
            && chunk.anchorText !== null
            && WORD_HIGHLIGHT_TEXT_CHUNK_TYPES.has(chunk.type)
          ));
        const chunks = await selectVisibleHighlightableChunks(
          cdp,
          pageSessionId,
          highlightableChunks,
          MAX_CHUNKS_PER_PAGE,
        );
        expect(chunks.length, `${label} highlightable queue items`).toBeGreaterThan(0);
        languageEvidence.pages.push({
          name: page.name,
          url: currentUrl,
          expectedLanguage: group.code,
          transcriptCharacters: normalizeText(extraction.text).length,
          chunkCount: chunks.length,
        });

        for (const chunk of chunks) {
          if (chunk.type !== 'table-row') {
            expect(speechContainsAnchorText(chunk), `${label}: "${chunk.speech}" should transcribe anchor text`).toBe(true);
          }

          const chunkHighlight = await sendContentMessage(cdp, serviceWorkerSessionId, {
            type: 'highlightChunk',
            anchorId: chunk.anchorId,
            text: chunk.anchorText,
          }, currentUrl);
          expect(chunkHighlight, `${label}: chunk highlight for ${chunk.anchorId}`).toMatchObject({ ok: true });

          const wordHighlight = await sendContentMessage(cdp, serviceWorkerSessionId, {
            type: 'highlightWord',
            index: getChunkDomWordOffset(chunk),
          }, currentUrl);
          expect(wordHighlight, `${label}: word highlight for ${chunk.anchorId}`).toMatchObject({ ok: true });

          const inspected = await inspectPageHighlight(cdp, pageSessionId, chunk);
          expect(inspected.anchorHighlighted, `${label}: block class for ${chunk.anchorId}`).toBe(true);
          expect(
            inspected.highlightStyleText.includes('pagenarrator-current-block')
              && inspected.highlightStyleText.includes('var(--pn-highlight-area-rgb)')
              && inspected.highlightAreaRgb === '255, 221, 87',
            `${label}: yellow block highlight CSS for ${chunk.anchorId}`,
          ).toBe(true);
          expect(inspected.regionPresent, `${label}: yellow region overlay for ${chunk.anchorId}`).toBe(true);
          expect(
            inspected.regionBackground.includes('255, 221, 87') || inspected.regionBorder.includes('255, 204, 51'),
            `${label}: yellow overlay color for ${chunk.anchorId}`,
          ).toBe(true);

          const expectedWord = domWordAt(inspected.anchorText || chunk.anchorText, getChunkDomWordOffset(chunk));
          const actualWordKey = wordKey(inspected.highlightedWord);
          const expectedWordKey = wordKey(expectedWord);
          expect(
            actualWordKey === expectedWordKey
              || expectedWordKey.startsWith(actualWordKey)
              || actualWordKey.startsWith(expectedWordKey),
            `${label}: word text for ${chunk.anchorId}`,
          ).toBe(true);
        }

        await sendContentMessage(cdp, serviceWorkerSessionId, { type: 'clearHighlight' }, currentUrl);
        await cdp.send('Target.closeTarget', { targetId: created.targetId });
      }
    }
    languagePagesEvidencePassed = true;
  }, LIVE_TEST_TIMEOUT_MS);
});
