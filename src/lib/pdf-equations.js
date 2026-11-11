// PDF text often flattens the original math layout. Use explicit operators
// and adjacent operands, leaving ordinary prose (including isolated variables)
// alone when there is no recognizable expression.
const TOKEN = /\d+(?:\.\d+)?|[\p{L}\p{M}\p{No}\u2070-\u209f]+|\S/gu;
const OPERAND = /^(?:\d+(?:\.\d+)?|[a-z]|[A-Z]{1,8}|sin|cos|tan|log|ln|exp|[\p{Script=Greek}\p{M}\p{No}\u2070-\u209f]+|(?:[a-zA-Z]{1,3}[\p{M}\p{No}\u2070-\u209f]+)+)$/u;
const MATH_TOKEN = /^[()[\]{}|‖*/^+−×÷·,<>≤≥≈≠=∑√-]$/u;
const RELATION = /^[=≈≠≤≥]$/u;
const DISTINCT_OPERATOR = /^[×÷∑√]$/u;
const EMPTY = /^[\s\p{P}\p{S}\p{Cf}]*$/u;

export function stripPdfEquations(text) {
  let run = [];
  let output = '';
  let cursor = 0;
  const flush = () => {
    const tokens = run;
    run = [];
    const isEquation = (tokens.some(token => RELATION.test(token[0])) && tokens.some(token => OPERAND.test(token[0])))
      || tokens.some((token, i) => DISTINCT_OPERATOR.test(token[0]) && OPERAND.test(tokens[i + 1]?.[0] || '')
        && (token[0] === '√' || token[0] === '∑' || OPERAND.test(tokens[i - 1]?.[0] || ''))
      );
    if (!isEquation) return;

    // A surrounding prose comma is separate from the equation.
    const start = (tokens[0][0] === ',' ? tokens[1] : tokens[0]).index;
    const last = tokens.at(tokens.at(-1)[0] === ',' ? -2 : -1);
    let end = last.index + last[0].length;
    const before = text.slice(cursor, start);
    if (EMPTY.test(before) || /[.!?;:]\s*$/u.test(before)) {
      end += text.slice(end).match(/^[.!?;](?=\s|$)/u)?.[0].length || 0;
    }
    output += `${before} `;
    cursor = end;
  };
  for (const token of text.matchAll(TOKEN)) {
    if (OPERAND.test(token[0]) || MATH_TOKEN.test(token[0])) run.push(token);
    else if (run.length) flush();
  }
  if (run.length) flush();
  if (!cursor) return text;
  const remaining = (output + text.slice(cursor)).replace(/\s+/gu, ' ').replace(/\s+([,.;:!?])/gu, '$1').trim();
  return EMPTY.test(remaining) ? '' : remaining;
}
