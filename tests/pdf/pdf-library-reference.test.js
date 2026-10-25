// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { rankLibraryPages, libraryReferencePageRequests, referenceCheckpoints, referenceFurniture } from '../../scripts/build-pdf-library-gold.mjs';

const protocol = { minimumReferenceCharacters: 100, minimumAnchorCharacters: 24,
  minimumAnchorLetterCharacters: 12, maximumAnchorCharacters: 140, checkpoints: 5 };
const lines = [
  'Opening paragraph introduces the independent reference document.',
  'The second paragraph establishes the intended reading sequence.',
  'A middle section explains the source evidence without using product output.',
  'The following section keeps every observed source page in the denominator.',
  'The final paragraph concludes the independently extracted reference page.',
];

describe('independent library-reference selection', () => {
  it('deterministically ranks only unexposed interior pages', () => {
    const pages = rankLibraryPages('a'.repeat(64), 100, 'frozen seed', 12);
    expect(pages).toEqual(rankLibraryPages('a'.repeat(64), 100, 'frozen seed', 12));
    expect(new Set(pages).size).toBe(12);
    expect(pages.every(page => page >= 4 && page <= 97 && ![1, 15, 50, 85, 100].includes(page))).toBe(true);
    expect(rankLibraryPages('a'.repeat(64), 3, 'seed')).toEqual([]);
    expect(rankLibraryPages('b'.repeat(64), 100, 'frozen seed', 12)).not.toEqual(pages);
  });

  it('captures forward witnesses for all ranked candidates with two unchanged bounded calls', () => {
    expect(libraryReferencePageRequests([4, 10], 20)).toEqual({ preceding: [1, 2, 3, 4, 7, 8, 9, 10], forward: [5, 6, 11, 12, 13] });
    expect(libraryReferencePageRequests([4, 21], 24).forward).toEqual([5, 6, 7, 22, 23, 24]);
    const ranked = Array.from({ length: 12 }, (_, index) => 4 + index * 10);
    const request = libraryReferencePageRequests(ranked, 130);
    expect(request.preceding).toHaveLength(48); expect(request.forward).toHaveLength(36);
    expect(request.forward.every(page => !request.preceding.includes(page))).toBe(true);
    expect(() => libraryReferencePageRequests([...ranked, 125], 130)).toThrow('bounds');
    expect(() => libraryReferencePageRequests([4, 4], 20)).toThrow('bounds');
    expect(() => libraryReferencePageRequests([19], 20)).toThrow('bounds');
  });

  it('retains five verbatim, ordered anchors only when both independent texts support them', () => {
    expect(referenceCheckpoints(lines.join('\n'), lines.join(' '), protocol)).toEqual(lines);
    expect(referenceCheckpoints(lines.join('\n'), [...lines].reverse().join(' '), protocol)).toBeNull();
    expect(referenceCheckpoints(lines.join('\n'), lines.slice(1).join(' '), protocol)).toBeNull();
    expect(referenceCheckpoints(lines.join('\n'), [...lines, lines[1]].join(' '), protocol)).toBeNull();
  });

  it('does not manufacture anchors from empty text or known running furniture', () => {
    expect(referenceCheckpoints('', '', protocol)).toBeNull();
    expect(referenceCheckpoints(lines.join('\n'), lines.join(' '), protocol, [lines[1]])).toBeNull();
  });

  it('keeps complete-word verbatim spans without guessing a split word or a true compound', () => {
    const wrapped = [lines[0] + ' consis-', 'tent ' + lines[1], lines[2] + ' resource-', 'constrained ' + lines[3], lines[4]];
    expect(referenceCheckpoints(wrapped.join('\n'), wrapped.join(' '), protocol)).toEqual(lines);
  });

  const word = (text, top, x0 = 40) => ({ text, x0, x1: x0 + 80, top, bottom: top + 10 });
  const page = (pageNumber, body = 'Substantial body text') => ({ pageNumber, height: 800,
    rawWords: [word('Running reference title', 20), word(body, 300), word(String(pageNumber), 770)] });

  it('requires independently located repeated margins, retaining their support pages', () => {
    const result = referenceFurniture([page(4), page(5), page(6), page(7)], 7);
    expect(result.forbidden).toEqual(['Running reference title', '7']);
    expect(result.support[0].pages).toEqual([4, 5, 6, 7]);
    expect(result.support[0].bbox).toEqual([40, 20, 120, 30]);
    expect(referenceFurniture([page(6), page(7)], 7).forbidden).toEqual([]);
    const chapterNumbers = [page(4), page(5), page(6), page(7)];
    for (const row of chapterNumbers) row.rawWords.at(-1).text = '42';
    expect(referenceFurniture(chapterNumbers, 7).forbidden).not.toContain('42');
  });

  it('never blacklists an ambiguous margin string that also occurs in legitimate body', () => {
    const result = referenceFurniture([page(4), page(5), page(6), page(7, 'Running reference title appears in legitimate body')], 7);
    expect(result.forbidden).not.toContain('Running reference title');
    expect(result.anchorExclusions).toContain('Running reference title');
    expect(referenceFurniture([], 7)).toEqual({ forbidden: [], support: [], status: 'no-unambiguous-furniture' });
  });

  it('uses spatial recurrence for alternating headers without adopting the product margin boundary', () => {
    const context = Array.from({ length: 6 }, (_, i) => page(i + 4));
    for (const row of context) {
      row.rawWords[0] = word(row.pageNumber % 2 ? 'Other running reference title' : 'Running reference title', 70);
      row.rawWords[1] = word('Ordinary first body paragraph remains body.', 105);
    }
    const result = referenceFurniture(context, 8);
    expect(result.forbidden).toContain('Running reference title');
    expect(result.support.find(row => row.text === 'Running reference title').pages).toEqual([4, 6, 8]);
  });

  it('reconciles complete furniture spans across independent inferred word boundaries', () => {
    const context = [page(4), page(5), page(6)];
    for (const [i, row] of context.entries()) {
      row.rawWords[0].text = ['Runningreferencetitle', 'Running reference title', 'Runningreference title'][i];
      row.layoutText = ['Running reference title', ...lines].join('\n');
    }
    const result = referenceFurniture(context, 6);
    expect(result.forbidden).toContain('Running reference title');
    const support = result.support.find(row => row.text === 'Running reference title');
    expect(support.pages).toEqual([4, 5, 6]);
    expect(support.rawText).toBe('Runningreference title');
    expect(referenceCheckpoints(['Running reference title', ...lines].join('\n'),
      ['Running reference title', ...lines].join(' '), protocol, ['Runningreferencetitle'])).toEqual(lines);
  });

  it('does not exclude a substantive source line by a furniture prefix or numeric substring', () => {
    expect(referenceCheckpoints(lines.join('\n'), lines.join(' '), protocol,
      ['Opening paragraph', '1', 'reference document'])).toEqual(lines);
  });

  it('retains body-collision protection after canonical word-boundary reconciliation', () => {
    const context = [page(4), page(5), page(6)];
    for (const row of context) {
      row.rawWords[0].text = 'Runningreferencetitle';
      row.layoutText = ['Running reference title', 'This body cites Running reference title explicitly.'].join('\n');
    }
    context[2].rawWords[1].text = 'ThisbodycitesRunningreferencetitleexplicitly.';
    const result = referenceFurniture(context, 6);
    expect(result.forbidden).not.toContain('Running reference title');
    expect(result.anchorExclusions).toContain('Running reference title');
    expect(result.support.find(row => row.text === 'Running reference title').bodyCollision).toBe(true);
  });

  it('does not treat a page label as a digit substring of a legitimate body number', () => {
    const context = [page(4, 'The archive was created in2016.'), page(5), page(6)];
    expect(referenceFurniture(context, 6).forbidden).toContain('6');
    context[0].rawWords[1].text = '6';
    expect(referenceFurniture(context, 6).forbidden).not.toContain('6');
  });

  it('does not invent canonical spacing when source layout has multiple alternatives', () => {
    const context = [page(4), page(5), page(6)];
    for (const row of context) {
      row.rawWords[0].text = 'Runningreferencetitle';
      row.layoutText = 'Running reference title\nRunningreference title\n';
    }
    expect(referenceFurniture(context, 6).support.find(row => row.rawText === 'Runningreferencetitle').text)
      .toBe('Runningreferencetitle');
  });

  it('keeps two-occurrence margin ambiguity separate from strict forbidden proof', () => {
    const context = [page(4), page(5)];
    for (const row of context) row.rawWords[1] = word('The first real body line stays nearby.', 35);
    const result = referenceFurniture(context, 5);
    expect(result.anchorExclusions).toContain('Running reference title');
    expect(result.anchorAmbiguities.find(row => row.text === 'Running reference title').pages).toEqual([4, 5]);
    expect(result.forbidden).not.toContain('Running reference title');
    expect(referenceFurniture([...context, page(6)], 6).forbidden).not.toContain('Running reference title');
  });

  it('excludes a combined number/header layout line only with independently proved page labels', () => {
    const context = [4, 5].map(pageNumber => ({ pageNumber, width: 600, height: 800,
      layoutText: `${pageNumber + 100} Running reference title\n${lines.join('\n')}`,
      rawWords: [word(String(pageNumber + 100), 20, 40), word('Running reference title', 20, 135), word('Body begins nearby.', 35)] }));
    expect(referenceFurniture(context, 5).anchorAmbiguities.some(row => row.text.includes('Running reference title'))).toBe(false);
    context.push({ ...context[0], pageNumber: 6, layoutText: `106 Running reference title\n${lines.join('\n')}`,
      rawWords: [word('106', 20, 40), word('Running reference title', 20, 135), word('Body begins nearby.', 35)] });
    const result = referenceFurniture(context, 6);
    expect(result.anchorExclusions).toContain('106 Running reference title');
    const proof = result.anchorAmbiguities.find(row => row.text === 'Running reference title');
    expect(proof.pageLabelProofs[0].witnesses).toEqual([4, 5, 6]);
    expect(result.forbidden).not.toContain('Running reference title');
    expect(referenceCheckpoints(context[2].layoutText, context[2].layoutText, protocol, result.anchorExclusions)).toEqual(lines);
  });

  it('retains unique margin body and repeated central body as positive candidates', () => {
    const context = [page(4), page(5), page(6)];
    context[2].rawWords[0].text = 'A unique opening body sentence remains meaningful.';
    expect(referenceFurniture(context, 6).anchorExclusions).not.toContain(context[2].rawWords[0].text);
    expect(referenceFurniture(context, 6).anchorExclusions).not.toContain('Substantial body text');
  });

  const boundaryPage = (previousX = 40, previousTop = 100) => ({ rawWords: [
    { text: 'Several cases are consis-', x0: previousX, x1: previousX + 330, top: previousTop, bottom: previousTop + 10 },
    { text: 'tent', x0: 40, x1: 60, top: 114, bottom: 124 },
    { text: lines[0], x0: 66, x1: 400, top: 114, bottom: 124 },
  ] });
  const interleaved = ['Several cases are consis-', 'A formula container interrupts the extracted text order.', 'tent ' + lines[0], ...lines.slice(1)];
  it('uses adjacent raw-word rows to trim a fragment hidden by interleaved layout containers', () => {
    const actual = referenceCheckpoints(interleaved.join('\n'), interleaved.join(' '), protocol, [], boundaryPage());
    expect(actual).toHaveLength(5);
    expect(actual).toContain(lines[0]); expect(actual).not.toContain('tent ' + lines[0]);
  });

  it.each([[320, 100], [40, 60]])('does not borrow a different-column or nonadjacent dangling row at %s/%s', (x, top) => {
    const actual = referenceCheckpoints(interleaved.join('\n'), interleaved.join(' '), protocol, [], boundaryPage(x, top));
    expect(actual).toContain('tent ' + lines[0]);
  });

  it('does not borrow a dangling word from the neighboring column on the same baseline', () => {
    const source = boundaryPage(330);
    source.rawWords.unshift({ text: 'Unrelated complete preceding sentence.', x0: 40, x1: 250, top: 100, bottom: 110 });
    expect(referenceCheckpoints(interleaved.join('\n'), interleaved.join(' '), protocol, [], source)).toContain('tent ' + lines[0]);
  });
});
