# 120 BPM soundtrack + in-key effects for brag v8 (v4 music with a resolved C ending at 18.0 and effects re-timed to the picture). Writes music.wav (48k stereo, 20.0s).
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

# C  Am  F  G  (bar = 2s); bar 8 builds F -> G, and bar 9 lands on C at 18.0 and rings out.
CH=[[60,64,67],[57,60,64],[53,57,60],[55,59,62]]; ROOT=[36,33,29,31]
F_,G_,C_=[53,57,60],[55,59,62],[60,64,67]
END=18.0  # the final hit, on the bar line
for bar in range(9):
    t0=bar*2.0
    halves=[(CH[bar%4],ROOT[bar%4])]*2 if bar<8 else [(F_,29),(G_,31)]
    for h,(ch,root) in enumerate(halves):
        th=t0+h*1.0
        add(pad(ch,1.05),th,0.10 if bar else 0.13)
        pat=[0,1,2,1,0,2,1,2]
        for k in range(8):
            tt=th+k*S16; kk=h*8+k
            m=ch[pat[kk%8]]+12+(12 if kk%8==7 else 0)
            add(pluck(m,0.3,0.8),tt,(0.10 if bar==0 else 0.13)*(1+0.5*(bar==8)*(tt-16)/2),pan=(-0.35 if kk%2 else 0.35))
        if bar==0: continue
        for b in range(2):
            tb=th+b*BEAT; beat=h*2+b
            add(kick(),tb,0.55)
            if beat in (1,3): add(clap(),tb,0.16)
            add(hat(),tb+0.25,0.07,pan=0.2)
            add(bass(root,0.22),tb,0.30); add(bass(root,0.2),tb+0.25,0.18)
# fill into the ending: a clap roll on the last beat, then a swell
for i,tt in enumerate(np.arange(17.5,18.0,S16)): add(clap(),tt,0.07+0.03*i)
add(swell(0.5),END-0.5,0.05)

# the ending: a resolved C chord that rings out over the poster hold
def bell(m,dur):
    n=int(dur*SR); t=np.arange(n)/SR; f=hz(m)
    x=np.sin(2*np.pi*f*t)+0.3*np.sin(2*np.pi*2*f*t)*np.exp(-t/0.4)+0.08*np.sin(2*np.pi*3*f*t)*np.exp(-t/0.2)
    return x*np.minimum(1,t/0.003)*np.exp(-t/0.75)
add(kick(),END,0.6); add(clap(),END,0.12)
n=int(2.0*SR); tb=np.arange(n)/SR; add(lp((np.sin(2*np.pi*hz(36)*tb)+0.25*np.sin(2*np.pi*hz(48)*tb))*np.minimum(1,tb/0.004)*np.exp(-tb/0.7),900),END,0.34)
for i,m in enumerate([60,64,67,72,76]): add(bell(m+12,2.0),END+i*0.012,0.075,pan=-0.3+0.15*i)
for i,m in enumerate([72,76,79,84]): add(blip(m+12),END+0.125+i*S16,0.05-0.008*i,pan=0.4-0.25*i)  # sparkle up
n=int(2.0*SR); tp=np.arange(n)/SR; xp=np.zeros(n)
for m in [48,55,64,72]:
    for det in (-0.08,0.08): xp+=np.sin(2*np.pi*hz(m+det)*tp)
add(lp(xp*np.minimum(1,tp/0.05)*np.exp(-tp/0.9),2200)/4,END,0.12)

# Effects, on the 16th grid, in key, matched to v8's picture
add(blip(72+12),0.0,0.08)                                                          # first fox
for i,m in enumerate([67,69,72,74,76,79,81,84]): add(blip(m+12),2.0+i*0.0625*1.5,0.07,pan=-0.6+i*0.17)  # the crowd ripples out
add(blip(67+12),4.375,0.08); add(blip(72+12),4.4375,0.06)                          # the crowd gathers into the row
for k in range(int(2.0/S16)): add(tick(),5.875+k*S16,0.035,pan=0.1)                # typing, 5.85-7.85
add(blip(76+12),8.0625,0.06)                                                       # tool call
add(blip(79+12),8.5,0.08); add(blip(81+12),8.625,0.08); add(blip(84+12),8.75,0.08)  # agents started
for t in (15.25,15.75): add(tick(),t,0.12); add(blip(72+12),t,0.05)                # clicks: choice, send
add(blip(79+12),15.875,0.07)                                                       # answered
for t in (4.0,5.5,10.0,14.0,17.0): add(swell(0.5),t-0.5,0.035)                     # scene cuts
add(pad(G_,1.0),17.0,0.08)                                                         # outro lift on the dominant

mix=np.stack([L,R],1)
# glue: gentle soft clip, fade tail
mix=np.tanh(mix*1.2)/np.tanh(1.2)
fade=np.ones(N); fn=int(0.25*SR); fade[-fn:]=np.linspace(1,0,fn)  # only guards against a click; the chord has already decayed
mix*=fade[:,None]
mix*=0.89/np.max(np.abs(mix))
wavfile.write('music.wav',SR,(mix*32767).astype(np.int16))
print('peak ok',mix.shape)
