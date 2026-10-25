// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const flatten = data => (data?.blocks || []).flatMap(b => b.paragraphs || []).flatMap(p => p.lines || []);
const area = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }) / Math.max(1, Math.min(area(a), area(b)));
const mixedCase = word => { const w = word.replace(/[^A-Za-z]/g, ''); return w && !/^[a-z]+$/.test(w) && !/^[A-Z]+$/.test(w) && !/^[A-Z][a-z]+$/.test(w); };
const numericProse = word => /^\(?\d+(?:[.,]\d+)?[a-z]*[),.;:!?]?$/.test(word);
const referenceWord = word => /^[A-Za-z]{2,}(?:['(-][A-Za-z]{2,})*[),.;:!?]?$/.test(word) || numericProse(word);
function sourceFrame(source, box) {
    const left = Math.max(0, Math.floor(box.x0)), right = Math.min(source.width, Math.ceil(box.x1)), top = Math.max(0, Math.floor(box.y0)), bottom = Math.min(source.height, Math.ceil(box.y1)), w = right - left, h = bottom - top, count = w * h;
    if (w < 1 || h < 1 || count > 262144)
        return null;
    const values = new Uint8Array(count), hist = new Uint32Array(256);
    let low = 255, high = 0;
    for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
            const p = (y * source.width + x) * 4, v = Math.round((source.data[p] * 77 + source.data[p + 1] * 150 + source.data[p + 2] * 29) / 256);
            values[(y - top) * w + x - left] = v;
            hist[v]++;
            low = Math.min(low, v);
            high = Math.max(high, v);
        }
    let background = 0, sum = 0;
    for (; background < 255; background++) {
        sum += hist[background];
        if (sum >= count / 2)
            break;
    }
    const light = high - background > background - low, contrast = light ? high - background : background - low;
    if (contrast < 30)
        return null;
    const threshold = background + (light ? 1 : -1) * contrast * .5, columns = new Uint8Array(w);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            if (light ? values[y * w + x] > threshold : values[y * w + x] < threshold)
                columns[x] = 1;
    const runs = [];
    for (let x = 0; x < w;) {
        if (columns[x]) {
            x++;
            continue;
        }
        const begin = x;
        while (x < w && !columns[x])
            x++;
        if (begin > 0 && x < w)
            runs.push({ left: left + begin, right: left + x, width: x - begin });
    }
    return { left, right, top, bottom, background, contrast, light, threshold, columns, runs };
}
export function analyzeSpacingSource(source, primary) {
    const result = { eligible: false, reason: 'invalid-source', references: [], words: [], medianReference: null };
    if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 21 || source.height < 21 || source.width * source.height > 1048576 || source.data?.length !== source.width * source.height * 4)
        return result;
    const lines = flatten(primary);
    if (lines.length !== 1 || !Array.isArray(lines[0].words) || lines[0].words.length > 512)
        return { ...result, reason: 'line/word-bound' };
    const words = lines[0].words, text = words.map(w => w.text).join(' ');
    if (/[^\x00-\x7f]|[@\\/_{}\[\]<>*=+|\x60]/.test(text) || words.some(w => mixedCase(w.text) || /\d/.test(w.text) && !numericProse(w.text)))
        return { ...result, reason: 'code/script/identifier' };
    if (words.some(w => !w.bbox || !Object.values(w.bbox).every(Number.isFinite) || !area(w.bbox) || w.bbox.x0 < 0 || w.bbox.y0 < 0 || w.bbox.x1 > source.width || w.bbox.y1 > source.height))
        return { ...result, reason: 'invalid-word-geometry' };
    if (words.some((w, i) => i && w.bbox.x0 < words[i - 1].bbox.x1))
        return { ...result, reason: 'overlapping/out-of-order-primary-ownership' };
    for (let i = 0; i + 1 < words.length; i++) {
        const a = words[i], b = words[i + 1], aBox = a.bbox, bBox = b.bbox;
        if (!referenceWord(a.text) || !referenceWord(b.text) || aBox.x1 > bBox.x0)
            continue;
        const yOverlap = Math.max(0, Math.min(aBox.y1, bBox.y1) - Math.max(aBox.y0, bBox.y0)) / Math.max(1, Math.min(aBox.y1 - aBox.y0, bBox.y1 - bBox.y0));
        if (yOverlap < .5)
            continue;
        const frame = sourceFrame(source, { x0: aBox.x0, x1: bBox.x1, y0: Math.min(aBox.y0, bBox.y0), y1: Math.max(aBox.y1, bBox.y1) }), mid = Math.floor((aBox.x1 + bBox.x0) / 2), gap = frame?.runs.find(r => r.left <= mid && r.right > mid);
        if (gap)
            result.references.push({ leftWord: i, rightWord: i + 1, ...gap, light: frame.light });
    }
    if (new Set(result.references.map(r => r.light)).size > 1)
        return { ...result, reason: 'ambiguous-source-polarity' };
    if (result.references.length < 2)
        return { ...result, reason: 'insufficient-wordspace-references' };
    const widths = result.references.map(r => r.width).sort((a, b) => a - b), middle = Math.floor(widths.length / 2);
    result.medianReference = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
    for (const [wordIndex, word] of words.entries()) {
        const frame = sourceFrame(source, word.bbox);
        if (!frame)
            continue;
        if (frame.light !== result.references[0].light)
            return { ...result, words: [], reason: 'ambiguous-source-polarity' };
        // Compare whole source columns; an even-sample median can fall between pixels.
        const gaps = frame.runs.filter(r => r.left > word.bbox.x0 && r.right < word.bbox.x1 && r.width >= 2 && r.width + 1 >= Math.floor(result.medianReference));
        if (gaps.length)
            result.words.push({ wordIndex, text: word.text, bbox: word.bbox, gaps, foreground: { background: frame.background, contrast: frame.contrast, light: frame.light, threshold: frame.threshold } });
    }
    result.eligible = result.words.length > 0;
    result.reason = result.eligible ? 'source-internal-wordspace' : 'no-wordspace-sized-internal-gap';
    return result;
}
export function mergeSpacingSource(source, primary, independent, analysis = analyzeSpacingSource(source, primary)) {
    const original = flatten(primary), checked = flatten(independent);
    if (!analysis.eligible || original.length !== 1 || checked.length !== 1 || !Array.isArray(checked[0].words) || checked[0].words.length > 512)
        return { data: primary, changes: [], reason: 'not-eligible' };
    if (checked[0].words.some(candidate => candidate.bbox && Object.values(candidate.bbox).every(Number.isFinite) && area(candidate.bbox) && original[0].words.filter(word => overlap(candidate.bbox, word.bbox) >= .5).length > 1))
        return { data: primary, changes: [], reason: 'ambiguous-independent-source-ownership' };
    const output = [], changes = [];
    for (const [index, word] of original[0].words.entries()) {
        const info = analysis.words.find(w => w.wordIndex === index);
        if (!info) {
            output.push(word);
            continue;
        }
        const matches = checked[0].words.filter(w => w.bbox && Object.values(w.bbox).every(Number.isFinite) && area(w.bbox) && overlap(w.bbox, word.bbox) >= .5).sort((a, b) => a.bbox.x0 - b.bbox.x0);
        if (matches.length < 2 || matches.some(w => typeof w.text !== 'string' || !w.text || /\s/.test(w.text) || !Number.isFinite(w.confidence) || w.confidence < 85) || matches.map(w => w.text).join('') !== word.text) {
            output.push(word);
            continue;
        }
        const boundaries = [];
        let valid = true;
        for (let j = 0; j + 1 < matches.length; j++) {
            if (matches[j].bbox.x1 >= matches[j + 1].bbox.x0) {
                valid = false;
                break;
            }
            const middle = (matches[j].bbox.x1 + matches[j + 1].bbox.x0) / 2, gap = info.gaps.find(g => g.left <= middle && g.right >= middle);
            if (!gap || boundaries.some(old => old.left === gap.left)) {
                valid = false;
                break;
            }
            boundaries.push(gap);
        }
        if (!valid) {
            output.push(word);
            continue;
        }
        const frame = sourceFrame(source, word.bbox), split = [];
        for (let j = 0; j < matches.length; j++) {
            const left = j ? boundaries[j - 1].right : word.bbox.x0, right = j < boundaries.length ? boundaries[j].left : word.bbox.x1;
            const hasInk = frame && frame.columns.slice(Math.max(0, Math.ceil(left - frame.left)), Math.min(frame.columns.length, Math.floor(right - frame.left))).some(Boolean);
            if (right <= left || !hasInk) {
                valid = false;
                break;
            }
            const part = { ...word, text: matches[j].text, bbox: { ...word.bbox, x0: left, x1: right } };
        // Whole-word CTC runs are not character evidence for either split word.
        delete part.symbols;
        split.push(part);
        }
        if (!valid) {
            output.push(word);
            continue;
        }
        output.push(...split);
        changes.push({ wordIndex: index, before: word, after: split, gaps: boundaries, referenceMedian: analysis.medianReference });
    }
    if (!changes.length || output.length > 512)
        return { data: primary, changes: [], reason: output.length > 512 ? 'output-word-bound' : 'no-corroborated-source-split' };
    const changedLine = { ...original[0], words: output }, data = { ...primary, blocks: primary.blocks.map(b => ({ ...b, paragraphs: b.paragraphs.map(p => ({ ...p, lines: p.lines.map(l => l === original[0] ? changedLine : l) })) })) };
    return { data, changes, reason: 'exact-letter-source-spacing' };
}
