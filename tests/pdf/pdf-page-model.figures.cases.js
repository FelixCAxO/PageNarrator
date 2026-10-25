import { item } from './pdf-page-model.fixtures.js';
import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from "../../src/lib/pdf-page-model.js";

describe('PDF page model', () => {
  it.each([true, false])('returns a deferred caption after its interrupted sentence with source EOL=%s', hasEOL => {
    const source = [
      item('The example crosses a column bound-', 50, 100, 220, 9, { fontName: 'Body', hasEOL: true }),
      item('Figure 1: A sample diagram.', 310, 450, 190, 9, { fontName: 'Body', hasEOL: false }),
      item('ary.', 310, 268, 30, 9, { fontName: 'Body', hasEOL }),
      item('Following body paragraph.', 320, 254, 130, 9, { fontName: 'BodyBold', hasEOL: false }),
    ];
    const model = createPdfPageModel(source, { pageView: [0, 0, 600, 840] });
    expect(model.speech).toBe('The example crosses a column boundary. Figure 1: A sample diagram. Following body paragraph.');
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(4);
    expect(source[2].hasEOL).toBe(hasEOL);
  });
  it.each([1, 1.5])('joins a centered caption with its shorter continuation at scale %s', scale => {
    const parts = [item('Native garden resources', 54, 760, 500, 20),
      item('Explore these native flowers and begin a garden', 54, 720, 290, 13),
      item('in your area today.', 100, 702, 198, 13)];
    const model = createPdfPageModel(parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) })),
    { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.speech).toContain('Explore these native flowers and begin a garden in your area today.');
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([1, 1.5])('finishes introductory prose beside a sparse picture caption at scale %s', scale => {
    const parts = [item('An illustrated guide', 54, 760, 500, 20),
      item('The introductory sentence continues', 254, 710, 280),
      item('through the next line and', 254, 693, 260),
      item('ends naturally in the same', 254, 676, 260),
      item('paragraph.', 254, 659, 70),
      item('A picture caption begins', 54, 678, 100, 10),
      item('and ends below the image.', 54, 666, 100, 10),
      item('The lower section follows both the prose and the picture caption.', 54, 630, 480),
      item('The lower section continues here.', 54, 612, 240)];
    const model = createPdfPageModel(parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) })),
    { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.speech).toContain('The introductory sentence continues through the next line and ends naturally in the same paragraph.');
    expect(model.speech.indexOf('ends naturally')).toBeLessThan(model.speech.indexOf('A picture caption'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([1, 1.5])('keeps a shifted two-line picture caption out of a list at scale %s', scale => {
    const parts = [item('A garden with changing column alignments', 48, 760, 500, 20),
      item('1) The left instructions begin', 48, 700, 205),
      item('and continue through their own paragraph.', 48, 684, 218),
      item('The left text continues at this position', 48, 510, 217),
      item('and completes the original list item.', 48, 494, 218),
      item('Make sure this picture caption', 300, 510, 236),
      item('ends together before the next section.', 310, 494, 220),
      item('The left box explains the image.', 48, 340, 220),
      item('The left box ends here.', 48, 324, 200)];
    for (let row = 0; row < 9; row++) parts.push(item(`The right instructions explain observation ${row}.`, 353, 450 - row * 16, 215));
    const model = createPdfPageModel(parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) })),
    { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.speech).toContain('Make sure this picture caption ends together before the next section.');
    expect(model.lines.find(line => line.text.startsWith('1)')).text).not.toContain('picture caption');
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([1, 1.5])('keeps an indented sidebar separate from illustrated prose at scale %s', scale => {
    const parts = [item('A useful sidebar', 48, 760, 88, 10), item('An illustrated chapter', 162, 760, 190, 20)];
    for (let row = 0; row < 30; row++) parts.push(item(`The sidebar detail ${row} continues`, 66, 735 - row * 16, 80, 10));
    for (const [index, top] of [700, 520, 340].entries()) parts.push(
      item('•', 48, top, 6, 10),
      item(`Illustration label ${index}`, 320, top + 40, 48, 10),
      item(`The main paragraph ${index} starts here`, 162, top, 200, 10),
      item('and completes its own observation.', 162, top - 12, 195, 10));
    const model = createPdfPageModel(parts.map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) })),
    { pageView: [0, 0, 396 * scale, 792 * scale] });
    expect(model.speech).toContain('The main paragraph 0 starts here and completes its own observation.');
    expect(model.speech.indexOf('sidebar detail 29')).toBeLessThan(model.speech.indexOf('The main paragraph 0'));
    expect(model.lines.every(line => !(line.text.includes('sidebar detail') && line.text.includes('main paragraph')))).toBe(true);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it.each([120, 564])('orders a small unlabelled caption at y=%s by its vertical band', captionY => {
    const parts = [item('An illustrated report', 54, 760, 480, 20)];
    for (let index = 0; index < 5; index++) {
      parts.push(item(`The left column explains the complete observation number ${index}.`, 54, 660 - index * 20, 230, 10),
        item(`The right column explains the complete comparison number ${index}.`, 326, 660 - index * 20, 230, 10));
    }
    parts.push(item('Typical seasonal patterns in the illustration', 78, captionY, 230, 8));
    const model = createPdfPageModel(parts);
    const caption = model.speech.indexOf('Typical seasonal patterns');
    const right = model.speech.indexOf('The right column');
    if (captionY === 120) expect(caption).toBeGreaterThan(model.speech.indexOf('comparison number 4'));
    else expect(caption).toBeLessThan(right);
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(parts.length);
  });

  it('keeps unlabelled chart-axis numbers out of narration', () => {
    const parts = [item('Chart illustration', 60, 760, 180, 20)];
    for (let index = 0; index < 4; index += 1) {
      parts.push(item(String(index * 10), 60, 680 - index * 22, 12),
        item(String(index * 20), 240, 680 - index * 22, 12));
    }
    const model = createPdfPageModel(parts);
    expect(model.lines.every(line => line.role !== 'table-row')).toBe(true);
    expect(model.speech).toBe('Chart illustration:');
  });

  it('reads a dense text column before sparse figure text beside it', () => {
    const model = createPdfPageModel([
      item('Paper title', 210, 760, 190, 20),
      item('Abstract', 158, 611, 45),
      item('Left sentence begins', 88, 588, 184),
      item('Figure label', 348, 585, 122),
      item('and continues here', 88, 576, 184),
      item('Diagram values', 313, 573, 156),
      item('before it finishes', 88, 564, 184),
      item('More diagram values', 313, 550, 156),
      item('1 Introduction', 71, 520, 96, 14),
      item('Left body ending', 71, 500, 220),
      item('Figure 1: Diagram caption', 306, 490, 220),
    ]);

    expect(model.anchorText).toMatch(
      /Left sentence begins[\s\S]*and continues here[\s\S]*before it finishes[\s\S]*Figure label/u,
    );
  });

  it('places a full-width caption after both columns in its vertical region', () => {
    const modelForCaption = createPdfPageModel([
      item('Architecture', 210, 760, 192, 20),
      item('Left column start', 54, 710, 164),
      item('Right column start', 326, 710, 170),
      item('Left column end', 54, 688, 154),
      item('Right column end', 326, 688, 160),
      item('Figure 1: Architecture overview', 118, 620, 376, 11),
    ]);

    expect(modelForCaption.anchorText).toMatch(
      /Left column end[\s\S]*Right column end[\s\S]*Figure 1: Architecture overview/,
    );
    expect(modelForCaption.lines.at(-1).role).toBe('caption');
  });

  it('defers a caption so it cannot split prose across columns', () => {
    const model = createPdfPageModel([
      item('Column continuation', 170, 760, 272, 20),
      item('The conditional map-', 54, 120, 220, 12, { hasEOL: true }),
      item('Figure 1: Capability overview', 326, 700, 210, 10, { hasEOL: false }),
      item('ping remains stable across conditions.', 326, 680, 220, 12, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('The conditional mapping remains stable across conditions.');
    expect(model.speech).toMatch(/conditions\. Figure 1: Capability overview\./u);
    expect(model.narratedOriginalIndices).toEqual([0, 1, 3, 2]);
  });

  it('keeps figure-internal labels out of speech while retaining anchors and a wrapped caption', () => {
    const model = createPdfPageModel([
      item('Figure regions', 170, 760, 272, 20),
      item('The body remains meaningful before the figure.', 54, 680, 260, 12, { hasEOL: false }),
      item('Python Script', 340, 620, 70, 5),
      item('fig, ax = plt.subplots()', 340, 608, 100, 5),
      item('ax.bar(Category, Values)', 340, 596, 105, 5),
      item('Figure 1: Aligned scripts for chart-to-code.', 326, 570, 220, 10, { hasEOL: true }),
      item('They support generation across languages.', 326, 558, 200, 10, { hasEOL: false }),
      item('The following prose is also meaningful.', 326, 520, 220, 12, { hasEOL: false }),
    ]);

    expect(model.anchorText).toMatch(/Python Script[\s\S]*fig, ax = plt\.subplots/u);
    expect(model.speech).not.toMatch(/Python Script|plt\.subplots|ax\.bar/u);
    expect(model.speech).toContain(
      'Figure 1: Aligned scripts for chart-to-code. They support generation across languages.',
    );
    expect(model.speech).toContain('The following prose is also meaningful.');
  });

  it('recognizes abbreviated figure captions and suppresses their plot labels', () => {
    const model = createPdfPageModel([
      item('Figure abbreviation', 170, 760, 272, 20),
      item('The introduction remains complete.', 54, 680, 230, 12),
      item('Human versus GPT-4', 326, 620, 120, 6),
      item('GPT-4', 470, 606, 38, 6),
      item('Principal Component 1', 326, 606, 110, 6),
      item('0.0 1.0 2.0', 326, 592, 70, 6),
      item('Fig. 1: Sentiment distributions.', 326, 570, 190, 10),
      item('The conclusion remains complete.', 326, 520, 220, 12),
    ]);

    expect(model.lines.find((line) => line.text.startsWith('Fig. 1'))?.role).toBe('caption');
    expect(model.speech).not.toMatch(/Human versus GPT-4|GPT-4|Principal Component|0\.0 1\.0 2\.0/u);
    expect(model.speech).toContain('Fig. 1: Sentiment distributions.');
  });

  it('suppresses a dense figure region separated from its caption by whitespace', () => {
    const model = createPdfPageModel([
      item('Dense figure boundary', 170, 760, 272, 20),
      item('Body prose remains available.', 54, 680, 230, 12),
      item('Case: positive ambience', 326, 620, 150, 8),
      item('previous ASQP category', 326, 608, 145, 8),
      item('global syntax information', 326, 596, 140, 8),
      item('local sentiment output', 326, 584, 130, 8),
      item('Figure 2: Model overview.', 326, 540, 190, 10),
      item('Meaningful prose follows the figure.', 326, 500, 220, 12),
    ]);

    expect(model.speech).not.toMatch(/positive ambience|ASQP category|syntax information|sentiment output/u);
    expect(model.speech).toContain('Figure 2: Model overview.');
  });

  it('stops a wrapped caption before the following abstract section', () => {
    const model = createPdfPageModel([
      item('Caption boundary', 170, 760, 272, 20),
      item('Figure 1: Evaluation over all domains.', 54, 600, 500, 10),
      item('Results use the complete benchmark.', 54, 588, 500, 10),
      item('reward terms remain body prose.', 326, 570.1, 190, 10),
      item('Abstract', 54, 570, 60, 10),
      item('The training mixture improves efficiency.', 54, 558, 240, 10),
    ]);

    const abstractLine = model.lines.find((line) => line.text === 'Abstract');
    const rewardLine = model.lines.find((line) => line.text === 'reward terms remain body prose.');
    expect(abstractLine?.captionContinuationOf).toBeUndefined();
    expect(rewardLine?.captionContinuationOf).toBeUndefined();
    expect(model.speech).toMatch(
      /Figure 1: Evaluation over all domains\. Results use the complete benchmark\. Abstract\. The training mixture improves efficiency\./u,
    );
  });

  it('keeps small text when no figure caption establishes a visual-only region', () => {
    const model = createPdfPageModel([
      item('Small prose guard', 170, 760, 272, 20),
      item('A compact but meaningful annotation remains.', 54, 680, 220, 6),
      item('Ordinary body prose remains too.', 54, 650, 190, 12),
    ]);

    expect(model.speech).toContain('A compact but meaningful annotation remains.');
  });

  it('never suppresses small table cells using figure-region rules', () => {
    const model = createPdfPageModel([
      item('Table evidence', 170, 760, 272, 20),
      item('Accuracy', 54, 650, 60, 6),
      item('0.64', 180, 650, 28, 6),
      item('Stable', 280, 650, 42, 6),
      item('Recall', 54, 638, 45, 6),
      item('0.72', 180, 638, 28, 6),
      item('Stable', 280, 638, 42, 6),
      item('F1', 54, 626, 18, 6),
      item('0.68', 180, 626, 28, 6),
      item('Stable', 280, 626, 42, 6),
      item('Table 1: Evaluation results', 54, 610, 180, 10),
    ]);

    expect(model.speech).toMatch(/Accuracy[\s\S]*0\.64[\s\S]*Recall[\s\S]*0\.72/u);
  });

  it('moves a wrapped caption after a lowercase cross-column sentence continuation', () => {
    const model = createPdfPageModel([
      item('Caption boundary', 170, 760, 272, 20),
      item('This approach supports long-context', 54, 120, 220, 12, { hasEOL: true }),
      item('Figure 2: Context extension', 326, 700, 190, 10, { hasEOL: true }),
      item('during model training.', 326, 688, 150, 10, { hasEOL: false }),
      item('corpora for reliable reasoning.', 326, 660, 190, 12, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('This approach supports long-context corpora for reliable reasoning.');
    expect(model.speech).toMatch(/reasoning\. Figure 2: Context extension during model training\./u);
  });

  it('does not fuse a caption fragment with the neighboring body column', () => {
    const model = createPdfPageModel([
      item('from a well. Groundwater', 324, 483.8, 100.62, 12),
      item('Groundwater can be adversely affected by leak', 437.0134, 479.2671, 134.4354, 10.1201),
      item('-', 571.2977, 479.2671, 2.9449, 10.1201),
      item('quality can be contaminated', 324, 469.4, 100.608, 12),
      item('ing septic tanks and other sources of pollution.', 437.0134, 468.227, 133.7068, 10.1201),
    ]);
    expect(model.speech).not.toContain('leakquality');
    expect(model.speech).toContain('leak quality');
  });
});
