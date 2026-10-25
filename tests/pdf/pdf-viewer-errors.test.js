import { describe, expect, it } from 'vitest';
import { classifyPdfLoadError } from '../../src/lib/pdf-viewer-errors.js';

describe('PDF viewer load errors', () => {
  it('separates corrupt file and network recovery paths', () => {
    expect(classifyPdfLoadError(new Error('Invalid PDF structure'))).toMatchObject({
      code: 'pdf_corrupt',
      message: 'This PDF is damaged or unsupported.',
    });

    expect(classifyPdfLoadError(new Error('404 Not Found'))).toMatchObject({
      code: 'pdf_network',
      message: 'Could not download the PDF. Check the link and your connection.',
      actionLabel: 'Retry',
    });
  });
});
