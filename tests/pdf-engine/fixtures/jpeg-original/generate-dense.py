# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
# Original maximum-length Huffman/dense-AC vector; direct 2D IDCT reference.
from pathlib import Path
import hashlib,json,math,sys

output=Path(sys.argv[1]);output.mkdir(parents=True,exist_ok=False)
width=int(sys.argv[2])if len(sys.argv)>2 else 8
assert 8<=width<=128 and width%8==0
sha=lambda data:hashlib.sha256(data).hexdigest()
def marker(code,data):return bytes([255,code])+(len(data)+2).to_bytes(2,'big')+data
zigzag=[0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63]
coefficients=[]
for channel in range(4):
 values=[0]*64
 for k in range(1,64):values[zigzag[k]]=(512+(k*31+channel*53)%512)*(-1 if (k+channel)%3==0 else 1)
 coefficients.append(values)
bits=[]
for mcu in range((width//8)**2):
 for channel in [3,1,0,2]:
  bits.append('0'*16) # Sole DC category0 code at length16.
  for k in range(1,64):
   value=coefficients[channel][zigzag[k]]
   bits.append('0'*16+format(value if value>=0 else value+1023,'010b'))
entropy=''.join(bits);codedBits=len(entropy);entropy+='1'*((-len(entropy))%8)
encodedEntropy=bytearray()
for at in range(0,len(entropy),8):
 value=int(entropy[at:at+8],2);encodedEntropy.append(value)
 if value==255:encodedEntropy.append(0)
dht=marker(196,bytes([0])+bytes([0]*15+[1])+bytes([0])+bytes([16])+bytes([0]*15+[1])+bytes([10]))
frame=bytes([8])+width.to_bytes(2,'big')*2+bytes([4])+b''.join(bytes([channel,17,0])for channel in range(4))
scan=bytes([4])+b''.join(bytes([channel,0])for channel in [3,1,0,2])+bytes([0,63,0])
jpeg=bytes([255,216])+marker(219,bytes([0])+bytes([1]*64))+dht+marker(192,frame)+marker(218,scan)+encodedEntropy+bytes([255,217])
planes=[]
for values in coefficients:
 planes.append([max(0,min(255,math.floor(128+.25*math.fsum((1/math.sqrt(2)if u==0 else 1)*(1/math.sqrt(2)if v==0 else 1)*values[v*8+u]*math.cos((2*x+1)*u*math.pi/16)*math.cos((2*y+1)*v*math.pi/16)for v in range(8)for u in range(8))+.5)))for y in range(8)for x in range(8)])
expected=bytes(planes[channel][(y%8)*8+x%8]for y in range(width)for x in range(width)for channel in range(4))
name='dense-long-huffman';(output/(name+'.jpg')).write_bytes(jpeg);(output/(name+'.expected')).write_bytes(expected)
report={'scope':'Original sole16-bit canonical Huffman codes, all63 AC coefficients populated at category10, reordered scan. Independent direct2D IDCT, no external decoder code. Bounded diagnostic, no performance acceptance.','width':width,'height':width,'scanOrder':[3,1,0,2],'blocks':4*(width//8)**2,'symbols':64*4*(width//8)**2,'maximumCodeLength':16,'codedBits':codedBits,'maximumAbsoluteSampleDifference':1,'input':{'path':name+'.jpg','bytes':len(jpeg),'sha256':sha(jpeg)},'expected':{'path':name+'.expected','bytes':len(expected),'sha256':sha(expected)}}
(output/(name+'.json')).write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report))
