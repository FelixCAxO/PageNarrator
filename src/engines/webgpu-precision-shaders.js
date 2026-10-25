// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
/** Specialize our static kernels: fp16 storage, fp32 arithmetic and accumulation. */
export function halfStorageShader(code) {
  const declarations = [...code.matchAll(/var<storage, (read|read_write)> (\w+): array<f32>;/gu)];
  if (!declarations.length) throw new Error('Half specialization requires float storage declarations.');
  for (const [, access, name] of declarations) {
    code = code.replace(`var<storage, ${access}> ${name}: array<f32>;`, `var<storage, ${access}> ${name}: array<f16>;`);
    const pattern = new RegExp(`\\b${name}\\[`, 'gu');
    let output = '', previous = 0, match;
    while ((match = pattern.exec(code))) {
      let end = pattern.lastIndex, depth = 1;
      while (depth && end < code.length) { if (code[end] === '[') depth += 1; if (code[end] === ']') depth -= 1; end += 1; }
      if (depth) throw new Error('Unbalanced static shader subscript.');
      const indexed = code.slice(match.index, end), rest = code.slice(end);
      const assignment = /^\s*=\s*(?!=)/u.exec(rest);
      output += code.slice(previous, match.index);
      if (assignment) {
        if (access !== 'read_write') throw new Error('Static shader assigns a read-only input.');
        const start = end + assignment[0].length, semicolon = code.indexOf(';', start);
        if (semicolon < 0) throw new Error('Unterminated static shader assignment.');
        output += `${indexed} = f16(${code.slice(start, semicolon)});`;
        previous = semicolon + 1;
      } else {
        output += `f32(${indexed})`;
        previous = end;
      }
      pattern.lastIndex = previous;
    }
    code = output + code.slice(previous);
  }
  return `enable f16;\n${code}`;
}

/** Index kernels copy values directly, including the two-byte half representation. */
export function halfIndexShader(code) {
  return `enable f16;\n${code.replace(/(src|dst): array<(?:u32|f32)>/gu, '$1: array<f16>')}`;
}

const scalar = type => ({ float32: 'f32', float16: 'f16', int32: 'i32', bool: 'u32' }[type]);
const enable = types => types.includes('float16') ? 'enable f16;' : '';
const declaration = (binding, name, type, write = false) => `@group(0) @binding(${binding}) var<storage, ${write ? 'read_write' : 'read'}> ${name}: array<${scalar(type)}>;`;
const numeric = (name, type) => type === 'bool' ? `select(0.0, 1.0, ${name} != 0u)` : `f32(${name})`;
const output = (expression, type) => type === 'bool' ? `select(0u, 1u, ${expression} != 0.0)` : `${scalar(type)}(${expression})`;

export function castShader(from, to) {
  return `${enable([from, to])}
${declaration(0, 'src', from)}
${declaration(1, 'dst', to, true)}
@group(0) @binding(2) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i = p.x + p.y * cfg[1u] * 64u;
  if (i < cfg[0u]) { dst[i] = ${output(numeric('src[i]', from), to)}; }
}`;
}

export function compareShader(type, operation = 'Equal') {
  const comparison = { Equal: 'lhs[ai] == rhs[bi]', Greater: 'lhs[ai] > rhs[bi]', GreaterOrEqual: 'lhs[ai] >= rhs[bi]',
    Less: 'lhs[ai] < rhs[bi]', And: 'lhs[ai] != 0u && rhs[bi] != 0u' }[operation];
  if (!comparison || (operation === 'And' && type !== 'bool')) throw new Error('Invalid typed comparison.');
  return `${enable([type])}
${declaration(0, 'lhs', type)}
${declaration(1, 'rhs', type)}
${declaration(2, 'dst', 'bool', true)}
@group(0) @binding(3) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i = p.x + p.y * cfg[7u] * 64u;
  if (i >= cfg[0u]) { return; }
  var ai = 0u; var bi = 0u; var remaining = i;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    ai += coord * cfg[16u + u32(axis)]; bi += coord * cfg[24u + u32(axis)];
  }
  dst[i] = select(0u, 1u, ${comparison});
}`;
}

export function whereShader(type) {
  return `${enable([type])}
${declaration(0, 'condition', 'bool')}
${declaration(1, 'yes', type)}
${declaration(2, 'no', type)}
${declaration(3, 'dst', type, true)}
@group(0) @binding(4) var<storage, read> cfg: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let i = p.x + p.y * cfg[2u] * 64u;
  if (i >= cfg[0u]) { return; }
  var ci = 0u; var ai = 0u; var bi = 0u; var remaining = i;
  for (var axis = i32(cfg[1u]) - 1; axis >= 0; axis -= 1) {
    let coord = remaining % cfg[8u + u32(axis)]; remaining /= cfg[8u + u32(axis)];
    ci += coord * cfg[16u + u32(axis)]; ai += coord * cfg[24u + u32(axis)]; bi += coord * cfg[32u + u32(axis)];
  }
  dst[i] = select(no[bi], yes[ai], condition[ci] != 0u);
}`;
}
