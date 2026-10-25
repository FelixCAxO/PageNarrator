// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original injected-browser controls. No network requests, real pages or captured transcripts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { privateCaptureOutput, snapshotCorpus } from '../../scripts/snapshot-corpus.mjs';

const directories = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const html = '<!doctype html><html><body><p>An amber marker identifies the next inspection.</p><script>not executed</script></body></html>';
const target = ['authored-control.html', 'https://example.invalid/authored-control'];
async function output() {
  const root = await mkdtemp(path.join(tmpdir(), 'pn-private-html-control-')); directories.push(root);
  return path.join(root, 'capture');
}
function browserStandIn(status = 200) {
  const page = { goto: vi.fn().mockResolvedValue({ status: () => status }), waitForTimeout: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(html), url: () => target[1], close: vi.fn().mockResolvedValue(undefined) };
  const browser = { version: () => 'original-test-double', newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  return { page, browser, launch: vi.fn().mockResolvedValue(browser) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('pn-private-html-control-')) throw new Error('Unexpected cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('private HTML capture boundary', () => {
  it('refuses public source output and empty output while allowing private paths', () => {
    const root = path.resolve('/original-source-control');
    expect(() => privateCaptureOutput(path.join(root, 'tests/e2e/corpus'), root)).toThrow('public fixture paths');
    expect(() => privateCaptureOutput('', root)).toThrow('new private directory');
    expect(privateCaptureOutput(path.join(root, '.cache/captures/run1'), root)).toBe(path.join(root, '.cache/captures/run1'));
  });

  it('records exact original capture bytes, source, time and unknown redistribution status', async () => {
    const out = await output(), standIn = browserStandIn();
    const result = await snapshotCorpus({ output: out, browserType: standIn, captureTargets: [target] });
    const bytes = await readFile(path.join(out, target[0]));
    const manifest = JSON.parse(await readFile(path.join(out, 'capture-manifest.json'), 'utf8'));
    expect(bytes.toString('utf8')).toBe(html.replace('<script>not executed</script>', ''));
    expect(manifest.pages[0]).toMatchObject({ file: target[0], sourceUrl: target[1], finalUrl: target[1], status: 'captured',
      bytes: bytes.length, sha256: hash(bytes), renderedDomSha256: hash(Buffer.from(html)), pageCloseCompleted: true });
    expect(Number.isFinite(Date.parse(manifest.pages[0].capturedAt))).toBe(true);
    expect(manifest.redistributionPermission).toContain('Not established');
    expect(manifest.scope).toContain('not held-out quality evidence');
    expect(result.output).toBe(out); expect(manifest.status).toBe('captured');
    expect(manifest.browserCloseCompleted).toBe(true);
    expect(standIn.page.goto).toHaveBeenCalledWith(target[1], { waitUntil: 'domcontentloaded', timeout: 45000 });
    expect(standIn.page.close).toHaveBeenCalledTimes(1); expect(standIn.browser.close).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an existing capture or launch another browser for it', async () => {
    const out = await output(), standIn = browserStandIn();
    await snapshotCorpus({ output: out, browserType: standIn, captureTargets: [target] });
    const before = await readFile(path.join(out, 'capture-manifest.json'));
    await expect(snapshotCorpus({ output: out, browserType: standIn, captureTargets: [target] })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(out, 'capture-manifest.json'))).toEqual(before);
    expect(standIn.launch).toHaveBeenCalledTimes(1);
  });

  it('retains failed-source metadata and closes the injected browser without producing a page', async () => {
    const out = await output(), standIn = browserStandIn(403);
    await expect(snapshotCorpus({ output: out, browserType: standIn, captureTargets: [target] })).rejects.toThrow('HTTP 403');
    const manifest = JSON.parse(await readFile(path.join(out, 'capture-manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed'); expect(manifest.pages[0].httpStatus).toBe(403);
    expect(manifest.pages[0].status).toBe('failed'); expect(manifest.pages[0]).not.toHaveProperty('sha256');
    expect(manifest.browserCloseCompleted).toBe(true);
    expect(standIn.page.content).not.toHaveBeenCalled(); expect(standIn.browser.close).toHaveBeenCalledTimes(1);
  });
});
