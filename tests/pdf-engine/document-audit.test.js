import { describe, expect, it, vi } from 'vitest';
import { auditPdfDocument } from '../../tooling/scripts/probe-pdf-document.mjs';

describe('whole-document PDF preflight', () => {
  it('checks pages beyond a failure, reports recovery, and disposes every page and document', async () => {
    const cleanup = vi.fn(), destroy = vi.fn(), onPage = vi.fn();
    const engine = { getDocument: () => ({ destroy, promise: Promise.resolve({ numPages: 4, getPage: async number => ({ cleanup,
      async getTextContent() { if (number === 2) throw Object.assign(new Error('Unreadable font'), { code: 'pdf_unsupported' }); return { items: [{ str: 'Text' }] }; },
      async inspect() { return { artworkWarnings: number === 3 ? [{ kind: 'shading' }] : [], unmappedGlyphs: number === 1 ? 2 : 0 }; },
      async ensureFonts() { if (number === 4) throw new SyntaxError('Invalid font data'); },
    }) }) }) };
    const report = await auditPdfDocument(new Uint8Array(), { engine, onPage });
    expect(report.pages).toBe(4); expect(report.failures).toBe(2); expect(report.recoveredPages).toEqual([3]);
    expect(report.unreadablePages).toEqual([1]);
    expect(report.records[1].error).toEqual({ code: 'pdf_unsupported', message: 'Unreadable font' });
    expect(report.records[3].error.message).toBe('Invalid font data');
    expect(cleanup).toHaveBeenCalledTimes(4); expect(destroy).toHaveBeenCalledOnce(); expect(onPage).toHaveBeenCalledTimes(4);
  });
});
