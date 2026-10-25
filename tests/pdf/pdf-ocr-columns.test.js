import { expect, it } from 'vitest';
import { orderPdfOcrColumns } from '../../src/lib/pdf-ocr-lines.js';

it('orders consistent drifting columns without changing words and preserves ambiguous layouts', () => {
  const columns=Array.from({length:3},(_,column)=>Array.from({length:16},(_,row)=>{
    const x0=column*140+row*2,y0=row*20+column*3;
    const bbox={x0,y0,x1:x0+100,y1:y0+10};
    return {bbox,words:[{text:`${column}:${row}`,bbox}]};
  }));
  const input=columns.flat().sort((a,b)=>a.bbox.y0-b.bbox.y0);
  const before=[...input];
  expect(orderPdfOcrColumns(input)).toEqual(columns.flat());
  expect(input).toEqual(before);
  expect(orderPdfOcrColumns(input).every(line=>input.includes(line))).toBe(true);
  const table=input.map(line=>({...line,bbox:{...line.bbox,y0:Math.floor(line.bbox.y0/20)*20,y1:Math.floor(line.bbox.y0/20)*20+10}}));
  expect(orderPdfOcrColumns(table)).toBe(table);
  const spanning=[{bbox:{x0:0,y0:-30,x1:400,y1:-10},words:[]},...input];
  expect(orderPdfOcrColumns(spanning)).toBe(spanning);
  const partial=input.filter(line=>!(line.bbox.x0>280&&line.bbox.y0>200));
  expect(orderPdfOcrColumns(partial)).toBe(partial);
  expect(orderPdfOcrColumns(columns[0])).toBe(columns[0]);
});

it('orders touching reversed fragments only after establishing a single body column', () => {
  const line=(x0,y0,x1,y1,text)=>{const bbox={x0,y0,x1,y1};return {bbox,words:[{text,bbox}]};};
  const body=Array.from({length:32},(_,i)=>line(0,i*20,100,i*20+10,`line ${i}`));
  body[0]=line(0,0,20,10,'heading');
  const left=line(0,301,50,311,'start'),right=line(51,300,100,310,'end');
  body.splice(15,1,right,left);
  const expected=[...body];expected.splice(15,2,left,right);
  expect(orderPdfOcrColumns(body)).toEqual(expected);
  expect(body[15]).toBe(right);
});
