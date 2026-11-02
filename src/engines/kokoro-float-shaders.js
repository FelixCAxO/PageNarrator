// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export function kokoroFloatShader(roundingWord) {
  // A zero configuration word blocks driver contraction across separately rounded float32 stages.
  return `
fn pn_round(value: f32) -> f32 { return bitcast<f32>(bitcast<u32>(value) ^ cfg[${roundingWord}u]); }
fn pn_add(a: f32,b: f32) -> f32 { return pn_round(a+b); }
fn pn_sub(a: f32,b: f32) -> f32 { return pn_round(a-b); }
fn pn_mul(a: f32,b: f32) -> f32 { return pn_round(a*b); }
fn pn_div(a: f32,b: f32) -> f32 {
  let q=pn_round(a/b);
  if(a==0.0&&b!=0.0){return bitcast<f32>((bitcast<u32>(a)^bitcast<u32>(b))&0x80000000u);}
  if(a==0.0||b==0.0||(bitcast<u32>(a)&0x7fffffffu)>=0x7f800000u||(bitcast<u32>(b)&0x7fffffffu)>=0x7f800000u||(bitcast<u32>(q)&0x7fffffffu)>=0x7f800000u){return q;}
  return fma(fma(-q,b,a),pn_round(1.0/b),q);
}
fn pn_sqrt(x:f32) -> f32 {
  let r=pn_round(sqrt(x));if(r==0.0){return r;}
  return fma(fma(-r,r,x),pn_round(0.5/r),r);
}
fn pn_two_sum(a:f32,b:f32) -> vec2<f32> {
  let s=pn_add(a,b);let v=pn_sub(s,a);
  return vec2<f32>(s,pn_add(pn_sub(a,pn_sub(s,v)),pn_sub(b,v)));
}
fn pn_pair_add(a:vec2<f32>,b:vec2<f32>) -> vec2<f32> {
  let p=pn_two_sum(a.x,b.x);let q=pn_two_sum(a.y,b.y);let r=pn_two_sum(p.y,q.x);let h=pn_two_sum(p.x,r.x);
  return pn_two_sum(h.x,pn_add(pn_add(h.y,r.y),q.y));
}
fn pn_pair_div(a:vec2<f32>,b:f32) -> f32 {
  let q=pn_div(a.x,b);let r=pn_add(fma(-q,b,a.x),a.y);return pn_add(q,pn_div(r,b));
}
// Keep the recovered product distinct; reusing the rounded product erases its residual.
fn pn_pair_mul(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{let p=pn_mul(a.x,b.x);let e=pn_add(pn_add(fma(pn_round(a.x),b.x,-p),pn_mul(a.x,b.y)),pn_add(pn_mul(a.y,b.x),pn_mul(a.y,b.y)));return pn_two_sum(p,e);}
fn pn_tanh(x:f32) -> f32 {
  if(abs(x)<1e-6){return x;}let v=clamp(x,-9.0,9.0);let z=pn_mul(v,v);
  var p=fma(-2.76076847742355e-16,z,2.00018790482477e-13);
  p=fma(p,z,-8.60467152213735e-11);p=fma(p,z,5.12229709037114e-8);p=fma(p,z,1.48572235717979e-5);p=fma(p,z,6.37261928875436e-4);p=fma(p,z,4.89352455891786e-3);
  var q=fma(1.19825839466702e-6,z,1.18534705686654e-4);q=fma(q,z,2.26843463243900e-3);q=fma(q,z,4.89352518554385e-3);
  return pn_div(pn_mul(v,p),q);
}
fn pn_sigmoid(x:f32) -> f32 {
  let v=clamp(x,-18.0,18.0);let z=pn_mul(v,v);
  var p=fma(4.37031012579801e-11,z,1.15627324459942e-7);p=fma(p,z,6.08574864600143e-5);p=fma(p,z,8.51377133304701e-3);p=fma(p,z,2.48287947061529e-1);
  var q=fma(6.10247389755681e-13,z,5.76102136993427e-9);q=fma(q,z,6.29106785017040e-6);q=fma(q,z,1.70198817374094e-3);q=fma(q,z,1.16817656904453e-1);q=fma(q,z,9.93151921023180e-1);
  return max(0.0,pn_add(pn_div(pn_mul(v,p),q),0.5));
}
fn pn_sum_exp(x:f32) -> f32 {
  let clamped=max(x,-88.3762626647949);let rounded=fma(clamped,1.44269504088896341,12582912.0);let m=pn_sub(rounded,12582912.0);
  var reduced=fma(m,-0.693145752,clamped);reduced=fma(m,-0.00000142860677,reduced);
  var p=fma(0x1.694000p-10,reduced,0x1.125edcp-7);p=fma(p,reduced,0x1.555b5ap-5);p=fma(p,reduced,0x1.555450p-3);p=fma(p,reduced,0x1.fffff6p-2);p=fma(p,reduced,1.0);p=fma(p,reduced,1.0);
  return pn_mul(p,bitcast<f32>((bitcast<u32>(rounded)<<23u)+0x3f800000u));
}
`;
}
