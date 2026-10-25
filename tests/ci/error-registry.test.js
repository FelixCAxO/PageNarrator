import { describe, expect, it } from 'vitest';
import { ERROR_REGISTRY, getErrorRecord } from '../../src/lib/error-registry.js';
import { classifyArticleExtractionError } from '../../src/lib/article-extraction-errors.js';
import { classifyPdfLoadError } from '../../src/lib/pdf-viewer-errors.js';

describe('shared error registry', () => {
  it('keeps actionable reader and PDF recovery records without commercial states', () => {
    expect(ERROR_REGISTRY).not.toHaveProperty('quota_exhausted');
    expect(ERROR_REGISTRY).not.toHaveProperty('pdf_pro_required');
    expect(ERROR_REGISTRY).not.toHaveProperty('invalid_license');
    expect(classifyArticleExtractionError({ source: 'pdf', error: 'scanned_pdf_unsupported' }))
      .toEqual(expect.objectContaining(getErrorRecord('scanned_pdf_unsupported')));
    expect(classifyPdfLoadError(new Error('Invalid PDF structure')))
      .toEqual(expect.objectContaining(getErrorRecord('pdf_corrupt')));
  });
});
