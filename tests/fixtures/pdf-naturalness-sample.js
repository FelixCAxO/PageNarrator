import { PDF_ACCEPTANCE_BENCHMARK } from './pdf-acceptance-manifest.js';

const SAMPLE_PDF_IDS = Object.freeze([
  '2604.27543v1',
  '2604.27421v1',
  '2604.27393v1',
  '2604.26328v1',
  '2604.25476v1',
  '2604.25359v1',
  '2604.25135v1',
  '2604.24559v1',
  '2604.23815v1',
  '2604.23575v2',
  '2604.23296v1',
  '2604.23002v1',
  '2604.22367v1',
  '2604.21590v1',
  '2604.21555v1',
  '2604.21229v1',
  '2604.20511v1',
  '2604.20382v1',
  '2604.22851v1',
  '2604.19984v1',
  '2604.19405v1',
  '2604.18913v1',
  '2604.17930v1',
  '2606.24188v1',
  '2606.24176v1',
  '2606.24162v1',
  '2606.24147v1',
  '2606.24133v1',
  '2606.24119v1',
  '2606.24099v1',
  '2606.24083v1',
  '2606.24063v1',
  '2606.24040v1',
  '2606.24014v1',
  '2606.23989v1',
  '2606.23943v1',
  '2606.23915v1',
  '2606.23881v1',
  '2606.23687v1',
  '2606.23670v1',
  'fixture-title-single-column',
  'fixture-ltr-two-column',
  'fixture-rtl-two-column',
  'fixture-mixed-direction',
  'fixture-list',
  'fixture-table',
  'fixture-caption-after-columns',
  'fixture-running-content',
  'fixture-citations-decorations',
  'fixture-split-words',
]);

const recordsById = new Map(PDF_ACCEPTANCE_BENCHMARK.map((record) => [record.id, record]));

export const PDF_NATURALNESS_SAMPLE = Object.freeze(SAMPLE_PDF_IDS.map((pdfId, index) => {
  const record = recordsById.get(pdfId);
  if (!record) throw new Error(`Unknown PDF naturalness sample identity: ${pdfId}`);
  return Object.freeze({
    id: `naturalness-${String(index + 1).padStart(2, '0')}`,
    pdfId,
    pageNumber: record.pageNumber,
    categories: Object.freeze([...record.categories]),
  });
}));
