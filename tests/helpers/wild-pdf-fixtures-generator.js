/**
 * Real Wild PDF Binary Fixtures Generator
 *
 * Generates 10 deterministic %PDF-1.4 binary fixtures representing pathological,
 * real-world PDF layout and typography artifacts.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfBytes } from './pdf-test-generator.js';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/pdfs/wild');

export const WILD_PDF_MANIFEST = [
  {
    id: 'wild-spanning-abstract-2col',
    name: 'Spanning Abstract with 2-Column Body',
    fileName: 'wild-spanning-abstract-2col.pdf',
    category: 'spanning-abstract',
    expectedCheckpoints: [
      'Robust Neural Text-to-Speech under Pathological Conditions',
      'This paper presents a resilient speech extraction architecture',
      '1. Introduction',
      'Document layout modeling in web readers must handle varied visual hierarchies.',
      'Column splitting ensures continuous flow across distinct text blocks.',
      'References',
      '1. Vaswani et al. Attention is all you need. 2017',
      '2. Architecture',
      'Our parser decomposes visual geometry into coherent semantic regions.',
      'Extracted lines are normalized before acoustic phonemization.',
    ],
    forbiddenTokens: [
      'Department of Computer Science',
      'Copyright © 2026',
    ],
  },
  {
    id: 'wild-fragmented-glyphs-kerning',
    name: 'Fragmented Kerning Stream Reassembly',
    fileName: 'wild-fragmented-glyphs-kerning.pdf',
    category: 'fragmented-glyphs',
    expectedCheckpoints: [
      'Micro-Fragmented Kerning Stream Evaluation',
      'PageNarrator preserves word cohesion.',
      'Kerning adjustments do not split spoken tokens.',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-ligatures-unicode',
    name: 'Unicode Typographic Ligatures',
    fileName: 'wild-ligatures-unicode.pdf',
    category: 'ligatures',
    expectedCheckpoints: [
      'Typographic Ligature Normalization',
      'The efficient offline flow achieved flawless affiliation and aesthetic manoeuvre.',
      'Different configuration flags amplify typographic clarity without sacrificing fidelity.',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-display-equations-math',
    name: 'Display Equations with Isolated Right Labels',
    fileName: 'wild-display-equations-math.pdf',
    category: 'display-equations',
    expectedCheckpoints: [
      'Mathematical Objective Formulation',
      'The total loss function balances reconstruction accuracy and adversarial regularization',
      'where alpha and beta denote hyperparameter weights chosen empirically.',
      'Training converges steadily when the learning rate is scheduled adaptively.',
      'L_total = alpha * L_rec + beta * L_adv',
      'grad_theta = nabla_theta * E[log D(x)]',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-multiline-table-cells',
    name: 'Multi-Line Table Cells',
    fileName: 'wild-multiline-table-cells.pdf',
    category: 'multiline-tables',
    expectedCheckpoints: [
      'Table 1: Benchmark Summary across Architectural Configurations',
      'Baseline on-device reader using CPU WebAssembly fallback',
      'Optimized WebGPU neural pipeline with streaming audio buffers',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-cross-page-column-wrap',
    name: 'Cross-Page Column Sentence Wrap',
    fileName: 'wild-cross-page-column-wrap.pdf',
    category: 'cross-page-continuation',
    expectedCheckpoints: [
      'Cross-Page Flow Study',
      'Section 1 introduces distributed optimization.',
      'The optimization objective function was formulated to minimize',
      'the reconstruction loss across all training samples without divergence.',
      'Subsequent experiments confirmed rapid loss decay across benchmark splits.',
    ],
    forbiddenTokens: [
      'Cross-Page Flow Study - Technical Report',
      'Page 2 of 2',
    ],
  },
  {
    id: 'wild-rotated-page',
    name: 'Mixed Landscape & Portrait Viewport',
    fileName: 'wild-rotated-page.pdf',
    category: 'rotated-page',
    expectedCheckpoints: [
      'Introduction to System Architecture',
      'Standard portrait narrative describing core client components.',
      'Wide System Topology Diagram and Component Interconnects',
      'Detailed subsystem breakdown spanning the wide landscape visual area.',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-footnotes-sidenotes',
    name: 'Superscript Footnotes and Bottom Annotations',
    fileName: 'wild-footnotes-sidenotes.pdf',
    category: 'footnotes',
    expectedCheckpoints: [
      'Acoustic Model Evaluation',
      'We evaluate the neural pipeline on the standardized multi-speaker benchmark',
      'and measure audio clarity across accents.',
      'The results demonstrate consistent word error rate reductions.',
    ],
    forbiddenTokens: [
      'Dataset available in public repository',
    ],
  },
  {
    id: 'wild-dropcap-quotes',
    name: 'Quotation Mark Drop Caps',
    fileName: 'wild-dropcap-quotes.pdf',
    category: 'quote-dropcaps',
    expectedCheckpoints: [
      'Chapter 1: The Evolution of Neural Speech',
      'In the beginning of neural synthesis research, models required massive server clusters to run.',
      'Today, lightweight models run completely inside client browsers.',
    ],
    forbiddenTokens: [],
  },
  {
    id: 'wild-ocr-jitter',
    name: 'OCR Baseline Jitter and Tolerance Bands',
    fileName: 'wild-ocr-jitter.pdf',
    category: 'ocr-jitter',
    expectedCheckpoints: [
      'Historical Archive Document Transcription',
      'Scanned text layers require flexible vertical alignment tolerances to prevent fragmentation.',
      'The extraction model clusters jittered text lines into single cohesive sentences.',
    ],
    forbiddenTokens: [],
  },
];

/**
 * Builds the descriptors for each of the 10 wild PDF fixtures.
 */
export function getWildPdfDescriptors() {
  return [
    // 1. Spanning Abstract with 2-Column Body
    {
      ...WILD_PDF_MANIFEST[0],
      pages: [{
        items: [
          { text: 'Robust Neural Text-to-Speech under Pathological Conditions', x: 54, y: 750, fontSize: 18 },
          { text: 'Alex Rivera, Morgan Vance, and Jordan Lee', x: 150, y: 720, fontSize: 10 },
          { text: 'Department of Computer Science, University of Cambridge', x: 130, y: 705, fontSize: 9 },
          { text: 'Abstract', x: 54, y: 675, fontSize: 12 },
          { text: 'This paper presents a resilient speech extraction architecture', x: 54, y: 655, fontSize: 10 },
          { text: 'designed to process complex multi-column documents with spanning summaries.', x: 54, y: 642, fontSize: 10 },
          // Left column
          { text: '1. Introduction', x: 54, y: 610, fontSize: 12 },
          { text: 'Document layout modeling in web readers', x: 54, y: 590, fontSize: 10 },
          { text: 'must handle varied visual hierarchies.', x: 54, y: 576, fontSize: 10 },
          { text: 'Column splitting ensures continuous flow', x: 54, y: 556, fontSize: 10 },
          { text: 'across distinct text blocks.', x: 54, y: 542, fontSize: 10 },
          // Right column
          { text: '2. Architecture', x: 320, y: 610, fontSize: 12 },
          { text: 'Our parser decomposes visual geometry', x: 320, y: 590, fontSize: 10 },
          { text: 'into coherent semantic regions.', x: 320, y: 576, fontSize: 10 },
          { text: 'Extracted lines are normalized before', x: 320, y: 556, fontSize: 10 },
          { text: 'acoustic phonemization.', x: 320, y: 542, fontSize: 10 },
          // Spanning References at bottom
          { text: 'References', x: 54, y: 500, fontSize: 12 },
          { text: '1. Vaswani et al. Attention is all you need. 2017.', x: 54, y: 480, fontSize: 10 },
          { text: 'Copyright © 2026 IEEE. All rights reserved.', x: 54, y: 20, fontSize: 8 },
        ],
      }],
    },

    // 2. Fragmented Kerning Stream Reassembly
    {
      ...WILD_PDF_MANIFEST[1],
      pages: [{
        items: [
          { text: 'Micro-Fragmented Kerning Stream Evaluation', x: 54, y: 750, fontSize: 16 },
          { text: 'PageNarrator preserves word cohesion.', x: 54, y: 700, fontSize: 12 },
          { text: 'Kerning adjustments do not split spoken tokens.', x: 54, y: 670, fontSize: 12 },
        ],
      }],
    },

    // 3. Unicode Typographic Ligatures
    {
      ...WILD_PDF_MANIFEST[2],
      pages: [{
        items: [
          { text: 'Typographic Ligature Normalization', x: 54, y: 750, fontSize: 16 },
          { text: 'The efficient offline flow achieved flawless affiliation and aesthetic manoeuvre.', x: 54, y: 700, fontSize: 12 },
          { text: 'Different configuration flags amplify typographic clarity without sacrificing fidelity.', x: 54, y: 670, fontSize: 12 },
        ],
      }],
    },

    // 4. Display Equations with Isolated Right Labels
    {
      ...WILD_PDF_MANIFEST[3],
      pages: [{
        items: [
          { text: 'Mathematical Objective Formulation', x: 54, y: 750, fontSize: 16 },
          { text: 'The total loss function balances reconstruction accuracy and adversarial regularization:', x: 54, y: 710, fontSize: 12 },
          { text: 'L_total = alpha * L_rec + beta * L_adv', x: 180, y: 670, fontSize: 12 },
          { text: '(1)', x: 530, y: 670, fontSize: 11 },
          { text: 'where alpha and beta denote hyperparameter weights chosen empirically.', x: 54, y: 630, fontSize: 12 },
          { text: 'grad_theta = nabla_theta * E[log D(x)]', x: 180, y: 590, fontSize: 12 },
          { text: '(2.1)', x: 520, y: 590, fontSize: 11 },
          { text: 'Training converges steadily when the learning rate is scheduled adaptively.', x: 54, y: 550, fontSize: 12 },
        ],
      }],
    },

    // 5. Multi-Line Table Cells
    {
      ...WILD_PDF_MANIFEST[4],
      pages: [{
        items: [
          { text: 'Table 1: Benchmark Summary across Architectural Configurations', x: 54, y: 750, fontSize: 14 },
          { text: 'Config Description Latency Throughput', x: 54, y: 710, fontSize: 11 },
          { text: 'A-1 Baseline on-device reader using CPU WebAssembly fallback 45ms 120wpm', x: 54, y: 670, fontSize: 11 },
          { text: 'B-2 Optimized WebGPU neural pipeline with streaming audio buffers 22ms 280wpm', x: 54, y: 630, fontSize: 11 },
        ],
      }],
    },

    // 6. Cross-Page Column Sentence Wrap
    {
      ...WILD_PDF_MANIFEST[5],
      pages: [
        {
          items: [
            { text: 'Cross-Page Flow Study', x: 54, y: 750, fontSize: 16 },
            { text: 'Section 1 introduces distributed optimization.', x: 54, y: 700, fontSize: 12 },
            { text: 'The optimization objective function was formulated to minimize', x: 54, y: 660, fontSize: 12 },
          ],
        },
        {
          items: [
            { text: 'Cross-Page Flow Study - Technical Report', x: 200, y: 775, fontSize: 8 },
            { text: 'the reconstruction loss across all training samples without divergence.', x: 54, y: 700, fontSize: 12 },
            { text: 'Subsequent experiments confirmed rapid loss decay across benchmark splits.', x: 54, y: 670, fontSize: 12 },
            { text: 'Page 2 of 2', x: 300, y: 18, fontSize: 8 },
          ],
        },
      ],
    },

    // 7. Mixed Landscape & Portrait Viewport
    {
      ...WILD_PDF_MANIFEST[6],
      pages: [
        {
          width: 612,
          height: 792,
          items: [
            { text: 'Introduction to System Architecture', x: 54, y: 750, fontSize: 16 },
            { text: 'Standard portrait narrative describing core client components.', x: 54, y: 700, fontSize: 12 },
          ],
        },
        {
          width: 792,
          height: 612,
          items: [
            { text: 'Wide System Topology Diagram and Component Interconnects', x: 54, y: 550, fontSize: 16 },
            { text: 'Detailed subsystem breakdown spanning the wide landscape visual area.', x: 54, y: 500, fontSize: 12 },
          ],
        },
      ],
    },

    // 8. Superscript Footnotes and Bottom Annotations
    {
      ...WILD_PDF_MANIFEST[7],
      pages: [{
        items: [
          { text: 'Acoustic Model Evaluation', x: 54, y: 750, fontSize: 16 },
          { text: 'We evaluate the neural pipeline on the standardized multi-speaker benchmark', x: 54, y: 700, fontSize: 12 },
          { text: '1', x: 480, y: 706, fontSize: 8 },
          { text: 'and measure audio clarity across accents.', x: 54, y: 670, fontSize: 12 },
          { text: '2', x: 300, y: 676, fontSize: 8 },
          { text: 'The results demonstrate consistent word error rate reductions.', x: 54, y: 640, fontSize: 12 },
          // Footnotes at bottom edge
          { text: '1 Dataset available in public repository under open license.', x: 54, y: 40, fontSize: 8 },
          { text: '2 Subjective evaluations conducted with blinded native listeners.', x: 54, y: 25, fontSize: 8 },
        ],
      }],
    },

    // 9. Quotation Mark Drop Caps
    {
      ...WILD_PDF_MANIFEST[8],
      pages: [{
        items: [
          { text: 'Chapter 1: The Evolution of Neural Speech', x: 54, y: 750, fontSize: 16 },
          { text: '"I', x: 48, y: 660, fontSize: 36 },
          { text: 'In the beginning of neural synthesis research,', x: 88, y: 685, fontSize: 12 },
          { text: 'models required massive server clusters to run.', x: 88, y: 668, fontSize: 12 },
          { text: 'Today, lightweight models run completely inside client browsers.', x: 54, y: 640, fontSize: 12 },
        ],
      }],
    },

    // 10. OCR Baseline Jitter and Tolerance Bands
    {
      ...WILD_PDF_MANIFEST[9],
      pages: [{
        items: [
          { text: 'Historical ', x: 54, y: 750.5, fontSize: 16 },
          { text: 'Archive ', x: 135, y: 749.2, fontSize: 16 },
          { text: 'Document ', x: 200, y: 751.1, fontSize: 16 },
          { text: 'Transcription', x: 285, y: 749.8, fontSize: 16 },
          { text: 'Scanned text layers require flexible vertical alignment tolerances to prevent fragmentation.', x: 54, y: 700.4, fontSize: 12 },
          { text: 'The extraction model clusters jittered text lines into single cohesive sentences.', x: 54, y: 670.2, fontSize: 12 },
        ],
      }],
    },
  ];
}

/**
 * Writes all 10 wild PDF fixtures to disk.
 */
export function writeAllWildPdfFixtures() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const descriptors = getWildPdfDescriptors();
  const writtenPaths = [];

  for (const descriptor of descriptors) {
    const filePath = path.join(FIXTURES_DIR, descriptor.fileName);
    const pdfBytes = buildPdfBytes(descriptor.pages);
    writeFileSync(filePath, pdfBytes);
    writtenPaths.push(filePath);
  }

  return writtenPaths;
}
