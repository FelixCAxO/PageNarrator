const PARAGRAPHS = ['Alpha', 'Beta', 'Gamma'];

export const SIDENOTE_PATTERN_AXES = {
  side: ['left', 'right'], anchorParagraph: [0, 1, 2], noteLines: [2, 5, 11], bodyLines: [3, 6],
  noteFontRatio: [0.6, 0.8], sourceOrder: ['rows', 'columns', 'reverse', 'shuffled'],
  fragmentation: ['lines', 'words'], scale: [0.5, 1, 2], rotation: [0, 90, 180, 270],
};

export function* sidenoteReadingOrderPatterns() {
  const entries = Object.entries(SIDENOTE_PATTERN_AXES);
  function* expand(index, parameters) {
    if (index === entries.length) { yield parameters; return; }
    const [key, values] = entries[index];
    for (const value of values) yield* expand(index + 1, { ...parameters, [key]: value });
  }
  let ordinal = 0;
  for (const parameters of expand(0, {})) {
    ordinal += 1;
    yield { id: `sidenote-${String(ordinal).padStart(5, '0')}`, family: `sidenote-${parameters.side}`,
      parameters: { ...parameters, source: 'pdf-text' } };
  }
}

export function rotateReadingOrderFixture(fixture, rotation) {
  if (!rotation) return fixture;
  const [, , width, height] = fixture.options.pageView;
  const items = fixture.items.map(item => {
    const [a, b, c, d, x, y] = item.transform;
    const transform = rotation === 90 ? [-b, a, -d, c, height - y, x]
      : rotation === 180 ? [-a, -b, -c, -d, width - x, height - y]
        : [b, -a, d, -c, y, width - x];
    return { ...item, x: transform[4], y: transform[5], transform };
  });
  return { ...fixture, items, options: { ...fixture.options, pageRotation: rotation,
    pageView: rotation === 180 ? [0, 0, width, height] : [0, 0, height, width] } };
}

export function buildSidenoteReadingOrderPattern({ parameters: p }, { measureText = (text, height) => text.length * height * 0.5 } = {}) {
  const mainX = p.side === 'left' ? 200 : 30, noteX = p.side === 'left' ? 30 : 370;
  const scale = p.scale, bodyHeight = 12, noteHeight = bodyHeight * p.noteFontRatio;
  const pitch = bodyHeight * 1.4, paragraphPitch = p.bodyLines * pitch + bodyHeight * 1.4;
  const paragraphs = PARAGRAPHS.map((label, paragraph) => Array.from({ length: p.bodyLines }, (_, line) => ({
    str: line === 0 ? `Main ${label} begins the explanation`
      : line === p.bodyLines - 1 ? `until the ${label} argument is complete.` : `and continues the ${label} account`,
    x: mainX, y: 820 - paragraph * paragraphPitch - line * pitch, height: bodyHeight,
    key: `main/${paragraph}/${line}`, column: p.side === 'left' ? 1 : 0,
  })));
  const note = Array.from({ length: p.noteLines }, (_, line) => ({
    str: line === 0 ? 'A separate note begins here' : line === p.noteLines - 1 ? 'and ends its own argument.' : `More detail for note ${line}`,
    x: noteX, y: 820 - p.anchorParagraph * paragraphPitch - pitch - line * noteHeight * 1.25,
    height: noteHeight, key: `note/${line}`, column: p.side === 'left' ? 0 : 1,
  }));
  const orderedLines = paragraphs.flatMap((paragraph, index) => index === p.anchorParagraph ? [...paragraph, ...note] : paragraph);
  const logical = orderedLines.flatMap(line => {
    let cursor = line.x;
    return (p.fragmentation === 'words' ? line.str.split(' ') : [line.str]).map((str, fragment) => {
      const width = measureText(str, line.height);
      const item = { str, x: cursor * scale, y: line.y * scale, height: line.height * scale, width: width * scale,
        transform: [1, 0, 0, 1, cursor * scale, line.y * scale], patternKey: `${line.key}/${fragment}`,
        column: line.column, fontName: line.key.startsWith('note') ? 'Notes' : 'Main' };
      cursor += width + measureText(' ', line.height);
      return item;
    });
  });
  const items = [...logical];
  if (p.sourceOrder === 'rows') items.sort((a, b) => b.y - a.y || a.x - b.x);
  if (p.sourceOrder === 'columns') items.sort((a, b) => a.column - b.column || b.y - a.y || a.x - b.x);
  if (p.sourceOrder === 'reverse') items.reverse();
  if (p.sourceOrder === 'shuffled') {
    let state = 8923;
    for (let i = items.length - 1; i > 0; i -= 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
  }
  return rotateReadingOrderFixture({ cells: orderedLines.map(line => line.str), items,
    expectedKeys: logical.map(item => item.patternKey), expectedText: logical.map(item => item.str),
    options: { pageView: [0, 0, 540 * scale, 900 * scale] } }, p.rotation);
}
