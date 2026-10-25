// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later

// CTC timestamps locate a word approximately. Visible ink gives steadier bounds
// when small inference differences move a timestamp or a detection crop edge.
function collectInk(gray, w, h, threshold, light, selectedColumn = null, minimumHeight = h*.15) {
  const count=w*h,seen=new Uint8Array(count),queue=new Int32Array(count),columns=new Uint8Array(w);
  let x0=w,y0=h,x1=0,y1=0,ink=0;
  const foreground=p=>light?gray[p]>threshold:gray[p]<threshold;
  for(let seed=0;seed<count;seed++){
    if(seen[seed]||!foreground(seed))continue;
    let head=0,tail=1,edge=false,touches=false,ax=w,ay=h,bx=0,by=0;
    queue[0]=seed;seen[seed]=1;
    while(head<tail){
      const p=queue[head++],x=p%w,y=Math.floor(p/w);
      ax=Math.min(ax,x);ay=Math.min(ay,y);bx=Math.max(bx,x+1);by=Math.max(by,y+1);
      if(!x||!y||x===w-1||y===h-1)edge=true;
      if(x===selectedColumn)touches=true;
      for(const next of[x?p-1:-1,x+1<w?p+1:-1,y?p-w:-1,y+1<h?p+w:-1]){
        if(next>=0&&!seen[next]&&foreground(next)){seen[next]=1;queue[tail++]=next;}
      }
    }
    // Rules and borders reaching the search edge are not letter components.
    if(edge||selectedColumn!==null&&!touches)continue;
    ink+=tail;x0=Math.min(x0,ax);y0=Math.min(y0,ay);x1=Math.max(x1,bx);y1=Math.max(y1,by);
    columns.fill(1,ax,bx);
  }
  let gap=0,maximumGap=1;
  for(let x=x0;x<x1;x++){gap=columns[x]?0:gap+1;maximumGap=Math.max(maximumGap,gap);}
  return {x0,y0,x1,y1,ink,maximumGap,valid:ink>=2&&ink<=count*.6&&y1-y0>=minimumHeight};
}

function refineWordPass(words, { data, width, height }, border, frame) {
  return words.map((word, index) => {
    const box = word.bbox, previous = words[index - 1]?.bbox, next = words[index + 1]?.bbox;
    const margin = (box.y1 - box.y0) * .5;
    // Preserve the established search/background; only connected edge glyphs
    // may extend into redrawn original context inside the model crop border.
    const minimumLeft = frame?.left ?? border;
    let left = Math.max(border, minimumLeft, Math.floor(previous ? (previous.x1 + box.x0) / 2 : box.x0 - margin));
    const maximumRight = frame?.right ?? (box.x1 > width - border ? width : width - border);
    let right = Math.min(maximumRight, box.x1 > width - border ? width : width - border,
      Math.ceil(next ? (box.x1 + next.x0) / 2 : box.x1 + margin));
    // Keep a real source pixel around the foreground frame: a letter touching
    // its exact edge must not be discarded as a search-edge rule or border.
    const top = frame ? Math.max(0, frame.top - 1) : border;
    const bottom = frame ? Math.min(height, frame.bottom + 1) : height - border, h = bottom - top;
    let w = right - left, count = w * h;
    if (w < 1 || h < 1 || count > 262144) return word;
    let gray = new Uint8Array(count);
    const histogram = new Uint32Array(256);
    let low = 255, high = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y + top) * width + x + left) * 4;
      const value = Math.round((data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) / 256);
      gray[y * w + x] = value; histogram[value]++; low = Math.min(low, value); high = Math.max(high, value);
    }
    let background = 0, cumulative = 0;
    for (; background < 255; background++) { cumulative += histogram[background]; if (cumulative >= count / 2) break; }
    let light = high - background > background - low;
    const contrast = light ? high - background : background - low;
    if (contrast < 30) return word;
    let threshold = background + (light ? 1 : -1) * contrast * .5;
    const minimumHeight=/^[\p{P}\p{S}]+$/u.test(word.text)?1:h*.15;
    let anchor=collectInk(gray,w,h,threshold,light,null,minimumHeight);
    // A gray selection can have a darker outline than its lettering. If all
    // preferred-polarity components are borders, try actual opposite ink once.
    if(!anchor.valid){
      const alternate=light?background-low:high-background;
      if(alternate>=30){
        const value=background+(light?-1:1)*alternate*.5;
        const other=collectInk(gray,w,h,value,!light,null,minimumHeight);
        if(other.valid){anchor=other;threshold=value;light=!light;}
      }
    }
    // An entirely unaligned timestamp has no established word ink to extend.
    if(!anchor.valid)return word;
    // Finish only connected glyph components crossing the timestamp edge.
    // Projection columns can overlap between kerned letters without touching.
    const oldLeft = left, oldRight = right;
    const inkRun = (edge, minimum, maximum) => {
      const span=maximum-minimum;
      if(span<1||span*h>262144)return null;
      const values=new Uint8Array(span*h);
      for(let y=0;y<h;y++)for(let x=0;x<span;x++){
        const p=((top+y)*width+minimum+x)*4;
        values[y*span+x]=Math.round((data[p]*77+data[p+1]*150+data[p+2]*29)/256);
      }
      const result=collectInk(values,span,h,threshold,light,edge-minimum,minimumHeight);
      return result.valid?{left:minimum+result.x0-1,right:minimum+result.x1+1,center:minimum+(result.x0+result.x1)/2}:null;
    };
    const first = inkRun(left,
      Math.max(minimumLeft, Math.floor(left - margin), previous ? Math.ceil((previous.x0 + previous.x1) / 2) : minimumLeft),
      Math.min(maximumRight, Math.ceil((box.x0 + box.x1) / 2)));
    const firstGap=first?Math.max(0,oldLeft+anchor.x0-(first.right-1)):-1;
    // Rasterizing two adjacent components may change their gap by one column.
    // A cut initial component may itself overlap this word's real CTC span.
    // A preceding control entirely outside that span still needs a glyph gap.
    if (first && firstGap>=0 && (firstGap<=anchor.maximumGap+1||first.right-1>box.x0)
      && (!previous || first.center >= (previous.x1 + box.x0) / 2)) left = first.left;
    const last = inkRun(right - 1,
      Math.max(minimumLeft, Math.floor((box.x0 + box.x1) / 2)),
      Math.min(maximumRight, Math.ceil(right + margin), next ? Math.floor((next.x0 + next.x1) / 2) : maximumRight));
    const lastGap=last?Math.max(0,last.left+1-(oldLeft+anchor.x1)):-1;
    if (last && lastGap>=0 && lastGap<=anchor.maximumGap+1
      && (!next || last.center <= (box.x1 + next.x0) / 2)) right = last.right;
    if (left !== oldLeft || right !== oldRight) {
      w = right - left; count = w * h;
      if (count > 262144) return word;
      gray = new Uint8Array(count);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = ((y + top) * width + x + left) * 4;
        gray[y * w + x] = Math.round((data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) / 256);
      }
    }
    const result=left===oldLeft&&right===oldRight?anchor:collectInk(gray,w,h,threshold,light,null,minimumHeight);
    if(!result.valid)return word;
    const {x0,y0,x1,y1}=result;
    return { ...word, bbox: { x0: Math.max(left, left + x0 - 1), y0: Math.max(top, top + y0 - 1),
      x1: Math.min(right, left + x1 + 1), y1: Math.min(bottom, top + y1 + 1) } };
  });
}

export function refinePdfOcrWordBounds(words, image, border = 10, frame = null) {
  if(frame!==null&&(!Number.isInteger(frame.top)||!Number.isInteger(frame.bottom)
    ||frame.top<0||frame.bottom>image.height||frame.bottom<=frame.top
    ||!Number.isFinite(frame.stepWidth)||frame.stepWidth<=0
    ||(frame.left!==undefined||frame.right!==undefined)&&(!Number.isInteger(frame.left)||!Number.isInteger(frame.right)
      ||frame.left<0||frame.right>image.width||frame.right<=frame.left)))throw new Error('Invalid OCR source word frame');
  const first=refineWordPass(words,image,border,frame);
  if(!frame)return first;
  const deltas=first.flatMap((word,i)=>word!==words[i]&&Array.from(word.text).length>=2
    ?[(word.bbox.x0+word.bbox.x1-words[i].bbox.x0-words[i].bbox.x1)/2]:[]).sort((a,b)=>a-b);
  if(deltas.length<3)return first;
  const center=Math.floor(deltas.length/2),offset=deltas.length%2?deltas[center]:(deltas[center-1]+deltas[center])/2;
  // A line's actual pixel anchors may expose the CTC time-bin delay. Never
  // move the search farther than one bin or return a shifted estimate as ink.
  if(!offset||Math.abs(offset)>frame.stepWidth)return first;
  const shifted=words.map(word=>({...word,bbox:{...word.bbox,x0:word.bbox.x0+offset,x1:word.bbox.x1+offset}}));
  const second=refineWordPass(shifted,image,border,frame);
  return second.map((word,i)=>{
    if(word===shifted[i])return first[i];
    const before=first[i].bbox,after=word.bbox;
    // An aligned search can recover missing source ink; it cannot discard
    // components that the first pass already established for this word.
    return first[i]===words[i]||(after.x0<=before.x0&&after.x1>=before.x1
      &&after.y0<=before.y0&&after.y1>=before.y1)?word:first[i];
  });
}
