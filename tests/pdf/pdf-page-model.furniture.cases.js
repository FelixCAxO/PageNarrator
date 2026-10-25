import { item } from './pdf-page-model.fixtures.js';
import { describe, expect, it } from 'vitest';
import { createPdfPageModel, renderPdfPageModel } from "../../src/lib/pdf-page-model.js";

describe('PDF page model', () => {
  it.each([true, false])('retains vetted lines of different heights after wrapping (EOL %s)', (hasEOL) => {
    const lines = [
      ['A subtitle that must be spoken', 610, 9.96],
      ['A. AUTHOR, Department of Example Studies', 588.2, 10.91],
    ].map(([text, y, height], originalIndex) => ({
      text, role: 'paragraph', y, left: 50, right: 400,
      parts: [{ ...item(text, 50, y, 350, height, { hasEOL }),
        x: 50, y, text, originalIndex }],
    }));
    const model = renderPdfPageModel(lines);
    expect(model.speech).toContain('A subtitle that must be spoken');
    expect(model.speech).toContain('A. AUTHOR, Department of Example Studies');
    expect(model.narratedOriginalIndices).toEqual([0, 1]);
  });

  it.each(['https://example.test/datasets/long-', 'www.example.test/datasets/long-'])(
    'omits a wrapped URL footnote beginning with %s while retaining body prose', (url) => {
      const model = createPdfPageModel([
        item('Meaningful body prose remains.', 54, 680, 220, 10),
        item('Read https://example.test for the full explanation.', 54, 150, 240, 8),
        item(`1 ${url}`, 326, 90, 220, 8),
        item('dataset_filename', 326, 80, 90, 8),
      ]);
      expect(model.speech).toContain('Meaningful body prose remains.');
      expect(model.speech).toContain('Read for the full explanation.');
      expect(model.speech).not.toContain('dataset_filename');
    },
  );

  it('does not infer body columns from a repeated author grid', () => {
    const model = createPdfPageModel([
      item('Author-grid safety', 170, 780, 220, 20),
      item('Alice Author', 54, 750, 90, 10),
      item('Bob Author', 326, 750, 90, 10),
      item('Carol Author', 54, 735, 90, 10),
      item('Dan Author', 326, 735, 90, 10),
      item('Eve Author', 54, 720, 90, 10),
      item('Frank Author', 326, 720, 90, 10),
      item('Grace Author', 54, 705, 90, 10),
      item('Heidi Author', 326, 705, 90, 10),
      item('Abstract', 54, 650, 60, 10),
      item('The method explains', 54, 580, 244, 10),
      item('the result clearly.', 318, 580, 150, 10),
    ]);

    expect(model.speech).toContain('The method explains the result clearly.');
  });

  it('does not bridge a distant paragraph across a removed citation line', () => {
    const model = createPdfPageModel([
      item('Paragraph boundary', 54, 760, 170, 20),
      item('The available support is distributed', 54, 700, 230, 10, { hasEOL: true }),
      item('[7]', 54, 684, 20, 8, { hasEOL: true }),
      item('We argue for a separate method.', 65, 662, 200, 10, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('support is distributed. We argue');
    expect(model.speech).not.toContain('support is distributed We argue');
  });

  it('suppresses PDF citation markers and decorative-only fragments without removing meaning', () => {
    const model = createPdfPageModel([
      item('Clean narration', 54, 760, 180, 20),
      item('Evidence should remain clear', 54, 710, 140),
      item('12', 198, 714, 9, 7),
      item('Numeric brackets [7] should not become isolated narration.', 54, 688, 300),
      item('Prior work (Smith et al., 2025) confirms the result.', 54, 666, 290),
      item('◆ ❖ ◇ \uE000', 54, 644, 72),
      item('1. First numbered finding', 72, 620, 160),
      item('The set [x, y] satisfies H2O = x + y.', 54, 598, 230),
    ]);

    expect(model.speech).toContain('Evidence should remain clear');
    expect(model.speech).toContain('Numeric brackets should not become isolated narration.');
    expect(model.speech).toContain('Prior work confirms the result.');
    expect(model.speech).toContain('1. First numbered finding');
    expect(model.speech).toContain('[x, y]');
    expect(model.speech).toContain('H2O = x + y');
    expect(model.speech).not.toMatch(/\b12\b|\[7\]|Smith et al\.|◆|❖|◇|\uE000/u);
    expect(model.anchorText).toContain('Numeric brackets [7] should not become isolated narration.');
  });

  it('removes punctuation scaffolding left by stripped citations', () => {
    const model = createPdfPageModel([
      item('Citation cleanup', 54, 760, 180, 20),
      item('Formal systems (Smith et al., 2025; Jones, 2024) support the result.', 54, 700, 390),
      item('Other evidence [7] also remains readable.', 54, 680, 250),
      item('Systems such as ChatGPT OpenAI et al. (2024) remain useful.', 54, 660, 320),
    ]);

    expect(model.speech).toContain('Formal systems support the result.');
    expect(model.speech).toContain('Other evidence also remains readable.');
    expect(model.speech).toContain('Systems such as ChatGPT remain useful.');
    expect(model.speech).not.toContain('OpenAI et al.');
    expect(model.speech).not.toMatch(/\(\s*[;,]|[;,]\s*\)|\(\s*\)/u);
  });

  it.each(["O'Neill", 'O’Neill'])('removes the whole author-year citation for %s while preserving source names', author => {
    const cited = `Prior work ${author} et al. (2025) confirms the result.`;
    const ordinary = `${author} explains the sensor reading.`;
    const model = createPdfPageModel([
      item(cited, 54, 680, 430),
      item(ordinary, 54, 650, 300),
    ]);

    expect(model.speech).toBe(`Prior work confirms the result. ${ordinary}`);
    expect(model.anchorText).toContain(cited);
    expect(model.anchorText).toContain(ordinary);
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([0, 1]);
  });

  it('does not leave a surname prefix as speech for a citation-only line', () => {
    const cited = 'O’Neill et al. (2025)';
    const model = createPdfPageModel([item(cited, 54, 680, 150)]);
    expect(model.speech).toBe('');
    expect(model.anchorText).toBe(cited);
    expect(model.narratedOriginalIndices).toEqual([]);
  });

  it('removes author-year citations split across physical rows', () => {
    const model = createPdfPageModel([
      item('Split citations', 54, 760, 150, 20),
      item('Prior work (Smith et al.,', 54, 700, 190, 12, { hasEOL: true }),
      item('2025; Jones, 2024) supports the result.', 54, 684, 270, 12, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('Prior work supports the result.');
    expect(model.speech).not.toMatch(/Smith|Jones|2025|2024|\(\s*[;,]/u);
  });

  it('collapses punctuation scaffolds left by adjacent numeric citations', () => {
    const model = createPdfPageModel([
      item('Citation punctuation', 54, 760, 170, 20),
      item('Prior work [1], [2], supports the result.', 54, 700, 250),
      item('Related methods [3]–[5] establish the baseline.', 54, 680, 270),
    ]);

    expect(model.speech).toContain('Prior work, supports the result.');
    expect(model.speech).toContain('Related methods establish the baseline.');
    expect(model.speech).not.toMatch(/,,|\s[–—-]+\s/u);
  });

  it('keeps a detached section number in visual anchors without narrating it as a citation', () => {
    const model = createPdfPageModel([
      item('1', 54, 700, 7, 7),
      item('Introduction', 72, 700, 108, 14),
      item('The opening section explains the result.', 54, 660, 230),
    ]);

    expect(model.anchorText).toMatch(/1[\s\S]*Introduction/u);
    expect(model.speech).toContain('Introduction');
    expect(model.speech).not.toMatch(/(?:^|[.!?]\s+)1[.!?](?:\s|$)/u);
  });

  it('suppresses publication and contact metadata while retaining nearby body prose', () => {
    const model = createPdfPageModel([
      item('Metadata filtering', 54, 760, 190, 20),
      item('The body explains the research result.', 54, 620, 220),
      item('Preprint.', 54, 580, 60, 8),
      item('Code and data are available at: https://github.com/example/repo', 54, 560, 330, 8),
      item('Work done during an internship at Example Lab.', 54, 540, 250, 8),
      item('Authors’ Contact Information: author@example.com', 54, 520, 260, 8),
      item('This work is licensed under a Creative Commons Attribution 4.0 International License.', 54, 500, 390, 8),
      item('Published as a paper at Example Workshop 2026.', 54, 480, 250, 8),
      item('40th Conference on Example Systems (EX 2026). Position Paper Track.', 54, 460, 340, 8),
      item('Accepted as a Short Paper at Digital Studies 2026.', 54, 440, 280, 8),
      item('* Equal Contribution', 54, 420, 120, 8),
      item('Contact Emails: author@example.com', 54, 400, 200, 8),
    ]);

    expect(model.speech).toContain('The body explains the research result.');
    expect(model.speech).not.toMatch(/Preprint|github\.com|internship|Contact Information|licensed under|Published as|Conference on|Accepted as|Equal Contribution|Contact Emails/u);
  });

  it('suppresses a bottom source-note region without blocking a cross-column continuation', () => {
    const model = createPdfPageModel([
      item('Footnote boundary', 170, 760, 220, 20),
      item('The corpus begins here.', 54, 700, 180, 10),
      item('created specifically for evaluation.', 326, 700, 210, 10),
      item('It was', 54, 140, 60, 10),
      item('1 Our data and code are available at example.test.', 54, 112, 240, 8),
      item('To spare readers our backronym explanation.', 54, 100, 220, 8),
      item('A separate sentence follows.', 326, 680, 180, 10),
    ]);

    expect(model.speech).toContain('It was created specifically for evaluation.');
    expect(model.speech).not.toMatch(/data and code|backronym explanation/u);
  });

  it('removes an inline corresponding-author note without deleting body prose', () => {
    const model = createPdfPageModel([
      item('Inline footnote', 54, 760, 160, 20),
      item('Although the task is fundamentally extractive ∗ Corresponding author of this paper, author@example.com', 54, 680, 460),
    ]);

    expect(model.speech).toContain('Although the task is fundamentally extractive.');
    expect(model.speech).not.toMatch(/Corresponding author|example\.com/u);
  });

  it('recognizes contribution and named code-data source notes as footnotes', () => {
    const model = createPdfPageModel([
      item('Source-note variants', 54, 760, 180, 20),
      item('Meaningful body prose remains.', 54, 680, 210),
      item('1 Graph2Counsel code and data', 54, 130, 180, 8),
      item('2 WHO (2025): source details', 54, 118, 180, 8),
      item('∗ Equal contribution', 326, 130, 120, 8),
    ]);

    expect(model.speech).toContain('Meaningful body prose remains.');
    expect(model.speech).not.toMatch(/Graph2Counsel code and data|WHO \(2025\)|Equal contribution/u);
  });

  it('keeps a centered title subtitle and document date while suppressing authors', () => {
    const model = createPdfPageModel([
      item('Beyond Pattern Matching', 175, 760, 260, 22),
      item('Seven Cross-Domain Techniques for Prompt Injection Detection', 100, 734, 412, 14),
      item('Alice Author and Bob Researcher', 180, 700, 250, 11),
      item('Department of Computing, Example University', 170, 684, 272, 10),
      item('June 2026', 270, 650, 72, 11),
      item('Abstract', 54, 610, 60, 12),
      item('The abstract body remains meaningful.', 54, 588, 230, 10),
    ]);

    expect(model.speech).toContain('Seven Cross-Domain Techniques for Prompt Injection Detection');
    expect(model.speech).toContain('June 2026');
    expect(model.speech).not.toMatch(/Alice Author|Bob Researcher|Department of Computing/u);
  });

  it('does not classify four-digit citation years as numbered list items', () => {
    const model = createPdfPageModel([
      item('List boundary', 54, 760, 150, 20),
      item('2025) to scientific discovery and data analysis.', 54, 700, 280),
      item('1) First contribution', 54, 670, 150),
    ]);

    expect(model.lines.find((line) => line.text.startsWith('2025)'))?.role).toBe('paragraph');
    expect(model.lines.find((line) => line.text.startsWith('1)'))?.role).toBe('list-item');
  });

  it('preserves numeric math notation and terminal exponents while removing citations', () => {
    const model = createPdfPageModel([
      item('Mathematical evidence', 54, 760, 180, 20),
      item('The vector [1, 2] is feasible on the interval [0, 1].', 54, 700, 310),
      item('Area equals x', 54, 675, 72),
      item('2', 126, 681, 7, 7),
      item('Prior evidence [7] supports the result.', 54, 650, 220),
      item('The value x ∈ [0, 1] remains bounded.', 54, 625, 220),
      item('Energy depends on velocity', 54, 600, 150),
      item('2', 204, 606, 7, 7),
    ]);

    expect(model.speech).toContain('The vector [1, 2] is feasible on the interval [0, 1].');
    expect(model.speech).toMatch(/Area equals x\s*2/u);
    expect(model.speech).toContain('x ∈ [0, 1]');
    expect(model.speech).toMatch(/velocity\s*2/u);
    expect(model.speech).not.toContain('[7]');
  });

  it('preserves factual year comparisons while removing author-year citations', () => {
    const model = createPdfPageModel([
      item('Year evidence', 54, 760, 150, 20),
      item('Enrollment doubled (from 2024 to 2025).', 54, 680, 250),
      item('Prior work (Smith et al., 2025) supports the result.', 54, 655, 280),
      item('The May 2025 release improved accuracy.', 54, 630, 220),
      item('Enrollment grew (May 2025) after launch.', 54, 605, 240),
      item('The Spring 2025 release improved accuracy.', 54, 580, 240),
      item('The Phase 2025 evaluation improved accuracy.', 54, 555, 250),
    ]);

    expect(model.speech).toContain('Enrollment doubled (from 2024 to 2025).');
    expect(model.speech).toContain('The May 2025 release improved accuracy.');
    expect(model.speech).toContain('Enrollment grew (May 2025) after launch.');
    expect(model.speech).toContain('The Spring 2025 release improved accuracy.');
    expect(model.speech).toContain('The Phase 2025 evaluation improved accuracy.');
    expect(model.speech).not.toContain('Smith et al.');
  });

  it('distinguishes a terminal exponent from an attached superscript citation', () => {
    const model = createPdfPageModel([
      item('Exponent context', 54, 760, 150, 20),
      item('Energy depends on velocity', 54, 680, 150),
      item('2', 204, 686, 7, 7),
      item('Prior evidence', 54, 650, 82),
      item('1', 136, 656, 7, 7),
      item('supports the claim.', 145, 650, 110),
    ]);

    expect(model.speech).toMatch(/velocity\s*2/u);
    expect(model.speech).toContain('Prior evidence supports the claim.');
    expect(model.speech).not.toMatch(/evidence\s*1/u);
  });

  it('suppresses structured small affiliation footnotes outside the top band', () => {
    const model = createPdfPageModel([
      item('Affiliation boundary', 54, 760, 170, 20),
      item('Meaningful body prose remains readable.', 54, 620, 230),
      item('Alice Example and Bob Author are with the School of Computing, Example University, Sweden.', 54, 92, 470, 9),
      item('Carol Researcher is with the Institute of Reliable Systems, France.', 54, 72, 370, 9),
    ]);

    expect(model.speech).toContain('Meaningful body prose remains readable.');
    expect(model.speech).not.toMatch(/Alice Example|Bob Author|Carol Researcher|School of Computing|Institute of Reliable/u);
  });

  it('does not treat ordinary workshop and licensing prose as publication metadata', () => {
    const model = createPdfPageModel([
      item('Ordinary body prose', 54, 760, 180, 20),
      item('We evaluate workshop participants in two groups.', 54, 620, 280),
      item('The licensed operators completed the study.', 54, 595, 240),
    ]);

    expect(model.speech).toContain('We evaluate workshop participants in two groups.');
    expect(model.speech).toContain('The licensed operators completed the study.');
  });

  it('suppresses small page-edge furniture while preserving a large document title', () => {
    const model = createPdfPageModel([
      item('Meaningful document title', 150, 750, 312, 20),
      item('Recurring report header', 72, 780, 150, 9),
      item('Body prose remains available.', 72, 700, 180),
      item('Confidential footer', 72, 30, 110, 9),
      item('Page 1', 288, 20, 40, 9),
    ]);

    expect(model.speech).toContain('Meaningful document title');
    expect(model.speech).toContain('Body prose remains available.');
    expect(model.speech).not.toMatch(/Recurring report header|Confidential footer|Page 1/u);
  });

  it.each([
    'PHONE (866) WTR-SENS (987-7367) WEBSITE www.example.test/resources',
    'EMAIL support@example.test Document-012 October 2017',
    'Website: https://example.test/resources',
    'Tel: +46 123 456 789',
  ])('omits a small bottom contact strip: %s', text => {
    const model = createPdfPageModel([
      item('Left body finishes here.', 54, 90, 210, 10),
      item('Right body continues here.', 326, 600, 220, 10),
      item(text, 54, 30, 240, 7),
    ]);
    expect(model.speech).toContain('Left body finishes here.');
    expect(model.speech).toContain('Right body continues here.');
    expect(model.speech).not.toMatch(/PHONE|EMAIL|Website:|Tel:/u);
    expect(model.narratedOriginalIndices).toEqual(expect.arrayContaining([0, 1]));
    expect(model.narratedOriginalIndices).not.toContain(2);
  });

  it.each([
    'Phone users reported fewer interruptions.',
    'Email improved the response rate.',
    'Website accessibility helps users.',
  ])('preserves bottom prose beginning with a contact word: %s', text => {
    const model = createPdfPageModel([item(text, 54, 30, 240, 7)]);
    expect(model.speech).toBe(text);
    expect(model.narratedOriginalIndices).toEqual([0]);
  });

  it('retains a labelled phone number in the body and in a large edge title', () => {
    for (const [y, height] of [[300, 10], [30, 20]]) {
      const model = createPdfPageModel([item('Phone: 123 456 789', 54, y, 240, height)]);
      expect(model.speech).toContain('Phone: 123 456 789');
      expect(model.narratedOriginalIndices).toEqual([0]);
    }
  });
});
