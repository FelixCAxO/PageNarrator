import {expect,it} from 'vitest';
import {orderPdfOcrNearbyFragments} from '../../src/lib/pdf-ocr-lines.js';

const line=(text,x0,x1,y)=>({bbox:{x0,x1,y0:y,y1:y+10},words:[{text,bbox:{x0,x1,y0:y,y1:y+10}}]});
it('repairs a nearby continuation across another column without mutating words or unrelated order',()=>{
  const right=line('tent',19,40,10),other=line('another column',100,180,11),left=line('pa',0,20,12);
  const input=[right,other,left],snapshot=JSON.stringify(input);
  expect(orderPdfOcrNearbyFragments(input)).toEqual([left,right,other]);
  expect(orderPdfOcrNearbyFragments(input)[0]).toBe(left);
  expect(JSON.stringify(input)).toBe(snapshot);
});
it('leaves distant, vertically separate and ambiguous matches unchanged',()=>{
  const left=line('left',0,20,10),right=line('right',21,40,10);
  for(const input of [[line('distant',60,80,10),left],[line('other row',21,40,30),left],
    [right,line('also possible',22,40,10),left],
    [right,...Array.from({length:4},(_,i)=>line('other',100,130,100+i*20)),left]])
    expect(orderPdfOcrNearbyFragments(input)).toBe(input);
  const ambiguous=[line('right',19,40,10),line('also possible',19,50,10),left];
  expect(orderPdfOcrNearbyFragments(ambiguous)).toBe(ambiguous);
});
