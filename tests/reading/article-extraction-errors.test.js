import { describe, expect, it } from 'vitest';
import { classifyArticleExtractionError } from '../../src/lib/article-extraction-errors.js';

describe('article extraction error classification', () => {
  it('classifies login walls, CAPTCHA pages, empty selections, and scanned PDFs into actionable reader copy', () => {
    expect(classifyArticleExtractionError({
      source: 'empty',
      text: '',
      title: 'Sign in',
      url: 'https://news.example.test/login',
      error: 'No readable article text was found.',
    })).toMatchObject({
      code: 'login_wall',
      message: 'Sign in to the site, then retry.',
      actionLabel: 'Sign in',
    });

    expect(classifyArticleExtractionError({
      source: 'empty',
      text: '',
      title: 'Verify you are human',
      error: 'CAPTCHA challenge detected.',
    })).toMatchObject({
      code: 'captcha',
      message: 'Complete the CAPTCHA on the page, then retry.',
      actionLabel: 'Try again',
    });

    expect(classifyArticleExtractionError({
      source: 'selection',
      text: '',
      error: 'Select text on the page first.',
    })).toMatchObject({
      code: 'empty_selection',
      message: 'No text is selected.',
      actionLabel: 'Select text',
    });

    expect(classifyArticleExtractionError({
      source: 'pdf',
      text: '',
      error: 'scanned_pdf_unsupported',
    })).toMatchObject({
      code: 'scanned_pdf_unsupported',
      message: 'Some PDF text could not be read reliably.',
      actionLabel: 'Use a text-based PDF',
    });

  });

  it('retains recognition routing when a PDF error crosses a message-only transport', () => {
    expect(classifyArticleExtractionError({ source: 'pdf', error: 'This PDF needs text recognition before its visible text can be read reliably.' }))
      .toMatchObject({ code: 'scanned_pdf_unsupported', title: 'Text recognition required' });
  });
});
