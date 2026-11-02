// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Reuse PageNarrator's freestanding math; no external library or allocator.
// MLAS/Eigen numerical schedules and constants retain the notices in public/legal/THIRD_PARTY_NOTICES.txt.
#include "engine.cpp"

// Speech follows its retained CPU oracle; OCR keeps its established vector kernels.
#ifdef PN_KOKORO_NUMERICS
static constexpr bool speech_numerics=true;
#else
static constexpr bool speech_numerics=false;
#endif

#if defined(__wasm_relaxed_simd__)
// Relaxed SIMD permits an unfused projection; enable it only after testing fused rounding on this host.
static u32 hardware_fma_mode=0;
static __attribute__((noinline)) bool hardware_fma_available(){
  if(!hardware_fma_mode){
    volatile float inputs[]={0x1.000002p0f,0x1.fffffcp-1f,-1.0f,0x1.fffffep127f,2.0f,-0x1.fffffep127f,0x1p-126f,0x1p-23f,0x1p-149f,0x1.001p0f,0x1.001p0f,0x1p-80f};
    const f32x4 a={inputs[0],inputs[3],inputs[6],inputs[9]},b={inputs[1],inputs[4],inputs[7],inputs[10]},c={inputs[2],inputs[5],inputs[8],inputs[11]};
    const f32x4 actual=__builtin_wasm_relaxed_madd_f32x4(a,b,c),expected={-0x1p-46f,0x1.fffffep127f,0x1p-148f,1.0f+0x1p-11f+0x1p-23f};
    hardware_fma_mode=2;for(u32 i=0;i<4;++i)if(actual[i]!=expected[i])hardware_fma_mode=1;
  }
  return hardware_fma_mode==2;
}
#endif
// Round the exact binary32 product-plus-add once, including double-rounding ties.
static __attribute__((always_inline)) inline float fused(float a,float b,float c) {
#if defined(__wasm_relaxed_simd__)
  if(hardware_fma_mode==2||(!hardware_fma_mode&&hardware_fma_available()))return __builtin_wasm_relaxed_madd_f32x4(f32x4{a,a,a,a},f32x4{b,b,b,b},f32x4{c,c,c,c})[0];
#endif
  const double product=static_cast<double>(a)*b, addend=c, sum=product+addend;
  union { double value; unsigned long long bits; } check={sum};
  if(__builtin_fabs(sum)>=0x1p-126&&((check.bits&0x1fffffffULL)!=0x10000000ULL))return static_cast<float>(sum);
  const double error=__builtin_fabs(product)>=__builtin_fabs(addend)?(product-sum)+addend:(addend-sum)+product;
  union { double value; unsigned long long bits; } rounded={sum};
  if(error!=0.0&&__builtin_isfinite(sum)&&!(rounded.bits&1))rounded.bits+=__builtin_signbit(sum)==__builtin_signbit(error)?1:-1;
  return static_cast<float>(rounded.value);
}
using f32x2=float __attribute__((vector_size(8)));
using f64x2=double __attribute__((vector_size(16)));
using u64x2=unsigned long long __attribute__((vector_size(16)));
static __attribute__((always_inline)) inline f32x4 fused4(f32x4 a,f32x4 b,f32x4 c){
#if defined(__wasm_relaxed_simd__)
  if(hardware_fma_mode==2||(!hardware_fma_mode&&hardware_fma_available()))return __builtin_wasm_relaxed_madd_f32x4(a,b,c);
#endif
  const f64x2 low=__builtin_convertvector(__builtin_shufflevector(a,a,0,1),f64x2)*__builtin_convertvector(__builtin_shufflevector(b,b,0,1),f64x2)+__builtin_convertvector(__builtin_shufflevector(c,c,0,1),f64x2);
  const f64x2 high=__builtin_convertvector(__builtin_shufflevector(a,a,2,3),f64x2)*__builtin_convertvector(__builtin_shufflevector(b,b,2,3),f64x2)+__builtin_convertvector(__builtin_shufflevector(c,c,2,3),f64x2);
  f32x4 result=__builtin_shufflevector(__builtin_convertvector(low,f32x2),__builtin_convertvector(high,f32x2),0,1,2,3);
  u64x2 lo,hi;__builtin_memcpy(&lo,&low,16);__builtin_memcpy(&hi,&high,16);
  const u64x2 magnitude={0x7fffffffffffffffULL,0x7fffffffffffffffULL},tail={0x1fffffffULL,0x1fffffffULL},half={0x10000000ULL,0x10000000ULL},normal={0x3810000000000000ULL,0x3810000000000000ULL},zero={0,0};
  const auto lm=((lo&tail)==half)|(((lo&magnitude)<normal)&((lo&magnitude)!=zero));
  const auto hm=((hi&tail)==half)|(((hi&magnitude)<normal)&((hi&magnitude)!=zero));
  if(__builtin_reduce_or(lm|hm)){for(unsigned i=0;i<4;++i){const unsigned long long bits=i<2?lo[i]:hi[i-2],absolute=bits&0x7fffffffffffffffULL;if((bits&0x1fffffffULL)==0x10000000ULL||(absolute&&absolute<0x3810000000000000ULL))result[i]=fused(a[i],b[i],c[i]);}}
  return result;
}
template<unsigned N> static float polynomial(float z,const float (&p)[N]) { float y=p[0];for(unsigned i=1;i<N;i++)y=fused(y,z,p[i]);return y; }
static float sigmoid(float x) {
  if(x!=x)return x;x=x< -18.0f?-18.0f:x>18.0f?18.0f:x;
  const float a[]={4.37031012579801e-11f,1.15627324459942e-07f,6.08574864600143e-05f,8.51377133304701e-03f,2.48287947061529e-01f};
  const float b[]={6.10247389755681e-13f,5.76102136993427e-09f,6.29106785017040e-06f,1.70198817374094e-03f,1.16817656904453e-01f,9.93151921023180e-01f};
  const float y=x*polynomial(x*x,a)/polynomial(x*x,b)+.5f;return y<0?0:y;
}
static float float_bits(u32 bits) { return from_bits(bits); }
using i32x4 = int __attribute__((vector_size(16)));
using u32x4 = unsigned int __attribute__((vector_size(16)));
static f32x4 exponential4(f32x4 x) {
  // Preserve exceptional/subnormal scalar behavior outside the normal neural activation range.
  for(u32 lane=0;lane<4;++lane)if(x[lane]!=x[lane]||x[lane]<-80.0f||x[lane]>80.0f){f32x4 result;for(u32 j=0;j<4;++j)result[j]=exponential(x[j]);return result;}
  const i32x4 exponent=__builtin_convertvector(__builtin_elementwise_floor(x*1.4426950408889634f+0.5f),i32x4);
  const f32x4 e=__builtin_convertvector(exponent,f32x4),r=(x-e*0.693145751953125f)-e*0.000001428606765330187f;
  const f32x4 p=1.0f+r*(1.0f+r*(0.5f+r*(0.16666666666666667f+r*(0.041666666666666664f+r*(0.008333333333333333f+r*(0.001388888888888889f+r*(0.0001984126984126984f+r*0.0000248015873015873f)))))));
  const u32x4 bits=__builtin_convertvector(exponent+127,u32x4)<<23;f32x4 scale;__builtin_memcpy(&scale,&bits,16);return p*scale;
}
extern "C" void pn_ocr_unary(const float* input,float* out,u32 count,u32 op,float alpha,float beta){
  if(speech_numerics&&op==2){for(u32 i=0;i<count;++i)out[i]=sigmoid(input[i]);return;}
  u32 i=0;const f32x4 zero={0,0,0,0};
  for(;i+4<=count;i+=4){f32x4 x,value;__builtin_memcpy(&x,input+i,16);const f32x4 a=(x<zero)?-x:x;
    switch(op){
      case 1:value=(x<zero)?zero:x;break;
      case 2:{const f32x4 e=exponential4(-a);value=(x<zero)?e/(1.0f+e):1.0f/(1.0f+e);break;}
      case 3:{const f32x4 e=exponential4(-2.0f*a),t=(1.0f-e)/(1.0f+e);value=(x<zero)?-t:t;break;}
      case 4:{const f32x4 t=1.0f/(1.0f+0.3275911f*a),p=(((((1.061405429f*t-1.453152027f)*t)+1.421413741f)*t-0.284496736f)*t+0.254829592f)*t;
        const f32x4 r=1.0f-p*exponential4(-a*a);value=(x<zero)?-r:r;value=(x==zero)?x:value;break;}
      case 5:value=__builtin_elementwise_sqrt(x);break;
      case 6:value=exponential4(x);break;
      case 7:value=-x;break;
      case 8:value=1.0f/x;break;
      case 9:{const f32x4 v=x*alpha+beta;value=(v<zero)?zero:(v>1.0f)?f32x4{1,1,1,1}:v;break;}
      default:value=x;
    }
    __builtin_memcpy(out+i,&value,16);
  }
  if(i<count)pn_unary(input+i,out+i,count-i,op,alpha,beta);
}
static u32 mapped(u32 index, u32 rank, const u32* shape, const int* strides) {
  int offset = 0;
  for (int axis = static_cast<int>(rank) - 1; axis >= 0; --axis) {
    offset += static_cast<int>(index % shape[axis]) * strides[axis]; index /= shape[axis];
  }
  return static_cast<u32>(offset);
}

template<u32 Op> static void binary_run(const float* a,const float* b,float* out,u32 count,u32 aStep,u32 bStep) {
  const f32x4 aScalar={a[0],a[0],a[0],a[0]},bScalar={b[0],b[0],b[0],b[0]};
  u32 i=0;
  for(;i+4<=count;i+=4){
    f32x4 x=aScalar,y=bScalar;
    if(aStep)__builtin_memcpy(&x,a+i,16);
    if(bStep)__builtin_memcpy(&y,b+i,16);
    const f32x4 value=Op==0?x+y:Op==1?x*y:Op==2?x/y:x-y;
    __builtin_memcpy(out+i,&value,16);
  }
  for(;i<count;++i){
    const float x=a[aStep?i:0],y=b[bStep?i:0];
    out[i]=Op==0?x+y:Op==1?x*y:Op==2?x/y:x-y;
  }
}

extern "C" int pn_ocr_binary(const float* a, const float* b, float* out, const u32* p) {
  const u32 count = p[0], rank = p[1], op = p[2];
  // Broadcast channel parameters once per contiguous inner run. The general
  // indexer and square-exponent validation below retain their existing paths.
  if(op<4&&rank&&p[8+rank-1]>=4){
    const u32 run=p[8+rank-1],aStep=p[3]==1?1:p[3]==2?0:p[16+rank-1],bStep=p[4]==1?1:p[4]==2?0:p[24+rank-1];
    if(aStep<=1&&bStep<=1){
      for(u32 i=0;i<count;i+=run){
        const u32 ai=p[3]==1?i:p[3]==2?0:mapped(i,rank,p+8,reinterpret_cast<const int*>(p+16));
        const u32 bi=p[4]==1?i:p[4]==2?0:mapped(i,rank,p+8,reinterpret_cast<const int*>(p+24));
        if(op==0)binary_run<0>(a+ai,b+bi,out+i,run,aStep,bStep);
        else if(op==1)binary_run<1>(a+ai,b+bi,out+i,run,aStep,bStep);
        else if(op==2)binary_run<2>(a+ai,b+bi,out+i,run,aStep,bStep);
        else binary_run<3>(a+ai,b+bi,out+i,run,aStep,bStep);
      }
      return 0;
    }
  }
  for (u32 i = 0; i < count; ++i) {
    const float x = a[p[3]==1?i:p[3]==2?0:mapped(i, rank, p + 8, reinterpret_cast<const int*>(p + 16))];
    const float y = b[p[4]==1?i:p[4]==2?0:mapped(i, rank, p + 8, reinterpret_cast<const int*>(p + 24))];
    if (op == 4 && y != 2.0f) return 1;
    out[i] = op == 0 ? x + y : op == 1 ? x * y : op == 2 ? x / y : op == 3 ? x - y : x * x;
  }
  return 0;
}

static void ocr_matmul_blocked(const float* lhs,const float* rhs,float* dst,u32 m,u32 n,u32 k) {
  u32 row=0;
  // Reuse each input vector across four output rows.
  for(;row+4<=m;row+=4){
    u32 col=0;
    for(;col+16<=n;col+=16){
      f32x4 sums[4][4]={};
      for(u32 j=0;j<k;++j){
        f32x4 values[4];for(u32 tile=0;tile<4;++tile)__builtin_memcpy(values+tile,rhs+j*n+col+tile*4,16);
        for(u32 r=0;r<4;++r){const float scalar=lhs[(row+r)*k+j];for(u32 tile=0;tile<4;++tile)sums[r][tile]+=values[tile]*f32x4{scalar,scalar,scalar,scalar};}
      }
      for(u32 r=0;r<4;++r)for(u32 tile=0;tile<4;++tile)__builtin_memcpy(dst+(row+r)*n+col+tile*4,&sums[r][tile],16);
    }
    for(;col<n;++col)for(u32 r=0;r<4;++r){float sum=0;for(u32 j=0;j<k;++j)sum+=lhs[(row+r)*k+j]*rhs[j*n+col];dst[(row+r)*n+col]=sum;}
  }
  if(row<m)pn_matmul(lhs+row*k,rhs,dst+row*n,m-row,n,k);
}

static void speech_matmul_blocked(const float* a,const float* b,float* out,u32 m,u32 n,u32 k,u32 block=256,u32 ldc=0) {
  if(!ldc)ldc=n;
  for(u32 row=0;row<m;row+=4){const u32 rows=m-row<4?m-row:4;u32 col=0;
    for(;col+4<=n;col+=4){f32x4 sum[4]={};
      for(u32 begin=0;begin<k;begin+=block){f32x4 part[4]={};const u32 end=begin+block<k?begin+block:k;
        for(u32 j=begin;j<end;++j){f32x4 values;__builtin_memcpy(&values,b+j*n+col,16);for(u32 r=0;r<rows;++r){const float x=a[(row+r)*k+j];part[r]=fused4(f32x4{x,x,x,x},values,part[r]);}}
        for(u32 r=0;r<rows;++r)sum[r]=begin?sum[r]+part[r]:part[r];
      }
      for(u32 r=0;r<rows;++r)__builtin_memcpy(out+(row+r)*ldc+col,&sum[r],16);
    }
    for(;col<n;++col)for(u32 r=0;r<rows;++r){float sum=0;for(u32 begin=0;begin<k;begin+=block){float part=0;const u32 end=begin+block<k?begin+block:k;for(u32 j=begin;j<end;++j)part=fused(a[(row+r)*k+j],b[j*n+col],part);sum=begin?sum+part:part;}out[(row+r)*ldc+col]=sum;}
  }
}

static u32 speech_projection_block(u32 n,u32 k){u32 block=128,panel=128;if(n>=k){while(block/2>=k)block/=2;}else{while(panel>16&&panel/2>=n){block*=2;panel/=2;}}return block;}
extern "C" void pn_ocr_matmul(const float* a, const float* b, float* out, const u32* p) {
  const u32 m = p[0], n = p[1], k = p[2], rank = p[3], batches = p[4];
  for (u32 batch = 0; batch < batches; ++batch) {
    const u32 ai = mapped(batch, rank, p + 8, reinterpret_cast<const int*>(p + 16)) * m * k;
    const u32 bi = mapped(batch, rank, p + 8, reinterpret_cast<const int*>(p + 24)) * k * n;
    const float* lhs=a+ai;const float* rhs=b+bi;float* dst=out+batch*m*n;
    if(speech_numerics)speech_matmul_blocked(lhs,rhs,dst,m,n,k);
    else ocr_matmul_blocked(lhs,rhs,dst,m,n,k);
  }
}

extern "C" void pn_ocr_conv(const float* input, const float* weights, const float* bias, float* out, float* scratch, const u32* p) {
  const u32 batches=p[0],ic=p[1],ih=p[2],iw=p[3],oc=p[4],oh=p[5],ow=p[6],icg=p[7],ocg=p[8];
  const u32 kh=p[9],kw=p[10],sh=p[11],sw=p[12],dh=p[13],dw=p[14],pt=p[15],pl=p[16];
  const bool has_bias=p[17],relu=p[18],transpose=p[19];
  if(!transpose&&kh==1&&kw==1&&sh==1&&sw==1&&!pt&&!pl&&oh==ih&&ow==iw){
    const u32 plane=ih*iw;
    if(speech_numerics&&ocg==1){for(u32 n=0;n<batches;++n)for(u32 g=0;g<ic/icg;++g)for(u32 x=0;x<plane;++x){float sum=0;for(u32 begin=0;begin<icg;){const u32 chunk=icg-begin>=4?4:icg-begin>=2?2:1;float part=weights[g*icg+begin]*input[((n*ic+g*icg+begin)*plane)+x];for(u32 j=1;j<chunk;++j)part+=weights[g*icg+begin+j]*input[((n*ic+g*icg+begin+j)*plane)+x];sum=part+sum;begin+=chunk;}if(has_bias)sum+=bias[g];out[(n*oc+g)*plane+x]=relu&&sum<0?0:sum;}return;}
    for(u32 n=0;n<batches;++n)for(u32 g=0;g<ic/icg;++g)
      if(speech_numerics)speech_matmul_blocked(weights+g*ocg*icg,input+(n*ic+g*icg)*plane,out+(n*oc+g*ocg)*plane,ocg,plane,icg,speech_projection_block(plane,icg));
      else ocr_matmul_blocked(weights+g*ocg*icg,input+(n*ic+g*icg)*plane,out+(n*oc+g*ocg)*plane,ocg,plane,icg);
    if(has_bias||relu)for(u32 i=0;i<batches*oc*plane;++i){const float v=out[i]+(has_bias?bias[(i/plane)%oc]:0.0f);out[i]=relu&&v<0.0f?0.0f:v;}
    return;
  }
  if(!transpose&&icg>1&&p[20]){
    const u32 spatial=oh*ow,kernel=icg*kh*kw,tile=p[20];
    for(u32 n=0;n<batches;++n)for(u32 g=0;g<ic/icg;++g)for(u32 start=0;start<spatial;start+=tile){
      const u32 columns=spatial-start<tile?spatial-start:tile;
      // Bounded im2col tiles share source pixels across all output filters.
      for(u32 ci=0;ci<icg;++ci)for(u32 ky=0;ky<kh;++ky)for(u32 kx=0;kx<kw;++kx){
        const u32 row=(ci*kh+ky)*kw+kx;
        for(u32 j=0;j<columns;++j){const u32 position=start+j;
          const int sy=static_cast<int>((position/ow)*sh+ky*dh)-static_cast<int>(pt),sx=static_cast<int>((position%ow)*sw+kx*dw)-static_cast<int>(pl);
          scratch[row*columns+j]=sy>=0&&sx>=0&&sy<static_cast<int>(ih)&&sx<static_cast<int>(iw)?input[((n*ic+g*icg+ci)*ih+sy)*iw+sx]:0.0f;
        }
      }
      if(speech_numerics){
      speech_matmul_blocked(weights+g*ocg*kernel,scratch,out+(n*oc+g*ocg)*spatial+start,ocg,columns,kernel,speech_projection_block(spatial,kernel),spatial);
      if(has_bias||relu)for(u32 c=0;c<ocg;++c)for(u32 j=0;j<columns;++j){float& value=out[(n*oc+g*ocg+c)*spatial+start+j];if(has_bias)value+=bias[g*ocg+c];if(relu&&value<0)value=0;}
      }else for(u32 c=0;c<ocg;++c){
        const float* filter=weights+(g*ocg+c)*kernel;float* destination=out+((n*oc+g*ocg+c)*spatial)+start;u32 j=0;
        for(;j+4<=columns;j+=4){f32x4 sum={0,0,0,0};for(u32 k=0;k<kernel;++k){f32x4 v;__builtin_memcpy(&v,scratch+k*columns+j,16);const float w=filter[k];sum+=v*f32x4{w,w,w,w};}
          if(has_bias){const float b=bias[g*ocg+c];sum+=f32x4{b,b,b,b};}if(relu)for(u32 lane=0;lane<4;++lane)if(sum[lane]<0.0f)sum[lane]=0.0f;__builtin_memcpy(destination+j,&sum,16);}
        for(;j<columns;++j){float sum=0;for(u32 k=0;k<kernel;++k)sum+=filter[k]*scratch[k*columns+j];if(has_bias)sum+=bias[g*ocg+c];destination[j]=relu&&sum<0.0f?0.0f:sum;}
      }
    }
    return;
  }
  for (u32 n=0;n<batches;++n) for(u32 c=0;c<oc;++c) for(u32 y=0;y<oh;++y) {
    const u32 group=c/ocg;
    u32 x=0;
    // Four adjacent output positions share the same weight and remain in SIMD registers.
    for (;x+4<=ow;x+=4) {
      const float initial=!speech_numerics&&has_bias?bias[c]:0.0f;
      f32x4 sum={initial,initial,initial,initial};
      for(u32 ci=0;ci<icg;++ci) for(u32 ky=0;ky<kh;++ky) {
        int sy=static_cast<int>(y*sh+ky*dh)-static_cast<int>(pt);
        if(transpose){sy=static_cast<int>(y+pt)-static_cast<int>(ky*dh);if(sy<0||sy%sh)continue;sy/=sh;}
        if(sy<0||sy>=static_cast<int>(ih))continue;
        const float* row=input+((n*ic+group*icg+ci)*ih+sy)*iw;
        for(u32 kx=0;kx<kw;++kx){
          const u32 wi=transpose?(((group*icg+ci)*ocg+c%ocg)*kh+ky)*kw+kx:((c*icg+ci)*kh+ky)*kw+kx;
          const float w=weights[wi]; f32x4 v={0,0,0,0};
          const int start=transpose?static_cast<int>(x+pl)-static_cast<int>(kx*dw):static_cast<int>(x*sw+kx*dw)-static_cast<int>(pl);
          if(!transpose&&sw==1&&start>=0&&start+3<static_cast<int>(iw))__builtin_memcpy(&v,row+start,16);
          else for(u32 lane=0;lane<4;++lane){int sx=start+static_cast<int>(lane*(transpose?1:sw));if(transpose){if(sx<0||sx%sw)continue;sx/=sw;}if(sx>=0&&sx<static_cast<int>(iw))v[lane]=row[sx];}
          sum+=v*f32x4{w,w,w,w};
        }
      }
      if(speech_numerics&&has_bias){const float b=bias[c];sum+=f32x4{b,b,b,b};}
      if(relu)for(u32 lane=0;lane<4;++lane)if(sum[lane]<0.0f)sum[lane]=0.0f;
      __builtin_memcpy(out+((n*oc+c)*oh+y)*ow+x,&sum,16);
    }
    for(;x<ow;++x){
      float sum=!speech_numerics&&has_bias?bias[c]:0.0f;
      for(u32 ci=0;ci<icg;++ci)for(u32 ky=0;ky<kh;++ky)for(u32 kx=0;kx<kw;++kx){
        int sy=static_cast<int>(y*sh+ky*dh)-static_cast<int>(pt),sx=static_cast<int>(x*sw+kx*dw)-static_cast<int>(pl);
        if(transpose){sy=static_cast<int>(y+pt)-static_cast<int>(ky*dh);sx=static_cast<int>(x+pl)-static_cast<int>(kx*dw);if(sy<0||sx<0||sy%sh||sx%sw)continue;sy/=sh;sx/=sw;}
        if(sy<0||sx<0||sy>=static_cast<int>(ih)||sx>=static_cast<int>(iw))continue;
        const u32 wi=transpose?(((group*icg+ci)*ocg+c%ocg)*kh+ky)*kw+kx:((c*icg+ci)*kh+ky)*kw+kx;
        sum+=input[((n*ic+group*icg+ci)*ih+sy)*iw+sx]*weights[wi];
      }
      if(speech_numerics&&has_bias)sum+=bias[c];
      out[((n*oc+c)*oh+y)*ow+x]=relu&&sum<0.0f?0.0f:sum;
    }
  }
}

static float packet_sum(const float* input,u32 count) {
  const u32 alignment=(4-(reinterpret_cast<__UINTPTR_TYPE__>(input)/4)%4)%4,first=alignment<count?alignment:count;
  const u32 packed=(count-first)/4*4,end=first+packed;
  if(!packed){float sum=input[0];for(u32 i=1;i<count;++i)sum+=input[i];return sum;}
  f32x4 a;__builtin_memcpy(&a,input+first,16);
  if(packed>4){f32x4 b;__builtin_memcpy(&b,input+first+4,16);const u32 paired=first+(count-first)/8*8;
    for(u32 i=first+8;i<paired;i+=8){f32x4 x,y;__builtin_memcpy(&x,input+i,16);__builtin_memcpy(&y,input+i+4,16);a+=x;b+=y;}
    a+=b;if(end>paired){f32x4 tail;__builtin_memcpy(&tail,input+paired,16);a+=tail;}
  }
  float sum=(a[0]+a[2])+(a[1]+a[3]);for(u32 i=0;i<first;++i)sum+=input[i];for(u32 i=end;i<count;++i)sum+=input[i];return sum;
}
extern "C" void pn_ocr_reduce(const float* input,float* out,const u32* p){
  const u32 count=p[0],reduction=p[1],rank=p[2],mask=p[3],mode=p[4];
  u32 shape[8],strides[8];u32 stride=1;
  for(int i=static_cast<int>(rank)-1;i>=0;--i){shape[i]=p[8+i];strides[i]=stride;stride*=shape[i];}
  for(u32 i=0;i<count;++i){
    if(speech_numerics&&p[5]&&mode!=1&&reduction>=4){const float sum=packet_sum(input+i*reduction,reduction);out[i]=mode==0?sum/reduction:sum;continue;}
    if(p[5]){float sum=mode==1?-from_bits(0x7f800000u):0.0f;for(u32 r=0;r<reduction;++r){const float v=input[i*reduction+r];sum=mode==1?(v>sum?v:sum):sum+v;}out[i]=mode==0?sum/reduction:sum;continue;}
    u32 at=i,base=0;
    for(int axis=static_cast<int>(rank)-1;axis>=0;--axis)if(!(mask&(1u<<axis))){base+=(at%shape[axis])*strides[axis];at/=shape[axis];}
    float sum=mode==1?-from_bits(0x7f800000u):0.0f;
    for(u32 r=0;r<reduction;++r){u32 remain=r,source=base;for(int axis=static_cast<int>(rank)-1;axis>=0;--axis)if(mask&(1u<<axis)){source+=(remain%shape[axis])*strides[axis];remain/=shape[axis];}const float v=input[source];sum=mode==1?(v>sum?v:sum):sum+v;}
    out[i]=mode==0?sum/reduction:sum;
  }
}

extern "C" void pn_ocr_pool(const float* input,float* out,const u32* p){
  const u32 count=p[0],ih=p[1],iw=p[2],oh=p[3],ow=p[4],kh=p[5],kw=p[6],sh=p[7],sw=p[8],dh=p[9],dw=p[10],pt=p[11],pl=p[12];
  for(u32 i=0;i<count;++i){
    const u32 x=i%ow,y=(i/ow)%oh,plane=i/(ow*oh);float sum=p[13]?0.0f:-from_bits(0x7f800000u);u32 divisor=0;
    for(u32 ky=0;ky<kh;++ky)for(u32 kx=0;kx<kw;++kx){int sy=static_cast<int>(y*sh+ky*dh)-static_cast<int>(pt),sx=static_cast<int>(x*sw+kx*dw)-static_cast<int>(pl);
      if(sy>=0&&sx>=0&&sy<static_cast<int>(ih)&&sx<static_cast<int>(iw)){const float v=input[(plane*ih+sy)*iw+sx];sum=p[13]?sum+v:(v>sum?v:sum);++divisor;}
      else if(p[14]&&sy>=-static_cast<int>(pt)&&sx>=-static_cast<int>(pl)&&sy<static_cast<int>(ih+p[15])&&sx<static_cast<int>(iw+p[16]))++divisor;
    }
    out[i]=p[13]?sum/divisor:sum;
  }
}

static float coordinate(u32 output,u32 input,u32 size,float scale,u32 mode){
  if(mode==1)return size>1?static_cast<float>(output)*(input-1)/(size-1):0.0f;
  if(mode==2)return output/scale;
  return mode==3&&size==1?0.0f:(output+0.5f)/scale-0.5f;
}
static u32 clamp_index(int x,u32 size){return x<0?0:static_cast<u32>(x)>=size?size-1:x;}
static u32 nearest(float x,u32 size,u32 mode){
  float low=__builtin_floorf(x);int index=static_cast<int>(low);
  if(mode==0)index+=x-low>0.5f;else if(mode==1)index+=x-low>=0.5f;else if(mode==3)index=static_cast<int>(__builtin_ceilf(x));
  return clamp_index(index,size);
}
extern "C" void pn_ocr_resize(const float* input,float* out,const u32* p){
  const u32 count=p[0],ih=p[1],iw=p[2],oh=p[3],ow=p[4];const float hs=float_bits(p[5]),ws=float_bits(p[6]);
  for(u32 i=0;i<count;++i){u32 x=i%ow,y=(i/ow)%oh,plane=i/(ow*oh);const float sy=coordinate(y,ih,oh,hs,p[8]),sx=coordinate(x,iw,ow,ws,p[8]);
    if(!p[7]){out[i]=input[(plane*ih+nearest(sy,ih,p[9]))*iw+nearest(sx,iw,p[9])];continue;}
    // Clamp coordinates before interpolation so a replicated border is an exact copy.
    const float cy=sy<0.0f?0.0f:sy>ih-1?static_cast<float>(ih-1):sy,cx=sx<0.0f?0.0f:sx>iw-1?static_cast<float>(iw-1):sx;
    const float ly=__builtin_floorf(cy),lx=__builtin_floorf(cx),fy=cy-ly,fx=cx-lx;
    const u32 y0=clamp_index(static_cast<int>(ly),ih),y1=clamp_index(static_cast<int>(ly)+1,ih),x0=clamp_index(static_cast<int>(lx),iw),x1=clamp_index(static_cast<int>(lx)+1,iw);
    const float a=input[(plane*ih+y0)*iw+x0]*(1.0f-fx)+input[(plane*ih+y0)*iw+x1]*fx,b=input[(plane*ih+y1)*iw+x0]*(1.0f-fx)+input[(plane*ih+y1)*iw+x1]*fx;
    out[i]=a*(1.0f-fy)+b*fy;
  }
}

extern "C" void pn_ocr_index(const unsigned char* input,unsigned char* out,const u32* p){for(u32 i=0;i<p[0];++i){const u32 from=p[2]+mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+16));for(u32 b=0;b<p[3];++b)out[i*p[3]+b]=input[from*p[3]+b];}}
extern "C" void pn_ocr_concat(const unsigned char* input,unsigned char* out,const u32* p){const u32 block=p[1]*p[2];for(u32 i=0;i<p[0];++i){const u32 to=(i/block*p[3]+p[4])*p[2]+i%block;for(u32 b=0;b<p[5];++b)out[to*p[5]+b]=input[i*p[5]+b];}}
extern "C" void pn_ocr_gather(const unsigned char* input,unsigned char* out,const u32* p){for(u32 i=0;i<p[0];++i){const u32 from=((i/(p[1]*p[2]))*p[3]+p[8+(i/p[1])%p[2]])*p[1]+i%p[1];for(u32 b=0;b<p[4];++b)out[i*p[4]+b]=input[from*p[4]+b];}}
extern "C" void pn_ocr_norm(const float* input,const float* scale,const float* bias,const float* mean,const float* variance,float* out,const u32* p){for(u32 i=0;i<p[0];++i){const u32 c=(i/p[2])%p[1];out[i]=(input[i]-mean[c])*scale[c]/__builtin_sqrtf(variance[c]+float_bits(p[3]))+bias[c];}}
static float softmax_exp(float x) {
  if(x!=x)return x;
  if(x< -88.3762626647949f)x=-88.3762626647949f;
  const float m=fused(x,1.44269504088896341f,12582912.0f)-12582912.0f;
  x=fused(m,-.693145752f,x);x=fused(m,-.00000142860677f,x);
  const float coefficients[]={0x1.694000p-10f,0x1.125edcp-7f,0x1.555b5ap-5f,0x1.555450p-3f,0x1.fffff6p-2f,1,1};
  return polynomial(x,coefficients)*from_bits(static_cast<u32>(static_cast<int>(m)+127)<<23);
}
extern "C" void pn_ocr_softmax(const float* input,float* out,const u32* p) {
  if(!speech_numerics){for(u32 row=0;row<p[0];++row){const u32 offset=row*p[1];float maximum=-from_bits(0x7f800000u);for(u32 j=0;j<p[1];++j)if(input[offset+j]>maximum)maximum=input[offset+j];float sum=0;for(u32 j=0;j<p[1];++j){const float e=exponential(input[offset+j]-maximum);out[offset+j]=e;sum+=e;}for(u32 j=0;j<p[1];++j)out[offset+j]/=sum;}return;}
  for(u32 row=0;row<p[0];++row){const u32 base=row*p[1];float maximum=-from_bits(0x7f800000u),sums[8]={};
    for(u32 j=0;j<p[1];++j)if(input[base+j]>maximum)maximum=input[base+j];
    for(u32 j=0;j<p[1];++j){const float e=softmax_exp(input[base+j]-maximum);out[base+j]=e;sums[j%8]+=e;}
    const float sum=((sums[0]+sums[1])+(sums[2]+sums[3]))+((sums[4]+sums[5])+(sums[6]+sums[7])),inverse=1.0f/sum;
    for(u32 j=0;j<p[1];++j)out[base+j]*=inverse;
  }
}

extern "C" void pn_ocr_argmax(const float* input,int* out,const u32* p){for(u32 i=0;i<p[0];++i){const u32 base=(i/p[2])*p[1]*p[2]+i%p[2];u32 best=0;float maximum=input[base];for(u32 j=1;j<p[1];++j){const float v=input[base+j*p[2]];if(v>maximum||(p[3]&&v==maximum)){maximum=v;best=j;}}out[i]=static_cast<int>(best);}}
extern "C" void pn_ocr_copy(const unsigned char* input,unsigned char* out,u32 count){for(u32 i=0;i<count;++i)out[i]=input[i];}
