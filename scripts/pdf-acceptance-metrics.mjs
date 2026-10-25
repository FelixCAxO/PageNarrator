import { releaseGateWaiver } from './lib/release-policy.mjs';

const ratio = (passed, total) => total ? passed / total : 0;
const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

export function validateNaturalnessRatingPanel(ratings, label = 'Naturalness evidence') {
  if (!Array.isArray(ratings) || ratings.length < 2 || ratings.length > 3
    || ratings.some((rating) => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error(`${label} has invalid ratings.`);
  }
  const requiresAdjudication = Math.abs(ratings[0] - ratings[1]) > 1;
  if (requiresAdjudication && ratings.length !== 3) {
    throw new Error(`${label} requires adjudication.`);
  }
  if (!requiresAdjudication && ratings.length !== 2) {
    throw new Error(`${label} has unexpected adjudication.`);
  }
}

export function validateNaturalnessReviews(record, label = 'Naturalness evidence') {
  const { ratings, reviews, transcriptSha256 } = record;
  if (!/^[a-f0-9]{64}$/u.test(transcriptSha256 || '') || !Array.isArray(ratings)
    || !Array.isArray(reviews) || reviews.length !== ratings.length) {
    throw new Error(`${label} requires one bound human review per rating.`);
  }
  const reviewers = new Set();
  for (const review of reviews) {
    const reviewer = typeof review?.reviewerId === 'string' ? review.reviewerId.trim().toLowerCase() : '';
    const instant = typeof review?.reviewedAt === 'string' ? Date.parse(review.reviewedAt) : NaN;
    if (review?.kind !== 'human' || !reviewer || reviewers.has(reviewer)
      || !Number.isFinite(instant) || new Date(instant).toISOString() !== review.reviewedAt
      || review.transcriptSha256 !== transcriptSha256) {
      throw new Error(`${label} requires distinct human reviewers, UTC review dates and matching transcript hashes.`);
    }
    reviewers.add(reviewer);
  }
}

export function matchesOrderedCheckpoints(text, checkpoints) {
  const documentTokens = getOrderTokens(text);
  const preparedCheckpoints = prepareOrderedCheckpoints(checkpoints);
  let cursor = 0;

  for (const checkpoint of preparedCheckpoints) {
    if (!checkpoint.meaningful) return { passed: false, failedCheckpoint: checkpoint.raw };
    const expectedTokens = checkpoint.tokens;
    const match = findTokenSequence(documentTokens, expectedTokens, cursor);
    if (!match) return { passed: false, failedCheckpoint: checkpoint.raw };
    cursor = match.end;
  }
  return { passed: true, failedCheckpoint: null };
}

function prepareOrderedCheckpoints(checkpoints) {
  const prepared = checkpoints.map(raw => {
    const text = stripNarrationSuppressedTokens(raw), tokens = getOrderTokens(text);
    return { raw, text, tokens, meaningful: tokens.length > 0 };
  });

  for (let index = 0; index < prepared.length - 1; index += 1) {
    const current = prepared[index];
    const next = prepared[index + 1];
    const left = current.text.match(/(\p{L}+)-\s*$/u)?.[1];
    const right = next.text.match(/^\s*(\p{Ll}[\p{L}-]*)/u)?.[1];
    if (!left || !right || right.includes('-') || !current.tokens.length || !next.tokens.length) continue;
    current.tokens[current.tokens.length - 1] = `${current.tokens.at(-1)}${next.tokens[0]}`;
    next.tokens.shift();
  }
  return prepared;
}

function stripNarrationSuppressedTokens(value) {
  // Checkpoints remain verbatim gold. Only declared speech suppressions are removed for scoring;
  // the candidate narration itself is never rewritten here. Match the existing URL_TOKEN policy.
  return String(value || '').replace(
    /\s*\[\s*\d+[a-z]?(?:\s*(?:,|[-\u2013])\s*\d+[a-z]?)*\s*\]/giu,
    ' ',
  ).replace(/\b(?:https?:\/\/|www\.|github\.com\/|kaggle\.com\/)[^\s<>{}\[\]]+/giu,
    (url, offset, source) => isQuotedCodeUrl(source, offset) ? url : ' ');
}

function isQuotedCodeUrl(source, offset) {
  // Keep meaningful literal arguments/assignments. This is an independent lexical scoring
  // rule, not an import of the candidate's code/layout classification.
  if (!/^[\p{L}_$][\p{L}\p{N}_$.]*(?:\(|\s*=(?!=))/u.test(source.trimStart())) return false;
  const quote = source[offset - 1];
  if (quote !== "'" && quote !== '"' || !/[(,=]\s*['"]$/u.test(source.slice(0, offset))) return false;
  for (let index = offset; index < source.length; index++) {
    if (source[index] === '\n' || source[index] === '\r') return false;
    if (source[index] === '\\') index++;
    else if (source[index] === quote) return /^\S+$/u.test(source.slice(offset, index));
  }
  return false;
}

function findTokenSequence(documentTokens, expectedTokens, start) {
  if (!expectedTokens.length) return { end: start };
  for (let index = start; index < documentTokens.length; index += 1) {
    const end = matchTokensAt(documentTokens, expectedTokens, index);
    if (end >= 0) return { end };
  }
  return null;
}

function matchTokensAt(documentTokens, expectedTokens, start) {
  let cursor = start, expectedCursor = 0;
  while (expectedCursor < expectedTokens.length) {
    let actual = documentTokens[cursor], expected = expectedTokens[expectedCursor];
    let actualCount = 1, expectedCount = 1;
    if (actual === undefined) return -1;
    // PDF item segmentation may split either side. Consume whole tokens only, with the same
    // eight-token bound in each direction; no prefix, missing-character or interior match.
    while (actual !== expected) {
      if (actual.length < expected.length) {
        if (!expected.startsWith(actual) || actualCount === 8 || cursor + actualCount >= documentTokens.length) return -1;
        actual += documentTokens[cursor + actualCount++];
      } else {
        if (!actual.startsWith(expected) || expectedCount === 8 || expectedCursor + expectedCount >= expectedTokens.length) return -1;
        expected += expectedTokens[expectedCursor + expectedCount++];
      }
    }
    cursor += actualCount;
    expectedCursor += expectedCount;
  }
  return cursor;
}

function getOrderTokens(value) {
  return foldLatinDiacritics(value)
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function foldLatinDiacritics(value) {
  let latinBase = false;
  let result = '';
  for (const character of String(value || '').normalize('NFKD')) {
    if (/\p{M}/u.test(character)) {
      if (!latinBase) result += character;
      continue;
    }
    latinBase = /\p{Script=Latin}/u.test(character);
    result += character;
  }
  return result;
}

export function countNarrationErrors(rawNarration, forbiddenEntries) {
  const narration = normalizeNarrationText(rawNarration);
  const standaloneSegments = String(rawNarration || '')
    .split(/\r?\n|(?<=[.!?])\s+/u)
    .map((segment) => normalizeNarrationText(segment).replace(/[.!?]+$/u, '').trim())
    .filter(Boolean);
  let errors = 0;

  for (const entry of new Set(forbiddenEntries)) {
    const forbidden = normalizeNarrationText(entry);
    if (!forbidden) continue;
    const pageNumberOnly = /^page\s*\d+$/u.test(forbidden);
    const standaloneOnly = /^(?:page\s*)?\d+$/u.test(forbidden)
      || !/[\p{L}\p{N}]/u.test(forbidden);
    if (standaloneOnly) {
      errors += standaloneSegments.filter((segment) => (
        segment === forbidden
        || (pageNumberOnly && isAttachedPageFurniture(segment, forbidden))
      )).length;
      continue;
    }
    let cursor = 0;
    while (cursor < narration.length) {
      const index = narration.indexOf(forbidden, cursor);
      if (index < 0) break;
      errors += 1;
      cursor = index + Math.max(1, forbidden.length);
    }
  }
  return errors;
}

function isAttachedPageFurniture(segment, forbidden) {
  if (!segment.startsWith(`${forbidden} `)) return false;
  const following = segment.slice(forbidden.length).trim();
  return !/^(?:contains?|describes?|discusses?|explains?|presents?|reports?|shows?|summari[sz]es?)\b/u.test(following);
}

function normalizeNarrationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function scorePdfAcceptance({ pages, passages, chunks, words, imageOnly }, {
  reportIncompleteNaturalness = false,
  ratingFixtureError = null,
  naturalnessWaiver = null,
} = {}) {
  if (pages.length !== 100) throw new Error(`Expected 100 benchmark pages, got ${pages.length}.`);
  const waived = naturalnessWaiver !== null;
  const expectedWaiver = naturalnessWaiver && releaseGateWaiver('human-listening-reviews', naturalnessWaiver.version);
  if (waived && (!expectedWaiver || Object.entries(expectedWaiver).some(([key, value]) => naturalnessWaiver[key] !== value))) {
    throw new Error('Invalid PDF naturalness release waiver.');
  }
  if (passages.length !== (waived ? 0 : 50)) throw new Error(`Expected ${waived ? 0 : 50} naturalness passages, got ${passages.length}.`);
  if (!chunks.length || !words.length || !imageOnly.length) {
    throw new Error('Grounding, word, and image-only evidence is required.');
  }
  if (typeof reportIncompleteNaturalness !== 'boolean') throw new TypeError('Naturalness reporting option must be boolean.');
  const evidence = !waived && reportIncompleteNaturalness ? describeNaturalnessEvidence(passages, ratingFixtureError) : null;
  if (!waived && !reportIncompleteNaturalness) validateNaturalnessEvidence(passages);

  const orderedPages = pages.filter((page) => page.readingOrder).length;
  const narrationErrors = pages.reduce((sum, page) => sum + page.narrationErrors, 0);
  const passageScores = evidence && !evidence.complete ? [] : passages.map((passage) => {
    const sorted = [...passage.ratings].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  });
  const groundedChunks = chunks.filter((chunk) => chunk.grounded).length;
  const alignedWords = words.filter((word) => word.aligned).length;
  const imageOnlyCorrect = imageOnly.filter((result) => (
    result.expectedImageOnly
      ? result.code === 'scanned_pdf_unsupported'
      : result.code !== 'scanned_pdf_unsupported'
  )).length;

  const result = {
    readingOrder: {
      passed: orderedPages,
      total: pages.length,
      accuracy: ratio(orderedPages, pages.length),
    },
    narration: { errors: narrationErrors, pages: pages.length },
    naturalness: waived ? { status: 'waived', verified: false, passages: 0, average: null, waiver: naturalnessWaiver }
      : { passages: passages.length, average: evidence && !evidence.complete ? null : average(passageScores),
        ...(evidence ? { evidence } : {}) },
    grounding: {
      passed: groundedChunks,
      total: chunks.length,
      accuracy: ratio(groundedChunks, chunks.length),
    },
    alignment: {
      passed: alignedWords,
      total: words.length,
      accuracy: ratio(alignedWords, words.length),
    },
    imageOnly: {
      passed: imageOnlyCorrect,
      total: imageOnly.length,
      accuracy: ratio(imageOnlyCorrect, imageOnly.length),
    },
  };
  const incompletePages = pages.filter(page => page.emptyOutput === true || page.error || page.evaluated === false);
  if (pages.some(page => Object.hasOwn(page, 'evaluated'))) result.incompletePages = incompletePages.map(page => page.id);
  result.passed = !incompletePages.length && (waived || (!evidence || evidence.complete) && result.naturalness.average >= 4)
    && result.readingOrder.accuracy >= 0.95
    && result.narration.errors <= 10
    && result.grounding.accuracy >= 0.98
    && result.alignment.accuracy >= 0.95
    && result.imageOnly.accuracy === 1;
  return result;
}

function describeNaturalnessEvidence(passages, fixtureError) {
  const ids = new Set(), hash = /^[a-f0-9]{64}$/u;
  const records = passages.map(passage => {
    const id = String(passage?.id || '').trim();
    if (!id || ids.has(id)) throw new Error('Naturalness evidence must contain 50 unique passage ids.');
    ids.add(id);
    const issues = [], current = passage.currentTranscriptSha256, rated = passage.ratedTranscriptSha256;
    if (fixtureError) issues.push({ code: 'invalid-rating-fixture', message: fixtureError });
    if (passage.ratingRecordCount !== 1) issues.push({ code: passage.ratingRecordCount === 0 ? 'missing-rating' : 'ambiguous-rating', message: 'Exactly one original rating record is required.' });
    if (!hash.test(current || '')) issues.push({ code: 'missing-current-transcript', message: 'Current transcript hash is missing or invalid.' });
    if (!hash.test(rated || '')) issues.push({ code: 'missing-rated-transcript', message: 'Original rated transcript hash is missing or invalid.' });
    if (hash.test(current || '') && hash.test(rated || '') && (current !== rated || passage.transcriptHashMatches !== true)) {
      issues.push({ code: 'stale-transcript', message: 'Human reviews do not qualify the current transcript.' });
    }
    try { validateNaturalnessRatingPanel(passage.ratings, `Naturalness evidence for ${id}`); }
    catch (error) { issues.push({ code: 'invalid-rating-panel', message: error.message }); }
    try { validateNaturalnessReviews(passage, `Naturalness evidence for ${id}`); }
    catch (error) { issues.push({ code: 'invalid-human-review', message: error.message }); }
    return { id, status: issues.length ? 'NOT_QUALIFIED' : 'CURRENT', qualified: issues.length === 0,
      currentTranscriptSha256: current ?? null, ratedTranscriptSha256: rated ?? null, issues };
  });
  const qualifiedPassages = records.filter(record => record.qualified).length;
  return { complete: qualifiedPassages === passages.length, status: qualifiedPassages === passages.length ? 'CURRENT' : 'NOT_QUALIFIED',
    qualifiedPassages, total: passages.length, fixtureError, records };
}

function validateNaturalnessEvidence(passages) {
  const passageIds = new Set();
  for (const passage of passages) {
    const passageId = String(passage?.id || '').trim();
    if (!passageId || passageIds.has(passageId)) {
      throw new Error('Naturalness evidence must contain 50 unique passage ids.');
    }
    passageIds.add(passageId);
    if (passage.transcriptHashMatches !== true) {
      throw new Error(`Naturalness evidence has a stale transcript hash for ${passageId}.`);
    }
    validateNaturalnessRatingPanel(passage.ratings, `Naturalness evidence for ${passageId}`);
    validateNaturalnessReviews(passage, `Naturalness evidence for ${passageId}`);
  }
}
