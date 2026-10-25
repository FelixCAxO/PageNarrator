import { JSDOM } from 'jsdom';
import { parseArticleDocument } from '../../src/engines/article-extractor.js';
import { describe, expect, it } from 'vitest';
import {
  PROBE_WORKLOADS,
  buildScannedPdf,
  needsFreshDocumentTarget,
  findCheckpointsInOrder,
  normalizeForScoring,
  orderedWordRecall,
  scoreWorkloadContent,
  selectScoredContent,
  loadPdfWorkloadBytes,
} from '../live/tts-probe-workloads.js';
import {
  COMPLEX_ARTICLE,
  longArticleReferenceText,
  renderComplexArticleHtml,
  renderLongArticleHtml,
} from '../fixtures/weak-hardware/workload-references.js';
import { EXTENDED_TTS_PROBE_DOCUMENT_TYPES, READ_TO_END_TTS_PROBE_DOCUMENT_TYPES, getTtsProbeDocumentTypes } from '../live/live-tts-hardware-probe-documents.js';
import { getDocument } from '../../src/pdf/pdf-engine.js';
import { options as originalPdfOptions } from '../pdf-engine/fixtures.js';
import { sha256 } from '../../scripts/weak-hardware/run-provenance.mjs';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { chunkText } from '../../src/lib/speech-chunks.js';

describe('weak-hardware probe workloads', () => {
  it('keeps the default documents and makes the new workloads opt-in', () => {
    expect(getTtsProbeDocumentTypes('')).toEqual(['article', 'pdf']);
    expect(getTtsProbeDocumentTypes('long-article,complex-html,two-column-pdf,scanned-pdf,soak-article')).toEqual(EXTENDED_TTS_PROBE_DOCUMENT_TYPES);
    for (const type of ['article', 'pdf', ...EXTENDED_TTS_PROBE_DOCUMENT_TYPES]) expect(PROBE_WORKLOADS[type]).toBeTruthy();
  });

  it('normalizes punctuation and case but keeps numbers intact', () => {
    expect(normalizeForScoring('Dr. Moreno counted $48,500 — 35.6 percent.')).toBe('dr moreno counted $48 500 35.6 percent');
  });

  it('measures ordered word recall so dropped or reordered content lowers the score', () => {
    const reference = 'one two three four five six seven eight nine ten';

    expect(orderedWordRecall(reference, reference)).toBe(1);
    expect(orderedWordRecall(reference, 'one two three four five')).toBe(0.5);
    expect(orderedWordRecall(reference, 'six seven eight nine ten one two three four five')).toBe(0.5);
    expect(orderedWordRecall('', 'anything')).toBeNull();
  });

  it('checks reading-order checkpoints and narrated page furniture', () => {
    expect(findCheckpointsInOrder('Left column begins. Right column ends.', ['Left column', 'Right column'])).toMatchObject({ found: 2, inOrder: true });
    expect(findCheckpointsInOrder('Right column ends. Left column begins.', ['Left column', 'Right column'])).toMatchObject({ found: 2, inOrder: false });

    const score = scoreWorkloadContent('Title. Accept all cookies. Body.', { checkpoints: ['Title', 'Missing part'], forbidden: ['Accept all cookies'] });
    expect(score.passes).toBe(false);
    expect(score.failures).toEqual(['missing content: Missing part', 'page furniture narrated: Accept all cookies']);
  });

  it('refuses to claim full-text recall from a truncated transcript', () => {
    const score = scoreWorkloadContent('partial', { fullText: 'partial text here' }, { truncated: true });

    expect(score).toMatchObject({ passes: false, wordRecall: null, truncated: true });
  });

  it('scores the authored long article at full recall against its own reference', () => {
    const extracted = parseArticleDocument(new JSDOM(renderLongArticleHtml()).window.document);
    const text = `${extracted.title}\n${extracted.textContent}`;

    expect(orderedWordRecall(longArticleReferenceText(), text)).toBeGreaterThanOrEqual(0.99);
  });

  it('places page furniture outside the complex article so a correct extractor can skip it', () => {
    const extracted = parseArticleDocument(new JSDOM(renderComplexArticleHtml()).window.document);
    const score = scoreWorkloadContent(`${extracted.title}\n${extracted.textContent}`, PROBE_WORKLOADS['complex-html'].reference);

    expect(score.checkpoints).toMatchObject({ found: 6, total: 6, inOrder: true });
    expect(score.forbiddenFound).toEqual([]);
    expect(COMPLEX_ARTICLE.forbidden.every((phrase) => renderComplexArticleHtml().includes(phrase.split(' ')[0]))).toBe(true);
  });

  it('builds a valid image-only PDF for the scanned workload', async () => {
    const bytes = await buildScannedPdf(['Known sentence.']);

    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.includes(Buffer.from('/Subtype /Image'))).toBe(true);
    expect(bytes.includes(Buffer.from('Known sentence'))).toBe(false);
  });

  it('pins a two-page PDF whose original-parser narration contains a real section handoff', async () => {
    const bytes = await loadPdfWorkloadBytes(PROBE_WORKLOADS.pdf);
    expect(sha256(bytes)).toBe(PROBE_WORKLOADS.pdf.sha256);
    const document = await getDocument({ data: new Uint8Array(bytes), ...originalPdfOptions }).promise;
    try {
      expect(document.numPages).toBe(2);
      const pages = [];
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        pages.push({ type: 'pdf-page', speech: createPdfPageModel(content.items).speech, pageNumber: number });
      }
      expect(scoreWorkloadContent(pages.map(page => page.speech).join(' '), PROBE_WORKLOADS.pdf.reference).passes).toBe(true);
      expect(chunkText(pages).length).toBeGreaterThanOrEqual(2);
    } finally { await document.destroy(); }
    await expect(loadPdfWorkloadBytes({ ...PROBE_WORKLOADS.pdf, sha256: '0'.repeat(64) })).rejects.toThrow('frozen fixture');
  });
});

describe('scored workload content', () => {
  // Live shape (2026-10-05): the transcript card held 321 of about 750 article
  // characters while every chunk was queued and spoken.
  const partialTranscript = {
    title: 'PageNarrator TTS Probe Article',
    paragraphs: ['This local article is deterministic. First measured section The first section has enough spoken text. Second measured section'],
    countLabel: '1 paragraph',
    truncated: false,
    source: 'recorded during read',
  };
  const narration = { chunks: ['PageNarrator TTS Probe Article. This local article is deterministic.', 'First measured section. The first section has enough spoken text.', 'Fourth measured section. The fourth section gives the flow probe another transition.'], broadcasts: 6, errors: [] };

  it('scores what was queued for speech and keeps the transcript separate', () => {
    const scored = selectScoredContent({ ...partialTranscript, narration });

    expect(scored).toMatchObject({ source: 'narration: queued speech text from reader-state broadcasts', truncated: false, queuedChunks: 3 });
    expect(scoreWorkloadContent(scored.text, PROBE_WORKLOADS.article.reference).passes).toBe(true);
    expect(scoreWorkloadContent(scored.transcriptText, PROBE_WORKLOADS.article.reference).checkpoints.missing)
      .toEqual(['Fourth measured section', 'The fourth section gives the flow probe another transition']);
  });

  it('falls back to the transcript when no narration was recorded', () => {
    const scored = selectScoredContent({ ...partialTranscript, truncated: true, narration: { chunks: ['', ''], broadcasts: 1, errors: [] } });

    expect(scored).toMatchObject({ source: 'transcript (recorded during read)', truncated: true, queuedChunks: null });
    expect(scored.text).toBe(scored.transcriptText);
    expect(selectScoredContent(null).text).toBe('');
  });
});

describe('workload read length', () => {
  it('reads every whole-document content workload to the end, but not the soak or default documents', () => {
    expect(READ_TO_END_TTS_PROBE_DOCUMENT_TYPES).toEqual(['long-article', 'complex-html', 'two-column-pdf', 'scanned-pdf']);
    for (const type of READ_TO_END_TTS_PROBE_DOCUMENT_TYPES) {
      expect(EXTENDED_TTS_PROBE_DOCUMENT_TYPES).toContain(type);
      expect(PROBE_WORKLOADS[type].reference.fullText || PROBE_WORKLOADS[type].reference.checkpoints.length).toBeTruthy();
    }
    expect(READ_TO_END_TTS_PROBE_DOCUMENT_TYPES).not.toContain('soak-article');
    expect(READ_TO_END_TTS_PROBE_DOCUMENT_TYPES).not.toContain('article');
  });
});

describe('document reuse across runs', () => {
  // Closing the toolbar player tears down the PDF viewer it read from.
  it('reopens a PDF that an earlier run in the same browser session used, and only then', () => {
    for (const type of ['pdf', 'two-column-pdf', 'scanned-pdf']) {
      expect(needsFreshDocumentTarget(type, { usedInSession: true })).toBe(true);
      expect(needsFreshDocumentTarget(type, { usedInSession: false })).toBe(false);
    }
    for (const type of ['article', 'long-article', 'complex-html', 'soak-article']) {
      expect(needsFreshDocumentTarget(type, { usedInSession: true })).toBe(false);
    }
    expect(needsFreshDocumentTarget('unknown', { usedInSession: true })).toBe(false);
  });
});
