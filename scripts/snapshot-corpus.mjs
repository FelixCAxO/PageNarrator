// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Private development captures only. Source availability does not grant redistribution.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const targets = [
  ['wikipedia-en-Internet.html', 'https://en.wikipedia.org/wiki/Internet'],
  ['mdn-web-docs-fetch.html', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'],
  ['react-dev-reference-usememo.html', 'https://react.dev/reference/react/useMemo'],
  ['github-readme-project.html', 'https://github.com/mdn/content#readme'],
  ['news-ycombinator-item-1.html', 'https://news.ycombinator.com/'],
  ['python-org-pep-1.html', 'https://peps.python.org/pep-0008/'],
  ['rust-lang-blog-1.html', 'https://blog.rust-lang.org/'],
  ['go-dev-blog-1.html', 'https://go.dev/blog/'],
  ['cloudflare-blog-workers-1.html', 'https://blog.cloudflare.com/workers/'],
  ['sqlite-docs-queryplanner-1.html', 'https://www.sqlite.org/queryplanner.html'],
];

function stripSnapshot(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/\s(?:nonce|integrity|crossorigin)="[^"]*"/gi, '')
    .replace(/\sdata-[a-z0-9_-]+=""/gi, '');
}

export function privateCaptureOutput(output, sourceRoot = SOURCE_ROOT) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Capture output must name a new private directory.');
  const absolute = path.resolve(output), relative = path.relative(sourceRoot, absolute);
  const insideSource = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (insideSource && !relative.startsWith(`.cache${path.sep}`)) {
    throw new Error('Captures inside the checkout must be under .cache; public fixture paths are not capture output.');
  }
  return absolute;
}

export async function snapshotCorpus({ output, browserType = chromium, captureTargets = targets } = {}) {
  const startedAt = new Date().toISOString();
  const outDir = privateCaptureOutput(output ?? path.join(SOURCE_ROOT, '.cache/html-corpus-captures', startedAt.replace(/[:.]/g, '-')));
  for (const [slug] of captureTargets) {
    if (slug !== path.basename(slug) || /[\\/]/.test(slug) || !slug.endsWith('.html')) throw new Error('Capture filename must be a plain HTML filename.');
  }
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir); // Refuse any existing directory before launching a browser.
  const manifest = {
    schema: 'pagenarrator-private-html-capture-v1', startedAt,
    producer: { file: 'scripts/snapshot-corpus.mjs', sha256: hash(await readFile(fileURLToPath(import.meta.url))) },
    captureKind: 'Rendered page DOM after domcontentloaded and a 2000 ms wait; scripts/noscript and selected attributes stripped.',
    scope: 'Private development flow inputs, not held-out quality evidence or public source-package inputs.',
    redistributionPermission: 'Not established by this capture. Source availability is not a redistribution grant.',
    status: 'incomplete', pages: [], cleanupErrors: [], browserCloseCompleted: false,
  };
  let browser, failure;
  try {
    browser = await browserType.launch();
    manifest.browserVersion = browser.version();
    for (const [slug, url] of captureTargets) {
      const record = { file: slug, sourceUrl: url, status: 'incomplete', pageCloseCompleted: false };
      manifest.pages.push(record);
      let page;
      try {
        page = await browser.newPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        record.httpStatus = response?.status() ?? null;
        if (record.httpStatus >= 400) throw new Error(`Capture source returned HTTP ${record.httpStatus}: ${url}`);
        await page.waitForTimeout(2000);
        const renderedDom = Buffer.from(await page.content(), 'utf8');
        const bytes = Buffer.from(stripSnapshot(renderedDom.toString('utf8')), 'utf8');
        await writeFile(path.join(outDir, slug), bytes, { flag: 'wx' });
        Object.assign(record, { status: 'captured', capturedAt: new Date().toISOString(), finalUrl: page.url(),
          renderedDomBytes: renderedDom.length, renderedDomSha256: hash(renderedDom), bytes: bytes.length, sha256: hash(bytes) });
      } catch (error) {
        record.status = 'failed'; record.error = error.message; throw error;
      } finally {
        if (page) {
          try { await page.close(); record.pageCloseCompleted = true; }
          catch (error) { manifest.cleanupErrors.push({ file: slug, stage: 'page.close', error: error.message }); }
        }
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (browser) {
      try { await browser.close(); manifest.browserCloseCompleted = true; }
      catch (error) { manifest.cleanupErrors.push({ stage: 'browser.close', error: error.message }); }
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.status = failure || manifest.cleanupErrors.length ? 'failed' : 'captured';
    if (failure) manifest.error = failure.message;
    await writeFile(path.join(outDir, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  if (failure) throw failure;
  if (manifest.cleanupErrors.length) throw new Error('Capture cleanup failed; see the private capture manifest.');
  return { output: outDir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/snapshot-corpus.mjs [--output NEW_PRIVATE_DIRECTORY]');
  const result = await snapshotCorpus({ output: args[1] });
  console.log(JSON.stringify({ output: result.output, status: result.manifest.status, capturedPages: result.manifest.pages.length }));
}
