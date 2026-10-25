// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import{scoreOcrHoldout,textInOcrHoldoutRegion}from'./ocr-holdout-score.mjs';

export function scoreOcrHoldoutScan(reference,text,words,width,height,scope=null){
  if(scope&&scope.primaryTextMetric!=='whole-page-unchanged-publishedGT'
    &&scope.primaryTextMetric!=='source-covered-caption-and-prose-region')throw new Error('Unknown frozen scan text scope.');
  if(scope?.primaryTextMetric==='source-covered-caption-and-prose-region'){
    const recognized=textInOcrHoldoutRegion(words,scope,width,height);
    return{scores:[{scope:scope.primaryTextMetric,reference,recognized,...scoreOcrHoldout(reference,recognized)}],
      rawFullPageDiagnostic:{status:'known-incomplete-published-reference',excludedFromPrimaryAggregate:true,
        reference,recognized:text,...scoreOcrHoldout(reference,text)}};
  }
  return{scores:[{reference,recognized:text,...scoreOcrHoldout(reference,text)}]};
}
