import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { buildReadingModel, renderReadingModelForSpeechChunks } from '../../src/lib/reading-model.js';
import { deadlineTableHtml, DEADLINE_ROWS } from '../fixtures/reading-order-fixtures.js';

const read = (html) => renderReadingModelForSpeechChunks(buildReadingModel(new JSDOM(`<main>${html}</main>`).window.document));

it('reads primary headings and prose inside a figure before its caption', () => {
  const chunks = read(`<p>Previous section.</p><figure><img alt="">
    <div><div><h2>5. Scientists can sample footprints</h2>
    <p>Snow from tracks contains environmental DNA.</p></div></div>
    <figcaption>Tracks in the snow.</figcaption></figure><p>Following section.</p>`);
  expect(chunks.map(({ type, anchorText }) => [type, anchorText])).toEqual([
    ['paragraph', 'Previous section.'], ['heading', '5. Scientists can sample footprints'],
    ['paragraph', 'Snow from tracks contains environmental DNA.'],
    ['caption', 'Tracks in the snow.'], ['paragraph', 'Following section.'],
  ]);
});

it('keeps multiple images and nested figures in their source positions', () => {
  const chunks = read(`<figure><p>Before the photographs.</p><img alt="Mountain summit at dawn">
    <p>Between the photographs.</p><figure><img alt="Valley river at noon">
    <figcaption>River measurements.</figcaption></figure><figcaption>Mountain measurements.</figcaption></figure>`);
  expect(chunks.map(({ anchorText }) => anchorText)).toEqual([
    'Before the photographs.', 'Mountain summit at dawn', 'Between the photographs.',
    'Valley river at noon', 'River measurements.', 'Mountain measurements.',
  ]);
});

it('reads a paragraph-wrapped caption only once and keeps figure lists and code', () => {
  const chunks = read(`<figure><figcaption><p>Observed footprints.</p></figcaption>
    <ul><li>Collect snow</li><li>Analyze samples</li></ul><pre>sample_id = 5;</pre></figure>`);
  expect(chunks.map(({ type }) => type)).toEqual(['caption', 'list', 'code']);
  expect(chunks[0].anchorText).toBe('Observed footprints.');
  expect(chunks[1].anchorText).toBe('Collect snow Analyze samples');
  expect(chunks[2].anchorText).toBe('sample_id = 5;');
});

it('honors visibility and noise within figures without losing visible prose', () => {
  const chunks = read(`<figure hidden><p>Secret hidden section.</p></figure>
    <figure><h2>Visible section</h2><p>Primary observations.</p>
    <div aria-hidden="true"><p>Hidden image credit.</p></div>
    <aside><p>Unrelated promotion.</p></aside><figcaption><p>Visible caption.</p></figcaption></figure>`);
  expect(chunks.map(({ anchorText }) => anchorText)).toEqual([
    'Visible section', 'Primary observations.', 'Visible caption.',
  ]);
});

it('omits figure media controls and standalone cards but retains inline prose links', () => {
  const chunks = read(`<figure><button aria-label="Play video">Play</button>
    <h2>Field observations</h2><p>Read the <a href="/study">complete study</a> for details.</p>
    <a href="/image">Image Details</a><button aria-label="Open caption"></button>
    <figcaption>Observed migration.</figcaption></figure>
    <figure><a href="/related"><div>Another story</div><div>Read more</div></a></figure>
    <button>Continue outside the figure</button>`);
  expect(chunks.map(({ anchorText }) => anchorText)).toEqual([
    'Field observations', 'Read the complete study for details.', 'Observed migration.',
    'Continue outside the figure',
  ]);
});

it('retains a heading and paragraph wrapped in a figure link', () => {
  const chunks = read(`<figure><a href="/study"><h2>DNA study</h2>
    <p>Footprints preserve the complete field observations.</p></a>
    <figcaption><a href="/photo"><p>Original caption.</p></a></figcaption></figure>`);
  expect(chunks.map(({ type, anchorText }) => [type, anchorText])).toEqual([
    ['heading', 'DNA study'], ['paragraph', 'Footprints preserve the complete field observations.'],
    ['caption', 'Original caption.'],
  ]);
});

it('keeps the supplied deadline table row order and header context', () => {
  const rows = read(deadlineTableHtml()).filter(({ type }) => type === 'table-row');
  expect(rows.map(({ anchorText }) => anchorText)).toEqual(DEADLINE_ROWS.slice(1).map((cells) => cells.join(' ')));
  expect(rows[1].speech).toContain('Submission deadline, 5 Oct 2026, 23:55');
});

it('does not mistake the first data row for headers in a headerless table', () => {
  const rows = read('<table><tr><td>Alpha</td><td>Monday</td></tr><tr><td>Beta</td><td>Tuesday</td></tr></table>')
    .filter(({ type }) => type === 'table-row');
  expect(rows.map(({ speech }) => speech)).toEqual(['Alpha - Monday.', 'Beta - Tuesday.']);
});

it('retains empty header positions instead of shifting labels left', () => {
  const rows = read('<table><tr><th></th><th>Deadline</th><th>Feedback</th></tr><tr><td>Alpha</td><td>Monday</td><td>Friday</td></tr></table>');
  expect(rows.at(-1).speech).toBe('Alpha - Deadline, Monday - Feedback, Friday.');
});

it('honors grouped headers and row spans without shifting or dropping cell values', () => {
  const chunks = read(`<table><thead><tr><th rowspan="2">Task</th><th colspan="2">Dates</th></tr>
    <tr><th>Submission</th><th>Feedback</th></tr></thead><tbody>
    <tr><td rowspan="2">Alpha</td><td>Monday</td><td>Friday</td></tr>
    <tr><td>Tuesday</td><td>Saturday</td></tr></tbody></table>`);
  const rows = chunks.filter(({ type }) => type === 'table-row');
  expect(chunks[0].speech).toBe('Table. 3 columns: Task, Dates, Submission, and Dates, Feedback.');
  expect(rows).toHaveLength(2);
  expect(rows[0].speech).toContain('Dates, Submission, Monday');
  expect(rows[1].speech).toContain('Task, Alpha');
  expect(rows[1].speech).toContain('Dates, Submission, Tuesday');
  expect(rows[1].speech).toContain('Dates, Feedback, Saturday');
  expect(rows[1].anchorText).toBe('Tuesday Saturday');
});

it('recognizes ARIA tables, headings, paragraphs, and lists once in document order', () => {
  const chunks = read(`<div role="heading" aria-level="2">Schedule</div><div role="paragraph">Read each row.</div>
    <div role="table"><div role="row"><div role="columnheader">Task</div><div role="columnheader">Due</div></div>
    <div role="row"><div role="cell">Alpha</div><div role="cell">Monday</div></div></div>
    <div role="list"><div role="listitem">Prepare</div><div role="listitem">Submit</div></div>`);
  expect(chunks.map(({ type }) => type)).toEqual(['heading', 'paragraph', 'table', 'table-row', 'list']);
  expect(chunks[3].speech).toBe('Task, Alpha - Due, Monday.');
  expect(chunks.at(-1).speech).toBe('List of 2 items: Prepare, Submit.');
});

it.each(['0', '99'])('ends rowspan=%s at its native row group', (span) => {
  const chunks = read(`<table><thead><tr><th>Task</th><th>Due</th></tr></thead>
    <tbody><tr><td rowspan="${span}">Alpha</td><td>Monday</td></tr><tr><td>Tuesday</td></tr></tbody>
    <tbody><tr><td>Beta</td><td>Friday</td></tr></tbody></table>`).filter(({ type }) => type === 'table-row');
  expect(chunks.map(({ speech }) => speech)).toEqual(['Task, Alpha - Due, Monday.', 'Task, Alpha - Due, Tuesday.', 'Task, Beta - Due, Friday.']);
});

it('uses ARIA row and column positions when DOM order differs or a cell is absent', () => {
  const chunks = read(`<div role="table">
    <div role="row" aria-rowindex="1"><span role="columnheader">Task</span><span role="columnheader">Due</span><span role="columnheader">Feedback</span></div>
    <div role="row" aria-rowindex="3"><span role="cell" aria-colindex="3">Friday</span><span role="cell" aria-colindex="1">Beta</span></div>
    <div role="row" aria-rowindex="2"><span role="cell">Alpha</span><span role="cell">Monday</span><span role="cell">Thursday</span></div>
  </div>`).filter(({ type }) => type === 'table-row');
  expect(chunks.map(({ speech }) => speech)).toEqual(['Task, Alpha - Due, Monday - Feedback, Thursday.', 'Task, Beta - Feedback, Friday.']);
});

it('keeps nested table rows from being narrated twice and ignores hidden row groups', () => {
  const chunks = read(`<table><tr><th>Section</th><th>Details</th></tr>
    <tr><td>Alpha</td><td><table><tr><th>Day</th></tr><tr><td>Monday</td></tr></table></td></tr>
    <tbody hidden><tr><td>Hidden</td><td>Secret</td></tr></tbody></table>`);
  const speech = chunks.map(({ speech }) => speech).join(' ');
  expect(speech.match(/Monday/g)).toHaveLength(1);
  expect(speech).not.toContain('Hidden');
  expect(speech).not.toContain('Secret');
});

it('retains a table wrapped in a figure, grouped definitions, and block boundaries', () => {
  const chunks = read(`<figure>${deadlineTableHtml()}</figure>
    <dl><div><dt>Deadline</dt><dd>The final submission date.</dd></div></dl>
    <p>First line<br>Second line <strong>stays</strong> together.</p>`);
  expect(chunks.filter(({ type }) => type === 'table-row')).toHaveLength(5);
  expect(chunks.slice(-3).map(({ speech }) => speech)).toEqual(['Deadline.', 'The final submission date.', 'First line Second line stays together.']);
});
