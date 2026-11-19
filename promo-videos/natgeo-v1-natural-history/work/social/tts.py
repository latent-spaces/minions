import json,soundfile as sf,numpy as np
from kokoro import KPipeline
p=KPipeline(lang_code='b'); d={}
for k,line in json.load(open('social/narration.json')):
    a=np.concatenate([x for _,_,x in p(line,voice='bm_george',speed=0.9)]); sf.write(f'social/vo/{k}.wav',a,24000); d[k]=round(len(a)/24000,2); print(k,d[k])
json.dump(d,open('social/vo/durations.json','w'),indent=1)
