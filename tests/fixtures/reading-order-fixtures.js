// Fixed text/geometry transcribed from the supplied screenshot; the source PDF was not supplied.
export const DEADLINE_ROWS = [
  ['Milestone', 'Submission deadline', 'Feedback / presentation'],
  ['Iteration 1', '24 Sep 2026, 23:55', 'RED 1: 25 Sep (past)'],
  ['Iteration 2 + two-goal PDF', '5 Oct 2026, 23:55', 'By 12 Oct, 23:55'],
  ['Iteration 3 + source PDF', '16 Oct 2026, 23:55', 'By 23 Oct, 23:55'],
  ['Iteration 4 + goal-model PDF', '29 Oct 2026, 10:00', 'RED 2: 29–30 Oct; booking opens 28 Oct'],
  ['Rest 1 / late final hand-in', '20 Nov 2026, 23:55', 'Within three weeks'],
];

export function tablePdfItems(rows = DEADLINE_ROWS, { scale = 1, rowGap = 42, top = 700 } = {}) {
  return rows.flatMap((row, rowIndex) => row.map((str, column) => ({
    str, x: (30 + column * 285) * scale, y: (top - rowIndex * rowGap) * scale,
    width: str.length * 6 * scale, height: 12 * scale,
    transform: [1, 0, 0, 1, (30 + column * 285) * scale, (top - rowIndex * rowGap) * scale],
  })));
}

export function deadlineTableHtml() {
  return `<table><caption>Deadline map</caption>${DEADLINE_ROWS.map((row, index) =>
    `<tr>${row.map((cell) => `<${index ? 'td' : 'th'}>${cell}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
}

// Text and approximate line bounds from the supplied Swedish table screenshot.
export const WRAPPED_SWEDISH_ROWS = [
  [['Intern förutsättning'], ['Typ av påverkan']],
  [['Kommunikation', 'inom organisationen'], [
    'Era kommunikationsvägar och sätt att kommunicera är centralt för',
    'styrningen av er informationssäkerhet. Alltså: ha era befintliga sätt',
    'att kommunicera internt i åtanke när ni utformar',
    'informationssäkerheten och dess styrning.',
  ]],
  [['Organisationens', 'infrastruktur'], [
    'Befintlig infrastruktur och teknik, inklusive informationsteknik,',
    'påverkar i hög grad informationssäkerheten och dess styrning.',
    'Observera att ni ska hantera specifika informationstillgångar i nästa',
    'del av analysen (del 3).',
  ]],
];

export function wrappedSwedishTableItems({ scale = 1, gutter = 0, ocr = false } = {}) {
  const widths = [
    [[190], [170]],
    [[155, 194], [566, 566, 412, 380]],
    [[152, 125], [537, 526, 566, 205]],
  ];
  const tops = [56, 92, 196];
  const items = WRAPPED_SWEDISH_ROWS.flatMap((row, rowIndex) => row.flatMap((cell, column) => (
    cell.map((str, line) => {
      const x = (column ? 237 + gutter : 27) * scale;
      const y = (792 - tops[rowIndex] - line * 22) * scale;
      return { str, x, y, width: widths[rowIndex][column][line] * scale, height: 20 * scale,
        transform: [1, 0, 0, 1, x, y] };
    })
  ))).sort((a, b) => a.x - b.x || b.y - a.y);
  return items.map((item, index) => ocr ? { ...item, ocrLine: index } : item);
}
