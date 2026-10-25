import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

describe('full-width figure captions delimit independent layout bands', () => {
  it.each([1, 1.5])('finishes both figure columns before each caption at scale %s', scale => {
    const source = [
      item('The introduction explains the complete process before the first diagram.', 94, 730, 360, 10),
      item('Each interaction the designer has', 159, 680, 125, 9),
      item('requires information about the fabric.', 159, 669, 125, 9),
      item('Each supplier receives the required details', 300, 680, 145, 9),
      item('The supplier performs the assigned independent task.', 300, 669, 145, 9),
      item('Figure 1. The first complete workflow explains the required activities.', 94, 620, 360, 9),
      item('for the first design.', 94, 609, 140, 9),
      item('The following paragraph introduces a different complete system.', 94, 570, 360, 10),
      item('Each interaction the customer has', 159, 520, 125, 9),
      item('requires information about the order.', 159, 509, 125, 9),
      item('Each retailer receives the required details', 300, 520, 145, 9),
      item('The retailer completes the requested independent task.', 300, 509, 145, 9),
      item('Figure 2. The second complete workflow explains the system activities.', 94, 460, 360, 9),
      item('for the second design.', 94, 449, 145, 9),
      item('The final paragraph follows both complete diagrams and their captions.', 94, 410, 360, 10),
    ].map(part => ({ ...part, width: part.width * scale, height: part.height * scale,
      transform: part.transform.map((value, index) => index >= 4 ? value * scale : value) }));
    const before = structuredClone(source);
    const model = createPdfPageModel(source, { pageView: [0, 0, 612 * scale, 792 * scale] });
    const at = text => { const found = model.speech.indexOf(text); expect(found).toBeGreaterThanOrEqual(0); return found; };
    expect(at('assigned independent task')).toBeLessThan(at('Figure 1.'));
    expect(at('for the first design')).toBeLessThan(at('following paragraph'));
    expect(at('requested independent task')).toBeLessThan(at('Figure 2.'));
    expect(at('for the second design')).toBeLessThan(at('final paragraph'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
    expect(source).toEqual(before);
  });

  it('keeps a half-width caption inside its own column rather than restarting page flow', () => {
    const source = [
      item('The left column begins its complete original explanation.', 54, 710, 230, 10),
      item('The right column begins its complete separate comparison.', 326, 710, 230, 10),
      item('Figure 1. A diagram within only the left column.', 54, 650, 230, 9),
      item('The left column continues below its own diagram.', 54, 610, 230, 10),
      item('The right column continues its separate explanation.', 326, 650, 230, 10),
      item('The right column completes its original comparison.', 326, 610, 230, 10),
    ];
    const model = createPdfPageModel(source);
    expect(model.speech.indexOf('left column continues')).toBeLessThan(model.speech.indexOf('right column begins'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
  });

  it('retains right-to-left column order inside a full-width figure band', () => {
    const source = [];
    for (let row = 0; row < 4; row++) source.push(
      item(`Left complete explanation number ${row} remains together.`, 54, 710 - row * 18, 230, 10),
      item(`Right complete explanation number ${row} remains together.`, 326, 710 - row * 18, 230, 10));
    source.push(item('Figure 1. Both complete explanations belong above this caption.', 54, 600, 500, 9),
      item('The lower paragraph follows the complete figure.', 54, 560, 500, 10));
    const model = createPdfPageModel(source, { direction: 'rtl' });
    expect(model.speech.indexOf('Right complete explanation number 3')).toBeLessThan(model.speech.indexOf('Left complete explanation number 0'));
    expect(model.speech.indexOf('Left complete explanation number 3')).toBeLessThan(model.speech.indexOf('Figure 1.'));
    expect(model.speech.indexOf('Figure 1.')).toBeLessThan(model.speech.indexOf('lower paragraph'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
  });

  it('preserves all table rows between independent full-width captions', () => {
    const source = [];
    for (let row = 0; row < 4; row++) source.push(
      item(`Left complete explanation number ${row} remains together.`, 54, 730 - row * 18, 230, 10),
      item(`Right complete explanation number ${row} remains together.`, 326, 730 - row * 18, 230, 10));
    source.push(item('Figure 1. The first illustration is complete.', 54, 640, 500, 9));
    for (const [row, name] of ['Alpha', 'Beta', 'Gamma'].entries()) source.push(
      item(name, 54, 600 - row * 20, 35, 10), item(String(10 + row), 230, 600 - row * 20, 16, 10),
      item(String(20 + row), 340, 600 - row * 20, 16, 10));
    source.push(item('Figure 2. The table remains complete in this vertical band.', 54, 510, 500, 9),
      item('The final paragraph follows the table and both captions.', 54, 470, 500, 10));
    const model = createPdfPageModel(source);
    expect(model.lines.filter(line => line.role === 'table-row').map(line => line.text))
      .toEqual(['Alpha 10 20', 'Beta 11 21', 'Gamma 12 22']);
    expect(model.speech.indexOf('Figure 1.')).toBeLessThan(model.speech.indexOf('Alpha 10 20'));
    expect(model.speech.indexOf('Gamma 12 22')).toBeLessThan(model.speech.indexOf('Figure 2.'));
    expect(new Set(model.orderedItems.map(part => part.originalIndex)).size).toBe(source.length);
  });
});
