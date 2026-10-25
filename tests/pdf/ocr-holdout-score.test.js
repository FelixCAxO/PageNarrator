import{expect,it}from'vitest';
import{ocrCharacterErrorRate,scoreOcrHoldout,textInOcrHoldoutRegion}from'../../scripts/lib/ocr-holdout-score.mjs';

it('uses the preregistered NFC/case/whitespace convention without removing punctuation',()=>{
  expect(ocrCharacterErrorRate('  Caf\u00e9,\nTEST! ','cafe\u0301, test!')).toEqual({errors:0,referenceCharacters:11,rate:0});
  expect(ocrCharacterErrorRate('one-two','one two').errors).toBe(1);
  expect(ocrCharacterErrorRate('reader’s','readers').errors).toBe(1);
});
it('retains split line-wrap tokens rather than correcting them from recognition',()=>{
  const result=scoreOcrHoldout('narration','narra-\ntion');
  expect(result.word.errors).toBe(2);expect(result.character.errors).toBe(2);
});
it('counts Unicode code points for character distance',()=>{
  expect(ocrCharacterErrorRate('A😀B','a😀c')).toEqual({errors:1,referenceCharacters:3,rate:1/3});
});
it('scores only fixed source regions by word center without cropping the input',()=>{
  const words=[{text:'inside',bbox:{x0:20,y0:30,x1:40,y1:50}},{text:'outside',bbox:{x0:70,y0:30,x1:90,y1:50}}];
  expect(textInOcrHoldoutRegion(words,{rect:[.1,.2,.4,.4]},100,100)).toBe('inside');
});
