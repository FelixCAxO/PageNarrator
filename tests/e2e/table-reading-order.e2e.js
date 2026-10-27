import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { DEADLINE_ROWS, deadlineTableHtml, tablePdfItems, WRAPPED_SWEDISH_ROWS, wrappedSwedishTableItems, SECURITY_TABLE_ROWS, securityTableItems, studyTableFixture } from '../fixtures/reading-order-fixtures.js';
import { buildPdfBytes } from '../helpers/pdf-test-generator.js';
import { buildSidenoteReadingOrderPattern } from '../helpers/sidenote-reading-order-patterns.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
import { tokenizeSpokenWords } from '../../src/lib/speech-tokenization.js';
import { buildCorpusFlowReport } from './corpus-flow-invariants.js';
import {
  launchExtensionContext, openPdfViewer, recordPlaybackEvents, seedFlowTestFlags, seedReadableTabTarget, startReadFromToolbarPopup,
} from './extension-fixture.js';

// Speech omits standalone slash/dash separators; cell words and dates must stay intact.
const normalize = (text) => text.replace(/\s+[/\-]\s+/gu, ' ').replace(/\s+/gu, ' ');
const sidenoteFixture = buildSidenoteReadingOrderPattern({ parameters: {
  side: 'right', anchorParagraph: 1, noteLines: 5, bodyLines: 3, noteFontRatio: 0.8,
  sourceOrder: 'columns', fragmentation: 'lines', scale: 1, rotation: 0,
} });

for (const { format, table, cells, pdfItems, width, height = 792, name } of [
  { format: 'PDF', table: 'deadline', cells: DEADLINE_ROWS.flat(), pdfItems: () => tablePdfItems().sort((a, b) => a.x - b.x || a.y - b.y), width: 1000 },
  { format: 'webpage', table: 'deadline', cells: DEADLINE_ROWS.flat() },
  { format: 'PDF', table: 'wrapped Swedish', cells: WRAPPED_SWEDISH_ROWS.flat(2), pdfItems: wrappedSwedishTableItems, width: 856 },
  { format: 'PDF', table: 'four-column security', cells: SECURITY_TABLE_ROWS.flat(2), pdfItems: securityTableItems, width: 924 },
  { format: 'PDF', table: 'numbered questions and answers', cells: studyTableFixture().cells.flat(2), pdfItems: () => studyTableFixture().items, width: 640 },
  { format: 'PDF', table: 'paragraph sidenote', cells: sidenoteFixture.expectedText, pdfItems: () => sidenoteFixture.items, width: 540, height: 900,
    name: 'PDF reads a sidenote after its paragraph with matching word highlights' },
]) {
  test(name || `${format} narrates the ${table} table in row order with matching word highlights`, async ({}, testInfo) => {
    const { context, cleanup } = await launchExtensionContext({ hostPermissions: ['http://reading-order.test/*'] });
    try {
      await seedFlowTestFlags(context);
      let page;
      if (format === 'PDF') {
        const bytes = buildPdfBytes(pdfItems(), { width, height });
        page = await openPdfViewer(context, `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`);
        await expect(page.locator('#pdf-status')).toContainText('1 page loaded');
      } else {
        await context.route('http://reading-order.test/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <title>Course schedule</title><style>td,th { padding: 10px; text-align: left; } body { font: 18px sans-serif; }</style>
          <main><h1>Course schedule</h1><p>Read each milestone before moving to the next row.</p>
          <figure>${deadlineTableHtml()}</figure>
          <dl><div><dt>Reminder</dt><dd>Keep a copy of your submission.</dd></div></dl>
          <div role="heading" aria-level="2">Checklist</div><div role="list"><div role="listitem">Prepare</div><div role="listitem">Submit</div></div>
          <blockquote>Finish one task at a time.</blockquote><pre>print('done')</pre>
          <div role="grid"><div role="row" aria-rowindex="1"><span role="columnheader">Task</span> <span role="columnheader">Day</span></div>
            <div role="row" aria-rowindex="3"><span role="gridcell" aria-colindex="2">Tuesday</span> <span role="gridcell" aria-colindex="1">Beta</span></div>
            <div role="row" aria-rowindex="2"><span role="gridcell">Alpha</span> <span role="gridcell">Monday</span></div>
            <div role="rowgroup" hidden><div role="row"><span role="gridcell">Secret</span></div></div></div></main>` }));
        page = await context.newPage();
        await page.goto('http://reading-order.test/schedule');
      }
      await startReadFromToolbarPopup(context, page);
      const worker = context.serviceWorkers()[0];
      await expect.poll(() => worker.evaluate(() => chrome.storage.session.get('readerEngineState')
        .then((value) => value.readerEngineState?.state)), { timeout: 45_000 }).toBe('finished');
      const readerEngineLog = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }).then((value) => value.log));
      // The PDF viewer has no content-script word log. Check every streamed word
      // against its live CSS range through the same extension message API.
      const pageLog = format === 'PDF' ? await verifyPdfWords(context, page) : await recordPlaybackEvents(page, context);
      const report = buildCorpusFlowReport({ readerEngineLog, pageLog });
      const evidence = testInfo.outputPath('reading-order.json');
      await writeFile(evidence, JSON.stringify({ format, table, readerEngineLog, pageLog, report }, null, 2));
      await testInfo.attach('reading-order-evidence', { path: evidence, contentType: 'application/json' });
      const speech = normalize(report.chunkStarts.map(({ speechText }) => speechText).join(' '));
      let cursor = -1;
      for (const cell of cells) {
        const position = speech.indexOf(normalize(cell), cursor + 1);
        expect(position, `Missing or out-of-order cell: ${cell}\n${speech}`).toBeGreaterThan(cursor);
        cursor = position;
      }
      if (format === 'webpage') {
        for (const text of ['Reminder', 'Keep a copy', 'Checklist', 'Prepare', 'Submit', 'Finish one task', "print('done')", 'Task, Alpha - Day, Monday', 'Task, Beta - Day, Tuesday']) {
          const position = speech.indexOf(normalize(text), cursor + 1);
          expect(position, `Missing or out-of-order element: ${text}\n${speech}`).toBeGreaterThan(cursor);
          cursor = position;
        }
        expect(speech).not.toContain('Secret');
      }
      expect(report.chunksSpoken).toBeGreaterThan(0);
      expect(report.chunksSpoken).toBe(report.chunksExtracted);
      expect(report.missingChunkIndices).toEqual([]);
      expect(report.unendedChunkIndices).toEqual([]);
      expect(report.replayedChunkIndices).toEqual([]);
      expect(report.synthesisFailures).toEqual([]);
      if (format === 'PDF') expect(report.wordEvents).toHaveLength(tokenizeSpokenWords(speech).length);
      else expect(report.wordEvents.length).toBeGreaterThan(70);
      expect(report.wordEventsMissingTokens).toEqual([]);
      expect(report.tokenMismatches).toEqual([]);
    } finally {
      await cleanup();
    }
  });
}

async function verifyPdfWords(context, page) {
  const tabId = await seedReadableTabTarget(context, page, { allowActiveExtensionTab: true });
  const worker = context.serviceWorkers()[0];
  const send = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
  const { instanceToken } = await send({ type: 'getPdfStreamMetadata' });
  const words = [];
  for (let chunkIndex = 0; chunkIndex < 100; chunkIndex += 1) {
    const result = await send({ type: 'getPdfChunk', streamId: 'table-word-check', instanceToken, startPage: 1 });
    expect(result.ok).toBe(true);
    if (result.done) return words;
    const chunk = result.value;
    expect(await send({ type: 'highlightChunk', anchorId: chunk.anchorId, text: chunk.anchorText,
      chunkText: chunk.chunkText || chunk.anchorText, domWordOffset: chunk.domWordOffset })).toMatchObject({ ok: true });
    for (const [wordIndex, token] of tokenizeSpokenWords(chunk.speech).entries()) {
      const index = getDomWordIndexForSpeechWord(chunk, wordIndex);
      if (index < 0) continue;
      expect(await send({ type: 'highlightWord', index })).toMatchObject({ ok: true });
      const marked = await page.evaluate(() => [...(CSS.highlights.get('pagenarrator-word-0') || [])]
        .filter((range) => range.startContainer.isConnected).map((range) => range.toString()).join(''));
      words.push({ kind: 'word', chunkIndex, wordIndex, speechText: token.text, domToken: marked });
    }
  }
  throw new Error('PDF word verification stream did not finish.');
}
