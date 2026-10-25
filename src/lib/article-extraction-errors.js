import { ERROR_REGISTRY, getErrorRecord } from './error-registry.js';

export function classifyArticleExtractionError(article = {}) {
  const code = article.errorCode || article.error?.code || (typeof article.error === 'string' && article.error);
  if (code && ERROR_REGISTRY[code]) {
    return getErrorRecord(code);
  }

  const message = getRawMessage(article);
  const haystack = `${article.title || ''} ${article.url || ''} ${message}`.toLowerCase();

  if (article.source === 'selection' || /select text/i.test(message)) {
    return getErrorRecord('empty_selection');
  }

  if (article.source === 'pdf' && /scanned|image-only|no text layer|text recognition|scanned_pdf_unsupported/i.test(message)) {
    return getErrorRecord('scanned_pdf_unsupported');
  }

  if (/\bcaptcha\b|verify you are human|robot check|cloudflare challenge/i.test(haystack)) {
    return getErrorRecord('captcha');
  }

  if (/\blog[\s-]?in\b|\bsign[\s-]?in\b|subscribe|paywall|account required/i.test(haystack)) {
    return getErrorRecord('login_wall');
  }

  return getErrorRecord('article_text_not_found', {
    message: message || 'No readable article text was found.',
    actionLabel: 'Try another page',
  });
}

function getRawMessage(article = {}) {
  if (typeof article.error === 'string') return article.error;
  return article.error?.message || '';
}
