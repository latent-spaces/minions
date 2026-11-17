# 96 BPM warm soundtrack for the control cut. Writes music.wav (48k stereo, 20.0s). Bar = 2.5s.
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR=48000; DUR=20.0; N=int(SR*DUR); B=0.625; E=B/2; BAR=4*B
rng=np.random.default_rng(3)
L=np.zeros(N); R=np.zeros(N)
def hz(m): return 440*2**((m-69)/12)
def add(sig,t,gain=1.0,pan=0.0):
    i=int(round(t*SR))
    if i>=N or i<0: return
    s=sig[:N-i]*gain
    L[i:i+len(s)]+=s*np.sqrt(1-pan); R[i:i+len(s)]+=s*np.sqrt(1+pan)
def env(n,a=0.003,d=0.3):
    t=np.arange(n)/SR; return np.minimum(1,t/a)*np.exp(-t/d)
def lp(x,f,o=2): return sosfilt(butter(o,f,'low',fs=SR,output='sos'),x)
def hp(x,f,o=2): return sosfilt(butter(o,f,'high',fs=SR,output='sos'),x)
def keys(m,dur=1.2,vel=1.0):
    n=int(dur*SR); t=np.arange(n)/SR; f=hz(m)
    x=np.sin(2*np.pi*f*t)+0.25*np.sin(2*np.pi*2*f*t)*np.exp(-t/0.3)+0.12*np.sin(2*np.pi*7.01*f*t)*np.exp(-t/0.05)
    trem=1+0.08*np.sin(2*np.pi*4.5*t)
    return x*trem*env(n,0.004,dur/2.2)*vel
def kick():
    n=int(0.3*SR); t=np.arange(n)/SR; f=45+70*np.exp(-t/0.03)
    return lp(np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.002,0.13),300)
def rim():
    n=int(0.08*SR); t=np.arange(n)/SR
    return (np.sin(2*np.pi*1700*t)*0.5+hp(rng.standard_normal(n),2500)*0.6)*env(n,0.001,0.018)
def shaker():
    n=int(0.07*SR); x=hp(rng.standard_normal(n),6000); t=np.arange(n)/SR
    return x*np.minimum(1,t/0.012)*np.exp(-t/0.025)
def bass(m,dur):
    n=int(dur*SR); t=np.arange(n)/SR; x=np.sin(2*np.pi*hz(m)*t)+0.15*np.sin(2*np.pi*2*hz(m)*t)
    return x*np.minimum(1,t/0.01)*np.exp(-t/(dur*0.8))
def chime(m):
    n=int(0.6*SR); t=np.arange(n)/SR
    return (np.sin(2*np.pi*hz(m)*t)+0.3*np.sin(2*np.pi*hz(m+12)*t))*env(n,0.002,0.18)
def tick():
    n=int(0.03*SR); return lp(hp(rng.standard_normal(n),1500),6000)*env(n,0.0005,0.006)
def swell(dur):
    n=int(dur*SR); t=np.arange(n)/SR
    return lp(rng.standard_normal(n),1800)*(t/dur)**2

# F  Dm  Bb  C   (one chord per bar)
CH=[[65,69,72,76],[62,65,69,72],[58,62,65,69],[60,64,67,70]]; ROOT=[41,38,34,36]
for bar in range(8):
    t0=bar*BAR; ch=CH[bar%4]; root=ROOT[bar%4]; last=bar==7
    if last: ch=CH[0]; root=ROOT[0]
    # keys: chord on 1, gentle broken notes on the 'and's
    for k,m in enumerate(ch): add(keys(m-12,2.4,0.8),t0+k*0.012,0.07,pan=-0.2+k*0.13)
    for j,(off,m) in enumerate([(E*3,ch[2]),(E*5,ch[3]),(E*6,ch[1]+12)]):
        add(keys(m,0.9,0.7),t0+off,0.05,pan=0.3*(-1)**j)
    if bar==0: continue
    for b in range(4):
        tb=t0+b*B
        if tb>=19.4: break
        if b in (0,2): add(kick(),tb,0.38)
        if b in (1,3): add(rim(),tb,0.06,pan=0.15)
        add(shaker(),tb+E,0.03,pan=-0.3); add(shaker(),tb,0.018,pan=-0.3)
    add(bass(root,1.2),t0,0.22); add(bass(root,0.6),t0+B*2.5,0.14)

# effects, on the eighth grid, in F major
add(chime(84),0.0,0.05)
add(chime(81),2.5,0.05); add(chime(84),2.8125,0.05)
for t in (9.0625,13.75,14.375,15.625,16.25,16.875): add(tick(),t,0.10)
add(chime(88),9.0625,0.04); add(chime(84),14.375,0.04)
for t,m in zip((17.5,17.8125,18.125),(77,81,84)): add(chime(m),t,0.045)
for t in (5.0,7.5,10.0,12.5,15.0,17.5): add(swell(0.6),t-0.6,0.012)
add(keys(53,2.5,0.8),17.5,0.06); add(keys(77,2.5,0.6),17.5,0.04)

mix=np.stack([L,R],1)
mix=np.tanh(mix*1.1)/np.tanh(1.1)
fade=np.ones(N); fn=int(0.9*SR); fade[-fn:]=np.linspace(1,0,fn)**1.6
mix*=fade[:,None]; mix*=0.88/np.max(np.abs(mix))
wavfile.write('music.wav',SR,(mix*32767).astype(np.int16)); print('ok')
