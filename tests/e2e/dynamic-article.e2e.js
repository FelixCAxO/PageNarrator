import { expect, test } from '@playwright/test';
import {
  launchExtensionContext,
  seedFlowTestFlags,
  seedReadableTabTarget,
  startReadFromToolbarPopup,
} from './extension-fixture.js';

async function openArticle(context) {
  await context.route('https://dynamic.example.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<title>Initial story</title><style>
      #responsive { display: none; }
      @media (max-width: 600px) { #responsive { display: block; } }
    </style><main><article><h1>Initial story</h1>
      <p>Original reporting explains the library opening and its public reading programme.</p>
    </article></main>`,
  }));
  const page = await context.newPage();
  await page.goto('https://dynamic.example.test/initial');
  return page;
}

function engineState(worker) {
  return worker.evaluate(() => chrome.storage.session.get('readerEngineState')
    .then((value) => {
      const state = value.readerEngineState;
      if (state?.state === 'error') throw new Error(JSON.stringify(state));
      return state?.state || 'idle';
    }));
}

test('repeated instructions and superscript units retain native ranges after DOM replacement', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    for (const area of [50, 75]) {
      await page.locator('article').evaluate((article, area) => {
        article.innerHTML = `<h1>Updated instructions</h1><h2>Creation</h2><p>You must not:</p>
          <ul><li>Remove vegetation.</li></ul><h2>Restoration</h2><p>You must not:</p>
          <ul><li>Drain the pond.</li></ul><p>Area is ${area} <abbr title="metres">m</abbr><sup>2</sup>.</p>`;
      }, area);
      const article = await send({ type: 'extract', startMode: 'top' });
      const instructions = article.chunks.filter(chunk => chunk.anchorText === 'You must not:');
      expect(instructions).toHaveLength(2);
      expect(new Set(instructions.map(chunk => chunk.anchorId)).size).toBe(2);
      for (const chunk of instructions) {
        expect(await send({ type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText, chunkText: chunk.anchorText })).toMatchObject({ ok: true });
        expect(await send({ type: 'highlightWord', index: 0 })).toMatchObject({ ok: true });
        expect(await page.evaluate(anchorId => {
          const ranges = [...CSS.highlights.get('pagenarrator-word-0')];
          return ranges.length > 0 && ranges.every(range => range.startContainer.parentElement.closest(`[data-pagenarrator-id="${anchorId}"]`));
        }, chunk.anchorId)).toBe(true);
      }
      const unit = article.chunks.find(chunk => chunk.anchorText === `Area is ${area} m2.`);
      expect(unit).toBeTruthy();
      expect(await send({ type: 'highlightChunk', anchorId: unit.anchorId, text: unit.anchorText, chunkText: unit.anchorText })).toMatchObject({ ok: true });
      expect(await send({ type: 'highlightWord', index: 3 })).toMatchObject({ ok: true });
      expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0')].map(range => range.toString()).join(''))).toBe('m2');
    }
  } finally { await cleanup(); }
});

test('a fresh read extracts hydrated content after same-tab article navigation', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const played = () => worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' })
      .then((response) => response.log.filter((event) => event.kind === 'chunk_play')));
    const previousCount = (await played()).length;

    await page.evaluate(() => {
      history.pushState({}, '', '/updated');
      document.title = 'Updated story';
      document.querySelector('article').innerHTML = `<h1>Updated story</h1>
        <p>Fresh reporting describes a completely different exhibition and the visiting artists.</p>
        <p hidden>Lazy content describes the final schedule and the evening workshop.</p>`;
      document.querySelector('[hidden]').hidden = false;
    });
    const tabId = await seedReadableTabTarget(context, page);
    const article = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'extract' }), tabId);
    expect(article, JSON.stringify(article)).toMatchObject({ title: 'Updated story' });
    expect(article.text, JSON.stringify(article)).toContain('Fresh reporting');
    await startReadFromToolbarPopup(context, page);
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const speech = (await played()).slice(previousCount).map((event) => event.speechText).join(' ');
    expect(speech).toContain('Updated story');
    expect(speech).toContain('Fresh reporting');
    expect(speech).toContain('Lazy content');
    expect(speech).not.toMatch(/Original reporting|Initial story/);
  } finally { await cleanup(); }
});

test('figure prose and captions retain current native ranges after reveal and replacement', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    for (const label of ['fresh', 'updated']) {
      await page.locator('article').evaluate((article, label) => {
        article.innerHTML = `<figure hidden><div><h2>Field observations</h2>
          <p>Samples reveal ${label}.</p></div><figcaption><p>The ${label} sample.</p></figcaption>
          <button aria-label="Open caption"></button></figure>`;
      }, label);
      expect((await send({ type: 'extract', startMode: 'top' })).text).not.toContain(`Samples reveal ${label}`);
      await page.locator('figure').evaluate(figure => { figure.hidden = false; });
      const article = await send({ type: 'extract', startMode: 'top' });
      expect(article.chunks.filter(chunk => ['heading', 'paragraph', 'caption'].includes(chunk.type)).map(chunk => chunk.anchorText))
        .toEqual(['Field observations', `Samples reveal ${label}.`, `The ${label} sample.`]);
      expect(article.text).not.toContain('Open caption');
      for (const [text, index] of [[`Samples reveal ${label}.`, 2], [`The ${label} sample.`, 1]]) {
        const chunk = article.chunks.find(chunk => chunk.anchorText === text);
        expect(await send({ type: 'highlightChunk', anchorId: chunk.anchorId, text, chunkText: text })).toMatchObject({ ok: true });
        expect(await send({ type: 'highlightWord', index })).toMatchObject({ ok: true });
        expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0')].map(range => range.toString()).join(''))).toBe(label);
      }
    }
  } finally { await cleanup(); }
});

test('fallback highlights track revealed, replaced and responsive article text', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await page.setViewportSize({ width: 1000, height: 800 });
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const highlight = (text) => worker.evaluate(({ tabId, text }) => chrome.tabs.sendMessage(tabId,
      { type: 'highlightChunk', text }), { tabId, text });

    await page.evaluate(() => {
      document.querySelector('article').insertAdjacentHTML('beforeend',
        '<p id="revealed" hidden>Hydrated passage contains newly published vocabulary.</p>'
        + '<p id="responsive">Narrow layout reveals distinctive responsive vocabulary.</p>');
    });
    expect(await highlight('Original reporting explains the library opening and its public reading programme.')).toMatchObject({ ok: true });
    await page.locator('#revealed').evaluate((element) => { element.hidden = false; });
    expect(await highlight('Hydrated passage contains newly published vocabulary.')).toMatchObject({ ok: true });
    await page.locator('#revealed').evaluate((element) => { element.hidden = true; });
    expect(await highlight('Hydrated passage contains newly published vocabulary.')).toMatchObject({ ok: false });

    await page.setViewportSize({ width: 500, height: 800 });
    expect(await highlight('Narrow layout reveals distinctive responsive vocabulary.')).toMatchObject({ ok: true });
    await page.locator('#responsive').evaluate((element) => {
      element.outerHTML = '<p>Replacement paragraph changes the underlying DOM nodes.</p>';
    });
    expect(await highlight('Replacement paragraph changes the underlying DOM nodes.')).toMatchObject({ ok: true });
    expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-chunk')]
      .map((range) => range.toString()).join(' '))).toBe('Replacement paragraph changes the underlying DOM nodes.');
  } finally { await cleanup(); }
});

test('fresh reads re-evaluate a hydrated social signup panel without dropping its replacement prose', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const extract = () => worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'extract', startMode: 'top' }), tabId);
    await page.evaluate(() => document.querySelector('article').insertAdjacentHTML('beforeend',
      '<section id="social-signup-hydrated"><p>Hydrated panel describes fresh observations from the evening workshop.</p>'
      + '<form><label>Email address<input type="email"></label><button>Sign up</button></form></section>'
      + '<button aria-label="Clap button for article likes"><svg></svg></button>'));
    const withWidget = await extract();
    expect(withWidget.text).toContain('Original reporting');
    expect(withWidget.text).not.toMatch(/Hydrated panel|Email address|Sign up|Clap button/u);
    await page.locator('#social-signup-hydrated form').evaluate((form) => form.remove());
    const withProse = await extract();
    expect(withProse.text).toContain('Original reporting');
    expect(withProse.text).toContain('Hydrated panel describes fresh observations');
  } finally { await cleanup(); }
});

test('fresh extraction follows replaced form labels and a share widget replaced by prose', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const send = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    await page.evaluate(() => document.querySelector('article').insertAdjacentHTML('beforeend',
      '<site-share class="share-icons"><a href="/share" aria-label="Share on Facebook">Facebook</a></site-share>'
      + '<form><label for="feedback">Initial feedback question</label><textarea id="feedback"></textarea></form>'));
    for (const word of ['Initial', 'Revised']) {
      const article = await send({ type: 'extract', startMode: 'top' });
      expect(article.text).not.toContain('Facebook');
      const chunk = article.chunks.find((chunk) => chunk.type === 'form-field');
      expect(chunk.anchorText).toBe(`${word} feedback question`);
      expect(await send({ type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText })).toMatchObject({ ok: true });
      expect(await send({ type: 'highlightWord', index: 0 })).toMatchObject({ ok: true });
      expect(await page.evaluate(() => [...CSS.highlights.get('pagenarrator-word-0')]
        .map((range) => range.toString()).join(''))).toBe(word);
      await page.locator('label').evaluate((label) => { label.outerHTML = '<label for="feedback">Revised feedback question</label>'; });
    }
    await page.locator('site-share').evaluate((widget) => {
      widget.classList.remove('share-icons');
      widget.innerHTML = '<p>Newly revealed reporting describes the seasonal return.</p>';
    });
    expect((await send({ type: 'extract', startMode: 'top' })).text).toContain('Newly revealed reporting');
  } finally { await cleanup(); }
});

test('fresh extraction reads linked cards once and preserves different accessible labels', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const extract = () => worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'extract', startMode: 'top' }), tabId);
    await page.evaluate(() => document.querySelector('article').insertAdjacentHTML('beforeend',
      '<a id="guide" href="/guide"><h3>Woodland guide</h3><p>Explore the varied woodland landscapes.</p></a>'));
    for (const label of ['', 'Open the complete guide']) {
      await page.locator('#guide').evaluate((card, label) => {
        card.outerHTML = `<a id="guide" href="/guide" aria-label="${label}"><h3>Woodland guide</h3><p>Explore the varied woodland landscapes.</p></a>`;
      }, label);
      const article = await extract();
      expect(article.text.match(/Explore the varied woodland landscapes/gu)).toHaveLength(1);
      expect(article.text.match(/Woodland guide/gu)).toHaveLength(1);
      if (label) expect(article.text).toContain(label);
    }
  } finally { await cleanup(); }
});

test('hydrated quoted paragraphs retain their closing punctuation without a separate spoken stop', async () => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    for (const word of ['Initial', 'Replacement']) {
      const text = `“${word} reporting explains why the woodland remains quiet.”`;
      await page.locator('article').evaluate((article, text) => { article.innerHTML = `<h1>Updated story</h1><p>${text}</p>`; }, text);
      const extracted = await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'extract', startMode: 'top' }), tabId);
      expect(extracted.chunks.find(chunk => chunk.type === 'paragraph').speech).toBe(text);
      const previousCount = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }).then(result => result.log.length));
      await startReadFromToolbarPopup(context, page);
      await expect.poll(() => worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }).then(result => result.log.length))).toBeGreaterThan(previousCount);
      await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
      const played = await worker.evaluate(previousCount => chrome.runtime.sendMessage({ type: 'getFlowLog' })
        .then(result => result.log.slice(previousCount).filter(event => event.kind === 'chunk_play').map(event => event.speechText)), previousCount);
      expect(played.join(' ')).toContain(text);
      expect(played.every(speech => /[\p{L}\p{N}]/u.test(speech))).toBe(true);
    }
  } finally { await cleanup(); }
});


test('inline fallback streams microscope prose and highlights original nodes across formatting', async ({}, testInfo) => {
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  let originalNodes;
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
    // These authored DIVs intentionally select the real article-fallback path.
    // A BR separates words; adjacent inline letters remain one source word.
    await page.locator('article').evaluate(article => {
      document.title = 'Field observations';
      article.innerHTML = '<div id="split">The micro<strong>scope</strong> records the first sample.<br>Afterwards the complete record remains available for review.</div>'
        + '<div id="plain">The second observation explains the complete source record in ordinary prose.</div>';
    });
    originalNodes = await page.locator('#split').evaluateHandle(block => ({
      block,
      leading: block.firstChild,
      formatted: block.querySelector('strong').firstChild,
      afterFormatting: block.querySelector('strong').nextSibling,
      lineBreak: block.querySelector('br'),
      afterBreak: block.querySelector('br').nextSibling,
    }));
    const first = 'The microscope records the first sample. Afterwards the complete record remains available for review.';
    const second = 'The second observation explains the complete source record in ordinary prose.';
    const response = await send({ type: 'extract', startMode: 'top', streamChunks: true, speechChunkOptions: { maxLen: 10000 } });
    expect(response).toMatchObject({ source: 'article-fallback', streaming: true });
    expect(response.chunkStreamId).toMatch(/^article-stream-/u);
    const chunks = [];
    let done = false;
    try {
      // Two authored blocks plus EOF; a bounded extra response exposes duplication.
      for (let i = 0; i < 4; i += 1) {
        const next = await send({ type: 'getArticleChunk', streamId: response.chunkStreamId });
        expect(next.error, JSON.stringify(next)).toBeUndefined();
        if (next.done) { done = true; break; }
        expect(next.chunk).toBeTruthy();
        chunks.push(next.chunk);
      }
      expect(done).toBe(true);
    } finally {
      expect(await send({ type: 'closeArticleChunkStream', streamId: response.chunkStreamId })).toEqual({ closed: true });
    }
    expect(chunks.map(chunk => chunk.speech)).toEqual([first, second]);
    expect(chunks[0].anchorId).toBe(await page.locator('#split').getAttribute('data-pagenarrator-id'));
    expect(chunks[1].anchorId).toBe(await page.locator('#plain').getAttribute('data-pagenarrator-id'));
    expect(await send({ type: 'highlightChunk', anchorId: chunks[0].anchorId, text: first, chunkText: first })).toMatchObject({ ok: true });
    const evidence = [];
    for (const [index, word] of [[1, 'microscope'], [2, 'records'], [6, 'Afterwards']]) {
      expect(await send({ type: 'highlightWord', index })).toMatchObject({ ok: true });
      const actual = await originalNodes.evaluate(({ block, leading, formatted, afterFormatting, lineBreak, afterBreak }, word) => {
        const ranges = [...(CSS.highlights.get('pagenarrator-word-0') || [])];
        const range = ranges[0], expectedStart = word === 'microscope' ? leading : word === 'records' ? afterFormatting : afterBreak;
        const expectedEnd = word === 'microscope' ? formatted : expectedStart;
        const rect = range?.getBoundingClientRect();
        return {
          word, rangeCount: ranges.length, text: range?.toString() ?? null,
          nativeRange: range instanceof Range, collapsed: range?.collapsed ?? null,
          originalStartNode: range?.startContainer === expectedStart, originalEndNode: range?.endContainer === expectedEnd,
          startOffset: range?.startOffset ?? null, endOffset: range?.endOffset ?? null,
          sourceNodesConnected: leading.isConnected && formatted.isConnected && expectedStart.isConnected && block.contains(expectedEnd),
          leadingUnchanged: block.firstChild === leading && leading.nodeValue === 'The micro',
          formattedUnchanged: block.querySelector('strong').firstChild === formatted && formatted.nodeValue === 'scope',
          breakUnchanged: block.querySelector('br') === lineBreak && lineBreak.nextSibling === afterBreak,
          positiveClientRects: range ? [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).length : 0,
          bounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        };
      }, word);
      evidence.push(actual);
      expect(actual).toMatchObject({ rangeCount: 1, text: word, nativeRange: true, collapsed: false,
        originalStartNode: true, originalEndNode: true, sourceNodesConnected: true,
        leadingUnchanged: true, formattedUnchanged: true, breakUnchanged: true });
      expect(actual.positiveClientRects).toBeGreaterThan(0);
      expect(actual.bounds.width).toBeGreaterThan(0);
      expect(actual.bounds.height).toBeGreaterThan(0);
    }
    expect(evidence.map(row => [row.startOffset, row.endOffset])).toEqual([[4, 5], [1, 8], [0, 10]]);
    await testInfo.attach('inline-fallback-native-range-evidence', {
      body: Buffer.from(JSON.stringify({ source: response.source, chunks, ranges: evidence }, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    try { await originalNodes?.dispose(); } finally { await cleanup(); }
  }
});


test('punctuation fallback and selected inline prose retain their original word ranges', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['https://dynamic.example.test/*'] });
  let punctuationNodes, selectionNodes;
  try {
    await seedFlowTestFlags(context);
    const page = await openArticle(context);
    await startReadFromToolbarPopup(context, page);
    const worker = context.serviceWorkers()[0];
    await expect.poll(() => engineState(worker), { timeout: 30_000 }).toBe('finished');
    const tabId = await seedReadableTabTarget(context, page);
    const send = message => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });

    // Reuse the frozen separate-curly-apostrophe DOM control, without changing its text.
    await page.locator('article').evaluate(article => {
      document.title = 'Source notes';
      article.innerHTML = '<div id="target">O<span>’</span>Neill records each sample before the final analysis begins.</div>'
        + '<div>The second observation explains the complete source record in ordinary prose.</div>';
    });
    punctuationNodes = await page.locator('#target').evaluateHandle(block => ({
      block, leading: block.firstChild, punctuation: block.querySelector('span').firstChild,
      following: block.querySelector('span').nextSibling,
    }));
    const first = 'O’Neill records each sample before the final analysis begins.';
    const second = 'The second observation explains the complete source record in ordinary prose.';
    const streamed = await send({ type: 'extract', startMode: 'top', streamChunks: true, speechChunkOptions: { maxLen: 10000 } });
    expect(streamed).toMatchObject({ source: 'article-fallback', streaming: true });
    const chunks = [];
    let done = false;
    try {
      for (let i = 0; i < 4; i += 1) {
        const next = await send({ type: 'getArticleChunk', streamId: streamed.chunkStreamId });
        expect(next.error, JSON.stringify(next)).toBeUndefined();
        if (next.done) { done = true; break; }
        expect(next.chunk).toBeTruthy(); chunks.push(next.chunk);
      }
      expect(done).toBe(true);
    } finally {
      expect(await send({ type: 'closeArticleChunkStream', streamId: streamed.chunkStreamId })).toEqual({ closed: true });
    }
    expect(chunks.map(chunk => chunk.speech)).toEqual([first, second]);
    expect(chunks[0].anchorId).toBe(await page.locator('#target').getAttribute('data-pagenarrator-id'));
    expect(chunks[1].anchorId).toBe(await page.locator('article > div').last().getAttribute('data-pagenarrator-id'));
    expect(await send({ type: 'highlightChunk', anchorId: chunks[0].anchorId, text: first, chunkText: first })).toMatchObject({ ok: true });
    expect(await send({ type: 'highlightWord', index: 1 })).toMatchObject({ ok: true });
    const punctuationRange = await punctuationNodes.evaluate(({ block, leading, punctuation, following }) => {
      const ranges = [...(CSS.highlights.get('pagenarrator-word-0') || [])], range = ranges[0];
      return {
        count: ranges.length, text: range?.toString(), native: range instanceof Range, collapsed: range?.collapsed,
        originalStart: range?.startContainer === following, originalEnd: range?.endContainer === following,
        start: range?.startOffset, end: range?.endOffset,
        sourceUnchanged: block.firstChild === leading && leading.nodeValue === 'O'
          && block.querySelector('span').firstChild === punctuation && punctuation.nodeValue === '’'
          && punctuation.parentNode.nextSibling === following && following.nodeValue === 'Neill records each sample before the final analysis begins.'
          && [leading, punctuation, following].every(node => node.isConnected),
        positiveRects: range ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length : 0,
      };
    });
    expect(punctuationRange).toMatchObject({ count: 1, text: 'records', native: true, collapsed: false,
      originalStart: true, originalEnd: true, start: 6, end: 13, sourceUnchanged: true });
    expect(punctuationRange.positiveRects).toBeGreaterThan(0);

    // Reuse the frozen selection-after-joined-word control and a real browser Selection.
    await page.locator('article').evaluate(article => {
      article.innerHTML = '<p id="target">The micro<strong>scope</strong> records each sample before the final analysis begins.</p>';
      const block = article.querySelector('#target'), text = block.querySelector('strong').nextSibling;
      const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, text.nodeValue.length);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    selectionNodes = await page.locator('#target').evaluateHandle(block => ({
      block, leading: block.firstChild, formatted: block.querySelector('strong').firstChild,
      following: block.querySelector('strong').nextSibling,
    }));
    const selectedText = 'records each sample before the final analysis begins.';
    const rawSelection = await page.evaluate(() => ({ selection: getSelection().toString(), range: getSelection().getRangeAt(0).toString() }));
    expect(rawSelection).toEqual({ selection: selectedText, range: selectedText });
    const selected = await send({ type: 'extract', readSelection: true, startMode: 'top' });
    expect(selected).toMatchObject({ source: 'selection', text: selectedText, startPosition: { text: selectedText } });
    expect(selected.chunks).toHaveLength(1);
    const chunk = selected.chunks[0];
    expect(chunk).toMatchObject({ speech: selectedText, anchorText: selectedText, domWordOffset: 2 });
    expect(chunk.anchorId).toBe(await page.locator('#target').getAttribute('data-pagenarrator-id'));
    expect(await send({ type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
      chunkText: chunk.speech, domWordOffset: chunk.domWordOffset })).toMatchObject({ ok: true });
    expect(await send({ type: 'highlightWord', index: chunk.domWordOffset })).toMatchObject({ ok: true });
    const selectionRange = await selectionNodes.evaluate(({ block, leading, formatted, following }) => {
      const ranges = [...(CSS.highlights.get('pagenarrator-word-0') || [])], range = ranges[0];
      return {
        count: ranges.length, text: range?.toString(), native: range instanceof Range, collapsed: range?.collapsed,
        originalStart: range?.startContainer === following, originalEnd: range?.endContainer === following,
        start: range?.startOffset, end: range?.endOffset,
        sourceUnchanged: block.firstChild === leading && leading.nodeValue === 'The micro'
          && block.querySelector('strong').firstChild === formatted && formatted.nodeValue === 'scope'
          && formatted.parentNode.nextSibling === following && following.nodeValue === ' records each sample before the final analysis begins.'
          && [leading, formatted, following].every(node => node.isConnected),
        positiveRects: range ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length : 0,
      };
    });
    expect(selectionRange).toMatchObject({ count: 1, text: 'records', native: true, collapsed: false,
      originalStart: true, originalEnd: true, start: 1, end: 8, sourceUnchanged: true });
    expect(selectionRange.positiveRects).toBeGreaterThan(0);
    await testInfo.attach('punctuation-selection-original-range-evidence', {
      body: Buffer.from(JSON.stringify({ chunks, punctuationRange, rawSelection, selected, selectionRange }, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    try { await punctuationNodes?.dispose(); }
    finally { try { await selectionNodes?.dispose(); } finally { await cleanup(); } }
  }
});
