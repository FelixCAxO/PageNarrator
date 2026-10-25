export function orderPdfOcrMarginalLines(lines = []) {
  lines = orderPdfOcrNearbyFragments(lines);
  const banded = orderPdfOcrColumns(lines);
  if (banded !== lines) return banded;
  if (lines.length < 4 || lines.some(line => !line.bbox)) return lines;
  const columns = [];
  for (const line of [...lines].sort((a,b)=>a.bbox.x0-b.bbox.x0)) {
    const previous = columns.at(-1);
    if (previous && line.bbox.x0 <= previous.right) {
      previous.right = Math.max(previous.right,line.bbox.x1);
      previous.lines.push(line);
    } else columns.push({left:line.bbox.x0,right:line.bbox.x1,lines:[line]});
  }
  if (columns.length !== 2 || columns.some(column=>column.lines.length<2)) return lines;
  const widths = columns.map(column=>column.right-column.left);
  // Only separate a narrow margin from a broad body; preserve peer-column order.
  if (Math.min(...widths) > Math.max(...widths)/3) return lines;
  const narrow = columns[widths[0] < widths[1] ? 0 : 1], broad = columns[widths[0] < widths[1] ? 1 : 0];
  const aligned = narrow.lines.filter(a=>broad.lines.some(b=>Math.abs(a.bbox.y0-b.bbox.y0)
    <= Math.min(a.bbox.y1-a.bbox.y0,b.bbox.y1-b.bbox.y0)/4));
  if (aligned.length >= narrow.lines.length/2) return lines;
  return columns.flatMap(column=>{
    const members=new Set(column.lines);
    return lines.filter(line=>members.has(line));
  });
}

export function orderPdfOcrNearbyFragments(lines = []) {
  const ordered = lines.slice();
  let changed = false;
  // ponytail: bounded local repair; ambiguous or distant matches retain detector order.
  for (let i = 1; i < ordered.length; i++) {
    const left = ordered[i], a = left.words?.at(-1)?.bbox;
    if (!a) continue;
    const matches = [];
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const right = ordered[j], b = right.words?.[0]?.bbox;
      if (!b || !(left.bbox?.x0 < right.bbox?.x0)) continue;
      const height = Math.min(a.y1 - a.y0, b.y1 - b.y0), gap = b.x0 - a.x1;
      if (height > 0 && gap >= -height * .3 && gap <= 0
        && Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) <= height * .35) matches.push(j);
    }
    if (matches.length === 1) {
      ordered.splice(matches[0], 0, ordered.splice(i, 1)[0]);
      changed = true;
    }
  }
  return changed ? ordered : lines;
}

// ponytail: consistent columns only; spanning or table-like layouts keep source order.
export function orderPdfOcrColumns(lines = []) {
  if (lines.length < 24 || lines.some(l => !l.bbox || !Object.values(l.bbox).every(Number.isFinite)
    || l.bbox.x1<=l.bbox.x0 || l.bbox.y1<=l.bbox.y0)) return lines;
  const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const widths=lines.map(l=>l.bbox.x1-l.bbox.x0),width=median([...widths]);
  if (Math.max(...widths)>width*1.5) return lines;
  const top=Math.min(...lines.map(l=>l.bbox.y0)),bottom=Math.max(...lines.map(l=>l.bbox.y1));
  const bandOf=l=>Math.min(3,Math.floor(((l.bbox.y0+l.bbox.y1)/2-top)/(bottom-top)*4));
  const models=[];
  for(let band=0;band<4;band++){
    const members=lines.filter(l=>bandOf(l)===band);
    if(members.length<6)return lines;
    const localWidth=width;
    const starts=members.filter(l=>l.bbox.x1-l.bbox.x0>=localWidth*.7).map(l=>l.bbox.x0).sort((a,b)=>a-b);
    const groups=[];
    for(const x of starts){
      if(!groups.length || x-groups.at(-1).at(-1)>localWidth*.4)groups.push([]);
      groups.at(-1).push(x);
    }
    if(groups.length<1 || groups.length>4 || groups.some(g=>g.length<3)
      || (models.length && groups.length!==models[0].starts.length))return lines;
    models.push({width:localWidth,starts:groups.map(g=>median(g))});
  }
  const columns=models[0].starts.map(()=>[]);
  for(const line of lines){
    const model=models[bandOf(line)],center=(line.bbox.x0+line.bbox.x1)/2;
    const distances=model.starts.map(x=>Math.abs(center-x-model.width/2));
    columns[distances.indexOf(Math.min(...distances))].push(line);
  }
  // Repeated aligned rows are ambiguous with tables, even when column starts are stable.
  for(let i=1;i<columns.length;i++){
    const a=columns[i-1],b=columns[i];
    const aligned=a.filter(l=>b.some(r=>Math.abs(l.bbox.y0-r.bbox.y0)
      <=Math.min(l.bbox.y1-l.bbox.y0,r.bbox.y1-r.bbox.y0)*.15));
    if(aligned.length>=Math.min(a.length,b.length)*.8)return lines;
  }
  for(const column of columns)for(let i=1;i<column.length;i++){
    const left=column[i],right=column[i-1],a=left.words?.at(-1)?.bbox,b=right.words?.[0]?.bbox;
    if(!a||!b)continue;
    const height=Math.min(a.y1-a.y0,b.y1-b.y0),gap=b.x0-a.x1;
    if(height>0&&left.bbox.x0<right.bbox.x0&&gap>=-height*.3&&gap<=height&&Math.abs((a.y0+a.y1-b.y0-b.y1)/2)<=height*.35){[column[i-1],column[i]]=[left,right];i++;}
  }
  return columns.flat();
}

// ponytail: join only nearby baseline continuations; distant columns stay separate.
// Quadratic in line fragments; use a spatial index only if dense-page measurements require it.
export function joinPdfOcrLineFragments(lines = []) {
  const pending = lines.map((line, index) => ({ ...line, index }))
    .sort((a, b) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0) || a.index - b.index);
  const result = [];
  while (pending.length) {
    let line = pending.shift();
    let nextIndex;
    while ((nextIndex = pending.findIndex((next) => continuesBaseline(line, next))) >= 0) {
      const next = pending.splice(nextIndex, 1)[0];
      line = { ...line, index: Math.min(line.index, next.index),
        words: [...(line.words || []), ...(next.words || [])],
        bbox: { x0: line.bbox.x0, y0: Math.min(line.bbox.y0, next.bbox.y0),
          x1: next.bbox.x1, y1: Math.max(line.bbox.y1, next.bbox.y1) },
        // Use the local tangent at the right edge, not a straight fit across the curve.
        baseline: next.baseline,
      };
    }
    result.push(line);
  }
  return result.sort((a, b) => a.index - b.index).map(({ index, ...line }) => {
    void index;
    return line;
  });
}

export function getPdfOcrRetryRectangle(lines, joined) {
  if (lines.length - joined.length < 3) return null;
  const boxes = joined.map((line) => line.bbox).filter(Boolean);
  if (boxes.length < 3) return null;
  const width = Math.max(...boxes.map((box) => box.x1)) - Math.min(...boxes.map((box) => box.x0));
  const wide = boxes.filter((box) => box.x1 - box.x0 >= width * 0.65);
  if (width <= 0 || wide.length < 3) return null;
  const starts = wide.map((box) => box.x0).sort((a, b) => a - b);
  const left = Math.max(0, Math.floor(starts[Math.floor(starts.length / 2)]) - 2);
  const top = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.y0))));
  return { left, top,
    width: Math.ceil(Math.max(...boxes.map((box) => box.x1))) - left,
    height: Math.ceil(Math.max(...boxes.map((box) => box.y1))) - top };
}

function continuesBaseline(left, right) {
  if (!left.bbox || !right.bbox || !left.baseline || !right.baseline) return false;
  const height = Math.min(left.bbox.y1 - left.bbox.y0, right.bbox.y1 - right.bbox.y0);
  const gap = right.bbox.x0 - left.bbox.x1;
  if (height <= 0 || gap < -height * 0.2 || gap > height * 2) return false;
  const base = left.baseline;
  const slope = (base.y1 - base.y0) / (base.x1 - base.x0);
  if (!Number.isFinite(slope) || Math.abs(slope) > 0.25) return false;
  const projected = base.y1 + slope * (right.baseline.x0 - base.x1);
  return Math.abs(projected - right.baseline.y0) <= Math.max(3, height * 0.35);
}
