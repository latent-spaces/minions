# 120 BPM soundtrack + in-key effects for the Minions brag video. Writes music.wav (48k stereo, 20.0s).
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR=48000; DUR=20.0; N=int(SR*DUR); BEAT=0.5; S16=BEAT/4
rng=np.random.default_rng(7)
L=np.zeros(N); R=np.zeros(N)
def hz(m): return 440*2**((m-69)/12)
def add(sig,t,gain=1.0,pan=0.0):
    i=int(round(t*SR));
    if i>=N: return
    s=sig[:N-i]*gain
    L[i:i+len(s)]+=s*np.sqrt((1-pan)/2)*1.414/2*2**.5
    R[i:i+len(s)]+=s*np.sqrt((1+pan)/2)*1.414/2*2**.5
def env(n,a=0.003,d=0.2):
    t=np.arange(n)/SR; e=np.minimum(1,t/a)*np.exp(-t/d); return e
def lp(x,f,o=2): return sosfilt(butter(o,f,'low',fs=SR,output='sos'),x)
def hp(x,f,o=2): return sosfilt(butter(o,f,'high',fs=SR,output='sos'),x)

def pluck(m,dur=0.35,bright=1.0):
    n=int(dur*SR); t=np.arange(n)/SR; f=hz(m)
    x=np.sin(2*np.pi*f*t)+0.35*np.sin(2*np.pi*2*f*t)*bright+0.12*np.sin(2*np.pi*3*f*t)*bright
    return x*env(n,0.002,dur/4)
def kick():
    n=int(0.35*SR); t=np.arange(n)/SR; f=48+90*np.exp(-t/0.03)
    return np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.001,0.12)
def clap():
    n=int(0.25*SR); x=rng.standard_normal(n); x=hp(lp(x,4500),900)
    return x*env(n,0.002,0.06)
def hat():
    n=int(0.06*SR); x=hp(rng.standard_normal(n),7000); return x*env(n,0.001,0.015)
def bass(m,dur):
    n=int(dur*SR); t=np.arange(n)/SR; f=hz(m)
    x=np.sin(2*np.pi*f*t)+0.25*np.sin(2*np.pi*2*f*t); return lp(x*env(n,0.004,dur*0.7),900)
def pad(ms,dur):
    n=int(dur*SR); t=np.arange(n)/SR; x=np.zeros(n)
    for m in ms:
        for det in (-0.08,0.08): x+=np.sin(2*np.pi*hz(m+det)*t)+0.3*np.sin(2*np.pi*hz(m+12+det)*t)
    a=np.minimum(1,t/0.25)*np.minimum(1,(dur-t)/0.3); return lp(x*a,2500)/len(ms)
def blip(m):
    n=int(0.18*SR); t=np.arange(n)/SR; f=hz(m)*(1+0.15*np.exp(-t/0.01))
    return np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.002,0.05)
def tick():
    n=int(0.02*SR); return hp(rng.standard_normal(n),3000)*env(n,0.0005,0.004)
def swell(dur=0.5):
    n=int(dur*SR); t=np.arange(n)/SR; x=rng.standard_normal(n)
    x=sosfilt(butter(2,[800,6000],'band',fs=SR,output='sos'),x); return x*(t/dur)**2.5

# C  Am  F  G  (bar = 2s)
CH=[[60,64,67],[57,60,64],[53,57,60],[55,59,62]]; ROOT=[36,33,29,31]
for bar in range(10):
    t0=bar*2.0; ch=CH[bar%4]; root=ROOT[bar%4]
    last=bar==9
    # pad: always (quiet), carries intro and outro
    add(pad(ch,2.05 if not last else 2.0),t0,0.10 if bar else 0.13)
    # arp: 16ths from bar 0; up-down pattern
    pat=[0,1,2,1,0,2,1,2]
    for k in range(16):
        tt=t0+k*S16
        if last and tt>=19.5: break
        m=ch[pat[k%8]]+12+(12 if k%8==7 else 0)
        add(pluck(m,0.3,0.8),tt,0.10 if bar==0 else 0.13,pan=(-0.35 if k%2 else 0.35))
    if bar==0: continue
    for b in range(4):
        tb=t0+b*BEAT
        if tb>=19.5: break
        add(kick(),tb,0.55)
        if b in (1,3): add(clap(),tb,0.16)
        for h in (0.25,): add(hat(),tb+h,0.07,pan=0.2)
        add(bass(root,0.22),tb,0.30); add(bass(root,0.2),tb+0.25,0.18)

# Effects, all on the 16th grid, in key, sitting under the music
POP=[67,69,72,74,76,79,81]  # C major pentatonic up the row
for i in range(7): add(blip(POP[i]+12),2.0+i*0.25,0.10,pan=-0.5+i/7)
add(blip(72+12),0.0,0.08)                     # first fox
for k in range(int((8.55-6.85)/S16)): add(tick(),6.875+k*S16,0.035,pan=0.1)  # typing
add(blip(76+12),9.25,0.08); add(blip(79+12),9.375,0.08); add(blip(84),9.5,0.08)  # agents started
for t in (15.75,16.25): add(tick(),t,0.12); add(blip(72+12),t,0.05)              # clicks
add(blip(79+12),16.375,0.07)                                                      # answered
for t in (4.0,6.5,10.0,14.0,17.0): add(swell(0.5),t-0.5,0.035)                     # scene cuts
add(pad([48,55,64,72],3.0),17.0,0.10)                                              # outro lift

mix=np.stack([L,R],1)
# glue: gentle soft clip, fade tail
mix=np.tanh(mix*1.2)/np.tanh(1.2)
fade=np.ones(N); fn=int(0.6*SR); fade[-fn:]=np.linspace(1,0,fn)**1.5
mix*=fade[:,None]
mix*=0.89/np.max(np.abs(mix))
wavfile.write('music.wav',SR,(mix*32767).astype(np.int16))
print('peak ok',mix.shape)
