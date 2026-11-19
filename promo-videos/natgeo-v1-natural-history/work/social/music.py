# Documentary score + SFX + narration mix for "Minions: A Natural History". Writes mix.wav (48k stereo).
import json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly
SR=48000; DUR=48.1; N=int(SR*DUR); rng=np.random.default_rng(7)
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
soc=json.load(open('stage/social.json')); segs=[]; st=0
for g in soc['segments']: segs.append((st,g)); st+=g['d']
def m(x):
    for s0,g in segs:
        if g['a']<=x<=g['b']: return s0+(x-g['a'])/(g['b']-g['a'])*g['d']
    return None
def at(x,fn,*a):
    v=m(x)
    if v is not None: fn(v,*a)
S=[s0 for s0,_ in segs]  # A B C D E F G H I J
harp(0.15,[62,66,69,74,78,81,86],0.07); pad(0.2,D,1.9); pad(S[1],G,3.2,0.24)
walk=[50,54,57,54,55,59,62,59,57,61,64,61,50,54,57,54]
for k in range(17): add(pluck(walk[k%16]+12,0.35),S[2]+k*0.32,0.28,pan=(-1)**k*0.3)
pad(S[2],D,5.5,0.12); pad(S[3],Em,2.0,0.18); pad(S[3]+2.0,A,1.6,0.22)
at(25.3,whoosh)
for i,x in enumerate(np.arange(26.9,28.7,0.11)): at(x,click)
at(30.25,click); v=m(30.25); harp(v,[62,66,69,74,78,81,86,90],0.04,0.35); pad(v,D,1.2,0.26)
for i in range(6): at(30.6+i*0.1,pop,74+i*2)
pad(S[4],G,2.5,0.16); pad(S[4]+2.5,D,2.6,0.16)
for x in [35.2,36.0,36.8,37.4,38.2,38.9,40.0]: at(x,blip,81+int(rng.integers(0,8)))
sneak=[59,62,61,59,58,59,None,54,59,62,64,62,61,None,57,54]
for k in range(17):
    n=sneak[k%16]
    if n: add(pluck(n,0.25),S[5]+k*0.34,0.3,pan=0.2)
pad(S[5],Bm,3.0,0.1); pad(S[5]+3.0,Fs,2.8,0.12); pad(S[6],D,2.4,0.2); pad(S[6]+2.4,G,2.4,0.2)
pad(S[7],D,2.9,0.2); pad(S[7]+2.9,G,2.9,0.2)
for k in range(9): add(pluck([74,78,81,78][k%4],0.6),S[7]+0.2+k*0.62,0.12)
pad(S[8],[50,55,57,62],4.0,0.18); at(88.6,click); at(89.6,click); v=m(89.6); harp(v,[69,74,78,81],0.06,0.3)
timp(S[9]-1.4,1.4); pad(S[9],[38]+D+[74],5.8,0.32); harp(S[9]+0.1,[62,66,69,74,78,81,86,90,93],0.09,0.3)
M*=0.55
V=np.zeros((N,2)); env=np.zeros(N)
for s0,g in segs:
    if 'vo' not in g: continue
    k,off=g['vo']; path=f'social/vo/{k}.wav' if k!='end1' else 'vo/end1.wav'
    a,_=sf.read(path); a=resample_poly(a,2,1); a=lp(hp(a,90),9000); add(a,s0+off,1.0,0,V); i=int((s0+off)*SR); env[i:i+len(a)]=1
k=int(0.3*SR); env=np.convolve(env,np.ones(k)/k,'same'); M*=(1-0.45*env)[:,None]
out=M+V*0.9; fade=np.ones(N); fn=int(0.8*SR); fade[-fn:]=np.linspace(1,0,fn); out*=fade[:,None]
out/=max(1e-9,np.abs(out).max())/0.89
sf.write('social/mix.wav',out,SR); print('ok')
