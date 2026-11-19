import sys,json,soundfile as sf,numpy as np
from kokoro import KPipeline
p=KPipeline(lang_code='b'); k=sys.argv[1]; line=dict(json.load(open('narration.json')))[k]
a=np.concatenate([x for _,_,x in p(line,voice='bm_george',speed=0.88)]); sf.write(f'vo/{k}.wav',a,24000)
d=json.load(open('vo/durations.json')); d[k]=round(len(a)/24000,2); json.dump(d,open('vo/durations.json','w'),indent=1); print(k,d[k])
