import { item } from './pdf-page-model.fixtures.js';
import { describe, expect, it } from 'vitest';
import {
  createPdfPageModel,
  renderPdfPageModel,
} from '../../src/lib/pdf-page-model.js';

describe('PDF page model', () => {
  it('preserves an observed compound in a list continuation and when rerendered', () => {
    const model = createPdfPageModel([
      item('The carbon-rich layer is visible.', 54, 700, 300),
      item('• Read the carbon-', 54, 674, 300),
      item('rich layer next.', 68, 658, 286),
    ]);
    expect(model.speech).toContain('Read the carbon-rich layer next.');
    expect(renderPdfPageModel(model.lines).speech).toBe(model.speech);
  });

  it.each([
    ['ranges', ['65-85', '86-110', '111-135']],
    ['plain values', ['20', '30', '40']],
    ['signed decimal ranges', ['−2–−1', '−1.5–0.5', '0.5–2']],
  ])('preserves headered numeric table rows with %s', (_name, values) => {
    const parts = [item('Band', 60, 700, 40), item('Value', 240, 700, 80)];
    values.forEach((value, index) => parts.push(item(String(index), 75, 678 - index * 22, 8),
      item(value, 260, 678 - index * 22, 40)));
    parts.push(item('7', 300, 20, 8));
    const model = createPdfPageModel(parts);
    const rows = model.lines.filter(line => line.role === 'table-row');
    expect(rows.map(line => line.text)).toEqual(['Band Value', ...values.map((value, index) => `${index} ${value}`)]);
    for (const [index, value] of values.entries()) expect(model.speech).toContain(`${index} ${value}`);
    expect(model.narratedOriginalIndices).toEqual(parts.slice(0, -1).map((_part, index) => index));
    expect(model.speech).not.toMatch(/\b7\b/u);
  });

  it.each([0.5, 1, 2])('preserves dense decimal table cells at scale %s', scale => {
    const parts = [];
    for (const [index, label] of ['Alpha', 'Beta', 'Gamma'].entries()) {
      const y = 700 - index * 11;
      parts.push(item(label, 54 * scale, y * scale, 30 * scale, 8.5 * scale));
      for (const [column, value] of ['11.0', '12.6', '14.2', '18.3'].entries()) {
        parts.push(item(value, (140 + column * 28) * scale, y * scale, 16 * scale, 8.5 * scale));
      }
    }
    const model = createPdfPageModel(parts, { pageView: [0, 0, 612 * scale, 792 * scale] });
    expect(model.lines.map(line => line.text)).toEqual([
      'Alpha 11.0 12.6 14.2 18.3', 'Beta 11.0 12.6 14.2 18.3', 'Gamma 11.0 12.6 14.2 18.3',
    ]);
    expect(model.lines.every(line => line.role === 'table-row')).toBe(true);
  });

  it('finishes left-column prose before reading a dense right-column table row by row', () => {
    const parts = [];
    for (let index = 0; index < 4; index++) {
      const y = 710 - index * 22;
      if (index < 3) parts.push(item(`The left narrative sentence ${index} stays complete and in source order.`, 54, y, 230, 10));
      parts.push(item(`Model ${index + 1}`, 326, y, 40, 10));
      for (const [column, value] of [11 + index, 22 + index, 33 + index].entries()) {
        parts.push(item(String(value), 415 + column * 45, y, 12, 10));
      }
    }
    const model = createPdfPageModel(parts);
    expect(model.lines.map(line => line.text)).toEqual([
      'The left narrative sentence 0 stays complete and in source order.',
      'The left narrative sentence 1 stays complete and in source order.',
      'The left narrative sentence 2 stays complete and in source order.',
      'Model 1 11 22 33', 'Model 2 12 23 34', 'Model 3 13 24 35', 'Model 4 14 25 36',
    ]);
    expect(model.lines.slice(3).every(line => line.role === 'table-row')).toBe(true);
    expect(model.speech).toContain('Model 1 11 22 33. Model 2 12 23 34.');
  });

  it('orders compact repeated table cells row-major without treating prose columns as a table', () => {
    const modelForTable = createPdfPageModel([
      item('Results', 54, 760, 92, 20),
      item('Name', 54, 710, 50),
      item('Score', 230, 710, 46),
      item('Notes', 340, 710, 48),
      item('Alice', 54, 688, 46),
      item('10', 230, 688, 18),
      item('Passed', 340, 688, 54),
      item('Bob', 54, 666, 34),
      item('8', 230, 666, 9),
      item('Review', 340, 666, 56),
    ]);

    expect(modelForTable.anchorText).toBe([
      'Results',
      'Name Score Notes',
      'Alice 10 Passed',
      'Bob 8 Review',
    ].join('\n\n'));
    expect(modelForTable.lines.map((line) => line.role)).toEqual([
      'title',
      'table-row',
      'table-row',
      'table-row',
    ]);
    expect(modelForTable.orderedItems.map((part) => part.str)).toEqual([
      'Results',
      'Name', 'Score', 'Notes',
      'Alice', '10', 'Passed',
      'Bob', '8', 'Review',
    ]);
  });

  it('keeps prose column-major when a row-major table follows it', () => {
    const model = createPdfPageModel([
      item('Mixed layout', 210, 760, 192, 20),
      item('Left column start', 54, 710, 164),
      item('Right column start', 326, 710, 170),
      item('Left column end', 54, 688, 154),
      item('Right column end', 326, 688, 160),
      item('Name', 54, 610, 50),
      item('Score', 230, 610, 46),
      item('Notes', 340, 610, 48),
      item('Alice', 54, 588, 46),
      item('10', 230, 588, 18),
      item('Passed', 340, 588, 54),
      item('Bob', 54, 566, 34),
      item('8', 230, 566, 9),
      item('Review', 340, 566, 56),
    ]);

    expect(model.orderedItems.map((part) => part.str)).toEqual([
      'Mixed layout',
      'Left column start',
      'Left column end',
      'Right column start',
      'Right column end',
      'Name', 'Score', 'Notes',
      'Alice', '10', 'Passed',
      'Bob', '8', 'Review',
    ]);
  });

  it('does not classify aligned prose and diagram fragments as a table', () => {
    const model = createPdfPageModel([
      item('Abstract', 158, 611, 45),
      item('Large language models often produce', 88, 589, 184),
      item('Olympics', 311, 589, 42),
      item('P(w|context)', 418, 589, 48),
      item('Tokyo', 470, 589, 40),
      item('content that contradicts information', 88, 581, 184),
      item('probability', 311, 581, 62),
      item('0.6', 418, 581, 18),
      item('Paris', 470, 581, 36),
      item('provided in the input context', 88, 569, 184),
      item('stadium', 311, 569, 48),
      item('0.2', 418, 569, 18),
      item('Summer', 470, 569, 44),
    ]);

    expect(model.lines.every((line) => line.role !== 'table-row')).toBe(true);
    expect(model.anchorText).toMatch(
      /Large language models often produce[\s\S]*content that contradicts information[\s\S]*provided in the input context/u,
    );
  });

  it('adds structural pauses for a heading and wrapped list items', () => {
    const modelForList = createPdfPageModel([
      item('Key findings', 54, 760, 128, 20),
      item('• First item', 72, 710, 92),
      item('• Second wrapped', 72, 684, 136),
      item('item', 88, 668, 32),
      item('• Third item', 72, 640, 90),
    ]);

    expect(modelForList.lines.map((line) => line.role)).toEqual([
      'title',
      'list-item',
      'list-item',
      'list-item',
    ]);
    expect(modelForList.speech).toContain('Key findings: First item; Second wrapped item; Third item.');
  });

  it('repairs split words inside wrapped list items', () => {
    const model = createPdfPageModel([
      item('Contributions', 54, 760, 128, 20),
      item('1) We measure aspiration fi-', 72, 710, 220, 12, { hasEOL: true }),
      item('delity across several', 88, 694, 170, 12, { hasEOL: true }),
      item('languages.', 88, 678, 90, 12, { hasEOL: false }),
      item('2) We publish the result.', 72, 670, 180, 12, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('We measure aspiration fidelity across several languages');
    expect(model.speech).not.toContain('fi- delity');
  });

  it('does not turn a parenthesized acronym continuation into a list item', () => {
    const model = createPdfPageModel([
      item('Related work', 54, 760, 128, 20),
      item('We compare RNN-Transducer (RNN-', 54, 700, 250, 12, { hasEOL: true }),
      item('T) with attention systems.', 54, 684, 180, 12, { hasEOL: false }),
    ]);

    expect(model.speech).toContain('RNN-Transducer (RNN-T) with attention systems.');
    expect(model.speech).not.toContain('RNN-. T)');
  });

  it('does not absorb a later column into a bottom-of-column list item', () => {
    const model = createPdfPageModel([
      item('Column safety', 200, 760, 212, 20),
      item('Left top', 54, 700, 120),
      item('Right top', 326, 700, 120),
      item('Left middle', 54, 680, 120),
      item('Right middle', 326, 680, 120),
      item('Left lower', 54, 660, 120),
      item('Right lower', 326, 660, 120),
      item('* Left footnote', 72, 80, 120),
      item('Right ending', 326, 640, 120),
    ]);

    expect(model.lines.find((line) => line.text.startsWith('* Left footnote'))?.text).toBe('* Left footnote');
    expect(model.lines.some((line) => line.text === 'Right top')).toBe(true);
    expect(model.lines.some((line) => line.text === 'Right ending')).toBe(true);
  });

  it('joins separate line-end hyphens in continued list entries', () => {
    const model = createPdfPageModel([
      item('• Continuing the Groundwater Am', 54, 710, 190),
      item('-', 244.1, 710, 3.5),
      item('bient Monitoring program.', 66, 695.6, 150),
    ]);
    expect(model.speech).toBe('Continuing the Groundwater Ambient Monitoring program.');
  });
});
