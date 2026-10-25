// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {refinePdfOcrWordBounds as refine} from '../.cache/ocr-contrast-baseline/word-anchor-prototype.js';

const input=JSON.parse(await readFile('artifacts/engines/ocr-contrast-crops.json','utf8'));
const directory='artifacts/engines/ocr-contrast-crop-audit';await mkdir(directory,{recursive:true});
const report={scope:'Offline source-pixel and CTC replay only; no new inference or acceptance',changes:[],cases:[]};
for(const fixed of input.cases)for(const capture of fixed.diagnostics.filter(d=>d.kind==='ctc-crop')){
  const {sourceWidth:width,sourceHeight:height,timedWords:words}=capture,data=Uint8ClampedArray.from(capture.pixels);
  const replay=refine(words,{data,width,height});
  for(let i=0;i<words.length;i++)if(JSON.stringify(replay[i].bbox)!==JSON.stringify(capture.words[i].bbox))report.changes.push({name:fixed.name,text:words[i].text,before:capture.words[i].bbox,after:replay[i].bbox});
  for(const [index,word]of words.entries()){
    if(!['Order','all','Release','row','saved','transcript,','voice','highlights','The','This','WebAssembly.'].includes(word.text))continue;
    if(word.text==='row'&&!fixed.name.startsWith('control-'))continue;
    const box=word.bbox,previous=words[index-1]?.bbox,next=words[index+1]?.bbox,margin=(box.y1-box.y0)*.5;
    const left=Math.max(10,Math.floor(previous?(previous.x1+box.x0)/2:box.x0-margin));
    const maximumRight=box.x1>width-10?width:width-10;
    const right=Math.min(maximumRight,Math.ceil(next?(box.x1+next.x0)/2:box.x1+margin));
    const top=10,bottom=height-10,h=bottom-top,w=right-left,histogram=new Uint32Array(256);let low=255,high=0;
    const gray=(x,y)=>Math.round((data[(y*width+x)*4]*77+data[(y*width+x)*4+1]*150+data[(y*width+x)*4+2]*29)/256);
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const v=gray(x,y);histogram[v]++;low=Math.min(low,v);high=Math.max(high,v);}
    let background=0,cumulative=0;for(;background<255;background++){cumulative+=histogram[background];if(cumulative>=w*h/2)break;}
    const light=high-background>background-low,contrast=light?high-background:background-low,threshold=background+(light?1:-1)*contrast*.5;
    const ink=(x,y)=>light?gray(x,y)>threshold:gray(x,y)<threshold;
    const columns=[];for(let x=10;x<width-10;x++){let count=0;for(let y=top;y<bottom;y++)if(ink(x,y))count++;columns.push({x,count});}
    const runs=[];for(const {x,count}of columns){if(!count)continue;let run=runs.at(-1);if(!run||run.right!==x){run={left:x,right:x,ink:0};runs.push(run);}run.right=x+1;run.ink+=count;}
    const seen=new Uint8Array(w*h),components=[];
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
      const at=(y-top)*w+x-left;if(seen[at]||!ink(x,y))continue;
      const queue=[[x,y]];seen[at]=1;let x0=x,y0=y,x1=x+1,y1=y+1,edge=false;
      for(let q=0;q<queue.length;q++){
        const [px,py]=queue[q];x0=Math.min(x0,px);y0=Math.min(y0,py);x1=Math.max(x1,px+1);y1=Math.max(y1,py+1);
        if(px===left||px===right-1||py===top||py===bottom-1)edge=true;
        for(const[nx,ny]of[[px-1,py],[px+1,py],[px,py-1],[px,py+1]])if(nx>=left&&nx<right&&ny>=top&&ny<bottom){const p=(ny-top)*w+nx-left;if(!seen[p]&&ink(nx,ny)){seen[p]=1;queue.push([nx,ny]);}}
      }
      components.push({x0,y0,x1,y1,pixels:queue.length,edge});
    }
    const keep=components.filter(c=>!c.edge),anchor={left:Math.min(...keep.map(c=>c.x0)),right:Math.max(...keep.map(c=>c.x1))};
    const anchorRuns=runs.map(r=>({left:Math.max(r.left,anchor.left),right:Math.min(r.right,anchor.right)})).filter(r=>r.left<r.right);
    const gaps=anchorRuns.slice(1).map((r,i)=>r.left-anchorRuns[i].right),maximumGap=Math.max(1,...gaps);
    const stem=`${fixed.name.replace(/[^a-z0-9-]/gi,'-')}-${word.text.replace(/[^a-z]/gi,'')}`;
    await sharp(Buffer.from(data),{raw:{width,height,channels:4}}).png().toFile(`${directory}/${stem}.png`);
    report.cases.push({name:fixed.name,text:word.text,size:[width,height],timed:box,window:{left,top,right,bottom},previous,next,background,light,threshold,components,anchor,gaps,maximumGap,runs,before:capture.words[index].bbox,after:replay[index].bbox,image:`${directory}/${stem}.png`});
  }
}
await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({scope:report.scope,changes:report.changes,cases:report.cases.map(c=>({name:c.name,text:c.text,window:c.window,anchor:c.anchor,gaps:c.gaps,threshold:c.threshold,light:c.light,runs:c.runs.filter(r=>r.right>=c.before.x0-32&&r.left<c.before.x0+10)}))},null,2));
