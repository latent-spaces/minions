# Documentary score + SFX + narration mix for "Minions: A Natural History". Writes mix.wav (48k stereo).
import json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly
SR=48000; DUR=113.0; N=int(SR*DUR); rng=np.random.default_rng(7)
M=np.zeros((N,2))
def hz(m): return 440*2**((m-69)/12)
def lp(x,f): return sosfilt(butter(2,f,'low',fs=SR,output='sos'),x)
def hp(x,f): return sosfilt(butter(2,f,'high',fs=SR,output='sos'),x)
def add(x,t,g=1.0,pan=0.0,buf=None):
    buf=M if buf is None else buf; i=int(t*SR)
    if i>=N: return
    x=x[:N-i]*g; buf[i:i+len(x),0]+=x*np.sqrt((1-pan)/2)*1.41; buf[i:i+len(x),1]+=x*np.sqrt((1+pan)/2)*1.41
def strings(notes,dur,att=1.2,rel=1.5):
    n=int((dur+rel)*SR); t=np.arange(n)/SR; x=np.zeros(n)
    for m in notes:
        for d in (-0.08,0.0,0.07):
            f=hz(m)*2**(d/12); ph=rng.random()
            vib=1+0.003*np.sin(2*np.pi*5.2*t+ph*6)
            x+=2*((f*t*vib+ph)%1)-1
    x=lp(x,1400)/ (len(notes)*3)
    e=np.minimum(1,t/att)*np.where(t<dur,1,np.exp(-(t-dur)/(rel/3)))
    return x*e
def pluck(m,dur=0.5,bright=0.5):
    f=hz(m); p=int(SR/f); n=int(dur*SR); buf=rng.uniform(-1,1,p); out=np.zeros(n)
    for i in range(n):
        out[i]=buf[i%p]; buf[i%p]=bright*buf[i%p]+(1-bright)*0.5*(buf[i%p]+buf[(i+1)%p])*0.996 if False else 0.5*(buf[i%p]+buf[(i+1)%p])*0.994
    return lp(out,3000)*np.exp(-np.arange(n)/SR/0.18)
def harp(start,notes,step=0.06,g=0.35):
    for k,m in enumerate(notes): add(pluck(m,1.2),start+k*step,g,pan=-0.4+0.8*k/len(notes))
def timp(t0,dur=1.6):
    n=int(dur*SR); t=np.arange(n)/SR; roll=np.zeros(n)
    for k in range(int(dur*18)): i=int(k/18*SR); roll[i:i+2400]+=np.sin(2*np.pi*73*np.arange(min(2400,n-i))/SR)*np.exp(-np.arange(min(2400,n-i))/SR/0.08)
    add(lp(roll*(t/dur)**1.5,400),t0,0.5)
def blip(t,m,g=0.12): n=int(.25*SR); tt=np.arange(n)/SR; add(np.sin(2*np.pi*hz(m)*tt)*np.exp(-tt/0.06),t,g,pan=rng.uniform(-.6,.6))
def click(t): n=int(.03*SR); add(hp(rng.standard_normal(n),2500)*np.exp(-np.arange(n)/SR/0.004),t,0.25)
def whoosh(t,d=0.9): n=int(d*SR); tt=np.arange(n)/SR; add(lp(rng.standard_normal(n),2000)*np.sin(np.pi*tt/d)**2,t,0.18)
def pop(t,m): n=int(.15*SR); tt=np.arange(n)/SR; add(np.sin(2*np.pi*hz(m)*(1+tt*4)*tt)*np.exp(-tt/0.04),t,0.15,pan=rng.uniform(-.5,.5))
D,G,Bm,A,Em,Fs=[50,57,62,66],[43,55,59,62],[47,54,59,62],[45,57,61,64],[40,55,59,64],[42,54,57,61]
def pad(t,ch,d,g=0.22): add(strings(ch,d),t,g)
# open
harp(0.2,[62,66,69,74,78,81,86],0.08); pad(0.3,D,3.3); pad(3.6,G,3.3); pad(6.9,Bm,2.0); pad(8.9,A,2.0); pad(10.9,D,2.5,0.28)
# chapter harps
for c in (13.4,32.4,47.6,66.0,79.4,92.0): harp(c+0.05,[74,78,81,86,90],0.07,0.25)
# release: pizz walk, tension, resolution
walk=[50,54,57,54,55,59,62,59,57,61,64,61,50,54,57,54]
for k in range(30): add(pluck(walk[k%16]+12,0.35),15.2+k*0.32,0.28,pan=(-1)**k*0.3)
pad(15.0,D,9.8,0.12); pad(24.8,Em,3.0,0.18); pad(27.8,A,2.5,0.22); harp(30.25,[62,66,69,74,78,81,86,90],0.04,0.35); pad(30.3,D,2.3,0.28)
whoosh(25.3); click(30.25)
for i,tt in enumerate(np.arange(26.9,28.7,0.075)): click(tt) if i%2==0 else None
for i in range(6): pop(30.6+i*0.1,74+i*2)
# communication: soft pad + message blips
pad(34.0,G,4.5,0.16); pad(38.5,D,4.5,0.16); pad(43.0,A,4.6,0.16)
for s in [35.2,36.0,36.8,37.4,38.2,38.9,40.6,41.2,41.9,42.5,43.1,43.6,44.2,44.8,45.4,46.0,46.6,47.1]: blip(s,81+int(rng.integers(0,8)))
# divide: sneaky tiptoe pizz in B minor, then resolve
sneak=[59,62,61,59,58,59,None,54,59,62,64,62,61,None,57,54]
for k in range(26):
    m=sneak[k%16]
    if m: add(pluck(m,0.25),49.3+k*0.34,0.3,pan=0.2)
pad(49.2,Bm,4.5,0.1); pad(53.7,Fs,4.6,0.12); pad(58.4,D,3.4,0.2); pad(61.8,G,4.0,0.2)
for i in range(4): pop(voat:=0,0) if False else None
# feed: warm, gentle
pad(67.6,D,3.0,0.2); pad(70.6,G,3.0,0.2); pad(73.6,Bm,3.0,0.2); pad(76.6,A,2.6,0.2)
for k in range(12): add(pluck([74,78,81,78][k%4],0.6),68.0+k*0.9,0.12)
# help: suspended, resolve on send
pad(81.0,[50,55,57,62],7.5,0.18); add(pluck(81,1.0),83.8,0.2); click(88.6); click(89.6); harp(89.65,[69,74,78,81],0.06,0.3); pad(89.6,D,2.4,0.2)
# rest: descending, quieter
pad(93.7,G,3.0,0.16); pad(96.7,Em,3.0,0.14); pad(99.7,A,3.0,0.12)
# ending
timp(101.8,1.6); pad(103.3,[38]+D+[74],7.5,0.32); harp(103.4,[62,66,69,74,78,81,86,90,93],0.09,0.3)
add(pluck(86,1.5),106.4,0.12); pad(110.0,D,2.2,0.12)
M*=0.55
# narration
dur=json.load(open('vo/durations.json'))
starts={'open1':2.6,'open2':10.9,'rel1':15.2,'rel2':24.9,'com1':34.2,'com2':40.5,'div1':49.4,'div2':58.5,'feed1':67.8,'feed2':72.7,'help1':81.2,'help2':87.2,'rest1':93.8,'end1':103.4,'end2':107.2}
V=np.zeros((N,2)); env=np.zeros(N)
for k,s in starts.items():
    a,_=sf.read(f'vo/{k}.wav'); a=resample_poly(a,2,1); a=lp(hp(a,90),9000)
    add(a,s,1.0,0,V); i=int(s*SR); env[i:i+len(a)]=1
# duck music under voice (smoothed)
k=int(0.3*SR); env=np.convolve(env,np.ones(k)/k,'same'); M*=(1-0.45*env)[:,None]
out=M+V*0.9
fade=np.ones(N); fn=int(1.2*SR); fade[-fn:]=np.linspace(1,0,fn); out*=fade[:,None]
out/=max(1e-9,np.abs(out).max())/0.89
sf.write('mix.wav',out,SR); print('ok',DUR)
