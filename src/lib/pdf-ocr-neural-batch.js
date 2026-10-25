import { decodePdfOcrCtcLabels } from './pdf-ocr-ctc.js';
import { initializeNativeKernels, packRgba } from './native-kernels.js';
import { refinePdfOcrWordBounds } from './pdf-ocr-word-bounds.js';
import { createPdfOcrCanvas } from './pdf-ocr-canvas.js';

export async function recognizePdfOcrNeuralLines(sources, ort, session, alphabet, sourceExtents = null) {
  if (!sources.length || sources.length > 2) throw new Error('Invalid OCR batch size');
  if (typeof session.recognizeLines === 'function') return session.recognizeLines(sources);
  if (sourceExtents !== null && (!Array.isArray(sourceExtents) || sourceExtents.length !== sources.length
    || sourceExtents.some((extent, i) => !extent || !Number.isFinite(extent.left) || !Number.isFinite(extent.right)
      || extent.left < 0 || extent.right > sources[i].width || extent.right <= extent.left))) throw new Error('Invalid OCR source extent');
  if(sourceExtents?.some((extent,i)=>(extent.wordTop!==undefined||extent.wordBottom!==undefined)
    &&(!Number.isInteger(extent.wordTop)||!Number.isInteger(extent.wordBottom)||extent.wordTop<0
      ||extent.wordBottom>sources[i].height||extent.wordBottom<=extent.wordTop)))throw new Error('Invalid OCR source word frame');
  const geometry = sources.map(source => {
    const width = source.width - 20, height = source.height - 20;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid OCR line crop');
    return { width, height, outputWidth: Math.max(1, Math.ceil(width * 48 / height)) };
  });
  const inputWidth = Math.max(320, ...geometry.map(g => Math.ceil(g.outputWidth / 128) * 128));
  if (inputWidth > 8192) throw new Error('OCR line exceeds batch width limit');
  await initializeNativeKernels();
  const stride = 3 * 48 * inputWidth, input = new Float32Array(stride * sources.length);
  for (let index = 0; index < sources.length; index++) {
    const { width, height, outputWidth } = geometry[index];
    const canvas = createPdfOcrCanvas(outputWidth, 48);
    try {
      const context = canvas.getContext('2d');
      context.drawImage(sources[index], 10, 10, width, height, 0, 0, outputWidth, 48);
      const pixels = context.getImageData(0, 0, outputWidth, 48).data;
      packRgba(pixels, outputWidth, 48, 'signed', inputWidth, input, index * stride);
    } finally { canvas.width = canvas.height = 0; }
  }
  const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [sources.length, 3, 48, inputWidth]) });
  const labels = output.ocr_labels.data, scores = output.ocr_scores.data;
  const steps = labels.length / sources.length;
  if (!Number.isInteger(steps) || steps < 1 || scores.length !== labels.length
    || output.ocr_labels.dims?.join(',') !== `${sources.length},${steps}`
    || output.ocr_scores.dims?.join(',') !== `${sources.length},${steps}`) throw new Error('Invalid OCR batch output');
  const spaces=output.ocr_spaces,spaceIndex=alphabet.indexOf(' ');
  if(spaceIndex<1 || spaces?.dims?.join(',')!==`${sources.length},${steps}`
    || spaces.data?.length!==labels.length)throw new Error('Invalid OCR space output');
  for(const probability of spaces.data)if(!Number.isFinite(probability)||probability<0||probability>1)
    throw new Error('Invalid OCR space probability');
  // Development-tested space recovery only; never replace a recognized letter.
  for(let i=0;i<labels.length;i++)if(Number(labels[i])===0 && spaces.data[i]>=.25){
    labels[i]=typeof labels[i]==='bigint'?BigInt(spaceIndex):spaceIndex;
    scores[i]=spaces.data[i];
  }
  return geometry.map(({width, height}, index) => {
    const timedWords = decodePdfOcrCtcLabels(labels.subarray(index * steps, (index + 1) * steps), scores.subarray(index * steps, (index + 1) * steps), alphabet,
      { left: 10, top: 10, height, inputWidth, width, sourceLeft: sourceExtents?.[index].left ?? 0,
        sourceRight: sourceExtents?.[index].right ?? sources[index].width });
    const source = sources[index];
    const extent=sourceExtents?.[index],frame=extent?.wordTop===undefined?null:
      {top:extent.wordTop,bottom:extent.wordBottom,left:Math.ceil(extent.left),right:Math.floor(extent.right),
        stepWidth:inputWidth*height/(steps*48)};
    const words = refinePdfOcrWordBounds(timedWords, source.getContext('2d').getImageData(0, 0, source.width, source.height),10,frame);
    return { blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 10, y0: 10, x1: width + 10, y1: height + 10 }, words }] }] }] };
  });
}
