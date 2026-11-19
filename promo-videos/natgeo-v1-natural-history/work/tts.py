import json, sys, soundfile as sf, numpy as np
from kokoro import KPipeline
p = KPipeline(lang_code='b')
out = {}
for k, line in json.load(open('narration.json')):
    a = np.concatenate([x for _,_,x in p(line, voice='bm_george', speed=0.88)])
    sf.write(f'vo/{k}.wav', a, 24000); out[k] = round(len(a)/24000, 2); print(k, out[k])
json.dump(out, open('vo/durations.json','w'), indent=1)
