// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// The speech kernels reuse PageNarrator's allocator-free SIMD OCR/math kernels.
#include "ocr-engine.cpp"

using i32 = int;
using i32x4 = int __attribute__((vector_size(16)));
using i16x8 = short __attribute__((vector_size(16)));
using u8x8 = unsigned char __attribute__((vector_size(8)));
using i8x8 = signed char __attribute__((vector_size(8)));
using u8x4 = unsigned char __attribute__((vector_size(4)));
using i8x4 = signed char __attribute__((vector_size(4)));
static_assert(sizeof(i32) == 4);

static float round_even(float x) {
  // WebAssembly nearest has the required ties-to-even and signed-zero contract.
  return x != x ? x : __builtin_elementwise_roundeven(x);
}
static float hyperbolic(float x) {
  // Avoid subtracting nearly equal exponentials, preserving tiny recurrent states and -0.
  if (__builtin_fabsf(x) <= .125f) {
    const double v=x,z=v*v;
    return static_cast<float>(v*(1.0+z*(-1.0/3.0+z*(2.0/15.0+z*(-17.0/315.0+z*(62.0/2835.0+z*(-1382.0/155925.0+z*(21844.0/6081075.0))))))));
  }
  const float e = exponential(-2.0f * __builtin_fabsf(x)), y = (1.0f-e)/(1.0f+e);
  return x < 0.0f ? -y : y;
}
static float logistic(float x) {
  const float e = exponential(x < 0.0f ? x : -x);
  return x < 0.0f ? e/(1.0f+e) : 1.0f/(1.0f+e);
}
static double sine(double x) {
  if (!__builtin_isfinite(x)) return static_cast<double>(from_bits(0x7fc00000u));
  constexpr double pi = 3.14159265358979323846, two_pi = 2.0*pi;
  x -= __builtin_floor((x+pi)/two_pi)*two_pi;
  if (x > pi/2.0) x = pi-x; else if (x < -pi/2.0) x = -pi-x;
  const double z=x*x;
  return x*(1.0+z*(-1.0/6.0+z*(1.0/120.0+z*(-1.0/5040.0+z*(1.0/362880.0+z*(-1.0/39916800.0+z*(1.0/6227020800.0+z*(-1.0/1307674368000.0))))))));
}
static float arctangent(float value) {
  constexpr double pi=3.14159265358979323846;
  double x=__builtin_fabs(static_cast<double>(value));
  const bool inverse=x>1.0; if(inverse)x=1.0/x;
  const bool shifted=x>0.4142135623730950488; if(shifted)x=(x-1.0)/(x+1.0);
  const double z=x*x;
  double sum=x, term=x;
  for(u32 n=1;n<13;++n){term*=-z;sum+=term/static_cast<double>(2*n+1);}
  if(shifted)sum+=pi/4.0;if(inverse)sum=pi/2.0-sum;
  return static_cast<float>(__builtin_signbit(value)?-sum:sum);
}

extern "C" int pn_kokoro_unary(const float* input,float* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){const float x=input[i];float y=x;
    switch(p[1]){
      case 0:y=round_even(x);break;case 1:y=__builtin_floorf(x);break;case 2:y=arctangent(x);break;
      case 3:y=x<0.0f?x*float_bits(p[2]):x;break;
      case 4:y=x<float_bits(p[3])?float_bits(p[3]):x>float_bits(p[4])?float_bits(p[4]):x;break;
      case 5:case 6:
        // Speech phases are bounded; reject magnitudes beyond accurate double range reduction.
        if(__builtin_fabsf(x)>1000000000.0f)return 1;
        y=static_cast<float>(sine(static_cast<double>(x)+(p[1]==6?1.57079632679489661923:0.0)));break;
      case 7:y=.5f*x*(1.0f+hyperbolic(.7978845608028654f*(x+.044715f*x*x*x)));break;
      case 8:y=hyperbolic(x);break;
    }out[i]=y;
  }return 0;
}

extern "C" void pn_kokoro_layer_norm(const float* input,const float* scale,const float* bias,float* out,const u32* p) {
  for(u32 row=0;row<p[0];++row){const u32 offset=row*p[1];float mean=0.0f,variance=0.0f;
    for(u32 j=0;j<p[1];++j)mean+=input[offset+j];mean/=p[1];
    for(u32 j=0;j<p[1];++j){const float d=input[offset+j]-mean;variance+=d*d;}
    const float inverse=1.0f/__builtin_sqrtf(variance/p[1]+float_bits(p[2]));
    for(u32 j=0;j<p[1];++j)out[offset+j]=(input[offset+j]-mean)*inverse*scale[j]+(p[3]?bias[j]:0.0f);
  }
}

extern "C" void pn_kokoro_lstm(const float* input,const float* w,const float* r,const float* bias,const float* initial_h,const float* initial_c,float* out,float* out_h,float* out_c,const u32* p) {
  const u32 steps=p[0],batch=p[1],features=p[2],hidden=p[3],directions=p[4];
  for(u32 i=0;i<directions*batch*hidden;++i){out_h[i]=initial_h[i];out_c[i]=initial_c[i];}
  for(u32 d=0;d<directions;++d)for(u32 b=0;b<batch;++b){const u32 state=(d*batch+b)*hidden;
    float next_h[256],next_c[256];
    for(u32 step=0;step<steps;++step){const u32 t=d==1||p[5]?steps-step-1:step;
      for(u32 unit=0;unit<hidden;++unit){float gates[4];
        for(u32 gate=0;gate<4;++gate){const u32 row=(d*4+gate)*hidden+unit;
          float sum=bias[d*8*hidden+gate*hidden+unit]+bias[d*8*hidden+(gate+4)*hidden+unit];
          for(u32 i=0;i<features;++i)sum+=input[(t*batch+b)*features+i]*w[row*features+i];
          for(u32 i=0;i<hidden;++i)sum+=out_h[state+i]*r[row*hidden+i];gates[gate]=sum;
        }
        next_c[unit]=logistic(gates[2])*out_c[state+unit]+logistic(gates[0])*hyperbolic(gates[3]);
        next_h[unit]=logistic(gates[1])*hyperbolic(next_c[unit]);
        out[((t*directions+d)*batch+b)*hidden+unit]=next_h[unit];
      }
      for(u32 unit=0;unit<hidden;++unit){out_h[state+unit]=next_h[unit];out_c[state+unit]=next_c[unit];}
    }
  }
}

extern "C" void pn_kokoro_resize_linear(const float* input,float* out,const u32* p) {
  const u32 batches=p[0],channels=p[1],length=p[2],width=p[3];
  for(u32 n=0;n<batches;n++)for(u32 c=0;c<channels;c++)for(u32 x=0;x<width;x++) {
    const float raw=coordinate(x,length,width,float_bits(p[4]),p[5]);
    const float position=raw<0.0f?0.0f:raw>length-1?static_cast<float>(length-1):raw;
    const u32 left=static_cast<u32>(position),right=left+1<length?left+1:left;
    const u32 low[3]={left,c,n},high[3]={right,c+1<channels?c+1:c,n+1<batches?n+1:n},sizes[3]={length,channels,batches};
    const float lower[3]={left==right?0.5f:static_cast<float>(right)-position,c==high[1]?0.5f:1.0f,n==high[2]?0.5f:1.0f};
    const float upper[3]={left==right?0.5f:position-static_cast<float>(left),c==high[1]?0.5f:0.0f,n==high[2]?0.5f:0.0f};
    float sum=0.0f;
    // Rank-three Resize accumulates trilinear corners in x/y/z order, even for singleton axes.
    for(int corner=0;corner<8;corner++) {
      float weight=1.0f;u32 offset=0,stride=1;
      for(u32 axis=0;axis<3;axis++){const bool next=(corner>>axis)&1;weight*=next?upper[axis]:lower[axis];offset+=(next?high[axis]:low[axis])*stride;stride*=sizes[axis];}
      sum+=input[offset]*weight;
    }
    out[(n*channels+c)*width+x]=sum;
  }
}

extern "C" void pn_kokoro_stft(const float* input,const float* window,float* out,const u32* p) {
  constexpr double pi=3.14159265358979323846;
  for(u32 b=0;b<p[0];++b)for(u32 frame=0;frame<p[4];++frame)for(u32 bin=0;bin<p[5];++bin){double real=0.0,imaginary=0.0;
    const bool real_bin=bin==0||(p[2]%2==0&&bin==p[2]/2);
    for(u32 j=0;j<p[2];++j){const float windowed=input[b*p[1]+frame*p[3]+j]*window[j];
      const double value=windowed,angle=-2.0*pi*bin*j/p[2];
      if(real_bin)real+=value*(bin==0||j%2==0?1.0:-1.0);
      else {real+=value*sine(angle+pi/2.0);imaginary+=value*sine(angle);}
    }
    const u32 i=((b*p[4]+frame)*p[5]+bin)*2;out[i]=static_cast<float>(real);out[i+1]=static_cast<float>(imaginary);
  }
}

extern "C" void pn_kokoro_snake(const float* input,const float* alpha,const float* scale,float* out,const u32* p) {
  const u32 rank=p[1],width=rank?p[8+rank-1]:1,xstep=rank?p[16+rank-1]:0,astep=rank?p[24+rank-1]:0,sstep=rank?p[32+rank-1]:0;
  for(u32 start=0;start<p[0];start+=width){
    const u32 x=mapped(start,rank,p+8,reinterpret_cast<const int*>(p+16)),a=mapped(start,rank,p+8,reinterpret_cast<const int*>(p+24)),s=mapped(start,rank,p+8,reinterpret_cast<const int*>(p+32));
    for(u32 i=0;i<width;++i){
      // Preserve every float32 stage; only repeated outer-axis indexing is removed.
      const float value=input[x+i*xstep],product=value*alpha[a+i*astep],wave=static_cast<float>(sine(static_cast<double>(product)));
      const float square=wave*wave,scaled=square*scale[s+i*sstep];out[start+i]=value+scaled;
    }
  }
}

extern "C" void pn_kokoro_conv_transpose(const float* input,const float* weight,const float* bias,float* out,float* scratch,const u32* p) {
  const u32 batches=p[0],channels=p[1],length=p[2],oc=p[3],width=p[4],icg=p[5],ocg=p[6],kernel=p[7],stride=p[8],dilation=p[9],left=p[10],tile=p[13];
  for(u32 n=0;n<batches;++n)for(u32 g=0;g<channels/icg;++g){
    for(u32 c=0;c<ocg;++c)for(u32 x=0;x<width;++x)out[(n*oc+g*ocg+c)*width+x]=p[11]?bias[g*ocg+c]:0.0f;
    for(u32 start=0;start<length;start+=tile){const u32 columns=length-start<tile?length-start:tile;
      for(u32 c=0;c<ocg;c+=4){const u32 rows=ocg-c<4?ocg-c:4;
        for(u32 k=0;k<kernel;++k){u32 x=0;
          for(;x+4<=columns;x+=4){f32x4 sums[4]={};
            for(u32 ci=0;ci<icg;++ci){f32x4 values;__builtin_memcpy(&values,input+((n*channels+g*icg+ci)*length)+start+x,16);
              for(u32 row=0;row<rows;++row){const float w=weight[((g*icg+ci)*ocg+c+row)*kernel+k];sums[row]+=values*f32x4{w,w,w,w};}
            }
            for(u32 row=0;row<rows;++row)__builtin_memcpy(scratch+((c+row)*kernel+k)*columns+x,&sums[row],16);
          }
          for(;x<columns;++x)for(u32 row=0;row<rows;++row){float sum=0.0f;for(u32 ci=0;ci<icg;++ci)sum+=input[(n*channels+g*icg+ci)*length+start+x]*weight[((g*icg+ci)*ocg+c+row)*kernel+k];scratch[((c+row)*kernel+k)*columns+x]=sum;}
        }
      }
      // Projection separates dense channel mixing from the sparse overlap-add geometry.
      for(u32 c=0;c<ocg;++c)for(u32 k=0;k<kernel;++k)for(u32 x=0;x<columns;++x){const int to=static_cast<int>((start+x)*stride+k*dilation)-static_cast<int>(left);if(to>=0&&to<static_cast<int>(width))out[(n*oc+g*ocg+c)*width+to]+=scratch[(c*kernel+k)*columns+x];}
    }
    if(p[12])for(u32 c=0;c<ocg;++c)for(u32 x=0;x<width;++x){float& value=out[(n*oc+g*ocg+c)*width+x];if(value<0.0f)value=0.0f;}
  }
}

extern "C" int pn_kokoro_cumsum(const unsigned char* input,unsigned char* out,const u32* p) {
  for(u32 outer=0;outer<p[0];++outer)for(u32 inner=0;inner<p[2];++inner){float sum=0.0f;long long integer=0;
    for(u32 j=0;j<p[1];++j){const u32 i=(outer*p[1]+j)*p[2]+inner;
      if(p[3]){integer+=reinterpret_cast<const i32*>(input)[i];if(integer<(-2147483647ll-1)||integer>2147483647ll)return 1;reinterpret_cast<i32*>(out)[i]=static_cast<i32>(integer);}
      else {sum+=reinterpret_cast<const float*>(input)[i];reinterpret_cast<float*>(out)[i]=sum;}
    }
  }return 0;
}
extern "C" void pn_kokoro_scatter(const float* updates,float* out,const u32* p) {
  for(u32 row=0;row<p[0];++row)for(u32 j=0;j<p[1];++j)out[p[2+row]+j]=updates[row*p[1]+j];
}

static int quantized(const unsigned char* values,u32 i,bool is_signed){return is_signed?reinterpret_cast<const signed char*>(values)[i]:values[i];}
static i32x4 quantized_four(const unsigned char* values,u32 offset,bool is_signed){
  if(is_signed){i8x4 bytes;__builtin_memcpy(&bytes,values+offset,4);return __builtin_convertvector(bytes,i32x4);}
  u8x4 bytes;__builtin_memcpy(&bytes,values+offset,4);return __builtin_convertvector(bytes,i32x4);
}
static int quantize_value(float value,float scale,int zero){const float y=round_even(value/scale)+zero;return y<0.0f?0:y>255.0f?255:static_cast<int>(y);}
static int quantization(const float* input,u32 count,float& scale,int& zero){
  float low=0.0f,high=0.0f;
  for(u32 i=0;i<count;++i){const float x=input[i];if(!__builtin_isfinite(x))return 1;if(x<low)low=x;if(x>high)high=x;}
  scale=high==low?1.0f:(high-low)/255.0f;
  if(!(scale>0.0f)||!__builtin_isfinite(scale))return 1;
  zero=quantize_value(-low,scale,0);return 0;
}
extern "C" int pn_kokoro_dynamic_quantize(const float* input,unsigned char* out,float* scale,unsigned char* zero,const u32* p) {
  int zp;if(quantization(input,p[0],scale[0],zp))return 1;zero[0]=static_cast<unsigned char>(zp);
  for(u32 i=0;i<p[0];++i)out[i]=static_cast<unsigned char>(quantize_value(input[i],scale[0],zp));return 0;
}
extern "C" int pn_kokoro_dequantize(const unsigned char* input,const float* scale,const unsigned char* zero,float* out,const u32* p) {
  for(u32 j=0;j<p[1];++j)if(!(scale[j]>0.0f)||!__builtin_isfinite(scale[j]))return 1;
  for(u32 i=0;i<p[0];++i){const u32 channel=p[1]==1?0:(i/p[2])%p[1];out[i]=(quantized(input,i,p[3])- (p[4]?quantized(zero,channel,p[3]):0))*scale[channel];}return 0;
}
extern "C" void pn_kokoro_matmul_integer(const unsigned char* a,const unsigned char* b,const unsigned char* az,const unsigned char* bz,i32* out,const u32* p) {
  const u32 m=p[0],n=p[1],k=p[2],rank=p[3],batches=p[4];
  const int za=p[7]?quantized(az,0,p[5]):0;
  for(u32 batch=0;batch<batches;++batch){const u32 ai=mapped(batch,rank,p+16,reinterpret_cast<const int*>(p+24))*m*k,bi=mapped(batch,rank,p+16,reinterpret_cast<const int*>(p+32))*k*n;
    u32 row=0;
    for(;row+4<=m;row+=4){u32 col=0;
      for(;col+4<=n;col+=4){i32x4 s0={0,0,0,0},s1={0,0,0,0},s2={0,0,0,0},s3={0,0,0,0};
        const int scalar=p[8]==1?quantized(bz,0,p[6]):0;
        const i32x4 zero=p[8]>1?quantized_four(bz,col,p[6]):i32x4{scalar,scalar,scalar,scalar};
        for(u32 j=0;j<k;++j){const i32x4 rhs=quantized_four(b,bi+j*n+col,p[6])-zero;
          const int x0=quantized(a,ai+row*k+j,p[5])-za,x1=quantized(a,ai+(row+1)*k+j,p[5])-za,x2=quantized(a,ai+(row+2)*k+j,p[5])-za,x3=quantized(a,ai+(row+3)*k+j,p[5])-za;
          s0+=i32x4{x0,x0,x0,x0}*rhs;s1+=i32x4{x1,x1,x1,x1}*rhs;s2+=i32x4{x2,x2,x2,x2}*rhs;s3+=i32x4{x3,x3,x3,x3}*rhs;
        }
        __builtin_memcpy(out+(batch*m+row)*n+col,&s0,16);__builtin_memcpy(out+(batch*m+row+1)*n+col,&s1,16);
        __builtin_memcpy(out+(batch*m+row+2)*n+col,&s2,16);__builtin_memcpy(out+(batch*m+row+3)*n+col,&s3,16);
      }
      for(;col<n;++col){const int zb=p[8]?quantized(bz,p[8]==1?0:col,p[6]):0;
        for(u32 r=0;r<4;++r){int sum=0;for(u32 j=0;j<k;++j)sum+=(quantized(a,ai+(row+r)*k+j,p[5])-za)*(quantized(b,bi+j*n+col,p[6])-zb);out[(batch*m+row+r)*n+col]=sum;}
      }
    }
    for(;row<m;++row){u32 col=0;
      for(;col+4<=n;col+=4){i32x4 sum={0,0,0,0};
        const int scalar=p[8]==1?quantized(bz,0,p[6]):0;
        const i32x4 zero=p[8]>1?quantized_four(bz,col,p[6]):i32x4{scalar,scalar,scalar,scalar};
        for(u32 j=0;j<k;++j){const int lhs=quantized(a,ai+row*k+j,p[5])-za;const i32x4 rhs=quantized_four(b,bi+j*n+col,p[6])-zero;
          sum+=i32x4{lhs,lhs,lhs,lhs}*rhs;
        }__builtin_memcpy(out+(batch*m+row)*n+col,&sum,16);
      }
      for(;col<n;++col){int sum=0;const int zb=p[8]?quantized(bz,p[8]==1?0:col,p[6]):0;for(u32 j=0;j<k;++j)sum+=(quantized(a,ai+row*k+j,p[5])-za)*(quantized(b,bi+j*n+col,p[6])-zb);out[(batch*m+row)*n+col]=sum;}
    }
  }
}
extern "C" void pn_kokoro_conv_integer(const unsigned char* input,const unsigned char* weight,const unsigned char* xz,const unsigned char* wz,i32* out,short* scratch,const u32* p) {
  const u32 batches=p[0],channels=p[1],length=p[2],oc=p[3],width=p[4],icg=p[5],ocg=p[6],kernel=p[7],stride=p[8],dilation=p[9],left=p[10];
  const int zx=p[13]?quantized(xz,0,p[11]):0;
  if(p[15]){const u32 products=icg*kernel,tile=p[15];
    for(u32 n=0;n<batches;++n)for(u32 g=0;g<channels/icg;++g)for(u32 start=0;start<width;start+=tile){const u32 columns=width-start<tile?width-start:tile;
      // Pack only a bounded spatial tile; signed16 preserves every asymmetric8-bit difference.
      for(u32 j=0;j<columns;++j)for(u32 ci=0;ci<icg;++ci)for(u32 k=0;k<kernel;++k){const int source=static_cast<int>((start+j)*stride+k*dilation)-static_cast<int>(left);
        scratch[j*products+ci*kernel+k]=source>=0&&source<static_cast<int>(length)?static_cast<short>(quantized(input,(n*channels+g*icg+ci)*length+source,p[11])-zx):0;
      }
      u32 ci=0;
      for(;ci+2<=ocg;ci+=2){
        const u32 c0=g*ocg+ci+0;const int zw0=p[14]?quantized(wz,p[14]==1?0:c0,p[12]):0;
        const i16x8 zero0={static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0),static_cast<short>(zw0)};
        const u32 c1=g*ocg+ci+1;const int zw1=p[14]?quantized(wz,p[14]==1?0:c1,p[12]):0;
        const i16x8 zero1={static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1),static_cast<short>(zw1)};
        u32 j=0;
        for(;j+4<=columns;j+=4){
          i32x4 s00={0,0,0,0},s01={0,0,0,0},s02={0,0,0,0},s03={0,0,0,0};
          i32x4 s10={0,0,0,0},s11={0,0,0,0},s12={0,0,0,0},s13={0,0,0,0};
          u32 k=0;for(;k+8<=products;k+=8){
            i16x8 a0,a1,a2,a3;
            __builtin_memcpy(&a0,scratch+(j+0)*products+k,16);
            __builtin_memcpy(&a1,scratch+(j+1)*products+k,16);
            __builtin_memcpy(&a2,scratch+(j+2)*products+k,16);
            __builtin_memcpy(&a3,scratch+(j+3)*products+k,16);
            i16x8 b0;if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c0*products+k,8);b0=__builtin_convertvector(raw,i16x8)-zero0;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c0*products+k,8);b0=__builtin_convertvector(raw,i16x8)-zero0;}
            s00+=__builtin_wasm_dot_s_i32x4_i16x8(a0,b0);
            s01+=__builtin_wasm_dot_s_i32x4_i16x8(a1,b0);
            s02+=__builtin_wasm_dot_s_i32x4_i16x8(a2,b0);
            s03+=__builtin_wasm_dot_s_i32x4_i16x8(a3,b0);
            i16x8 b1;if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c1*products+k,8);b1=__builtin_convertvector(raw,i16x8)-zero1;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c1*products+k,8);b1=__builtin_convertvector(raw,i16x8)-zero1;}
            s10+=__builtin_wasm_dot_s_i32x4_i16x8(a0,b1);
            s11+=__builtin_wasm_dot_s_i32x4_i16x8(a1,b1);
            s12+=__builtin_wasm_dot_s_i32x4_i16x8(a2,b1);
            s13+=__builtin_wasm_dot_s_i32x4_i16x8(a3,b1);
          }
          int sums0[4]={s00[0]+s00[1]+s00[2]+s00[3],s01[0]+s01[1]+s01[2]+s01[3],s02[0]+s02[1]+s02[2]+s02[3],s03[0]+s03[1]+s03[2]+s03[3]};
          int sums1[4]={s10[0]+s10[1]+s10[2]+s10[3],s11[0]+s11[1]+s11[2]+s11[3],s12[0]+s12[1]+s12[2]+s12[3],s13[0]+s13[1]+s13[2]+s13[3]};
          for(;k<products;++k){
            const int w0=quantized(weight,c0*products+k,p[12])-zw0;for(u32 lane=0;lane<4;++lane)sums0[lane]+=scratch[(j+lane)*products+k]*w0;
            const int w1=quantized(weight,c1*products+k,p[12])-zw1;for(u32 lane=0;lane<4;++lane)sums1[lane]+=scratch[(j+lane)*products+k]*w1;
          }
          __builtin_memcpy(out+(n*oc+c0)*width+start+j,sums0,16);
          __builtin_memcpy(out+(n*oc+c1)*width+start+j,sums1,16);
        }
        for(;j<columns;++j){
          i32x4 tail0={0,0,0,0};
          i32x4 tail1={0,0,0,0};
          u32 k=0;for(;k+8<=products;k+=8){i16x8 a;__builtin_memcpy(&a,scratch+j*products+k,16);
            i16x8 b0;if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c0*products+k,8);b0=__builtin_convertvector(raw,i16x8)-zero0;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c0*products+k,8);b0=__builtin_convertvector(raw,i16x8)-zero0;}
            tail0+=__builtin_wasm_dot_s_i32x4_i16x8(a,b0);
            i16x8 b1;if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c1*products+k,8);b1=__builtin_convertvector(raw,i16x8)-zero1;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c1*products+k,8);b1=__builtin_convertvector(raw,i16x8)-zero1;}
            tail1+=__builtin_wasm_dot_s_i32x4_i16x8(a,b1);
          }
          int sum0=tail0[0]+tail0[1]+tail0[2]+tail0[3];
          int sum1=tail1[0]+tail1[1]+tail1[2]+tail1[3];
          for(;k<products;++k){
            sum0+=scratch[j*products+k]*(quantized(weight,c0*products+k,p[12])-zw0);
            sum1+=scratch[j*products+k]*(quantized(weight,c1*products+k,p[12])-zw1);
          }
          out[(n*oc+c0)*width+start+j]=sum0;
          out[(n*oc+c1)*width+start+j]=sum1;
        }
      }
      for(;ci<ocg;++ci){const u32 c=g*ocg+ci;const int zw=p[14]?quantized(wz,p[14]==1?0:c,p[12]):0;
        const i16x8 zero={static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw),static_cast<short>(zw)};
        // Adjacent columns use the same weights; extend each weight vector once for four dots.
        u32 j=0;
        for(;j+4<=columns;j+=4){i32x4 s0={0,0,0,0},s1={0,0,0,0},s2={0,0,0,0},s3={0,0,0,0};u32 k=0;
          for(;k+8<=products;k+=8){i16x8 a0,a1,a2,a3,b;
            __builtin_memcpy(&a0,scratch+j*products+k,16);__builtin_memcpy(&a1,scratch+(j+1)*products+k,16);
            __builtin_memcpy(&a2,scratch+(j+2)*products+k,16);__builtin_memcpy(&a3,scratch+(j+3)*products+k,16);
            if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c*products+k,8);b=__builtin_convertvector(raw,i16x8)-zero;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c*products+k,8);b=__builtin_convertvector(raw,i16x8)-zero;}
            s0+=__builtin_wasm_dot_s_i32x4_i16x8(a0,b);s1+=__builtin_wasm_dot_s_i32x4_i16x8(a1,b);
            s2+=__builtin_wasm_dot_s_i32x4_i16x8(a2,b);s3+=__builtin_wasm_dot_s_i32x4_i16x8(a3,b);
          }
          int sums[4]={s0[0]+s0[1]+s0[2]+s0[3],s1[0]+s1[1]+s1[2]+s1[3],s2[0]+s2[1]+s2[2]+s2[3],s3[0]+s3[1]+s3[2]+s3[3]};
          for(;k<products;++k){const int w=quantized(weight,c*products+k,p[12])-zw;for(u32 lane=0;lane<4;++lane)sums[lane]+=scratch[(j+lane)*products+k]*w;}
          __builtin_memcpy(out+(n*oc+c)*width+start+j,sums,16);
        }
        for(;j<columns;++j){i32x4 sums={0,0,0,0};u32 k=0;
          for(;k+8<=products;k+=8){i16x8 a,b;__builtin_memcpy(&a,scratch+j*products+k,16);
            if(p[12]){i8x8 raw;__builtin_memcpy(&raw,weight+c*products+k,8);b=__builtin_convertvector(raw,i16x8)-zero;}
            else {u8x8 raw;__builtin_memcpy(&raw,weight+c*products+k,8);b=__builtin_convertvector(raw,i16x8)-zero;}
            sums+=__builtin_wasm_dot_s_i32x4_i16x8(a,b);
          }
          int sum=sums[0]+sums[1]+sums[2]+sums[3];for(;k<products;++k)sum+=scratch[j*products+k]*(quantized(weight,c*products+k,p[12])-zw);
          out[(n*oc+c)*width+start+j]=sum;
        }
      }
    }return;
  }
  for(u32 n=0;n<batches;++n)for(u32 c=0;c<oc;++c){const u32 group=c/ocg;const int zw=p[14]?quantized(wz,p[14]==1?0:c,p[12]):0;
    u32 x=0;
    for(;x+4<=width;x+=4){i32x4 sum={0,0,0,0};
      for(u32 ci=0;ci<icg;++ci)for(u32 j=0;j<kernel;++j){const int start=static_cast<int>(x*stride+j*dilation)-static_cast<int>(left),w=quantized(weight,(c*icg+ci)*kernel+j,p[12])-zw;i32x4 v={0,0,0,0};
        for(u32 lane=0;lane<4;++lane){const int source=start+static_cast<int>(lane*stride);if(source>=0&&source<static_cast<int>(length))v[lane]=quantized(input,(n*channels+group*icg+ci)*length+source,p[11])-zx;}
        sum+=v*i32x4{w,w,w,w};
      }__builtin_memcpy(out+(n*oc+c)*width+x,&sum,16);
    }
    for(;x<width;++x){int sum=0;for(u32 ci=0;ci<icg;++ci)for(u32 j=0;j<kernel;++j){const int source=static_cast<int>(x*stride+j*dilation)-static_cast<int>(left);if(source>=0&&source<static_cast<int>(length))sum+=(quantized(input,(n*channels+group*icg+ci)*length+source,p[11])-zx)*(quantized(weight,(c*icg+ci)*kernel+j,p[12])-zw);}out[(n*oc+c)*width+x]=sum;}
  }
}

// Quantize the complete X projection once and the current recurrent state per step.
extern "C" int pn_kokoro_dynamic_lstm(const float* input,const unsigned char* w,const unsigned char* r,const float* bias,const float* initial_h,const float* initial_c,const float* ws,const unsigned char* wz,const float* rs,const unsigned char* rz,float* out,float* out_h,float* out_c,unsigned char* qx,const u32* p) {
  const u32 steps=p[0],batch=p[1],features=p[2],hidden=p[3],directions=p[4],gates=4*hidden;float xs;int xz;
  if(quantization(input,steps*batch*features,xs,xz))return 1;
  for(u32 i=0;i<steps*batch*features;++i)qx[i]=static_cast<unsigned char>(quantize_value(input[i],xs,xz));
  for(u32 i=0;i<directions*batch*hidden;++i){out_h[i]=initial_h[i];out_c[i]=initial_c[i];}
  for(u32 d=0;d<directions;++d){
    for(u32 step=0;step<steps;++step){const u32 t=d==1||p[5]?steps-step-1:step;float hs;int hz;
      if(quantization(out_h+d*batch*hidden,batch*hidden,hs,hz))return 1;
      for(u32 b=0;b<batch;++b){const u32 state=(d*batch+b)*hidden;unsigned char qh[256];float next_h[256],next_c[256];
        for(u32 i=0;i<hidden;++i)qh[i]=static_cast<unsigned char>(quantize_value(out_h[state+i],hs,hz));
        u32 unit=0;
        // Four adjacent gates share quantized activations and contiguous weights in SIMD registers.
        for(;unit+4<=hidden;unit+=4){f32x4 gate_values[4];
          for(u32 gate=0;gate<4;++gate){const u32 col=gate*hidden+unit,wi=p[8]?d*gates+col:d,ri=p[9]?d*gates+col:d;
            i32x4 zw,zr;f32x4 sw,sr;
            for(u32 lane=0;lane<4;++lane){const u32 windex=wi+(p[8]?lane:0),rindex=ri+(p[9]?lane:0);
              if(!(ws[windex]>0.0f)||!(rs[rindex]>0.0f)||!__builtin_isfinite(ws[windex])||!__builtin_isfinite(rs[rindex]))return 1;
              zw[lane]=quantized(wz,windex,p[6]);zr[lane]=quantized(rz,rindex,p[7]);sw[lane]=ws[windex];sr[lane]=rs[rindex];
            }
            i32x4 wx={0,0,0,0},rh={0,0,0,0};
            for(u32 i=0;i<features;++i){const int q=static_cast<int>(qx[(t*batch+b)*features+i])-xz;wx+=i32x4{q,q,q,q}*(quantized_four(w,(d*features+i)*gates+col,p[6])-zw);}
            for(u32 i=0;i<hidden;++i){const int q=static_cast<int>(qh[i])-hz;rh+=i32x4{q,q,q,q}*(quantized_four(r,(d*hidden+i)*gates+col,p[7])-zr);}
            f32x4 wb,rb;__builtin_memcpy(&wb,bias+d*8*hidden+col,16);__builtin_memcpy(&rb,bias+d*8*hidden+gates+col,16);
            gate_values[gate]=__builtin_convertvector(wx,f32x4)*f32x4{xs,xs,xs,xs}*sw+__builtin_convertvector(rh,f32x4)*f32x4{hs,hs,hs,hs}*sr+wb+rb;
          }
          for(u32 lane=0;lane<4;++lane){const u32 at=unit+lane;next_c[at]=logistic(gate_values[2][lane])*out_c[state+at]+logistic(gate_values[0][lane])*hyperbolic(gate_values[3][lane]);next_h[at]=logistic(gate_values[1][lane])*hyperbolic(next_c[at]);out[((t*directions+d)*batch+b)*hidden+at]=next_h[at];}
        }
        for(;unit<hidden;++unit){float gate_values[4];
          for(u32 gate=0;gate<4;++gate){const u32 col=gate*hidden+unit,wi=p[8]?d*gates+col:d,ri=p[9]?d*gates+col:d;
            if(!(ws[wi]>0.0f)||!(rs[ri]>0.0f)||!__builtin_isfinite(ws[wi])||!__builtin_isfinite(rs[ri]))return 1;
            const int zw=quantized(wz,wi,p[6]),zr=quantized(rz,ri,p[7]);int wx=0,rh=0;
            for(u32 i=0;i<features;++i)wx+=(static_cast<int>(qx[(t*batch+b)*features+i])-xz)*(quantized(w,(d*features+i)*gates+col,p[6])-zw);
            for(u32 i=0;i<hidden;++i)rh+=(static_cast<int>(qh[i])-hz)*(quantized(r,(d*hidden+i)*gates+col,p[7])-zr);
            gate_values[gate]=static_cast<float>(wx)*xs*ws[wi]+static_cast<float>(rh)*hs*rs[ri]+bias[d*8*hidden+col]+bias[d*8*hidden+gates+col];
          }
          next_c[unit]=logistic(gate_values[2])*out_c[state+unit]+logistic(gate_values[0])*hyperbolic(gate_values[3]);next_h[unit]=logistic(gate_values[1])*hyperbolic(next_c[unit]);out[((t*directions+d)*batch+b)*hidden+unit]=next_h[unit];
        }
        for(u32 i=0;i<hidden;++i){out_h[state+i]=next_h[i];out_c[state+i]=next_c[i];}
      }
    }
  }return 0;
}

static double read_number(const unsigned char* src,u32 index,u32 type) {
  return type==1?reinterpret_cast<const float*>(src)[index]:type==6?reinterpret_cast<const i32*>(src)[index]:quantized(src,index,type==3);
}
extern "C" int pn_kokoro_cast(const unsigned char* input,unsigned char* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){const double x=read_number(input,i,p[1]);
    if(p[2]==1)reinterpret_cast<float*>(out)[i]=static_cast<float>(x);
    else if(p[2]==9)out[i]=x!=0.0;
    else if(p[2]==6){if(!__builtin_isfinite(x)||x< -2147483648.0||x>=2147483648.0)return 1;reinterpret_cast<i32*>(out)[i]=static_cast<i32>(x);}
    else {if(!__builtin_isfinite(x)||x< -2147483648.0||x>=2147483648.0)return 1;out[i]=static_cast<unsigned char>(static_cast<i32>(x));}
  }return 0;
}
extern "C" int pn_kokoro_gather(const unsigned char* input,const i32* indices,unsigned char* out,const u32* p) {
  for(u32 j=0;j<p[2];++j)if(indices[j]<-static_cast<int>(p[3])||indices[j]>=static_cast<int>(p[3]))return 1;
  for(u32 i=0;i<p[0];++i){int selected=indices[(i/p[1])%p[2]];if(selected<0)selected+=p[3];
    const u32 source=((i/(p[1]*p[2]))*p[3]+selected)*p[1]+i%p[1];for(u32 j=0;j<p[4];++j)out[i*p[4]+j]=input[source*p[4]+j];
  }return 0;
}
template<u32 Op> static int integer_binary_run(const i32* a,const i32* b,i32* out,u32 count,u32 astep,u32 bstep) {
  for(u32 i=0;i<count;++i){const long long x=a[i*astep],y=b[i*bstep];
    if(Op==2&&!y)return 1;const long long z=Op==0?x+y:Op==1?x*y:Op==2?x/y:x-y;
    if(z<(-2147483647ll-1)||z>2147483647ll)return 1;out[i]=static_cast<i32>(z);
  }return 0;
}
extern "C" int pn_kokoro_integer_binary(const i32* a,const i32* b,i32* out,const u32* p) {
  const u32 rank=p[1],width=rank?p[8+rank-1]:1,astep=rank?p[16+rank-1]:0,bstep=rank?p[24+rank-1]:0;
  // Broadcasting changes at outer-axis boundaries; map once per contiguous inner run.
  for(u32 i=0;i<p[0];i+=width){
    const i32* lhs=a+mapped(i,rank,p+8,reinterpret_cast<const int*>(p+16));
    const i32* rhs=b+mapped(i,rank,p+8,reinterpret_cast<const int*>(p+24));int status;
    switch(p[2]){
      case 0:status=integer_binary_run<0>(lhs,rhs,out+i,width,astep,bstep);break;
      case 1:status=integer_binary_run<1>(lhs,rhs,out+i,width,astep,bstep);break;
      case 2:status=integer_binary_run<2>(lhs,rhs,out+i,width,astep,bstep);break;
      default:status=integer_binary_run<3>(lhs,rhs,out+i,width,astep,bstep);break;
    }if(status)return status;
  }return 0;
}
extern "C" int pn_kokoro_power(const float* a,const float* b,float* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){const float x=a[mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+16))],y=b[mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+24))];if(y!=2.0f&&y!=3.0f)return 1;out[i]=y==2.0f?x*x:x*x*x;}return 0;
}
extern "C" void pn_kokoro_range(unsigned char* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){if(p[3]==1)reinterpret_cast<float*>(out)[i]=float_bits(p[1])+static_cast<float>(i)*float_bits(p[2]);
    else reinterpret_cast<i32*>(out)[i]=static_cast<i32>(static_cast<long long>(static_cast<i32>(p[1]))+static_cast<long long>(i)*static_cast<i32>(p[2]));}
}
extern "C" void pn_kokoro_fill(unsigned char* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){if(p[1]==1||p[1]==6)reinterpret_cast<u32*>(out)[i]=p[2];else out[i]=static_cast<unsigned char>(p[2]);}
}
extern "C" void pn_kokoro_compare(const unsigned char* a,const unsigned char* b,unsigned char* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){const double x=read_number(a,mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+16)),p[3]),y=read_number(b,mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+24)),p[3]);out[i]=p[2]==0?x==y:p[2]==1?x<y:p[2]==2?x>y:p[2]==3?x>=y:p[2]==4?x<=y:(x!=0.0&&y!=0.0);}
}
extern "C" void pn_kokoro_where(const unsigned char* condition,const unsigned char* yes,const unsigned char* no,unsigned char* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){const bool select=condition[mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+16))];const unsigned char* src=(select?yes:no)+mapped(i,p[1],p+8,reinterpret_cast<const int*>(p+(select?24:32)))*p[2];for(u32 j=0;j<p[2];++j)out[i*p[2]+j]=src[j];}
}
extern "C" void pn_kokoro_pad(const float* input,float* out,const u32* p) {
  for(u32 i=0;i<p[0];++i){u32 index=i,source=0;bool outside=false;
    for(int axis=static_cast<int>(p[1])-1;axis>=0;--axis){int x=static_cast<int>(index%p[8+axis])-static_cast<int>(p[16+axis]);index/=p[8+axis];const int size=static_cast<int>(p[24+axis]);if(x<0||x>=size){outside=true;if(p[2]==1)x=x<0?0:size-1;else if(p[2]==2)x=x<0?-x:2*size-x-2;}source+=static_cast<u32>(x)*p[32+axis];}
    out[i]=outside&&!p[2]?float_bits(p[3]):input[source];
  }
}
