# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
from datetime import datetime,timezone
import math,json,hashlib
base=Path(__file__).parent;out=Path(__import__('sys').argv[1])if len(__import__('sys').argv)>1 else base/'generated';out.mkdir(parents=True,exist_ok=False);sha=lambda d:hashlib.sha256(d).hexdigest()
zigzag=[0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63]
def marker(code,data):return bytes([255,code])+len(data+bytes(2)).to_bytes(2,'big')+data
dc=list(range(12));ac=[0,240]+[run*16+size for run in range(16)for size in range(1,11)];dht=marker(196,bytes([0])+bytes([0,0,0,12]+[0]*12)+bytes(dc)+bytes([16])+bytes([0]*7+[len(ac)]+[0]*8)+bytes(ac))
class Bits:
 def __init__(self):self.data=bytearray();self.bits=''
 def add(self,n,width):self.bits+=format(n,f'0{width}b') if width else'';self.drain()
 def drain(self):
  while len(self.bits)>=8:
   byte=int(self.bits[:8],2);self.bits=self.bits[8:];self.data.append(byte)
   if byte==255:self.data.append(0)
 def finish(self):
  if self.bits:self.bits+='1'*(8-len(self.bits));self.drain()
 def restart(self,index):self.finish();self.data.extend([255,208+index])
def block(bits,coefficients,previous):
 difference=coefficients[0]-previous;size=abs(difference).bit_length();bits.add(dc.index(size),4);bits.add(difference if difference>=0 else difference+(1<<size)-1,size);zeros=0
 for k in range(1,64):
  value=coefficients[zigzag[k]]
  if not value:zeros+=1;continue
  while zeros>=16:bits.add(ac.index(240),8);zeros-=16
  size=abs(value).bit_length();bits.add(ac.index(zeros*16+size),8);bits.add(value if value>=0 else value+(1<<size)-1,size);zeros=0
 if zeros:bits.add(ac.index(0),8)
 return coefficients[0]
def idct(coefficients):
 return [max(0,min(255,math.floor(128+.25*math.fsum((1/math.sqrt(2)if u==0 else 1)*(1/math.sqrt(2)if v==0 else 1)*coefficients[v*8+u]*math.cos((2*x+1)*u*math.pi/16)*math.cos((2*y+1)*v*math.pi/16)for v in range(8)for u in range(8))+.5)))for y in range(8)for x in range(8)]
def make(name,width,height,sampling,coeff,order=(0,1,2,3),restart=0):
 maxh=max(h for h,v in sampling);maxv=max(v for h,v in sampling);cols=math.ceil(width/(maxh*8));rows=math.ceil(height/(maxv*8));bits=Bits();previous=[0]*4;planes=[bytearray(cols*h*8*rows*v*8)for h,v in sampling];mcu=0;rst=0
 for row in range(rows):
  for column in range(cols):
   if mcu and restart and mcu%restart==0:bits.restart(rst);rst=(rst+1)%8;previous=[0]*4
   for channel in order:
    h,v=sampling[channel];stride=cols*h*8
    for by in range(v):
     for bx in range(h):
      coefficients=coeff(channel,row,column,by,bx);previous[channel]=block(bits,coefficients,previous[channel]);samples=idct(coefficients)
      for y in range(8):
       offset=((row*v+by)*8+y)*stride+(column*h+bx)*8;planes[channel][offset:offset+8]=samples[y*8:y*8+8]
   mcu+=1
 bits.finish();frame=bytes([8])+height.to_bytes(2,'big')+width.to_bytes(2,'big')+bytes([4])+b''.join(bytes([channel,h*16+v,0])for channel,(h,v)in enumerate(sampling));scan=bytes([4])+b''.join(bytes([channel,0])for channel in order)+bytes([0,63,0]);encoded=bytes([255,216])+marker(219,bytes([0])+bytes([1]*64))+dht+marker(192,frame)+(marker(221,restart.to_bytes(2,'big'))if restart else b'')+marker(218,scan)+bits.data+bytes([255,217]);expected=bytearray()
 for y in range(height):
  for x in range(width):
   for c,(h,v)in enumerate(sampling):
    realw=math.ceil(width*h/maxh);realh=math.ceil(height*v/maxv);sx=(x+.5)*h/maxh-.5;sy=(y+.5)*v/maxv-.5;left=math.floor(sx);top=math.floor(sy);fx=sx-left;fy=sy-top;stride=cols*h*8
    def at(px,py):return planes[c][max(0,min(realh-1,py))*stride+max(0,min(realw-1,px))]
    value=at(left,top)*(1-fx)*(1-fy)+at(left+1,top)*fx*(1-fy)+at(left,top+1)*(1-fx)*fy+at(left+1,top+1)*fx*fy;expected.append(math.floor(value+.5))
 jpeg=out/f'{name}.jpg';raw=out/f'{name}.expected';jpeg.write_bytes(encoded);raw.write_bytes(expected);return {'id':name,'input':{'path':str(jpeg),'bytes':len(encoded),'sha256':sha(encoded)},'expected':{'path':str(raw),'bytes':len(expected),'sha256':sha(expected)},'width':width,'height':height,'sampling':sampling,'scanOrder':order,'restartInterval':restart,'stuffedBytes':encoded.count(bytes([255,0])),'rawSampleBound':1}
def constant(c,r,x,by,bx):
 result=[0]*64;result[0]=([16,64,128,224][c]-128)*8;return result
def ac_case(c,r,x,by,bx):
 result=constant(c,r,x,by,bx);result[[1,8,9,63][c]]=[32,-24,17,1023][c];return result
def varied(c,r,x,by,bx):
 result=[0]*64;result[0]=((32+27*c+17*r+13*x+7*by+5*bx)%220-128)*8;return result
records=[make('dc-only',8,8,[(1,1)]*4,constant),make('ac-and-stuffing',8,8,[(1,1)]*4,ac_case),make('restart-reset',24,16,[(1,1)]*4,varied,restart=1),make('odd-crop',9,9,[(1,1)]*4,varied),make('reordered-scan',16,8,[(1,1)]*4,varied,order=(3,0,2,1)),make('subsample-rows',33,35,[(2,2),(1,1),(1,1),(2,2)],varied)]
assert next(r for r in records if r['id']=='ac-and-stuffing')['stuffedBytes']>0
report={'createdAt':datetime.now(timezone.utc).isoformat(),'scope':'Original authoredT.81baselineentropy/DCprediction/ACzigzag/restart/byte-stuffing/odd-crop/reordered-component/subsampling vectors. ExpectedIDCT uses direct2Dmathsum, implementation uses separablebasis; no externaldecoder code. No colourtransform/polarity acceptance.','sourceSha256':sha(Path(__file__).read_bytes()),'records':records};(out/'manifest.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps({'records':len(records),'manifestSha256':sha((out/'manifest.json').read_bytes())}))
