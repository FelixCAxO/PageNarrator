// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Geometry stays in PDF coordinates; projections determine logical writing order.
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const isVerticalPdfItem = item => item.vertical === true || item.dir === 'ttb';

export function joinVerticalText(left, right, separated = false) {
  if (!left) return right;
  if (!right) return left;
  const boundary = [...left].at(-1) + [...right][0];
  return `${left}${separated && !cjk.test(boundary) ? ' ' : ''}${right}`;
}

export function getVerticalPdfRegions(items) {
  const columns = [];
  for (const item of items) {
    const [a = 0, b = 0, c = 0, d = 0] = item.transform || [];
    const em = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    const advance = [-c / em, -d / em], normalLength = Math.hypot(a, b) || em;
    const normal = [a / normalLength, b / normalLength];
    const position = item.x * normal[0] + item.y * normal[1], start = item.x * advance[0] + item.y * advance[1];
    const width = Math.abs(item.width) || normalLength, end = start + Math.abs(item.height);
    const projected = { item, advance, normal, em, width, position, start, end };
    const column = columns.find(candidate => Math.abs(candidate.position - position) <= Math.min(candidate.width, width) * 0.45
      && candidate.advance[0] * advance[0] + candidate.advance[1] * advance[1] > 0.999);
    if (column) column.parts.push(projected);
    else columns.push({ position, width, advance, normal, parts: [projected] });
  }
  const lines = [];
  for (const column of columns) {
    const groups = [];
    for (const part of column.parts.sort((a, b) => a.start - b.start || a.item.originalIndex - b.item.originalIndex)) {
      const group = groups.at(-1), previous = group?.at(-1);
      if (previous && part.start - previous.end <= Math.max(part.em, previous.em) * 1.5) group.push(part);
      else groups.push([part]);
    }
    for (const group of groups) {
      const parts = group.map(part => part.item), corners = group.flatMap(part => {
        const { item, advance, normal, width } = part;
        return [-0.5, 0.5].flatMap(side => [0, item.height].map(along => ({
          x: item.x + normal[0] * width * side + advance[0] * along,
          y: item.y + normal[1] * width * side + advance[1] * along,
        })));
      });
      let text = '';
      for (let i = 0; i < group.length; i++) text = joinVerticalText(text, group[i].item.text, i > 0 && group[i].start - group[i - 1].end > group[i].em * 0.2);
      lines.push({ vertical: true, role: 'paragraph', text, speechText: text, parts, originalIndex: parts[0].originalIndex,
        y: Math.max(...corners.map(corner => corner.y)), bottom: Math.min(...corners.map(corner => corner.y)),
        left: Math.min(...corners.map(corner => corner.x)), right: Math.max(...corners.map(corner => corner.x)),
        columnPosition: column.position, columnFlowStart: group[0].start, columnFlowEnd: Math.max(...group.map(part => part.end)),
        advance: column.advance, em: Math.max(...group.map(part => part.em)) });
    }
  }
  const regions = [];
  for (const line of lines) {
    const connected = regions.filter(candidate => candidate.lines.some(other => other.advance[0] * line.advance[0] + other.advance[1] * line.advance[1] > 0.999
      && Math.min(other.columnFlowEnd, line.columnFlowEnd) > Math.max(other.columnFlowStart, line.columnFlowStart)));
    const region = { lines: [line, ...connected.flatMap(candidate => candidate.lines)] };
    for (const candidate of connected) regions.splice(regions.indexOf(candidate), 1);
    regions.push(region);
  }
  return regions.map((region, index) => ({ top: Math.max(...region.lines.map(line => line.y)),
    lines: region.lines.sort((a, b) => b.columnPosition - a.columnPosition || a.columnFlowStart - b.columnFlowStart)
      .map(line => ({ ...line, verticalRegion: index })) })).sort((a, b) => b.top - a.top);
}
