# 150 BPM chaotic soundtrack + in-key impacts. Writes music.wav (48k stereo, 20.0s).
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR=48000; DUR=20.0; N=int(SR*DUR); B=0.4; S16=B/4; BAR=4*B
rng=np.random.default_rng(11)
L=np.zeros(N); R=np.zeros(N)
def hz(m): return 440*2**((m-69)/12)
def add(sig,t,gain=1.0,pan=0.0):
    i=int(round(t*SR))
    if i>=N or i<0: return
    s=sig[:N-i]*gain
    L[i:i+len(s)]+=s*np.sqrt(1-pan); R[i:i+len(s)]+=s*np.sqrt(1+pan)
def env(n,a=0.002,d=0.2):
    t=np.arange(n)/SR; return np.minimum(1,t/a)*np.exp(-t/d)
def lp(x,f,o=2): return sosfilt(butter(o,f,'low',fs=SR,output='sos'),x)
def hp(x,f,o=2): return sosfilt(butter(o,f,'high',fs=SR,output='sos'),x)
def saw(f,n): t=np.arange(n)/SR; return 2*((t*f)%1)-1
def kick():
    n=int(0.3*SR); t=np.arange(n)/SR; f=50+140*np.exp(-t/0.025)
    x=np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.001,0.11); return np.tanh(x*1.8)
def snare():
    n=int(0.22*SR); t=np.arange(n)/SR
    x=hp(lp(rng.standard_normal(n),7000),1200)*env(n,0.001,0.07)+0.5*np.sin(2*np.pi*190*t)*env(n,0.001,0.04); return x
def hat(open_=False):
    n=int((0.18 if open_ else 0.05)*SR); return hp(rng.standard_normal(n),8000)*env(n,0.001,0.06 if open_ else 0.012)
def bass(m,dur):
    n=int(dur*SR); x=saw(hz(m),n)+0.5*np.sin(2*np.pi*hz(m-12)*np.arange(n)/SR)
    return lp(x*env(n,0.003,dur*0.6),700)
def stab(ms,dur=0.25):
    n=int(dur*SR); x=sum(saw(hz(m),n)+saw(hz(m)*1.006,n) for m in ms)/len(ms)
    return lp(x*env(n,0.002,0.09),3200)
def lead(m,dur=0.18):
    n=int(dur*SR); t=np.arange(n)/SR; f=hz(m)
    x=np.sign(np.sin(2*np.pi*f*t))*0.5+np.sin(2*np.pi*2*f*t)*0.3; return lp(x*env(n,0.002,0.07),4500)
def impact():
    n=int(0.9*SR); t=np.arange(n)/SR; f=40+60*np.exp(-t/0.05)
    x=np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.001,0.35)+0.4*lp(rng.standard_normal(n),2500)*env(n,0.001,0.12)
    return np.tanh(x*1.5)
def riser(dur):
    n=int(dur*SR); t=np.arange(n)/SR; x=rng.standard_normal(n)
    x=sosfilt(butter(2,[1500,9000],'band',fs=SR,output='sos'),x); return x*(t/dur)**2
def blip(m):
    n=int(0.12*SR); t=np.arange(n)/SR; return np.sin(2*np.pi*hz(m)*t)*env(n,0.001,0.04)

# Am F C G
CH=[[57,60,64],[53,57,60],[48,52,55],[55,59,62]]; ROOT=[33,29,36,31]
nb=int(DUR/B)
for b in range(nb):
    t=b*B; bar=int(t//BAR); ch=CH[bar%4]; root=ROOT[bar%4]
    if t>=19.6: break
    intro=t<1.6          # sparse intro: hats + stabs only
    breakdown=12.0<=t<12.4 or 15.6<=t<16.0
    if not intro and not breakdown:
        add(kick(),t,0.6)
        if b%2==1: add(snare(),t,0.28)
        add(bass(root,0.18),t+0.2,0.32); add(bass(root+12 if b%4==3 else root,0.16),t+0.3,0.22)
    for k in range(4):
        add(hat(open_=(k==2 and not intro)),t+k*S16,0.07 if k!=2 else 0.09,pan=0.25)
    if b%4==0: add(stab([m+12 for m in ch],0.3),t,0.14 if not intro else 0.18,pan=-0.15)
    # lead riff on 8ths after the drop
    if t>=3.2:
        riff=[0,2,1,2,0,1,2,1]
        for k in range(2):
            m=ch[riff[(b*2+k)%8]]+24
            add(lead(m),t+k*0.2,0.06,pan=0.3*(-1)**(b+k))

# Slams / cuts: impacts on scene hits, risers into the drops
for t in (0.0,0.8,3.2,6.4,6.8,7.6,10.8,12.0,13.2,14.4,15.2,16.4):
    add(impact(),t,0.32)
add(riser(1.6),1.6,0.07); add(riser(0.8),2.4,0.05)
for i,t in enumerate((1.6,2.0,2.4,2.8)): add(blip(69+i*5+12),t,0.08)   # multiply steps, A minor up
for k in range(int(0.5/0.025)): add(hat(),5.7+k*0.025,0.03)              # super-fast typing (32nd grid)
for t in (8.4,9.2,11.0,13.6,15.6): add(blip(76+12),t,0.06)
add(stab([69,72,76,81],1.2),16.4,0.12)

mix=np.stack([L,R],1)
mix=hp(mix.T,30).T
mix=np.tanh(mix*1.1)/np.tanh(1.1)
fade=np.ones(N); fn=int(0.5*SR); fade[-fn:]=np.linspace(1,0,fn)**1.5
mix*=fade[:,None]; mix*=0.9/np.max(np.abs(mix))
wavfile.write('music.wav',SR,(mix*32767).astype(np.int16)); print('ok')
