import { describe, expect, it, vi } from 'vitest';
import {
  PDF_CMAPS_ASSET_PATH,
  PDF_ICCS_ASSET_PATH,
  PDF_STANDARD_FONTS_ASSET_PATH,
  PDF_WASM_ASSET_PATH,
  PDF_WORKER_ASSET_PATH,
  extractPdfArticle,
  extractPdfTextFromData,
  getPdfCMapUrl,
  getPdfDocumentParams,
  getPdfIccUrl,
  getPdfStandardFontDataUrl,
  getPdfWasmUrl,
  getPdfWorkerUrl,
} from '../../src/lib/pdf-extraction.js';

describe('Original PDF WASM, CMap, Font, and ICC asset configuration', () => {
  it('exposes stable asset path constants for extension packaging', () => {
    expect(PDF_WORKER_ASSET_PATH).toBe('assets/pdf.worker.js');
    expect(PDF_WASM_ASSET_PATH).toBe('assets/pdf-engine/pdf.wasm');
    expect(PDF_CMAPS_ASSET_PATH).toBe('assets/pdf-cmaps/');
    expect(PDF_STANDARD_FONTS_ASSET_PATH).toBe('assets/pdf-data/standard_fonts/');
    expect(PDF_ICCS_ASSET_PATH).toBe('assets/pdf-data/iccs/');
  });

  it('uses packaged paths without a runtime; Node callers supply explicit local configuration', () => {
    expect(getPdfWasmUrl({})).toBe(PDF_WASM_ASSET_PATH);
    expect(getPdfCMapUrl({})).toBe(PDF_CMAPS_ASSET_PATH);
    expect(getPdfStandardFontDataUrl({})).toBe(PDF_STANDARD_FONTS_ASSET_PATH);
    expect(getPdfIccUrl({})).toBe(PDF_ICCS_ASSET_PATH);
    expect(getPdfWorkerUrl({})).toBe(PDF_WORKER_ASSET_PATH);
  });

  it('resolves chrome-extension asset URLs when chrome.runtime is provided', () => {
    const mockRuntime = {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    };

    expect(getPdfWasmUrl(mockRuntime)).toBe('chrome-extension://test-extension-id/assets/pdf-engine/pdf.wasm');
    expect(getPdfCMapUrl(mockRuntime)).toBe('chrome-extension://test-extension-id/assets/pdf-cmaps/');
    expect(getPdfStandardFontDataUrl(mockRuntime)).toBe('chrome-extension://test-extension-id/assets/pdf-data/standard_fonts/');
    expect(getPdfIccUrl(mockRuntime)).toBe('chrome-extension://test-extension-id/assets/pdf-data/iccs/');
    expect(getPdfWorkerUrl(mockRuntime)).toBe('chrome-extension://test-extension-id/assets/pdf.worker.js');
  });

  it('falls back to relative asset paths when runtime is an empty object without getURL', () => {
    const fallbackRuntime = {};

    expect(getPdfWasmUrl(fallbackRuntime)).toBe('assets/pdf-engine/pdf.wasm');
    expect(getPdfCMapUrl(fallbackRuntime)).toBe('assets/pdf-cmaps/');
    expect(getPdfStandardFontDataUrl(fallbackRuntime)).toBe('assets/pdf-data/standard_fonts/');
    expect(getPdfIccUrl(fallbackRuntime)).toBe('assets/pdf-data/iccs/');
  });

  it('includes wasmUrl, cMapUrl, and standardFontDataUrl in getPdfDocumentParams when requested', () => {
    const mockRuntime = {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    };

    const params = getPdfDocumentParams('https://example.test/document.pdf', {
      runtime: mockRuntime,
    });

    expect(params).toEqual({
      url: 'https://example.test/document.pdf',
      withCredentials: false,
      useSystemFonts: true,
      rangeChunkSize: 64 * 1024,
      enableScripting: false,
      wasmUrl: 'chrome-extension://test-extension-id/assets/pdf-engine/pdf.wasm',
      cMapUrl: 'chrome-extension://test-extension-id/assets/pdf-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'chrome-extension://test-extension-id/assets/pdf-data/standard_fonts/',
    });
  });

  it('preserves exact 5-property baseline for getPdfDocumentParams when called without options', () => {
    const baseline = getPdfDocumentParams('https://example.test/document.pdf');
    expect(baseline).toEqual({
      url: 'https://example.test/document.pdf',
      withCredentials: false,
      useSystemFonts: true,
      rangeChunkSize: 64 * 1024,
      enableScripting: false,
    });
  });

  it('passes wasmUrl, cMapUrl, and standardFontDataUrl when extractPdfTextFromData loads document bytes', async () => {
    const calls = [];
    const fakeDoc = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getTextContent: async () => ({ items: [{ str: 'Sample page', transform: [1, 0, 0, 1, 0, 0] }] }),
        cleanup: vi.fn(),
      })),
      destroy: vi.fn(async () => {}),
    };
    const fakePdfjs = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: vi.fn((params) => {
        calls.push(params);
        return {
          promise: Promise.resolve(fakeDoc),
          destroy: vi.fn(async () => {}),
        };
      }),
    };

    const mockRuntime = {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    };

    await extractPdfTextFromData(new Uint8Array([37, 80, 68, 70, 45]), {
      pdfjs: fakePdfjs,
      runtime: mockRuntime,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      data: expect.any(Uint8Array),
      enableScripting: false,
      wasmUrl: 'chrome-extension://test-extension-id/assets/pdf-engine/pdf.wasm',
      cMapUrl: 'chrome-extension://test-extension-id/assets/pdf-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'chrome-extension://test-extension-id/assets/pdf-data/standard_fonts/',
    });
  });

  it('passes wasmUrl, cMapUrl, and standardFontDataUrl when extractPdfArticle delegates URL loading', async () => {
    const calls = [];
    const fakeDoc = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getTextContent: async () => ({ items: [{ str: 'Article text', transform: [1, 0, 0, 1, 0, 0] }] }),
        cleanup: vi.fn(),
      })),
      destroy: vi.fn(async () => {}),
    };
    const fakePdfjs = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: vi.fn((params) => {
        calls.push(params);
        return {
          promise: Promise.resolve(fakeDoc),
          destroy: vi.fn(async () => {}),
        };
      }),
    };

    const mockRuntime = {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    };

    await extractPdfArticle({
      tab: { title: 'Book.pdf', url: 'https://example.test/book.pdf' },
      pdfjs: fakePdfjs,
      runtime: mockRuntime,
      fetch: async () => {
        throw new Error('fetch should not be called for range loaded article');
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://example.test/book.pdf',
      wasmUrl: 'chrome-extension://test-extension-id/assets/pdf-engine/pdf.wasm',
      cMapUrl: 'chrome-extension://test-extension-id/assets/pdf-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'chrome-extension://test-extension-id/assets/pdf-data/standard_fonts/',
    });
  });
});
