// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
#include "kokoro-engine.cpp"

extern "C" u32 pn_parallel_abi_version() { return 0x504e5201u; }

static bool parallel_span(const void* pointer,unsigned long long bytes) {
  const unsigned long long at=reinterpret_cast<__UINTPTR_TYPE__>(pointer);
  return at+bytes>=at && at+bytes<=static_cast<unsigned long long>(__builtin_wasm_memory_size(0))*65536ull;
}
static bool parallel_overlap(const void* a,unsigned long long an,const void* b,unsigned long long bn) {
  const unsigned long long x=reinterpret_cast<__UINTPTR_TYPE__>(a),y=reinterpret_cast<__UINTPTR_TYPE__>(b);
  return an && bn && x<y+bn && y<x+an;
}

// Whole aligned row pairs retain the original SIMD dot/reduction/tail order.
extern "C" int pn_kokoro_conv_integer_rows(const unsigned char* input,const unsigned char* weight,const unsigned char* xz,const unsigned char* wz,i32* out,short* scratch,const u32* p,u32 begin,u32 end,u32 scratchBytes) {
  if((reinterpret_cast<__UINTPTR_TYPE__>(p)&3u)||!parallel_span(p,64))return 1;
  const unsigned long long products=static_cast<unsigned long long>(p[5])*p[7];
  if(p[0]!=1||p[1]!=p[5]||p[3]!=p[6]||p[5]<2||!p[2]||!p[4]||!p[7]||!p[8]||!p[9]||!p[15]||p[15]>32
    ||products<8||products>3270||products*65025ull>2147483647ull||begin>=end||end>p[3]||(begin&1u)||((end&1u)&&end!=p[3])
    ||static_cast<unsigned long long>(p[4]-1)*p[8]+static_cast<unsigned long long>(p[7]-1)*p[9]>2147483647ull||p[10]>2147483647u
    ||p[11]>1||p[12]>1||p[13]>1||(p[14]!=0&&p[14]!=1&&p[14]!=p[3])||scratchBytes<products*p[15]*2ull)return 1;
  const unsigned long long xb=static_cast<unsigned long long>(p[1])*p[2],wb=static_cast<unsigned long long>(p[3])*products,ob=static_cast<unsigned long long>(p[3])*p[4]*4ull,sb=products*p[15]*2ull;
  if((reinterpret_cast<__UINTPTR_TYPE__>(out)&3u)||(reinterpret_cast<__UINTPTR_TYPE__>(scratch)&1u)
    ||!parallel_span(input,xb)||!parallel_span(weight,wb)||!parallel_span(out,ob)||!parallel_span(scratch,sb)
    ||(p[13]&&!parallel_span(xz,1))||(p[14]&&!parallel_span(wz,p[14])))return 1;
  if(parallel_overlap(out,ob,input,xb)||parallel_overlap(out,ob,weight,wb)||parallel_overlap(out,ob,scratch,sb)||parallel_overlap(out,ob,p,64)
    ||(p[13]&&parallel_overlap(out,ob,xz,1))||(p[14]&&parallel_overlap(out,ob,wz,p[14]))
    ||parallel_overlap(scratch,sb,input,xb)||parallel_overlap(scratch,sb,weight,wb)||parallel_overlap(scratch,sb,p,64)
    ||(p[13]&&parallel_overlap(scratch,sb,xz,1))||(p[14]&&parallel_overlap(scratch,sb,wz,p[14])))return 1;
  u32 local[16];__builtin_memcpy(local,p,sizeof(local));
  local[3]=local[6]=end-begin;
  const unsigned char* zero=wz;
  if(p[14]>1){zero+=begin;local[14]=end-begin;}
  pn_kokoro_conv_integer(input,weight+begin*products,xz,zero,out+begin*p[4],scratch,local);
  return 0;
}
