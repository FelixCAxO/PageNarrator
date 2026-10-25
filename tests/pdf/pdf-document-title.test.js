import { describe, expect, it } from 'vitest';
import { DEFAULT_PDF_VIEWER_TITLE, getPdfDisplayTitle } from '../../src/lib/pdf-document-title.js';

describe('PDF viewer display title', () => {
  it('prefers the PDF metadata title', () => {
    expect(getPdfDisplayTitle({ metadataTitle: '  Listening to Long Documents ', sourceUrl: 'https://example.com/guide.pdf' }))
      .toBe('Listening to Long Documents');
  });

  it('strips authoring-tool prefixes and file extensions from metadata titles', () => {
    expect(getPdfDisplayTitle({ metadataTitle: 'Microsoft Word - Quarterly Report.docx' })).toBe('Quarterly Report');
    expect(getPdfDisplayTitle({ metadataTitle: 'slides.pptx' })).toBe('slides');
  });

  it('falls back to the decoded file name when metadata is missing or generic', () => {
    expect(getPdfDisplayTitle({ metadataTitle: '', sourceUrl: 'https://example.com/docs/Annual%20Report_2026.pdf?x=1#page=3' }))
      .toBe('Annual Report_2026');
    expect(getPdfDisplayTitle({ metadataTitle: 'untitled', sourceUrl: 'file:///C:/Users/me/Paper.PDF' })).toBe('Paper');
    expect(getPdfDisplayTitle({ metadataTitle: 'Untitled document', sourceUrl: 'https://example.com/a/notes.pdf' })).toBe('notes');
  });

  it('keeps the viewer default when nothing useful is available', () => {
    expect(getPdfDisplayTitle({})).toBe(DEFAULT_PDF_VIEWER_TITLE);
    expect(getPdfDisplayTitle({ sourceUrl: 'https://example.com/download?id=42' })).toBe(DEFAULT_PDF_VIEWER_TITLE);
    expect(getPdfDisplayTitle({ sourceUrl: 'https://example.com/%E0%A4%A.pdf' })).toBe(DEFAULT_PDF_VIEWER_TITLE);
  });

  it('bounds very long titles', () => {
    const title = getPdfDisplayTitle({ metadataTitle: 'A'.repeat(400) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });
});
