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

// Text and approximate line bounds from the four-column security table screenshot.
export const SECURITY_TABLE_ROWS = [
  [['Sociala världen'], ['Att verksamhetens uppdrag,', 'etik och säkerhetspolicy är', 'förenliga med säkerhetskraven'],
    ['Insiderbrott; normaliserat', 'regelbrott; otydligt ansvar som', 'utnyttjas'],
    ['Styrning, ledningens ansvar,', 'lagstiftning och regelverk som', 'NIS2 och GDPR']],
  [['Pragmatik'], ['Organisationens normer och', 'säkerhetskultur; utbildning och', 'medvetenhet'],
    ['Social manipulation där avsikten', 'döljs (vd-bedrägeri); varningar', 'som ignoreras'],
    ['Utbildning, motringning, tydliga', 'kanaler för att ifrågasätta en', 'begäran']],
  [['Semantik'], ['Följder av feltolkade data och', 'felaktigt tillämpade regler;', 'ansvar och skuld'],
    ['Nätfiske, förfalskad avsändare,', 'manipulerade indata,', 'desinformation, förväxlingsbara', 'domännamn'],
    ['Ursprungskontroll, verifiering', 'mot oberoende källa, tydliga', 'begrepp, ansvarsstrukturer']],
  [['Syntax'], ['Programvara; granskning och', 'revision för dataintegritet och', 'programfel'],
    ['Injektion, buffertöverskridning,', 'felaktig tolkning av format och', 'protokoll'],
    ['Indatavalidering, strikta format,', 'patchning, kodgranskning']],
  [['Empirics'], ['Teleutrustning och', 'nätverksstrategier;', 'virushantering och kryptering'],
    ['Överbelastning, störsändning,', 'trafikanalys, sidokanaler'],
    ['Kapacitet, redundans,', 'felrättande koder, kryptering,', 'trafikutjämning']],
  [['Fysiska världen'], ['Hårdvara; fysisk säkerhet'],
    ['Stöld, sabotage, kabelbrott,', 'avlyssning av röjande signaler'],
    ['Skalskydd, redundans,', 'skärmning, tillträdeskontroll']],
];

export function securityTableItems({ scale = 1, ocr = false, header = false } = {}) {
  const rows = header ? [[['Nivå'], ['Ansvar (Dhillon)'], ['Hot'], ['Åtgärder']], ...SECURITY_TABLE_ROWS] : SECURITY_TABLE_ROWS;
  const tops = header ? [10, 45, 128, 210, 317, 400, 484] : [45, 128, 210, 317, 400, 484];
  const starts = [48, 182, 418, 653];
  const items = rows.flatMap((row, rowIndex) => row.flatMap((cell, column) => cell.map((str, line) => {
    const x = starts[column] * scale, y = (792 - tops[rowIndex] - line * 24) * scale;
    return { str, x, y, width: Math.min(str.length * 7.2, 220) * scale, height: 15 * scale,
      transform: [1, 0, 0, 1, x, y] };
  }))).sort((a, b) => a.x - b.x || b.y - a.y);
  return items.map((item, index) => ocr ? { ...item, ocrLine: index } : item);
}

// Numbered study rows with wrapping and smaller source references beside an answer.
export function studyTableFixture({ prefix = '', scale = 1, ocr = false, numbered = true } = {}) {
  const cells = Array.from({ length: 3 }, (_, row) => [
    numbered ? [`${prefix}${String(row + 1).padStart(3, '0')} Which steps belong to this`, 'part of the process?', `F2 source ${row + 1}`]
      : [row === 1 ? 'Long label with little space' : `Concept ${row + 1}`, ...(row === 1 ? ['continued label'] : [])],
    numbered ? [`Answer ${row + 1} starts here and`, 'continues until the whole answer is complete.']
      : [`Description ${row + 1} starts with enough detail to explain the concept`,
        'and continues across several lines for the reader.', `F2 source ${row + 1}`],
  ]);
  const items = cells.flatMap((row, rowIndex) => row.flatMap((cell, column) => cell.map((str, line) => {
    const x = (column ? 300 : 30) * scale;
    const y = (700 - rowIndex * 65 - line * 13 - (line === 2 ? 1.2 : 0)) * scale;
    const width = (!numbered && !column && rowIndex === 1 && line === 0 ? 265 : Math.min(str.length * 5, column ? 300 : 250)) * scale;
    return { str, x, y, width, height: (line === 2 ? 8 : 10) * scale, transform: [1, 0, 0, 1, x, y] };
  })));
  items.sort((a, b) => a.x - b.x || b.y - a.y);
  return { cells, items: items.map((item, index) => ocr ? { ...item, ocrLine: index } : item), width: 640 * scale };
}
