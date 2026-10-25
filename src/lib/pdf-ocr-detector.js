import {recognizePdfOcrNeuralLines} from './pdf-ocr-neural-batch.js';
import { mapPdfOcrShearedBox, mapPdfOcrShearedBaseline } from './pdf-ocr-grid.js';
import { initializeNativeKernels, packRgba, detectorComponents } from './native-kernels.js';
import { createPdfOcrCanvas as createCanvas } from './pdf-ocr-canvas.js';
// Only chooses the ordinary OCR path; an empty preview never suppresses OCR.
export function hasPdfOcrInteriorInk(data, left, right) {
  for (let y = 24; y < 216; y++) {
    for (let x = Math.ceil((left + 0.1 * (right - left)) * 240);
      x < Math.floor((right - 0.1 * (right - left)) * 240); x++) {
      if (data[(y * 240 + x) * 4] < 180) return true;
    }
  }
  return false;
}
export async function detectPdfOcrLines(image, ort, session, maximumSide = 640) {
await initializeNativeKernels();
const scale=Math.min(1,maximumSide/Math.max(image.width,image.height));
const width=Math.max(32,Math.round(image.width*scale/32)*32),height=Math.max(32,Math.round(image.height*scale/32)*32);
const canvas=createCanvas(width,height);
try {
const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,width,height);
const pixels=ctx.getImageData(0,0,width,height).data,data=packRgba(pixels,width,height,'detector');
const result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',data,[1,3,height,width])});
const out=result[session.outputNames[0]],dims=out?.dims;
if(dims?.length!==4||dims[0]!==1||dims[1]!==1
  ||!dims.every(d=>Number.isInteger(d)&&d>0)||dims[2]>height||dims[3]>width
  ||out.data?.length!==dims[2]*dims[3])throw new Error('Invalid detector shape');
const boxes=detectorComponents(out.data,dims[3],dims[2],image.width,image.height);

// ponytail: one bounded retry for sparse distant print; dense pages keep the fast path.
const heights=boxes.map(box=>(box.y1-box.y0)*scale).sort((a,b)=>a-b);
if(maximumSide===640&&boxes.length>0&&boxes.length<20&&heights[Math.floor(heights.length/2)]<=6
 &&Math.max(image.width,image.height)>640){
 const retry=await detectPdfOcrLines(image,ort,session,1280);
 if(retry.length>boxes.length)return Object.assign(retry.concat(boxes.filter(box=>{
  const x=(box.x0+box.x1)/2,y=(box.y0+box.y1)/2+box.slope*(x-box.x0);
  return !retry.some(next=>x>=next.x0&&x<=next.x1
    &&y>=next.y0+next.slope*(x-next.x0)&&y<=next.y1+next.slope*(x-next.x0));
 })),{highResolutionRetry:true});
}
return boxes;
} finally { canvas.width = canvas.height = 0; }
}
export async function recognizePdfOcrDetectedLines(image, ort, session, recognizer, alphabet, cancelled, boxes, verifyLine = null) {
boxes ||= await detectPdfOcrLines(image,ort,session);
boxes = splitPdfOcrTallComponents(image, boxes);
const results=[],deferred=[];
const project=(data,crop)=>{
 const {box,left,top}=crop,projection={left,top,originX:box.x0,slope:box.slope,sourceWidth:image.width,sourceHeight:image.height};
 const map=b=>mapPdfOcrShearedBox(b,projection),output=[];
 for(const line of data.blocks.flatMap(b=>b.paragraphs).flatMap(p=>p.lines)){
  const words=line.words.map(word=>({...word,bbox:map(word.bbox)})).filter(word=>word.bbox),bbox=map(line.bbox);if(!words.length||!bbox)continue;
  const{baseline,...rest}=line,mappedBaseline=baseline&&mapPdfOcrShearedBaseline(baseline,projection);output.push({...rest,bbox,words,...(mappedBaseline?{baseline:mappedBaseline}:{})});
 }return output;
};
try{
 for(let index=0;index<boxes.length;index+=2){
 const crops=[];
 try {
 for(const box of boxes.slice(index,index+2)){
  if (cancelled()) return null;
  const height=box.y1-box.y0,pad=Math.max(3,Math.ceil(height*.15));
  let left=Math.max(0,Math.floor(box.x0)-pad),top=Math.max(0,Math.floor(box.y0)-pad);
  const width=Math.min(image.width-left,Math.ceil(box.x1)+Math.max(pad,Math.ceil(height*.5))-left),h=Math.min(image.height-top,Math.ceil(box.y1)+pad-top);
  let canvas=createCanvas(width+20,h+20);
  const crop={canvas,box,left,top};crops.push(crop);
  const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.setTransform(1,-box.slope,0,1,10-left,10-top+box.slope*box.x0);ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),core={top:10+box.y0-top,bottom:10+box.y1-top};
  const expansion=pdfOcrRecognitionExpansion(pixels,core),foreground=pdfOcrCropExpansion(pixels,core);
  if(expansion.some(Boolean)){
    const [l,t,r,b]=expansion, expanded=createCanvas(canvas.width+l+r,canvas.height+t+b);
    const target=expanded.getContext('2d');target.fillStyle='white';target.fillRect(0,0,expanded.width,expanded.height);
    // The new context must sample original pixels; copying the old raster adds
    // synthetic white padding where the clipped glyph still needs source ink.
    left-=l;top-=t;target.setTransform(1,-box.slope,0,1,10-left,10-top+box.slope*box.x0);
    target.drawImage(image,0,0);canvas.width=canvas.height=0;canvas=expanded;
  }
  Object.assign(crop,{canvas,left,top,sourceExtent:{left:Math.max(0,10-left),right:Math.min(canvas.width,image.width+10-left),
    wordTop:Math.max(0,10+expansion[1]-foreground[1]),wordBottom:Math.min(canvas.height,canvas.height-10-expansion[3]+foreground[3])}});
 }
 const batch=await recognizePdfOcrNeuralLines(crops.map(c=>c.canvas),ort,recognizer,alphabet,crops.map(c=>c.sourceExtent));
 for(let i=0;i<crops.length;i++){
  if(cancelled())return null;
  const crop=crops[i],primary=batch[i],uncertain=verifyLine?.uncertainCandidate?.(crop.canvas,primary)||false;
   const candidate=uncertain||(deferred.length<4&&verifyLine?.spacingCandidate?await verifyLine.spacingCandidate(crop.canvas,primary):null);
  if(cancelled())return null;
  const data=verifyLine?await verifyLine(crop.canvas,primary):primary;
  if(cancelled())return null;
  const group=results.length;results.push(project(data,crop));
  if(candidate){
    // Retain at most four descriptors; late letter uncertainty displaces spacing,
    // while all immediate legacy slash checks keep first use of the model budget.
    if(uncertain&&deferred.length===4){const discard=deferred.map(value=>value.uncertain).lastIndexOf(false);if(discard>=0)deferred.splice(discard,1);}
    if(deferred.length<4)deferred.push({width:crop.canvas.width,height:crop.canvas.height,left:crop.left,top:crop.top,box:{...crop.box},primary,group,candidate,uncertain});
   }
 }

 }finally{for(const {canvas} of crops)canvas.width=canvas.height=0;}
 }

 for(const retained of [...deferred.filter(value=>value.uncertain),...deferred.filter(value=>!value.uncertain)]){
  if(cancelled())return null;let canvas;
  if(verifyLine.spacingRemaining&&!verifyLine.spacingRemaining())break;
  try{
   const{width,height,left,top,box,primary,group,candidate,uncertain}=retained;
   canvas=createCanvas(width,height);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,width,height);
   ctx.setTransform(1,-box.slope,0,1,10-left,10-top+box.slope*box.x0);ctx.drawImage(image,0,0);
   if(cancelled())return null;
   const data=await (uncertain?verifyLine.verifyUncertain(canvas,primary,
     {left,top,originX:box.x0,slope:box.slope,sourceWidth:image.width,sourceHeight:image.height}):verifyLine.verifySpacing(canvas,primary,candidate));
   if(cancelled())return null;
   if(data!==primary)results[group]=project(data,retained);
  }finally{if(canvas)canvas.width=canvas.height=0;}
 }
 return results.flat();
}finally{deferred.length=0;}
}

// Preserve the established model input/context. Foreground ownership below is
// independent, so highlight repair cannot change recognized printed characters.
export function pdfOcrRecognitionExpansion({data,width,height},core={top:10,bottom:height-10}) {
  return expandPdfOcrEdges({width,height},core,(x,y)=>Math.min(data[(y*width+x)*4],data[(y*width+x)*4+1],data[(y*width+x)*4+2])<160);
}

// Find visible glyph context without treating a gray/dark background as ink.
export function pdfOcrCropExpansion({data,width,height}, core = {top:10,bottom:height-10}) {
  const gray=(x,y)=>Math.round((data[(y*width+x)*4]*77+data[(y*width+x)*4+1]*150+data[(y*width+x)*4+2]*29)/256);
  const histogram=new Uint32Array(256);let low=255,high=0,count=0;
  for(let y=10;y<height-10;y++)for(let x=10;x<width-10;x++){const value=gray(x,y);histogram[value]++;low=Math.min(low,value);high=Math.max(high,value);count++;}
  let background=0,total=0;for(;background<255;background++){total+=histogram[background];if(total>=count/2)break;}
  const light=high-background>background-low,contrast=light?high-background:background-low;
  if(!count||contrast<30)return[0,0,0,0];
  const threshold=background+(light?1:-1)*contrast*.5;
  const ink=(x,y)=>light?gray(x,y)>threshold:gray(x,y)<threshold;
  return expandPdfOcrEdges({width,height},core,ink);
}

function expandPdfOcrEdges({width,height},core,ink) {
  const column=x=>{for(let y=10;y<height-10;y++)if(ink(x,y))return true;return false;};
  const row=y=>{for(let x=10;x<width-10;x++)if(ink(x,y))return true;return false;};
  const separated=(edge,target)=>{
    let blank=0;const step=edge<=target?1:-1;
    for(let y=edge;step>0?y<=target:y>=target;y+=step){
      blank=row(y)?0:blank+1;if(blank>=2)return true;
    }
    return false;
  };
  let l=0,t=0,r=0,b=0;
  while(l<10&&column(10-l))l++;
  // A neighboring row can graze the crop edge. Blank source rows separating it
  // from the detector core prevent that unrelated ink from enlarging this line.
  if(!separated(10,Math.min(height-11,Math.max(10,Math.floor(core.top)))))while(t<10&&row(10-t))t++;
  while(r<10&&column(width-11+r))r++;
  if(!separated(height-11,Math.max(10,Math.min(height-11,Math.ceil(core.bottom)-1))))while(b<10&&row(height-11+b))b++;
  return [l,t,r,b];
}


// ponytail: only repeated horizontal gaps; curved or vertical writing needs a layout model.
export function splitPdfOcrTallComponents(image, boxes) {
boxes = boxes.flatMap(box => {
 const width=box.x1-box.x0;
 if(box.y1-box.y0<width*2) return [box];
 const x=Math.max(0,Math.floor(box.x0)-2), right=Math.min(image.width,Math.ceil(box.x1)+2);
 const top=Math.max(0,Math.floor(Math.min(box.y0,box.y0+box.slope*width))), bottom=Math.min(image.height,Math.ceil(Math.max(box.y1,box.y1+box.slope*width)));
 const data=image.getContext('2d').getImageData(x,top,right-x,bottom-top).data, mins=[];
 for(let y=0;y<bottom-top;y++){let min=255;for(let c=0;c<right-x;c++){const i=(y*(right-x)+c)*4;min=Math.min(min,(data[i]+data[i+1]+data[i+2])/3);}mins.push(min);}
 const low=Math.min(...mins),high=Math.max(...mins);if(high-low<30)return [box];
 const threshold=low+(high-low)*.75, runs=[];let start=-1,blank=0;
 for(let y=0;y<=mins.length;y++){
  if(y<mins.length&&mins[y]<threshold){if(start<0)start=y;blank=0;}
  else if(start>=0&&++blank>=2){runs.push([start,y-blank+1]);start=-1;}
 }
 if(start>=0)runs.push([start,mins.length]);
 if(runs.length<3||runs.some(([a,b])=>b-a<width*.3||b-a>width*1.5))return [box];
 return runs.map(([a,b])=>({...box,x0:x,x1:right,y0:top+a,y1:top+b,slope:0}));
});
return orderPdfOcrBoxes(boxes);
}

// Subpixel inference noise must not change the order or pairing of a row's crops.
// Anchor each row once instead of using a non-transitive tolerance comparator.
export function orderPdfOcrBoxes(boxes) {
 const sorted=[...boxes].sort((a,b)=>a.y0-b.y0||a.x0-b.x0), ordered=[];
 const height=box=>Number.isFinite(box.y1-box.y0)?Math.max(0,box.y1-box.y0):0;
 for(let i=0;i<sorted.length;){
  const top=sorted[i].y0;let end=i+1;
  while(end<sorted.length&&sorted[end].y0-top<=Math.max(.5,Math.min(height(sorted[i]),height(sorted[end]))*.2))end++;
  for(const box of sorted.slice(i,end).sort((a,b)=>a.x0-b.x0||a.y0-b.y0))ordered.push(box);
  i=end;
 }
 return ordered;
}
