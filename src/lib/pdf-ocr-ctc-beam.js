// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Pure CTC path marginalization. There is no dictionary, word prior or text rewrite.
const NEGATIVE_INFINITY = -Infinity;
export const OCR_CTC_BEAM_POLICY = Object.freeze({ beamWidth: 16, topClasses: 8 });

function add(a, b) {
  if (a === NEGATIVE_INFINITY) return b;
  if (b === NEGATIVE_INFINITY) return a;
  const high = Math.max(a, b);
  return high + Math.log1p(Math.exp(Math.min(a, b) - high));
}

function total(state) {
  let value = state.blank;
  for (const probability of state.nonblank.values()) value = add(value, probability);
  return value;
}

function state(map, text) {
  let value = map.get(text);
  if (!value) { value = { text, blank: NEGATIVE_INFINITY, nonblank: new Map() }; map.set(text, value); }
  return value;
}

function nonblank(target, label, probability) {
  if (probability !== NEGATIVE_INFINITY) target.nonblank.set(label, add(target.nonblank.get(label) ?? NEGATIVE_INFINITY, probability));
}

/** Bounded prefix beam over glyph strings, retaining class identity for duplicate glyph classes. */
export function decodePdfOcrCtcBeam(data, steps, alphabet, { beamWidth = 16, topClasses = 8, align = true } = {}) {
  const classes = alphabet?.length;
  if (!(data instanceof Float32Array || data instanceof Float64Array) || !Number.isInteger(steps) || steps < 1 || steps > 2048
    || !Array.isArray(alphabet) || classes < 2 || classes > 20000 || alphabet[0] !== ''
    || alphabet.slice(1).some(value => typeof value !== 'string' || [...value].length !== 1)
    || data.length !== steps * classes || data.length > 32_000_000
    || !Number.isInteger(beamWidth) || beamWidth < 1 || beamWidth > 128
    || !Number.isInteger(topClasses) || topClasses < 1 || topClasses > 32) throw new RangeError('Invalid bounded CTC beam input or policy.');
  let beam = [{ text: '', blank: 0, nonblank: new Map() }];
  const selected = [];
  for (let frame = 0; frame < steps; frame++) {
    const offset = frame * classes, top = [];
    let sum = 0;
    for (let label = 0; label < classes; label++) {
      const probability = data[offset + label];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid CTC posterior probability.');
      sum += probability;
      if (!label || !probability) continue;
      if (top.length === topClasses && probability <= data[offset + top.at(-1)]) continue;
      let index = top.length;
      while (index && probability > data[offset + top[index - 1]]) index--;
      if (index < topClasses) { top.splice(index, 0, label); if (top.length > topClasses) top.pop(); }
    }
    if (Math.abs(sum - 1) > .001) throw new Error('CTC posterior frame is not normalized.');
    selected.push(new Set(top));
    const next = new Map(), blank = Math.log(data[offset]);
    for (const previous of beam) {
      const same = state(next, previous.text);
      same.blank = add(same.blank, total(previous) + blank);
      for (const label of top) {
        const probability = Math.log(data[offset + label]);
        nonblank(same, label, (previous.nonblank.get(label) ?? NEGATIVE_INFINITY) + probability);
        let extension = previous.blank;
        for (const [before, score] of previous.nonblank) if (before !== label) extension = add(extension, score);
        if (extension !== NEGATIVE_INFINITY) nonblank(state(next, previous.text + alphabet[label]), label, extension + probability);
      }
    }
    beam = [...next.values()].map(value => ({ ...value, probability: total(value) }))
      .filter(value => value.probability !== NEGATIVE_INFINITY)
      .sort((a, b) => b.probability - a.probability || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).slice(0, beamWidth);
    if (!beam.length) throw new Error('CTC beam lost every valid path.');
  }
  const best = beam[0], result = { text: best.text, logProbability: best.probability,
    alternatives: beam.map(value => ({ text: value.text, logProbability: value.probability })) };
  return align ? { ...result, ...alignCtcText(data, steps, alphabet, best.text, selected) } : result;
}

// The highest scoring path spelling the marginalized winner provides frame-level geometry.
// Blank resets repetition; duplicate glyph classes still have distinct repeat states.
function alignCtcText(data, steps, alphabet, text, selected) {
  const glyphs = [...text], byGlyph = new Map();
  for (let label = 1; label < alphabet.length; label++) {
    const labels = byGlyph.get(alphabet[label]) ?? []; labels.push(label); byGlyph.set(alphabet[label], labels);
  }
  const count = 1 + glyphs.reduce((sum, glyph) => sum + (byGlyph.get(glyph)?.length || 0) + 1, 0);
  if (count > 8192 || count * steps > 4_000_000 || glyphs.some(glyph => byGlyph.get(glyph).length > 32)) throw new RangeError('CTC alignment exceeds its bounded state budget.');
  const states = [{ label: 0, previous: [0] }], groups = [[0]], blanks = [0];
  for (let index = 0; index < glyphs.length; index++) {
    const prior = groups[index], current = [];
    for (const label of byGlyph.get(glyphs[index]) || []) {
      const id = states.length;
      states.push({ label, previous: [id, blanks[index], ...prior.filter(before => states[before].label && states[before].label !== label)] });
      current.push(id);
    }
    const blank = states.length;
    states.push({ label: 0, previous: [blank, ...current] }); blanks.push(blank); groups.push(current);
  }
  let previous = new Float64Array(states.length).fill(NEGATIVE_INFINITY); previous[0] = 0;
  const back = new Int32Array(states.length * steps).fill(-1);
  for (let frame = 0; frame < steps; frame++) {
    const current = new Float64Array(states.length).fill(NEGATIVE_INFINITY);
    for (let index = 0; index < states.length; index++) {
      const { label, previous: sources } = states[index];
      if (label && !selected[frame].has(label)) continue;
      let score = NEGATIVE_INFINITY, source = -1;
      for (const before of sources) if (previous[before] > score) { score = previous[before]; source = before; }
      const probability = data[frame * alphabet.length + label];
      if (!probability || source < 0) continue;
      current[index] = score + Math.log(probability); back[frame * states.length + index] = source;
    }
    previous = current;
  }
  let final = blanks.at(-1);
  for (const index of groups.at(-1)) if (previous[index] > previous[final]) final = index;
  if (!Number.isFinite(previous[final])) throw new Error('CTC winner has no valid frame alignment.');
  const labels = new Int32Array(steps), scores = new Float32Array(steps), bestPathLogProbability = previous[final];
  for (let frame = steps - 1; frame >= 0; frame--) {
    labels[frame] = states[final].label; scores[frame] = data[frame * alphabet.length + labels[frame]];
    final = back[frame * states.length + final];
  }
  return { labels, scores, bestPathLogProbability };
}
