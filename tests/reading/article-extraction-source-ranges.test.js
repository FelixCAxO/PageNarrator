import { chooseArticleExtraction, iterateArticleSpeechChunks } from '../../src/lib/article-extraction.js';
import { JSDOM } from 'jsdom';
import { afterEach,expect,it,vi } from 'vitest';
import { isArticleDocument,parseArticleDocument } from '../../src/engines/article-extractor.js';
import { createPageHighlighter } from '../../src/lib/page-highlighter.js';
import { getDomWordIndexForSpeechWord } from '../../src/lib/reading-model.js';
// Original synthetic DOM controls; these are not real-article quality evidence.
const controls={
  "schema": "article-source-range-authored-controls-v1",
  "scope": "Ten original DOM miniatures with text, source anchor and word position authored before any product execution. Synthetic development controls, not held-out articles.",
  "fallbackTail": "The second observation explains the complete source record in ordinary prose.",
  "cases": [
    {
      "id": "separate-curly-apostrophe",
      "mode": "fallback",
      "markup": "<div id=\"target\">O<span>’</span>Neill records each sample before the final analysis begins.</div>",
      "expected": "O’Neill records each sample before the final analysis begins.",
      "wordIndex": 1,
      "word": "records"
    },
    {
      "id": "separate-compound-hyphen",
      "mode": "fallback",
      "markup": "<div id=\"target\">The source<span>-</span>bound record explains each sample before the final analysis begins.</div>",
      "expected": "The source-bound record explains each sample before the final analysis begins.",
      "word": "record"
    },
    {
      "id": "separate-parentheses",
      "mode": "fallback",
      "markup": "<div id=\"target\">The <span>(</span>archived<span>)</span> sample explains the complete source record before analysis begins.</div>",
      "expected": "The (archived) sample explains the complete source record before analysis begins.",
      "wordIndex": 2,
      "word": "sample"
    },
    {
      "id": "separate-comma",
      "mode": "fallback",
      "markup": "<div id=\"target\">The first<span>,</span> second and third observations remain in the complete source record.</div>",
      "expected": "The first, second and third observations remain in the complete source record.",
      "wordIndex": 2,
      "word": "second"
    },
    {
      "id": "excluded-hidden-punctuation",
      "mode": "fallback",
      "markup": "<div id=\"target\">The micro<span hidden>’</span><strong>scope</strong> records each sample before the final analysis begins.</div>",
      "expected": "The microscope records each sample before the final analysis begins.",
      "wordIndex": 2,
      "word": "records"
    },
    {
      "id": "selection-after-joined-word",
      "mode": "selection",
      "markup": "<p id=\"target\">The micro<strong>scope</strong> records each sample before the final analysis begins.</p>",
      "selected": "records each sample before the final analysis begins.",
      "expected": "records each sample before the final analysis begins.",
      "domWordOffset": 2,
      "word": "records"
    },
    {
      "id": "selection-after-hidden-words",
      "mode": "selection",
      "markup": "<p id=\"target\">Earlier <span hidden>discarded hidden words</span>context records each sample before the final analysis begins.</p>",
      "selected": "records each sample before the final analysis begins.",
      "expected": "records each sample before the final analysis begins.",
      "domWordOffset": 2,
      "word": "records"
    },
    {
      "id": "selection-after-reference-marker",
      "mode": "selection",
      "markup": "<p id=\"target\">Earlier<sup class=\"reference\">7</sup> context records each sample before the final analysis begins.</p>",
      "selected": "records each sample before the final analysis begins.",
      "expected": "records each sample before the final analysis begins.",
      "domWordOffset": 2,
      "word": "records"
    },
    {
      "id": "selection-after-real-separator",
      "mode": "selection",
      "markup": "<p id=\"target\">The <em>first</em> <strong>second</strong> records each sample before the final analysis begins.</p>",
      "selected": "records each sample before the final analysis begins.",
      "expected": "records each sample before the final analysis begins.",
      "domWordOffset": 3,
      "word": "records"
    },
    {
      "id": "selection-after-explicit-break",
      "mode": "selection",
      "markup": "<p id=\"target\">Earlier observations<br>records each sample before the final analysis begins.</p>",
      "selected": "records each sample before the final analysis begins.",
      "expected": "records each sample before the final analysis begins.",
      "domWordOffset": 2,
      "word": "records"
    }
  ]
};

const opened=[];
afterEach(()=>{for(const w of opened.splice(0))w.close();vi.unstubAllGlobals();});
for(const c of controls.cases)it(c.id,async()=>{
 const dom=new JSDOM(`<title>Source notes</title><article>${c.markup}${c.mode==='fallback'?'<div>'+controls.fallbackTail+'</div>':''}</article>`,{url:'https://example.test/source-notes',pretendToBeVisual:true});opened.push(dom.window);dom.window.scrollBy=()=>{};
 const document=dom.window.document,element=document.querySelector('#target'),sourceNodes=[];
 const walker=document.createTreeWalker(element,dom.window.NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode())sourceNodes.push({node:n,value:n.nodeValue});
 if(c.mode==='selection'){
  const start=sourceNodes.find(x=>x.value.includes(c.selected));expect(start).toBeTruthy();const range=document.createRange(),offset=start.value.indexOf(c.selected);range.setStart(start.node,offset);range.setEnd(start.node,offset+c.selected.length);dom.window.getSelection=()=>({toString:()=>range.toString(),rangeCount:1,getRangeAt:()=>range});
 }
 const article=chooseArticleExtraction(document,{startMode:'top',readSelection:c.mode==='selection',articleFallback:{isArticleDocument,parse:parseArticleDocument}}),chunks=[];
 for await(const chunk of iterateArticleSpeechChunks(article,{maxLen:10000}))chunks.push(typeof chunk==='string'?{speech:chunk}:chunk);
 const own=chunks.find(x=>x.anchorId&&document.querySelector(`[data-pagenarrator-id="${x.anchorId}"]`)===element);
 const highlights=new Map();vi.stubGlobal('CSS',{highlights});vi.stubGlobal('Highlight',class{constructor(...ranges){this.ranges=ranges;}});const highlighter=createPageHighlighter(document);let grounding=null,wordResult=null,wordRange=null;
 try{if(own){grounding=highlighter.highlightChunkByAnchor(own.anchorId,own.anchorText,{chunkText:own.speech,domWordOffset:own.domWordOffset,reportGrounding:true});const index=c.mode==='selection'?getDomWordIndexForSpeechWord(own,0):c.wordIndex;if(Number.isInteger(index)){wordResult=highlighter.highlightWord(index);wordRange=highlights.get('pagenarrator-word-0')?.ranges?.[0];}}const row={id:c.id,source:article.source,text:article.text,chunks:chunks.map(x=>({speech:x.speech,anchorId:x.anchorId,domWordOffset:x.domWordOffset})),anchorMatches:!!own,grounding,wordResult,wordRange:wordRange?.toString()??null,sourceNodesPreserved:sourceNodes.every(x=>x.node.isConnected&&x.node.nodeValue===x.value)};
  expect(row.sourceNodesPreserved).toBe(true);expect(chunks.map(x=>x.speech)).toEqual(c.mode==='fallback'?[c.expected,controls.fallbackTail]:[c.expected]);expect(own).toBeTruthy();expect(own.speech).toBe(c.expected);expect(grounding).toEqual({ok:true,grounded:true,fallback:false});if(c.mode==='selection')expect(own.domWordOffset??0).toBe(c.domWordOffset);if(c.mode==='selection'||Number.isInteger(c.wordIndex))expect(wordRange?.toString()).toBe(c.word);
 }finally{highlighter.dispose();}
});

// Two prospectively frozen actual jsdom Selection/Range controls.
const additionalControls={
  "schema": "article-source-range-additional-controls-v2",
  "scope": "Two additional original DOM controls, prospectively authored within the authorized total of twelve. These use real jsdom Selection.addRange; their raw Selection and Range strings are recorded, not claimed to be a real browser user's visual selection behavior.",
  "cases": [
    {
      "id": "selection-spans-hidden-and-reference",
      "markup": "<p id=\"target\">Earlier context <em>records each </em><span hidden>hidden words</span><sup class=\"reference\">7</sup><strong>sample</strong> before review.</p>",
      "startSelector": "em",
      "expectedRaw": "records each hidden words7sample before review.",
      "expectedVisible": "records each sample before review.",
      "expectedDomWordOffset": 2,
      "speechWordIndex": 2,
      "word": "sample",
      "wordStartSelector": "strong",
      "wordStartOffset": 0,
      "wordEndSelector": "strong",
      "wordEndOffset": 6
    },
    {
      "id": "selection-spans-inline-word",
      "markup": "<p id=\"target\">Earlier context <em>records the micro</em><strong>scope</strong> sample before review.</p>",
      "startSelector": "em",
      "expectedRaw": "records the microscope sample before review.",
      "expectedVisible": "records the microscope sample before review.",
      "expectedDomWordOffset": 2,
      "speechWordIndex": 2,
      "word": "microscope",
      "wordStartSelector": "em",
      "wordStartOffset": 12,
      "wordEndSelector": "strong",
      "wordEndOffset": 5
    }
  ]
};
for(const c of additionalControls.cases)it(c.id,async()=>{
 const dom=new JSDOM(`<title>Selection notes</title><article>${c.markup}</article>`,{url:'https://example.test/selection-notes',pretendToBeVisual:true});opened.push(dom.window);dom.window.scrollBy=()=>{};
 const document=dom.window.document,element=document.querySelector('#target'),range=document.createRange();range.setStart(element.querySelector(c.startSelector).firstChild,0);range.setEnd(element.lastChild,element.lastChild.nodeValue.length);const selection=dom.window.getSelection();selection.removeAllRanges();selection.addRange(range);
 const rawSelection=selection.toString(),rawRange=range.toString(),source=[];const walker=document.createTreeWalker(element,dom.window.NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode())source.push({node:n,value:n.nodeValue});
 const article=chooseArticleExtraction(document,{readSelection:true,startMode:'top'}),chunks=[];for await(const chunk of iterateArticleSpeechChunks(article,{maxLen:10000}))chunks.push(chunk);const first=chunks[0];
 const highlights=new Map();vi.stubGlobal('CSS',{highlights});vi.stubGlobal('Highlight',class{constructor(...ranges){this.ranges=ranges;}});const highlighter=createPageHighlighter(document);let grounding,wordRange;
 try{if(first){grounding=highlighter.highlightChunkByAnchor(first.anchorId,first.anchorText,{chunkText:first.speech,domWordOffset:first.domWordOffset,reportGrounding:true});highlighter.highlightWord(getDomWordIndexForSpeechWord(first,c.speechWordIndex));wordRange=highlights.get('pagenarrator-word-0')?.ranges?.[0];}
  expect(rawSelection).toBe(c.expectedRaw);expect(rawRange).toBe(c.expectedRaw);expect(chunks.map(x=>x.speech)).toEqual([c.expectedVisible]);expect(article.text).toBe(c.expectedVisible);expect(article.startPosition.text).toBe(c.expectedVisible);expect(first.domWordOffset).toBe(c.expectedDomWordOffset);expect(document.querySelector(`[data-pagenarrator-id="${first.anchorId}"]`)).toBe(element);expect(grounding).toEqual({ok:true,grounded:true,fallback:false});expect(wordRange?.toString()).toBe(c.word);expect(wordRange.startContainer).toBe(element.querySelector(c.wordStartSelector).firstChild);expect(wordRange.startOffset).toBe(c.wordStartOffset);expect(wordRange.endContainer).toBe(element.querySelector(c.wordEndSelector).firstChild);expect(wordRange.endOffset).toBe(c.wordEndOffset);expect(source.every(x=>x.node.isConnected&&x.node.nodeValue===x.value)).toBe(true);
 }finally{highlighter.dispose();}
});
