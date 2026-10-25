import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = process.cwd();
if (process.platform !== 'linux' || !process.env.DISPLAY || !process.env.PN_E2E_EXTENSION_DIR) {
  throw new Error('Capture in an isolated Linux/Xvfb desktop (1280x880), with ImageMagick installed and PN_E2E_EXTENSION_DIR set to the release being submitted. Never run this against your desktop or rebuild the release for screenshots.');
}
const { startCorpusFixtureServer } = await import(pathToFileURL(path.join(root, 'tests/e2e/corpus-fixture-server.js')));
const { routeKokoroModelFiles, seedKokoroModelCache } = await import(pathToFileURL(path.join(root, 'tests/e2e/kokoro-download-fixture.js')));
const outputDir = path.resolve(process.env.PN_CAPTURE_OUTPUT_DIR || path.join(root, 'artifacts/product-media'));
const sourceDir = path.join(root, 'website/public');
const scratch = await mkdtemp(path.join(tmpdir(), 'pagenarrator-native-media-'));
const extensionDir = path.join(scratch, 'extension');
const inputDir = path.resolve(process.env.PN_E2E_EXTENSION_DIR);
const inputPackage = await fingerprintPackage(inputDir);
const pdfName = 'pagenarrator-listening-guide.pdf';
const GUIDE_PDF_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Listening to Long Documents</title><style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1b1b1b; font-size: 12.5pt; line-height: 1.55; }
  h1 { font-size: 24pt; margin: 0 0 4pt; text-align: center; }
  .byline { text-align: center; color: #555; margin-bottom: 22pt; }
  h2 { font-size: 15pt; margin: 20pt 0 6pt; }
  p { margin: 0 0 10pt; text-align: justify; }
</style></head><body>
  <h1>Listening to Long Documents</h1>
  <p class="byline">A PageNarrator reading guide</p>
  <h2>Abstract</h2>
  <p>PageNarrator reads PDFs aloud while keeping the page visible. Highlights follow the text. Your position is saved so you can return later.</p>
  <h2>1. Choose a starting point</h2>
  <p>Open the PDF and choose Read page in the toolbar. Reading starts on the visible page or at your saved position. Use Read selected for a highlighted passage.</p>
  <h2>2. Follow along on the page</h2>
  <p>The current passage stays highlighted and in view. Pause to check a figure or citation, then resume.</p>
  <h2>3. Adjust the pace</h2>
  <p>Set speed from 0.5× to 3× and adjust section pauses. Use the transcript to choose a section.</p>
  <h2>4. Pick up where you left off</h2>
  <p>Reopen the document and resume where you stopped. The position stays on this device.</p>
  <h2>5. Keep your reading private</h2>
  <p>Missing voice files download from Hugging Face. Speech runs locally. PageNarrator does not receive the text for narration.</p>
</body></html>`;
await mkdir(outputDir, { recursive: true });
await cp(inputDir, extensionDir, { recursive: true });
// Only the temporary copy gains local-demo access and tab metadata. Programmatic
// openPopup does not grant activeTab like a real toolbar click. UI/models stay unchanged.
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
manifest.permissions = [...new Set([...manifest.permissions, 'tabs'])];
await writeFile(manifestPath, JSON.stringify(manifest));
await writeGuidePdf(path.join(scratch, pdfName));
const server = await startCorpusFixtureServer({ corpusDir: sourceDir });
const pdfServer = await startCorpusFixtureServer({ corpusDir: scratch });
const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
  channel: 'chromium', headless: false, viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--mute-audio', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
    '--window-position=0,0', '--window-size=1280,880', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required'],
});
try {
  await routeKokoroModelFiles(context);
  await seedKokoroModelCache(context);
  const article = context.pages()[0];
  await article.goto(server.urlFor('cws-demo.html'), { waitUntil: 'networkidle' });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ 'voiceSetupPending.v1': false }));
  const cdp = await context.newCDPSession(article);
  let popupSession;
  let popupTarget;
  let commandId = 0;
  // Native action popups are CDP targets but are not Playwright pages. Attach directly;
  // opening popup.html in a tab and pasting its screenshot would misrepresent the UI.
  async function popupCommand(method, params) {
    const id = ++commandId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error('Popup command timed out')); }, 15000);
      const listener = (event) => {
        if (event.sessionId !== popupSession) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve(message.result);
      };
      cdp.on('Target.receivedMessageFromTarget', listener);
    });
    await cdp.send('Target.sendMessageToTarget', { sessionId: popupSession, message: JSON.stringify({ id, method, params }) });
    return response;
  }
  async function popupEval(expression) {
    return (await popupCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  }
  async function popupClick(selector) {
    const point = await popupEval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Capture control is unavailable');
      element.scrollIntoView({block:'nearest'});
      const rect = element.getBoundingClientRect();
      return {x:rect.x + rect.width / 2, y:rect.y + rect.height / 2};
    })()`);
    await popupCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await popupCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function waitPopup(expression, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (!(await popupEval(expression))) {
      if (Date.now() > deadline) throw new Error(`Popup condition timed out: ${expression}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async function openPopup(page) {
    await page.bringToFront();
    // Programmatic openPopup does not record the toolbar invocation's target tab.
    await worker.evaluate(async ({ url, title }) => {
      const tabs = await chrome.tabs.query({});
      if (tabs.length !== 1 || !tabs[0].active) throw new Error('Capture requires exactly one active reading tab.');
      const tab = tabs[0];
      await chrome.storage.local.set({ readableTabTarget: { tabId: tab.id, tabSnapshot: { id: tab.id, url, title }, createdAt: Date.now() } });
    }, { url: page.url(), title: await page.title() });
    await worker.evaluate(() => chrome.action.openPopup());
    const targets = await cdp.send('Target.getTargets');
    const target = targets.targetInfos.find(info => info.url.endsWith('/src/popup.html'));
    if (!target) throw new Error('The native toolbar popup did not open. No tab/composite fallback is allowed.');
    popupTarget = target.targetId;
    popupSession = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })).sessionId;
    await waitPopup('document.readyState === "complete"');
  }
  async function capture(name) {
    // One native display capture includes the real browser and its real popup.
    // No page styles, popup geometry, highlights, progress, or pixels are synthesized.
    await popupEval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 250));
    const raw = path.join(outputDir, `raw-${name}`);
    execFileSync('import', ['-window', 'root', raw]);
    const metadata = await sharp(raw).metadata();
    if (metadata.width !== 1280 || metadata.height !== 880) throw new Error('Xvfb must be 1280x880; screenshots are never resized or composited.');
    // Crop only the tabs/address bar above the native popup; preserve every UI pixel.
    await sharp(raw).extract({ left: 0, top: 80, width: 1280, height: 800 }).removeAlpha().png().toFile(path.join(outputDir, name));
    const state = await popupEval(`({
      status: document.getElementById('popup-status').textContent,
      advancedOpen: document.getElementById('popup-advanced').open,
      visibleControls: [...document.querySelectorAll('input[id], select[id], button[id]')]
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight; })
        .map(element => element.id)
    })`);
    await writeFile(path.join(outputDir, `${name}.json`), JSON.stringify(state, null, 2) + '\n');
    console.log(`Captured ${name}: ${await popupEval('document.getElementById("popup-status").textContent')}`);
  }
  await openPopup(article);
  await waitPopup('document.querySelector("#start-reading:not([disabled])") !== null');
  await capture('screenshot-01-toolbar-player-idle.png');
  await popupClick('#start-reading');
  await waitForWordHighlight(article);
  await waitPopup('document.getElementById("popup-status").textContent === "Reading"');
  await article.evaluate(() => window.scrollTo(0, 0));
  await capture('screenshot-02-toolbar-player-reading.png');
  await popupClick('#popup-toggle');
  await waitPopup('document.getElementById("popup-status").textContent === "Paused"');
  await popupClick('#popup-advanced > summary');
  await popupEval('document.getElementById("popup-advanced").scrollIntoView({block:"start"})');
  await capture('screenshot-03-toolbar-player-settings.png');
  await popupClick('#popup-stop');
  await cdp.send('Target.closeTarget', { targetId: popupTarget });
  const extensionId = new URL(worker.url()).hostname;
  await article.goto(`chrome-extension://${extensionId}/src/pdf-viewer.html?src=${encodeURIComponent(pdfServer.urlFor(pdfName))}`);
  await article.waitForFunction(() => (document.querySelector('[data-pagenarrator-id="pdf-page-1"] .textLayer')?.textContent.length || 0) > 200, null, { timeout: 30000 });
  await openPopup(article);
  await waitPopup('document.querySelector("#start-reading:not([disabled])") !== null');
  await popupClick('#start-reading');
  await waitForWordHighlight(article);
  await waitPopup('document.getElementById("popup-status").textContent === "Reading"');
  await article.waitForFunction(() => [...(CSS.highlights?.get('pagenarrator-word-0') || [])]
    .some(range => [...range.getClientRects()].some(rect => rect.width > 60 && rect.right < 700 && rect.top > 0 && rect.bottom < innerHeight)), null, { timeout: 30000 });
  await capture('screenshot-04-toolbar-player-pdf.png');
  await popupClick('#popup-stop');
  await waitPopup('document.getElementById("popup-status").textContent !== "Reading"');
  await popupEval('document.getElementById("popup-tts-engine").focus()');
  for (const type of ['keyDown', 'keyUp']) {
    await popupCommand('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  }
  await waitPopup('document.getElementById("popup-tts-engine").value === "omnivoice" && !document.getElementById("popup-omnivoice-settings").hidden');
  if (!(await popupEval('document.getElementById("popup-settings").open'))) await popupClick('#popup-settings > summary');
  await popupEval('document.getElementById("popup-settings").scrollIntoView({block:"start"})');
  await capture('screenshot-05-omnivoice-controls.png');
  await writePromoTile(path.join(outputDir, 'promo-tile-440x280.png'));
  if (JSON.stringify(await fingerprintPackage(inputDir)) !== JSON.stringify(inputPackage)) throw new Error('The selected release changed during capture.');
  await finalizeMedia();
} finally {
  await context.close();
  await server.close(); await pdfServer.close();
  await rm(scratch, { recursive: true, force: true });
}

async function waitForWordHighlight(page) {
  await page.waitForFunction(() => [...(CSS.highlights?.get('pagenarrator-word-0') || [])]
    .some(range => [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)), null, { timeout: 180000 });
}
async function writeGuidePdf(outputPath) {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent(GUIDE_PDF_HTML);
    await page.pdf({ path: outputPath, format: 'Letter', margin: { top: '0.9in', bottom: '0.9in', left: '1in', right: '1in' } });
  } finally { await browser.close(); }
}
async function writePromoTile(outputPath) {
  const width = 440;
  const height = 280;
  const badgeSize = 132;
  const iconSize = 112;
  const icon = await sharp(path.join(root, 'icons', 'PageNarrator_Icon_Transparent.png'))
    .trim()
    .resize({ width: iconSize, height: iconSize, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const badgeLeft = 34;
  const badgeTop = Math.round((height - badgeSize) / 2);
  const background = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3f7cf0"/><stop offset="1" stop-color="#1d3fa8"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect x="${badgeLeft}" y="${badgeTop}" width="${badgeSize}" height="${badgeSize}" rx="30" fill="#ffffff"/>
      <text x="${badgeLeft + badgeSize + 22}" y="${height / 2 + 13}" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#ffffff">PageNarrator</text>
    </svg>`);
  const offset = Math.round((badgeSize - iconSize) / 2);
  await sharp(background)
    .composite([{ input: icon, left: badgeLeft + offset, top: badgeTop + offset }])
    .removeAlpha()
    .png()
    .toFile(outputPath);
}

async function finalizeMedia() {
  const storeDir = path.join(root, 'docs/cws-listing');
  const websiteDir = path.join(root, 'website/public');
  const pairs = [
    ['screenshot-01-toolbar-player-idle.png', 'toolbar-player-idle.png'],
    ['screenshot-02-toolbar-player-reading.png', 'toolbar-player-reading.png'],
    ['screenshot-03-toolbar-player-settings.png', 'toolbar-player-settings.png'],
    ['screenshot-04-toolbar-player-pdf.png', 'toolbar-player-pdf.png'],
    ['screenshot-05-omnivoice-controls.png', 'omnivoice-controls.png'],
  ];
  const images = [];
  for (const [name, website] of pairs) {
    const bytes = await readFile(path.join(outputDir, name));
    await writeFile(path.join(storeDir, name), bytes);
    await writeFile(path.join(websiteDir, 'assets/screenshots', website), bytes);
    images.push({ name, sha256: hash(bytes), rawCaptureSha256: hash(await readFile(path.join(outputDir, `raw-${name}`))),
      nativePixelsUnchanged: true, state: JSON.parse(await readFile(path.join(outputDir, `${name}.json`), 'utf8')) });
  }
  await cp(path.join(outputDir, 'promo-tile-440x280.png'), path.join(storeDir, 'promo-tile-440x280.png'));
  const reading = path.join(websiteDir, 'assets/screenshots/toolbar-player-reading.png');
  await sharp(reading).webp({ lossless: true, quality: 100, effort: 6, preset: 'text' }).toFile(path.join(websiteDir, 'assets/screenshots/toolbar-player-reading.webp'));
  await sharp(reading).resize(1200, 630, { fit: 'cover', position: 'north' }).jpeg({ quality: 88 }).toFile(path.join(websiteDir, 'og-image.jpg'));
  for (const name of (await readdir(websiteDir)).filter(name => name.endsWith('.html'))) {
    let html = await readFile(path.join(websiteDir, name), 'utf8');
    const resources = [...new Set([...html.matchAll(/(\/assets\/(?:site-[\w.-]+\.css|screenshots\/[\w.-]+\.(?:png|webp))|\/og-image\.jpg)(?:\?v=[a-f0-9]+)?/g)].map(match => match[0]))];
    for (const resource of resources) {
      const asset = resource.split('?')[0];
      const bytes = await readFile(path.join(websiteDir, asset));
      const version = hash(asset.endsWith('.css') ? bytes.toString().replace(/\r\n/g, '\n') : bytes).slice(0, 12);
      html = html.replaceAll(resource, `${asset}?v=${version}`);
    }
    await writeFile(path.join(websiteDir, name), html);
  }
  const sourceSha256 = {};
  for (const name of ['src/popup.html', 'src/popup.css', 'src/popup.js', 'src/pdf-viewer.html', 'src/pdf-viewer.css', 'src/pdf-viewer.js',
    'website/public/cws-demo.html', 'scripts/capture-current-product-media.mjs']) {
    sourceSha256[name] = hash((await readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n'));
  }
  const provenance = {
    method: 'One native X11 display capture per image; crop top 80 pixels, convert to RGB. No screenshot composition, resizing, or UI layout overrides.',
    environment: `Isolated Playwright ${JSON.parse(await readFile(path.join(root, 'node_modules/playwright/package.json'), 'utf8')).version} / Chromium ${context.browser().version()} / ${process.platform} / Xvfb / Openbox.`,
    fixturePermissions: 'Disposable extension copy adds tabs and localhost access. Pinned, hash-verified model fixtures seed the cache; actual packaged synthesis produces speech.',
    version: manifest.version, artifact: 'Explicitly selected packaged extension; screenshots only, no Store submission.',
    capturedAt: new Date().toISOString(), nodeVersion: process.version, inputPackage,
    sourceHashNormalization: 'UTF-8 with CRLF normalized to LF.', sourceSha256,
    brandIconSha256: hash(await readFile(path.join(websiteDir, 'assets/pagenarrator-icon.png'))),
    width: 1280, height: 800, images,
  };
  await writeFile(path.join(storeDir, 'capture-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log('Updated store media, website derivatives, asset versions, and source-bound provenance.');
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fingerprintPackage(directory) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: path.relative(directory, file).split(path.sep).join('/'), bytes: bytes.length, sha256: hash(bytes) });
      } else throw new Error('The capture package contains a non-file entry.');
    }
  }
  await visit(directory);
  if (!files.length) throw new Error('The selected capture package is empty.');
  return { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: hash(files.map(file => `${file.path}\0${file.sha256}`).sort().join('\n')) };
}
