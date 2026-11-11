import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';
import { pdf, stream } from '../pdf-engine/fixtures.js';
import {
  getExtensionId, launchExtensionContext, openPdfViewer, seedFlowTestFlags, startReadFromToolbarPopup,
} from './extension-fixture.js';

// Reproduce the exported PDF's invisible formatting and Greek math text.
const cmap = stream(`begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
3 beginbfchar
<95> <25CF>
<A1> <200B>
<A2> <03A3>
endbfchar
endcmap`);
const text = (value, y, x = 54) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${value}) Tj ET`;
const firstPage = [
  text('The opening paragraph introduces the study.', 720),
  text('The value x = 17 is used in this example.', 692),
  text('Method', 640), text('Score', 640, 250), text('Outcome', 640, 380),
  text('Baseline', 619), text('21', 619, 250), text('Stable', 619, 380),
  text('Candidate', 598), text('32', 598, 250), text('Improved', 598, 380),
  text('The discussion continues below the results.', 544),
].join('\n');
const fixture = pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> >>',
  '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', stream(firstPage),
  '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>', stream(text('\\242 = x + 119', 696, 240)),
  '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>', stream(text('\\225\\241 The final page confirms that narration continued.', 710)),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 10 0 R >>', cmap,
]);

for (const skip of [true, false]) {
  test(`reads a technical PDF to the end with PDF cleanup ${skip ? 'enabled by default' : 'turned off'}`, async () => {
    const { context, cleanup, extensionDir } = await launchExtensionContext();
    try {
      await seedFlowTestFlags(context);
      const page = await openPdfViewer(context, `data:application/pdf;base64,${Buffer.from(fixture).toString('base64')}`);
      await expect(page.locator('#pdf-status')).toContainText('3 pages loaded');
      await expect(page.locator('.pdf-page').first().locator('.textLayer')).toContainText('Candidate');
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${await getExtensionId(context)}/src/popup.html`);
      await popup.locator('#popup-advanced summary').click();
      const checkbox = popup.getByRole('checkbox', { name: 'Skip PDF equations and tables' });
      await expect(checkbox).toBeChecked();
      if (!skip) {
        await checkbox.uncheck();
        const worker = context.serviceWorkers()[0];
        await expect.poll(() => worker.evaluate(async () =>
          (await chrome.storage.local.get('playbackSettings')).playbackSettings?.skipPdfEquationsAndTables)).toBe(false);
        await popup.reload();
        await popup.locator('#popup-advanced').evaluate(element => { element.open = true; });
        await expect(checkbox).not.toBeChecked();
      }
      await popup.close();

      await startReadFromToolbarPopup(context, page, { fromStart: true });
      const worker = context.serviceWorkers()[0];
      await expect.poll(() => worker.evaluate(async () =>
        (await chrome.storage.session.get('readerEngineState')).readerEngineState?.state)).toBe('finished');
      const { log } = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'getFlowLog' }));
      const starts = log.filter(event => event.kind === 'chunk_play');
      expect(log.filter(event => event.kind === 'chunk_end').map(event => event.chunkIndex))
        .toEqual(starts.map(event => event.chunkIndex));
      const speech = starts.map(event => event.speechText).join(' ');
      expect(speech).toMatch(/opening paragraph.*used in this example.*discussion continues.*final page confirms/u);
      if (skip) expect(speech).not.toMatch(/Candidate|119|17/u);
      else expect(speech).toMatch(/17.*Candidate.*Σ.*119/u);

      // Silent playback exercises sequencing; use the production phonemizer on
      // the exact chunks sent to speech so Unicode input failures are visible.
      const phonemizer = await createEnglishPhonemizer({
        runtime: { getURL: name => path.join(extensionDir, name) },
        fetcher: async filename => new Response(await readFile(filename)),
      });
      try {
        for (const { speechText } of starts) expect(await phonemizer.phonemizeText(speechText)).toBeTruthy();
      } finally {
        await phonemizer.dispose();
      }
    } finally {
      await cleanup();
    }
  });
}
