// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';

// ISO 32000-1 7.10.5/Table 42 only: no names, variables, procedure objects or host calls.
export const PDF_CALCULATOR_LIMITS = Object.freeze({ bytes: 65536, tokens: 16384, depth: 32, stack: 256, steps: 100000, totalSteps: 100000000 });
const operators = new Set('abs add atan ceiling cos cvi cvr div exp floor idiv ln log mod mul neg round sin sqrt sub truncate and bitshift eq ge gt le lt ne not or xor copy dup exch index pop roll'.split(' '));
const corrupt = message => { throw new PdfEngineError(`Invalid PDF calculator function: ${message}.`, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(`PDF calculator ${message} limit exceeded.`, 'pdf_limit'); };
const integer = n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
const numeric = (value, isInteger = false) => {
  if (!Number.isFinite(value)) corrupt('undefined numeric result');
  return { type: isInteger && integer(value) ? 'integer' : 'real', value };
};

/** Parse braces as conditional syntax, never as operand-stack procedure objects. */
export function parsePdfCalculator(program) {
  if (typeof program !== 'string') corrupt('missing program');
  if (program.length > PDF_CALCULATOR_LIMITS.bytes) limit('program byte');
  let at = 0, tokens = 0;
  const white = c => c === '\0' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  function next() {
    for (;;) {
      while (at < program.length && white(program[at])) at++;
      if (program[at] !== '%') break;
      while (at < program.length && !['\r', '\n'].includes(program[at])) at++;
    }
    if (at === program.length) return null;
    if (++tokens > PDF_CALCULATOR_LIMITS.tokens) limit('token');
    if ('{}'.includes(program[at])) return program[at++];
    const start = at;
    while (at < program.length && !white(program[at]) && !'{}%'.includes(program[at])) at++;
    return program.slice(start, at);
  }
  function expression(depth) {
    if (depth > PDF_CALCULATOR_LIMITS.depth) limit('conditional depth');
    const code = [];
    for (let token = next(); token !== '}'; token = next()) {
      if (token === null) corrupt('unclosed expression');
      if (token === '{') {
        const yes = expression(depth + 1), after = next();
        if (after === 'if') code.push({ op: 'if', yes });
        else if (after === '{') {
          const no = expression(depth + 1); if (next() !== 'ifelse') corrupt('conditional requires ifelse');
          code.push({ op: 'ifelse', yes, no });
        } else corrupt('expression requires if or ifelse');
      } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token)) {
        code.push(numeric(Number(token), !token.includes('.')));
      } else if (token === 'true' || token === 'false') code.push({ type: 'boolean', value: token === 'true' });
      else if (operators.has(token)) code.push({ op: token });
      else corrupt(`unsupported token ${token.slice(0, 40)}`);
    }
    return code;
  }
  if (next() !== '{') corrupt('program requires outer braces');
  const code = expression(0); if (next() !== null) corrupt('trailing program tokens');
  return code;
}

/** A typed, bounded numeric evaluator; results are copied only after all checks pass. */
export function compilePdfCalculator(program, domain, outputs) {
  const code = parsePdfCalculator(program); let totalSteps = PDF_CALCULATOR_LIMITS.totalSteps;
  return (source, result) => {
    const stack = Array.from(source, (n, i) => numeric(Math.max(domain[i * 2], Math.min(domain[i * 2 + 1], n))));
    let steps = PDF_CALCULATOR_LIMITS.steps;
    const charge = (cost = 1) => { if ((steps -= cost) < 0 || (totalSteps -= cost) < 0) limit('execution step'); };
    const push = value => { if (stack.length === PDF_CALCULATOR_LIMITS.stack) limit('operand stack'); stack.push(value); };
    const pop = () => { if (!stack.length) corrupt('operand stack underflow'); return stack.pop(); };
    const number = value => { if (!['integer', 'real'].includes(value.type)) corrupt('numeric operand required'); return value.value; };
    const int = value => { if (value.type !== 'integer') corrupt('integer operand required'); return value.value; };
    const bool = value => { if (value.type !== 'boolean') corrupt('boolean operand required'); return value.value; };
    function execute(instructions) {
      for (const instruction of instructions) {
        charge();
        if (instruction.type) { push(instruction); continue; }
        const op = instruction.op;
        if (op === 'if' || op === 'ifelse') { const condition = bool(pop()); if (condition) execute(instruction.yes); else if (op === 'ifelse') execute(instruction.no); continue; }
        if (op === 'pop') { pop(); continue; }
        if (op === 'dup') { const value = pop(); push(value); push(value); continue; }
        if (op === 'exch') { const b = pop(), a = pop(); push(b); push(a); continue; }
        if (op === 'copy' || op === 'index') {
          const n = int(pop()); if (n < 0 || n > stack.length || op === 'index' && n === stack.length) corrupt('stack index out of range');
          if (op === 'index') push(stack[stack.length - 1 - n]);
          else { charge(n); if (stack.length + n > PDF_CALCULATOR_LIMITS.stack) limit('operand stack'); for (const value of stack.slice(stack.length - n)) push(value); }
          continue;
        }
        if (op === 'roll') {
          const j = int(pop()), n = int(pop()); if (n < 0 || n > stack.length) corrupt('roll count out of range');
          charge(n); if (n) { const shift = (j % n + n) % n; if (shift) stack.splice(stack.length - n, n, ...stack.slice(-shift), ...stack.slice(stack.length - n, stack.length - shift)); }
          continue;
        }
        if (op === 'not') { const a = pop(); push(a.type === 'boolean' ? { type: 'boolean', value: !a.value } : numeric(~int(a), true)); continue; }
        if (['and', 'or', 'xor'].includes(op)) {
          const b = pop(), a = pop(); if (a.type !== b.type) corrupt('matching boolean or integer operands required');
          if (a.type === 'boolean') push({ type: 'boolean', value: op === 'and' ? a.value && b.value : op === 'or' ? a.value || b.value : a.value !== b.value });
          else { const x = int(a), y = int(b); push(numeric(op === 'and' ? x & y : op === 'or' ? x | y : x ^ y, true)); }
          continue;
        }
        if (op === 'eq' || op === 'ne') {
          const b = pop(), a = pop(), equal = (a.type === b.type || a.type !== 'boolean' && b.type !== 'boolean') && a.value === b.value;
          push({ type: 'boolean', value: op === 'eq' ? equal : !equal }); continue;
        }
        if (['gt', 'ge', 'lt', 'le'].includes(op)) {
          const b = number(pop()), a = number(pop()); push({ type: 'boolean', value: op === 'gt' ? a > b : op === 'ge' ? a >= b : op === 'lt' ? a < b : a <= b }); continue;
        }
        if (op === 'bitshift') {
          const shift = int(pop()), value = int(pop()); push(numeric(Math.abs(shift) >= 32 ? 0 : shift > 0 ? value << shift : shift < 0 ? value >>> -shift : value, true)); continue;
        }
        if (['add', 'sub', 'mul', 'div', 'idiv', 'mod', 'atan', 'exp'].includes(op)) {
          const b = pop(), a = pop(), y = number(b), x = number(a); let value;
          if (op === 'add') value = x + y;
          else if (op === 'sub') value = x - y;
          else if (op === 'mul') value = x * y;
          else if (op === 'div') { if (y === 0) corrupt('division by zero'); value = x / y; }
          else if (op === 'idiv' || op === 'mod') {
            int(a); int(b); if (y === 0) corrupt('division by zero'); value = op === 'idiv' ? Math.trunc(x / y) : x % y;
            if (!integer(value)) corrupt('integer result out of range');
          } else if (op === 'atan') { if (x === 0 && y === 0) corrupt('undefined angle'); value = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360; }
          else value = x ** y;
          push(numeric(value, ['add', 'sub', 'mul', 'idiv', 'mod'].includes(op) && a.type === 'integer' && b.type === 'integer')); continue;
        }
        const a = pop(), value = number(a); let answer;
        if (op === 'abs') answer = Math.abs(value);
        else if (op === 'neg') answer = -value;
        else if (op === 'ceiling') answer = Math.ceil(value);
        else if (op === 'floor') answer = Math.floor(value);
        else if (op === 'round') answer = Math.round(value);
        else if (op === 'truncate' || op === 'cvi') answer = Math.trunc(value);
        else if (op === 'cvr') answer = value;
        else if (op === 'sqrt') answer = Math.sqrt(value);
        else if (op === 'sin') answer = Math.sin(value % 360 * Math.PI / 180);
        else if (op === 'cos') answer = Math.cos(value % 360 * Math.PI / 180);
        else if (op === 'ln') answer = value > 0 ? Math.log(value) : NaN;
        else if (op === 'log') answer = value > 0 ? Math.log10(value) : NaN;
        else corrupt('unrecognised operator');
        if (op === 'cvi' && !integer(answer)) corrupt('integer conversion out of range');
        push(numeric(answer, op === 'cvi' || a.type === 'integer' && ['abs', 'neg', 'ceiling', 'floor', 'round', 'truncate'].includes(op)));
      }
    }
    execute(code);
    if (stack.length !== outputs || stack.some(value => value.type === 'boolean')) corrupt('numeric output count disagrees with Range');
    for (let i = 0; i < outputs; i++) result[i] = stack[i].value;
  };
}
