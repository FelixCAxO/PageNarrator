export const DARK_CODE_BLOCK_ATTRIBUTE = 'data-pagenarrator-dark-code-block';
export const PDF_TEXT_LAYER_ORDER_ATTRIBUTE = 'data-pagenarrator-pdf-order';
export const PDF_TEXT_LAYER_NARRATION_ORDER_ATTRIBUTE = 'data-pagenarrator-pdf-narration-order';
export const PDF_TEXT_LAYER_TEXT_ATTRIBUTE = 'data-pagenarrator-pdf-text';
export const PDF_TEXT_LAYER_NARRATED_ATTRIBUTE = 'data-pagenarrator-pdf-narrated';

export function getPdfTextNodeOrder(node, sourceOrder = false) {
  const element = node.parentElement?.closest?.(`[${PDF_TEXT_LAYER_ORDER_ATTRIBUTE}]`);
  // Selection offsets count all source words; narration can reorder/filter them.
  const narrationOrder = sourceOrder ? null : element?.getAttribute(PDF_TEXT_LAYER_NARRATION_ORDER_ATTRIBUTE);
  const order = Number.parseInt(narrationOrder ?? element?.getAttribute(PDF_TEXT_LAYER_ORDER_ATTRIBUTE) ?? '', 10);
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}
