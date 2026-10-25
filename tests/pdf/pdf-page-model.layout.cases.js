import { item } from './pdf-page-model.fixtures.js';
import { describe, expect, it } from 'vitest';
import {
  createPdfPageModel,
  renderPdfPageModel,
} from '../../src/lib/pdf-page-model.js';

describe('PDF page model', () => {
  it('keeps an ordinary wrapped airport word closed when air-source appears elsewhere on the page', () => {
    const model = createPdfPageModel([
      item('The air-source system works.', 54, 700, 300),
      item('The air-', 54, 674, 300),
      item('port remains open today.', 54, 658, 300),
    ]);
    expect(model.speech).toContain('The airport remains open today.');
    expect(model.speech).not.toContain('air-port');
  });

  it.each([1, 1.5])('retains a mixed-size centered title above an abstract at scale %s', scale => {
    const parts = [
      item('AN INTEGRATED GUIDE TO', 140, 490, 280, 17.76),
      item('WILDERNESS CAMPSITES', 176, 472, 208, 17.76),
      item('MANAGEMENT', 218, 454, 124, 19.92),
      item('Alice Author', 240, 430, 80, 11.76),
      item('ABSTRACT. Meaningful source prose remains.', 80, 408, 390, 11.76),
    ];
    const model = createPdfPageModel(parts.map(part => ({ ...part,
      width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value),
    })), { pageView: [0, 0, 557 * scale, 720 * scale] });
    expect(model.speech).toBe('AN INTEGRATED GUIDE TO WILDERNESS CAMPSITES MANAGEMENT: ABSTRACT. Meaningful source prose remains.');
    expect(model.narratedOriginalIndices).toEqual([0, 1, 2, 4]);
  });

  it.each([1, 1.5])('places a same-size full-width conclusion after both columns at scale %s', scale => {
    const parts = [item('A report with a conclusion', 54, 760, 500, 20)];
    for (let row = 0; row < 4; row++) parts.push(item(`The left column explains observation ${row}.`, 54, 700 - row * 18, 230),
      item(`The right column explains observation ${row}.`, 326, 700 - row * 18, 230));
    parts.push(item('The full-width conclusion follows the two complete columns.', 54, 620, 500));
    const model = createPdfPageModel(parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) })),
    { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.speech.indexOf('observation 3.', model.speech.indexOf('The right column'))).toBeLessThan(model.speech.indexOf('The full-width conclusion'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([700, 740])('keeps a right-column heading at y=%s after the complete left column', rightHeadingY => {
    const parts = [item('An illustrated document', 36, 780, 540, 22),
      item('2 Left section', 36, 700, 220, 14),
      item('3 Right section', 316, rightHeadingY, 220, 14)];
    for (let row = 0; row < 6; row++) parts.push(
      item(`The left section paragraph ${row} remains in its original column.`, 36, 680 - row * 18, 245, 10),
      item(`The right section paragraph ${row} remains in its original column.`, 316, 680 - row * 18, 245, 10));
    const model = createPdfPageModel(parts);
    expect(model.speech.indexOf('An illustrated document')).toBeLessThan(model.speech.indexOf('2 Left section'));
    expect(model.speech.indexOf('2 Left section')).toBeLessThan(model.speech.indexOf('The left section'));
    expect(model.speech.indexOf('left section paragraph 5')).toBeLessThan(model.speech.indexOf('3 Right section'));
    expect(model.speech.indexOf('3 Right section')).toBeLessThan(model.speech.indexOf('The right section'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([12, 18])('keeps fragmented prose in three columns with a %s-point gutter', gutter => {
    const parts = [item('A report with three independent columns', 36, 760, 540, 20)];
    const width = 168;
    const starts = [36, 36 + width + gutter, 36 + 2 * (width + gutter)];
    for (let row = 0; row < 5; row++) {
      for (const [column, start] of starts.entries()) {
        parts.push(item(`The ${['left', 'middle', 'right'][column]} column continues`, start, 680 - row * 16, 148, 10),
          item('on', start + 158, 680 - row * 16, 10, 10));
      }
    }
    for (const [column, start] of starts.entries()) parts.push(item(`The ${['left', 'middle', 'right'][column]} column ends here.`, start, 600, 168, 10));
    const model = createPdfPageModel(parts);
    expect(model.speech.indexOf('left column ends here')).toBeLessThan(model.speech.indexOf('The middle column'));
    expect(model.speech.indexOf('middle column ends here')).toBeLessThan(model.speech.indexOf('The right column'));
    for (const line of model.lines.filter(line => line.y <= 680)) {
      expect(line.right - line.left).toBeLessThanOrEqual(width);
    }
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([24, 36, 48])('keeps an independent column heading with body indented by %s points', indent => {
    const parts = [
      item('A practical guide', 54, 760, 490, 24),
      item('An introduction spans the two columns before their separate instructions.', 54, 710, 490, 12),
      item('Before getting started', 54, 650, 150, 14),
      item('Follow these instructions', 397, 650, 160, 14),
      item('keep supplies ready', 54, 636, 135, 14),
      item('in the correct order', 397, 636, 135, 14),
      item('•', 66, 625, 6, 12),
      item('Prepare all supplies.', 82, 625, 120, 12),
      item('•', 66, 603, 6, 12),
      item('Keep the area clean.', 82, 603, 130, 12),
      item('•', 66, 581, 6, 12),
      item('Store materials safely.', 82, 581, 120, 12),
      item('•', 66, 560, 6, 12),
      item('Check the supplies.', 82, 560, 120, 12),
      item('•', 66, 540, 6, 12),
      item('Arrange the tools.', 82, 540, 120, 12),
      item('•', 66, 520, 6, 12),
      item('Place everything within reach.', 82, 520, 155, 12),
      item('1.', 397 + indent - 16, 625, 10, 12),
      item('Begin with the first', 397 + indent, 625, 112, 12),
      item('complete instruction.', 397 + indent, 610, 112, 12),
      item('Check every result.', 397 + indent, 597, 112, 12),
      item('Continue only when ready.', 397 + indent, 584, 125, 12),
      item('2.', 397 + indent - 16, 560, 10, 12),
      item('Finish the second instruction.', 397 + indent, 560, 125, 12),
      item('Review the whole process.', 397 + indent, 547, 125, 12),
      item('Confirm the readings are correct.', 397 + indent, 534, 140, 12),
    ];
    const model = createPdfPageModel(parts);
    expect(model.lines.some(line => line.text === 'Before getting started')).toBe(true);
    expect(model.lines.some(line => line.text === 'Follow these instructions')).toBe(true);
    expect(model.speech.indexOf('Store materials safely.')).toBeLessThan(model.speech.indexOf('Follow these instructions'));
    expect(model.speech.indexOf('Place everything within reach.')).toBeLessThan(model.speech.indexOf('Follow these instructions'));
    expect(model.speech).toContain('Begin with the first complete instruction');
    expect(model.speech.indexOf('Follow these instructions')).toBeLessThan(model.speech.indexOf('Begin with the first'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it('keeps dense numeric rows and a label wrapped above its baseline together', () => {
    const parts = [item('Survey results', 54, 760, 150, 20)];
    for (const [index, name] of ['Northern region', 'Central region', '', 'Southern region'].entries()) {
      const y = 710 - index * 24;
      parts.push(item(`Zone ${index + 1}`, 54, y, 45, 10));
      if (name) parts.push(item(name, 130, y, 80, 10));
      for (const [column, value] of [11 + index, 22 + index, 33 + index, 44 + index].entries()) {
        parts.push(item(String(value), 250 + column * 55, y, 12, 10));
      }
    }
    parts.push(item('Coastal', 130, 670, 40, 10), item('district', 130, 655, 40, 10));
    const model = createPdfPageModel(parts);
    const rows = model.lines.filter(line => line.role === 'table-row');
    expect(rows.map(line => line.text)).toEqual([
      'Zone 1 Northern region 11 22 33 44', 'Zone 2 Central region 12 23 34 45',
      'Zone 3 Coastal district 13 24 35 46', 'Zone 4 Southern region 14 25 36 47',
    ]);
    expect(model.orderedItems).toHaveLength(parts.length);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it('does not merge a tightly spaced numeric row whose leading label cells touch', () => {
    const parts = [];
    for (const [index, label] of ['North', 'West', 'Central district', 'South'].entries()) {
      const y = 710 - index * 10.5;
      parts.push(item(label, 54, y, index === 2 ? 70 : 24, 8.5), item('Area', 130, y, 25, 8.5));
      for (const [column, value] of [11 + index, 22 + index, 33 + index, 44 + index].entries()) {
        parts.push(item(String(value), 250 + column * 55, y, 9, 8.5));
      }
    }
    const model = createPdfPageModel(parts);
    expect(model.lines.filter(line => line.role === 'table-row').map(line => line.text)).toEqual([
      'North Area 11 22 33 44', 'West Area 12 23 34 45',
      'Central district Area 13 24 35 46', 'South Area 14 25 36 47',
    ]);
    expect(model.orderedItems).toHaveLength(parts.length);
  });

  it('keeps close three-panel gutters and panel headings from joining unrelated sentences', () => {
    const parts = [item('Left panel', 20, 570, 100, 16), item('Middle panel', 284, 570, 120, 16), item('Right panel', 554, 570, 120, 16)];
    for (let index = 0; index < 8; index++) {
      const y = 530 - index * 18;
      parts.push(item(index === 0 ? 'Left statement ends with a wrap-' : index === 1 ? 'ped sentence completes this paragraph.' : `left continuation ${index} completes this sentence.`, 20, y, 250),
        item(`Middle paragraph ${index} remains an independent statement.`, 284, y, 255),
        item(`Right paragraph ${index} remains an independent statement.`, 554, y, 220));
    }
    const model = createPdfPageModel(parts, { pageView: [0, 0, 792, 612] });
    const indices = text => model.speech.indexOf(text);
    expect(indices('Left panel')).toBeLessThan(indices('Left statement'));
    expect(indices('left continuation 7')).toBeLessThan(indices('Middle panel'));
    expect(indices('Middle paragraph 7')).toBeLessThan(indices('Right panel'));
    expect(model.speech).not.toContain('wrapMiddle');
    expect(model.speech).toContain('wrapped sentence completes this paragraph.');
  });

  it.each([90, 180, 270])('reads intrinsic %i-degree pages in displayed coordinates without changing source items', (pageRotation) => {
    const pageView = [10, 20, 622, 812];
    const width = 612, height = 792;
    const readingView = pageRotation === 180 ? [0, 0, width, height] : [0, 0, height, width];
    const canonical = [item('Rotated document title', 240, readingView[3] - 40, 260, 22),
      item('Left column opening.', 50, readingView[3] - 100, 200),
      item('Right column opening.', readingView[2] / 2 + 30, readingView[3] - 100, 210),
      item('Left column ending.', 50, readingView[3] - 120, 200),
      item('Right column ending.', readingView[2] / 2 + 30, readingView[3] - 120, 210)];
    const source = canonical.map(part => {
      const [, , , , x, y] = part.transform;
      const h = part.height;
      const transform = pageRotation === 90 ? [0, h, -h, 0, 10 + width - y, 20 + x]
        : pageRotation === 180 ? [-h, 0, 0, -h, 10 + width - x, 20 + height - y]
          : [0, -h, h, 0, 10 + y, 20 + height - x];
      return { ...part, transform };
    });
    const original = structuredClone(source);
    const expected = createPdfPageModel(canonical, { pageView: readingView });
    const actual = createPdfPageModel(source, { pageView, pageRotation });
    expect(actual.speech).toBe(expected.speech);
    expect(actual.orderedItems.map(part => part.originalIndex)).toEqual(expected.orderedItems.map(part => part.originalIndex));
    expect(actual.pageView).toEqual(readingView);
    expect(source).toEqual(original);
    const sideways = { ...source[1], str: 'Sideways margin furniture',
      transform: [12, 0, 0, 12, source[1].transform[4], source[1].transform[5]] };
    if (pageRotation !== 180) expect(createPdfPageModel([...source, sideways], { pageView, pageRotation }).speech).not.toContain('Sideways');
  });

  it('reads tightly positioned letter fragments as words in native and OCR text', () => {
    for (const metadata of [{}, { ocrLine: 0 }]) {
      const letters = [...'return'].map((letter, index) =>
        item(letter, 100 + index * 6, 300, 5, 12, metadata));
      const model = createPdfPageModel([
        item('JSONify and', 20, 300, 74, 12, metadata), ...letters,
        item('the result', 141, 300, 60, 12, metadata),
      ]);
      expect(model.anchorText).toBe('JSONify and return the result');
      expect(model.speech).toBe('JSONify and return the result.');
      expect(model.orderedItems.map(part => part.str)).toContain('r');
    }
  });

  it('keeps a title before ordinary two-column prose in column-major order', () => {
    const model = createPdfPageModel([
      item('A Focused Paper', 190, 760, 232, 22),
      item('Left column start', 54, 710, 164),
      item('Right column start', 326, 710, 170),
      item('Left column end', 54, 688, 154),
      item('Right column end', 326, 688, 160),
    ]);

    expect(model.orderedItems.map((part) => part.str)).toEqual([
      'A Focused Paper',
      'Left column start',
      'Left column end',
      'Right column start',
      'Right column end',
    ]);
    expect(model.lines.map((line) => line.role)).toEqual([
      'title',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
  });

  it('joins an unfinished sentence across a column boundary', () => {
    const model = createPdfPageModel([
      item('Cross-column continuation', 170, 760, 272, 20),
      item('The benchmark starts here.', 54, 710, 180),
      item('created specifically for evaluation.', 326, 710, 210),
      item('It was', 54, 688, 70),
      item('A separate sentence follows.', 326, 688, 180),
    ]);

    expect(model.speech).toContain('It was created specifically for evaluation.');
    expect(model.speech).not.toContain('It was. created');
  });

  it('joins consecutive document-title lines into one structural pause', () => {
    const model = createPdfPageModel([
      item('Randomized YaRN Improves Length Generalization', 137, 752, 321, 16),
      item('for Long-Context Reasoning', 210, 736, 175, 16),
      item('Abstract', 158, 611, 45, 10),
      item('The method improves long-context reasoning.', 88, 588, 230, 10),
    ]);

    expect(model.lines.slice(0, 2).map((line) => line.role)).toEqual(['title', 'title']);
    expect(model.speech).toContain(
      'Randomized YaRN Improves Length Generalization for Long-Context Reasoning:',
    );
  });

  it('moves an oversized drop cap before the upper line it begins', () => {
    const model = createPdfPageModel([
      item('T', 49, 247, 20, 29),
      item('HE proliferation of large language models has', 70, 260, 230, 10),
      item('transformed content creation', 70, 248, 130, 10),
    ]);

    expect(model.anchorText).toMatch(
      /^T HE proliferation of large language models has\s+transformed content creation/u,
    );
    expect(model.orderedItems.map((part) => part.str)).toEqual([
      'T',
      'HE proliferation of large language models has',
      'transformed content creation',
    ]);
  });

  it('does not move a body initial into the next line beside a duplicate decorative drop cap', () => {
    const model = createPdfPageModel([
      item('T', 50, 659, 15, 25),
      item('T', 65, 670, 6, 10), item('he radar detects rotation.', 71, 670, 170, 10),
      item('The warning can come Ear-', 65, 658, 180, 10),
      item('ly enough to help.', 50, 646, 140, 10),
    ]);
    expect(model.anchorText).toMatch(/^The radar detects rotation\./u);
    expect(model.speech).toContain('The warning can come Early enough to help.');
    expect(model.speech).not.toMatch(/EarT|TT/u);
    expect(model.orderedItems.map(part => part.originalIndex)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a visually continuous full-width line intact above later columns', () => {
    const model = createPdfPageModel([
      item('This guide demonstrates whether garden recommendations', 72, 634, 222),
      item('anchor Coastal irrigation scheduling', 297, 634, 228),
      item('Left one', 72, 560, 110),
      item('Right one', 297, 560, 110),
      item('Left two', 72, 540, 110),
      item('Right two', 297, 540, 110),
      item('Left three', 72, 520, 110),
      item('Right three', 297, 520, 110),
      item('Left four', 72, 500, 110),
      item('Right four', 297, 500, 110),
    ], { pageView: [0, 0, 612, 842] });

    expect(model.lines.some((line) => line.text === (
      'This guide demonstrates whether garden recommendations anchor Coastal irrigation scheduling'
    ))).toBe(true);
  });

  it('keeps justified same-row fragments in one sentence', () => {
    const model = createPdfPageModel([
      item('Same-row continuity', 170, 760, 220, 20),
      item('In this paper, we', 54, 680, 110),
      item('present eight findings.', 183, 680, 140),
    ]);

    expect(model.speech).toContain('In this paper, we present eight findings.');
    expect(model.speech).not.toContain('we. present');
  });

  it('does not turn ordinary wide body wraps into title pauses', () => {
    const model = createPdfPageModel([
      item('A Real Document Title', 150, 760, 312, 20),
      item('This ordinary paragraph line spans most of the readable page width', 54, 650, 410, 12, { hasEOL: true }),
      item('and continues naturally on the next visual line.', 54, 632, 300, 12, { hasEOL: true }),
    ]);

    expect(model.lines.map((line) => line.role)).toEqual(['title', 'paragraph', 'paragraph']);
    expect(model.speech).toContain(
      'This ordinary paragraph line spans most of the readable page width and continues naturally on the next visual line.',
    );
    expect(model.speech).not.toContain('readable page width:');
  });

  it('does not classify lowercase section words inside wrapped prose as headings', () => {
    const model = createPdfPageModel([
      item('A Real Document Title', 150, 760, 312, 20),
      item('However, these', 54, 650, 90, 12, { hasEOL: true }),
      item('results are typically obtained under controlled conditions,', 54, 632, 330, 12, { hasEOL: true }),
      item('methods under evaluation remain comparable.', 54, 614, 260, 12, { hasEOL: true }),
    ]);

    expect(model.lines.filter((line) => /^(?:results|methods)\b/u.test(line.text)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'paragraph' }),
        expect.objectContaining({ role: 'paragraph' }),
      ]));
    expect(model.speech).not.toMatch(/results are typically[^.]*:|methods under evaluation[^.]*:/u);
  });

  it('uses one structural pause after a wrapped document title', () => {
    const model = createPdfPageModel([
      item('A Long Document Title', 120, 760, 372, 20, { hasEOL: true }),
      item('with a Descriptive Subtitle', 170, 742, 272, 18, { hasEOL: false }),
      item('The abstract begins with ordinary prose.', 54, 680, 250, 12, { hasEOL: false }),
      item('It continues with a second sentence.', 54, 662, 220, 12, { hasEOL: false }),
      item('A final body line keeps the body size typical.', 54, 644, 260, 12, { hasEOL: false }),
    ]);

    expect(model.lines.slice(0, 2).map((line) => line.role)).toEqual(['title', 'title']);
    expect(model.speech).toContain(
      'A Long Document Title with a Descriptive Subtitle: The abstract begins with ordinary prose.',
    );
    expect(model.speech).not.toContain('Document Title: with');
  });

  it('orders real Arabic columns right-to-left while retaining the title first', () => {
    const modelForRtl = createPdfPageModel([
      item('العنوان', 258, 760, 96, 20, { dir: 'rtl' }),
      item('بداية العمود الأيمن', 368, 710, 158, 12, { dir: 'rtl' }),
      item('نهاية العمود الأيمن', 368, 688, 158, 12, { dir: 'rtl' }),
      item('بداية العمود الأيسر', 76, 710, 158, 12, { dir: 'rtl' }),
      item('نهاية العمود الأيسر', 76, 688, 158, 12, { dir: 'rtl' }),
    ], { direction: 'rtl' });

    expect(modelForRtl.orderedItems.map((part) => part.str)).toEqual([
      'العنوان',
      'بداية العمود الأيمن',
      'نهاية العمود الأيمن',
      'بداية العمود الأيسر',
      'نهاية العمود الأيسر',
    ]);
  });

  it('uses each line direction for mixed-direction fragments instead of a page-global switch', () => {
    const model = createPdfPageModel([
      item('Mixed direction', 200, 760, 212, 20),
      item('second', 126, 710, 54, 12, { dir: 'ltr' }),
      item('First', 54, 710, 44, 12, { dir: 'ltr' }),
      item('الثاني', 360, 680, 54, 12, { dir: 'rtl' }),
      item('الأول', 438, 680, 48, 12, { dir: 'rtl' }),
    ]);

    expect(model.lines.map((line) => line.parts.map((part) => part.str))).toEqual([
      ['Mixed direction'],
      ['First', 'second'],
      ['الأول', 'الثاني'],
    ]);
  });

  it('uses baseline geometry when PDF.js omits end-of-line flags', () => {
    const model = createPdfPageModel([
      item('Geometry fallback', 54, 760, 160, 20),
      item('The first four are measured', 54, 700, 210, 10, { hasEOL: false }),
      item('with forced alignment probes.', 54, 688, 190, 10, { hasEOL: false }),
      item('The benchmark includes', 54, 660, 170, 10, { hasEOL: false }),
      item('a fifth system.', 65, 648, 110, 10, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('The first four are measured with forced alignment probes.');
    expect(model.speech).toContain('The benchmark includes a fifth system.');
  });

  it('orders title-gated top matter by visual rows before body columns', () => {
    const model = createPdfPageModel([
      item('A Document Title', 180, 760, 250, 20),
      item('Alice Author', 54, 718, 90, 11),
      item('Bob Researcher', 220, 718, 105, 11),
      item('Carol Scientist', 390, 718, 105, 11),
      item('Abstract', 54, 680, 60, 12),
      item('Left body start', 54, 620, 180, 10),
      item('Right body start', 326, 620, 180, 10),
      item('Left body end', 54, 604, 180, 10),
      item('Right body end', 326, 604, 180, 10),
    ]);

    expect(model.orderedItems.map((part) => part.str).slice(0, 5)).toEqual([
      'A Document Title',
      'Alice Author',
      'Bob Researcher',
      'Carol Scientist',
      'Abstract',
    ]);
    expect(model.speech).toContain('A Document Title: Abstract.');
    expect(model.speech).not.toMatch(/Alice Author|Bob Researcher|Carol Scientist/u);
  });

  it('preserves a neighboring-column section heading above the abstract baseline', () => {
    const model = createPdfPageModel([
      item('A Document Title', 180, 760, 250, 20),
      item('Alice Author', 230, 720, 120, 11),
      item('Abstract', 54, 600, 60, 12),
      item('The abstract body remains first.', 54, 578, 210, 10),
      item('1 Introduction', 326, 610, 90, 12),
      item('The introduction body follows.', 326, 588, 200, 10),
    ]);

    expect(model.speech).toContain('1 Introduction');
    expect(model.speech.indexOf('The abstract body remains first.'))
      .toBeLessThan(model.speech.indexOf('1 Introduction'));
    expect(model.speech).not.toContain('Alice Author');
  });

  it('finishes a two-column abstract band before a lower full-width section', () => {
    const model = createPdfPageModel([
      item('A Document Title', 180, 760, 250, 20),
      item('Alice Author', 230, 720, 120, 11),
      item('A R T I C L E I N F O', 54, 620, 140, 12),
      item('A B S T R A C T', 326, 620, 110, 12),
      item('Keywords', 54, 598, 60, 10),
      item('Reliable systems', 54, 580, 100, 10),
      item('The abstract begins in the right region.', 326, 598, 230, 10),
      item('It finishes before the lower section.', 326, 580, 210, 10),
      item('1. Introduction', 54, 540, 100, 14),
      item('The full-width introduction follows the complete upper band.', 54, 518, 500, 10),
    ]);

    expect(model.speech.indexOf('It finishes before the lower section.'))
      .toBeLessThan(model.speech.indexOf('1. Introduction'));
    expect(model.lines.find((line) => line.text === '1. Introduction')?.role).toBe('title');
    expect(model.speech).not.toContain('Alice Author');
  });

  it('preserves a small top-region sentence that merely mentions a university', () => {
    const model = createPdfPageModel([
      item('The university study found a benefit.', 54, 680, 230, 9),
      item('Department of Computing, Example University, Sweden', 54, 660, 280, 9),
      item('Body evidence remains.', 54, 600, 150),
    ]);

    expect(model.speech).toContain('The university study found a benefit.');
    expect(model.speech).not.toContain('Department of Computing');
  });

  it('preserves meaningful small prose that continues into the bottom page band', () => {
    const model = createPdfPageModel([
      item('Page-edge continuity', 54, 760, 180, 20),
      item('The conclusion continues with meaningful evidence.', 54, 30, 280, 10),
      item('Draft legislation protects workers.', 54, 18, 190, 10),
    ]);

    expect(model.speech).toContain('The conclusion continues with meaningful evidence.');
    expect(model.speech).toContain('Draft legislation protects workers.');
  });

  it('does not attach a spaced prose dash to a preceding word', () => {
    const model = createPdfPageModel([
      item('A comparison', 54, 710, 80),
      item('-', 140, 710, 3.5),
      item('and its conclusion.', 150, 710, 110),
    ]);
    expect(model.anchorText).toBe('A comparison - and its conclusion.');
    expect(model.speech).toBe('A comparison and its conclusion.');
  });

  it('preserves a spaced dash at the end of a prose line as a word boundary', () => {
    const model = createPdfPageModel([
      item('A comparison', 54, 710, 80),
      item('-', 140, 710, 3.5),
      item('and its conclusion.', 54, 695.6, 100),
    ]);
    expect(model.speech).toBe('A comparison and its conclusion.');
  });

  it('does not merge complete words that happen to resemble lexical prefixes', () => {
    const model = createPdfPageModel([
      item('Prefix boundary', 54, 760, 154, 20),
      item('The review considered inter', 54, 710, 170, 12, { hasEOL: true }),
      item('alia evidence from several studies.', 54, 692, 210, 12, { hasEOL: true }),
    ]);

    expect(model.speech).toContain('inter alia evidence');
    expect(model.speech).not.toContain('interalia');
  });

  it('retains source identities, geometry, and original indexes on every ordered part', () => {
    const source = [
      item('Right', 326, 710, 44),
      item('Left', 54, 710, 34),
      item('Right end', 326, 688, 74),
      item('Left end', 54, 688, 64),
    ];
    const model = createPdfPageModel(source);

    expect(model.orderedItems.map((part) => part.originalIndex)).toEqual([1, 3, 0, 2]);
    for (const line of model.lines) {
      expect(line).toEqual(expect.objectContaining({
        parts: expect.any(Array),
        originalIndex: expect.any(Number),
        y: expect.any(Number),
        left: expect.any(Number),
        right: expect.any(Number),
        role: expect.stringMatching(/^(title|paragraph|list-item|table-row|caption)$/),
      }));
    }
  });

  it('renders one line collection into raw anchors and punctuation-bearing speech', () => {
    const model = createPdfPageModel([
      item('Summary', 54, 760, 94, 20),
      item('A complete sentence', 54, 710, 146),
    ]);

    const rendered = renderPdfPageModel(model.lines);

    expect(rendered.anchorText).toBe('Summary\n\nA complete sentence');
    expect(rendered.speech).toBe('Summary: A complete sentence.');
    expect(model.anchorText).toBe(rendered.anchorText);
    expect(model.speech).toBe(rendered.speech);
  });
});

describe('centered title continuations above independent columns', () => {
  it.each([[1, 1], [1, 2], [1.5, 1], [1.5, 2]])('keeps %s-scale title with %s short final lines together', (scale, trailing) => {
    const titles = ['A Community Field Guide to Reliable Planning',
      'An Illustrated Handbook for Local Groups', 'Reading the Landscape to Find Productive', 'Soil'];
    const widths = [510, 425, 492, 44];
    const parts = titles.map((text, index) => item(text, 297.64 - widths[index] / 2,
      770 - index * 28, widths[index], 24));
    if (trailing === 2) {
      titles.push('Care');
      parts.push(item('Care', 275.64, 658, 44, 24));
    }
    parts.push(item('Dana Example', 235, 625, 125, 12));
    for (let row = 0; row < 6; row++) parts.push(
      item(row ? `The left column retains original sentence ${row}.`
        : 'Abstract Original left-column prose begins here.', 40.6, 580 - row * 14, 251, 10),
      item(`The right column retains original sentence ${row}.`, 303.6, 580 - row * 14, 251, 10));
    const scaled = parts.map(part => ({ ...part, width: part.width * scale,
      height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) }));
    const original = structuredClone(scaled);
    const model = createPdfPageModel(scaled, { pageView: [0, 0, 595.28 * scale, 841.89 * scale] });
    expect(model.speech.startsWith(`${titles.join(' ')}:`)).toBe(true);
    expect(model.orderedItems.slice(0, titles.length).map(part => part.originalIndex))
      .toEqual(titles.map((_, index) => index));
    expect(model.speech.indexOf('left column retains original sentence 5'))
      .toBeLessThan(model.speech.indexOf('right column retains original sentence 0'));
    expect(model.anchorText).toContain('Soil');
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
    expect(scaled).toEqual(original);
  });
});
