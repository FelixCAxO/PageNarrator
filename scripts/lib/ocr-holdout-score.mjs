// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{ocrWordErrorRate,isOcrWordInRegion}from'../../tests/helpers/ocr-word-error-rate.js';

export function ocrCharacterErrorRate(reference,recognized){
  const normalize=text=>Array.from(text.normalize('NFC').toLowerCase().replace(/\s+/g,' ').trim());
  const expected=normalize(reference),actual=normalize(recognized);let previous=Uint32Array.from({length:actual.length+1},(_,i)=>i);
  for(let i=0;i<expected.length;i++){const next=new Uint32Array(actual.length+1);next[0]=i+1;
    for(let j=0;j<actual.length;j++)next[j+1]=Math.min(next[j]+1,previous[j+1]+1,previous[j]+Number(expected[i]!==actual[j]));previous=next;}
  return{errors:previous[actual.length],referenceCharacters:expected.length,rate:previous[actual.length]/Math.max(1,expected.length)};
}
export function scoreOcrHoldout(reference,recognized){return{word:ocrWordErrorRate(reference,recognized),character:ocrCharacterErrorRate(reference,recognized)};}
export function holdoutWordsFromPdf(entry){return entry.items.map(item=>({text:item.str,bbox:{x0:item.transform[4]*3,y0:(item.transform[5]-item.height)*3,
  x1:(item.transform[4]+item.width)*3,y1:item.transform[5]*3}}));}
export function textInOcrHoldoutRegion(words,region,width,height){return words.filter(word=>isOcrWordInRegion({x:(word.bbox.x0+word.bbox.x1)/(2*width),
  y:(word.bbox.y0+word.bbox.y1)/(2*height)},region)).map(word=>word.text).join(' ');}
