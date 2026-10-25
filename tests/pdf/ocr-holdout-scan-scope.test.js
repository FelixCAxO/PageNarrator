import{expect,it}from'vitest';
import{scoreOcrHoldoutScan}from'../../scripts/lib/ocr-holdout-scan-scope.mjs';

const words=[{text:'Untranscribed',bbox:{x0:10,y0:10,x1:30,y1:20}},
  {text:'map-label',bbox:{x0:40,y0:10,x1:60,y1:20}},
  {text:'Complete',bbox:{x0:10,y0:60,x1:30,y1:70}},
  {text:'caption.',bbox:{x0:40,y0:60,x1:60,y1:70}}];
const scope={primaryTextMetric:'source-covered-caption-and-prose-region',rect:[0,.5,1,.5]};
it('scores the frozen source rectangle against the entire unchanged reference while preserving raw full-page failure',()=>{
  const result=scoreOcrHoldoutScan('Complete caption.','Untranscribed map-label Complete caption.',words,100,100,scope);
  expect(result.scores).toHaveLength(1);
  expect(result.scores[0].recognized).toBe('Complete caption.');
  expect(result.scores[0].word.errors).toBe(0);expect(result.scores[0].character.errors).toBe(0);
  expect(result.rawFullPageDiagnostic.reference).toBe('Complete caption.');
  expect(result.rawFullPageDiagnostic.word.errors).toBeGreaterThan(0);
  expect(result.rawFullPageDiagnostic.excludedFromPrimaryAggregate).toBe(true);
});
it('counts missing region text without dropping or rewriting published words',()=>{
  const result=scoreOcrHoldoutScan('Complete caption.','Untranscribed map-label Complete',words.slice(0,3),100,100,scope);
  expect(result.scores[0].word.errors).toBe(1);expect(result.scores[0].reference).toBe('Complete caption.');
});
it('preserves the original whole-page scoring when no supplement applies',()=>{
  const result=scoreOcrHoldoutScan('Complete caption.','Untranscribed map-label Complete caption.',words,100,100);
  expect(result.scores[0].recognized).toBe('Untranscribed map-label Complete caption.');
  expect(result.scores[0].word.errors).toBeGreaterThan(0);expect(result.rawFullPageDiagnostic).toBeUndefined();
});
it.each([{primaryTextMetric:'output-selected-crop'}, {...scope,rect:[0,0,2,1]}])('rejects unsupported or unsafe annotation scopes',bad=>{
  expect(()=>scoreOcrHoldoutScan('Complete caption.','Complete caption.',words,100,100,bad)).toThrow();
});
