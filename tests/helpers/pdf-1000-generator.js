/**
 * 1,000 Generated PDF Binary Fixtures
 *
 * Generates an exhaustive matrix of 1,000 distinct, valid PDF 1.4 binary documents
 * across 10 structural layout families (10 archetypes x 10 parametric variations = 100 per family).
 */
import { buildPdfBytes } from './pdf-test-generator.js';

export const PDF_1000_FAMILIES = [
  { id: 'f1', name: 'Family 1: Single-Column Layouts' },
  { id: 'f2', name: 'Family 2: Two-Column Symmetric LTR Layouts' },
  { id: 'f3', name: 'Family 3: Two-Column Asymmetric Layouts' },
  { id: 'f4', name: 'Family 4: Three-Column & Multi-Column Layouts' },
  { id: 'f5', name: 'Family 5: Tables, Figures & Captions' },
  { id: 'f6', name: 'Family 6: Lists, Numbering & Outlines' },
  { id: 'f7', name: 'Family 7: Typography, Hyphenation & Diacritics' },
  { id: 'f8', name: 'Family 8: Academic Citations & Noise Suppression' },
  { id: 'f9', name: 'Family 9: Speech Flow & Streaming Chunks' },
  { id: 'f10', name: 'Family 10: Multi-Page, RTL & Adversarial Layouts' },
];

const TOPICS = [
  'Neural Speech Synthesis', 'WebAssembly Acceleration', 'On-Device Machine Learning',
  'Vector Database Indexing', 'Streaming Audio Pipelines', 'Client-Side Tokenization',
  'Low-Latency Audio Rendering', 'Browser Extension Architecture', 'Highlighter Grounding',
  'Document Layout Modeling',
];

const NOISE_HEADERS = [
  'Confidential Draft Report Header',
  'Recurring Report Header',
  'arXiv:2604.99999v1 [cs.CL] 30 Apr 2026',
  'Preprint - Under Review',
  'Draft Copy - Do Not Distribute',
  'Submitted to INTERSPEECH 2026 for review',
  'Recurring Header Title',
  'Confidential Manuscript Header',
  'Technical Report Header',
  'Draft Report Header',
];

/**
 * Builds 1,000 synthetic PDF test descriptors with valid binary PDF bytes.
 *
 * @returns {Array<Object>} 1,000 PDF benchmark entries
 */
export function buildPdfCorpus1000() {
  const corpus = [];

  for (let f = 1; f <= 10; f += 1) {
    const familyMeta = PDF_1000_FAMILIES[f - 1];

    for (let a = 1; a <= 10; a += 1) {
      for (let v = 1; v <= 10; v += 1) {
        const itemNumber = (f - 1) * 100 + (a - 1) * 10 + v;
        const entry = generateCorpusEntry(f, a, v, itemNumber, familyMeta);
        corpus.push(entry);
      }
    }
  }

  return corpus;
}

function generateCorpusEntry(familyNum, archetypeNum, varNum, itemNum, familyMeta) {
  const id = `pdf-1000-f${familyNum}-${String(itemNum).padStart(4, '0')}`;
  const topic = TOPICS[(archetypeNum - 1) % TOPICS.length];
  const noiseHeader = NOISE_HEADERS[(varNum - 1) % NOISE_HEADERS.length];

  let pages = [];
  let expectedCheckpoints = [];
  let forbiddenTokens = [];
  let expectedPattern = null;
  let isImageOnly = false;

  switch (familyNum) {
    // -----------------------------------------------------------------------
    // Family 1: Single-Column Layouts
    // -----------------------------------------------------------------------
    case 1: {
      const topMargin = 750 - (varNum * 2);
      const fontSize = 11 + (varNum % 3);
      const title = `${topic} Overview Vol ${archetypeNum}`;
      const p1 = `Section ${varNum} explores ${topic.toLowerCase()} in modern browsers.`;
      const p2 = `Empirical results show a ${(92 + varNum * 0.5).toFixed(1)} percent speedup.`;

      pages = [{
        items: [
          { text: title, x: 54, y: topMargin, fontSize: 18 },
          { text: p1, x: 54, y: topMargin - 40, fontSize },
          { text: p2, x: 54, y: topMargin - 80, fontSize },
        ],
      }];
      expectedCheckpoints = [title, p1, p2];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 2: Two-Column Symmetric LTR Layouts
    // -----------------------------------------------------------------------
    case 2: {
      const gutter = 320;
      const title = `Two Column Study ${archetypeNum}.${varNum}: ${topic}`;
      const l1 = `Left column starts methodology.`;
      const l2 = `Left column details calibration split ${varNum}.`;
      const r1 = `Right column explains comparative findings.`;
      const r2 = `Right column concludes with speedup.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 18 },
          { text: l1, x: 54, y: 700, fontSize: 12 },
          { text: l2, x: 54, y: 670, fontSize: 12 },
          { text: r1, x: gutter, y: 700, fontSize: 12 },
          { text: r2, x: gutter, y: 670, fontSize: 12 },
        ],
      }];
      expectedCheckpoints = [title, l1, l2, r1, r2];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 3: Two-Column Asymmetric Layouts
    // -----------------------------------------------------------------------
    case 3: {
      const isWideLeft = varNum % 2 === 1;
      const title = `Asymmetric Document ${archetypeNum}-${varNum}`;
      const mainColText1 = `Primary narrative explores ${topic.toLowerCase()}.`;
      const mainColText2 = `Continuation confirms stability index ${varNum * 10}.`;
      const sideColText = `Sidebar ${varNum}: Reference note.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          ...(isWideLeft ? [
            { text: mainColText1, x: 50, y: 700, fontSize: 12 },
            { text: mainColText2, x: 50, y: 670, fontSize: 12 },
            { text: sideColText, x: 420, y: 700, fontSize: 9 },
          ] : [
            { text: sideColText, x: 50, y: 700, fontSize: 9 },
            { text: mainColText1, x: 200, y: 700, fontSize: 12 },
            { text: mainColText2, x: 200, y: 670, fontSize: 12 },
          ]),
        ],
      }];
      expectedCheckpoints = isWideLeft
        ? [title, mainColText1, mainColText2, sideColText]
        : [title, sideColText, mainColText1, mainColText2];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 4: Three-Column & Multi-Column Layouts
    // -----------------------------------------------------------------------
    case 4: {
      const title = `Three-Column Newsletter Report ${archetypeNum}.${varNum}`;
      const c1 = `Col 1 initial analysis.`;
      const c2 = `Col 2 architecture note.`;
      const c3 = `Col 3 summary metrics.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          { text: c1, x: 40, y: 700, fontSize: 11 },
          { text: c2, x: 220, y: 700, fontSize: 11 },
          { text: c3, x: 400, y: 700, fontSize: 11 },
        ],
      }];
      expectedCheckpoints = [title, c1, c2, c3];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 5: Tables, Figures & Captions
    // -----------------------------------------------------------------------
    case 5: {
      const title = `Data Analysis ${archetypeNum}.${varNum}`;
      const tableCap = `Table ${archetypeNum}: Performance Metrics for ${topic}`;
      const r1 = `Model Alpha achieved precision ${(0.91 + varNum * 0.005).toFixed(3)} with latency ${40 + varNum}ms in testing.`;
      const r2 = `Model Beta achieved precision ${(0.94 + varNum * 0.004).toFixed(3)} with latency ${30 + varNum}ms in testing.`;
      const figCap = `Figure ${varNum}: Convergence rate across training epochs.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          { text: tableCap, x: 54, y: 720, fontSize: 12 },
          { text: r1, x: 54, y: 680, fontSize: 11 },
          { text: r2, x: 54, y: 650, fontSize: 11 },
          { text: figCap, x: 54, y: 600, fontSize: 10 },
        ],
      }];
      expectedCheckpoints = [title, tableCap, 'Model Alpha achieved', 'Model Beta achieved', figCap];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 6: Lists, Numbering & Outlines
    // -----------------------------------------------------------------------
    case 6: {
      const title = `Execution Checklist ${archetypeNum}.${varNum}`;
      const isNumbered = varNum % 2 === 1;
      const i1 = isNumbered ? `1. Initialize pipeline for ${topic.toLowerCase()}.` : `- Initialize pipeline for ${topic.toLowerCase()}.`;
      const i2 = isNumbered ? `2. Validate WebAssembly audio buffer ${varNum}.` : `- Validate WebAssembly audio buffer ${varNum}.`;
      const i3 = isNumbered ? `3. Confirm zero dropped frames.` : `- Confirm zero dropped frames.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          { text: i1, x: 54, y: 700, fontSize: 12 },
          { text: i2, x: 54, y: 670, fontSize: 12 },
          { text: i3, x: 54, y: 640, fontSize: 12 },
        ],
      }];
      expectedCheckpoints = [title, isNumbered ? '1. Initialize pipeline' : 'Initialize pipeline', isNumbered ? '2. Validate WebAssembly' : 'Validate WebAssembly', isNumbered ? '3. Confirm' : 'Confirm'];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 7: Typography, Hyphenation & Diacritics
    // -----------------------------------------------------------------------
    case 7: {
      const title = `Typography Benchmark ${archetypeNum}.${varNum}`;
      const p1 = `The inter-`;
      const p2 = `national multi-disciplinary group evaluated ${topic.toLowerCase()}.`;
      const p3 = `A state-of-the-art approach was deployed in Zurich and Sao Paulo.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          { text: p1, x: 54, y: 700, fontSize: 12 },
          { text: p2, x: 54, y: 680, fontSize: 12 },
          { text: p3, x: 54, y: 650, fontSize: 12 },
        ],
      }];
      expectedCheckpoints = [title, 'international multi-disciplinary', 'state-of-the-art', 'Zurich'];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 8: Academic Citations & Noise Suppression
    // -----------------------------------------------------------------------
    case 8: {
      const title = `Research Paper ${archetypeNum}.${varNum}: ${topic}`;
      const headerNoise = noiseHeader;
      const affiliation = `Department of Computer Science, University of Technology ${varNum}`;
      const bodyWithCitation = `Prior work [${varNum}, ${varNum + 1}] demonstrated high TTS efficiency across devices.`;
      const footerNoise = `Copyright © 2026 IEEE. All rights reserved.`;

      pages = [{
        items: [
          { text: headerNoise, x: 200, y: 775, fontSize: 8 },
          { text: title, x: 54, y: 740, fontSize: 18 },
          { text: affiliation, x: 54, y: 710, fontSize: 9 },
          { text: bodyWithCitation, x: 54, y: 680, fontSize: 12 },
          { text: footerNoise, x: 54, y: 18, fontSize: 8 },
        ],
      }];
      expectedCheckpoints = [title, 'demonstrated high TTS efficiency'];
      forbiddenTokens = [headerNoise, `[${varNum}, ${varNum + 1}]`, affiliation, 'Copyright © 2026'];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 9: Speech Flow & Streaming Chunks
    // -----------------------------------------------------------------------
    case 9: {
      const title = `Streaming Flow ${archetypeNum}.${varNum}`;
      const sentence1 = `As demonstrated by Smith et al. in Sec. ${varNum}, precision reached ${(99.1 + varNum * 0.05).toFixed(2)}% at 10:30 AM.`;
      const sentence2 = `Dr. Watson confirmed that constant pi is approx. 3.14159 during evaluation.`;

      pages = [{
        items: [
          { text: title, x: 54, y: 760, fontSize: 16 },
          { text: sentence1, x: 54, y: 700, fontSize: 12 },
          { text: sentence2, x: 54, y: 660, fontSize: 12 },
        ],
      }];
      expectedCheckpoints = [title, 'Smith et al.', '10:30 AM', '3.14159'];
      break;
    }

    // -----------------------------------------------------------------------
    // Family 10: Multi-Page, RTL & Adversarial Layouts
    // -----------------------------------------------------------------------
    case 10: {
      if (archetypeNum === 10 && varNum === 10) {
        // Scanned PDF
        isImageOnly = true;
        pages = [{ items: [] }];
        expectedPattern = /scanned_pdf_unsupported/u;
      } else if (archetypeNum === 10 && varNum === 9) {
        // Blank PDF
        pages = [{ items: [] }];
        expectedCheckpoints = [];
      } else if (archetypeNum <= 3) {
        // Multi-page document (2 to 4 pages)
        const pageCount = 2 + (varNum % 3);
        pages = Array.from({ length: pageCount }, (_, p) => ({
          items: [
            { text: `Document ${archetypeNum}.${varNum} Section ${p + 1}`, x: 54, y: 750, fontSize: 16 },
            { text: `Prose narrative for ${topic.toLowerCase()} on page ${p + 1} continues.`, x: 54, y: 700, fontSize: 12 },
          ],
        }));
        expectedCheckpoints = ['page 1 continues', `page ${pageCount} continues`];
      } else {
        // Standard high-density test
        const title = `Advanced Layout ${archetypeNum}.${varNum}`;
        const p1 = `Section ${varNum} details complex multi-stage pipeline flow for ${topic.toLowerCase()}.`;
        pages = [{
          items: [
            { text: title, x: 54, y: 750, fontSize: 16 },
            { text: p1, x: 54, y: 700, fontSize: 12 },
          ],
        }];
        expectedCheckpoints = [title, p1];
      }
      break;
    }

    default:
      break;
  }

  return {
    id,
    familyId: familyMeta.id,
    familyName: familyMeta.name,
    archetypeId: `arch-${archetypeNum}`,
    archetypeName: `${familyMeta.name} Archetype ${archetypeNum}`,
    variationIndex: varNum,
    pageCount: pages.length,
    pages,
    isImageOnly,
    get pdfBytes() {
      return buildPdfBytes(pages, { isImageOnly });
    },
    expectedCheckpoints,
    forbiddenTokens,
    expectedPattern,
  };
}
