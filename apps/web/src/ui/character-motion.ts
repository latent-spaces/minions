import { stableHash } from './avatar-tone.js';
import type { CommunicationAgentState } from '@mlswarm/contracts';

export type CharacterClip = 'neutral' | 'blink' | 'work-enter' | 'work-loop' | 'stop' | 'needs-you' | 'blocked' | 'message';
export type PoseBank = 'directions' | 'reactions' | 'actions';
export type CharacterPose = {clip:CharacterClip;bank:PoseBank;cell:number;frame:number;interruptible:boolean};
export function characterTiming(id:string) {
  const hash=stableHash(`character-motion:${id}`),interval=Math.round((12_000+hash%8_001)/.75);
  return {interval,offset:(hash>>>8)%interval,rate:.85+(hash>>>16)%31/100};
}
const quiet=(state:CommunicationAgentState)=>['offline','revoked','unknown'].includes(state);
const pose=(clip:CharacterClip,bank:PoseBank,cell:number,interruptible=false):CharacterPose=>({clip,bank,cell,frame:cell,interruptible});
export const neutralPose=()=>pose('neutral','directions',4,true);
export function staticCharacterPose(state:CommunicationAgentState):CharacterPose {
  return state==='needs_you'?pose('needs-you','actions',5):state==='blocked'?pose('blocked','actions',6)
    :state==='working'?pose('work-loop','actions',2):state==='talking'?pose('message','actions',7):neutralPose();
}

/** One semantic owner. These poses never change the actual worker state. */
export class CharacterMotion {
  private phase:'entry'|'base'|'work-enter'|'work-loop'|'stop'|'message'|'needs-you'|'blocked'='entry';
  private began:number;
  private lastMessage:string|null=null;
  private nextBlink:number;
  private blinkBegan=-Infinity;
  constructor(private state:CommunicationAgentState,now:number,private timing={interval:21_333,offset:0,rate:1}) {this.began=now;this.nextBlink=now+160+(timing.offset?timing.interval-timing.offset:0);}
  private destination(){return this.state==='working'?'work-enter':this.state==='needs_you'?'needs-you':this.state==='blocked'?'blocked':'base';}
  setState(state:CommunicationAgentState,now:number) {
    if(state===this.state)return;
    this.sample(now);
    const working=this.state==='working'||this.phase==='work-enter'||this.phase==='work-loop';
    this.state=state;
    if(quiet(state)){this.phase='base';this.began=now;return;}
    if(this.phase==='stop'&&['pausing','paused','stopped','completed','idle','talking','waiting','pause_unconfirmed'].includes(state))return;
    this.phase=working&&state!=='working'&&!['needs_you','blocked'].includes(state)?'stop':'entry';this.began=now;
  }
  message(id:string,now:number) {
    if(id===this.lastMessage)return;
    this.lastMessage=id;
    if(!['working','talking','idle','waiting','completed'].includes(this.state))return;
    this.phase='message';this.began=now;
  }
  afterPoke(now:number){this.blinkBegan=-Infinity;this.nextBlink=now+this.timing.interval;}
  /** Hidden views and reduced motion discard transient acting rather than replaying it on return. */
  settle(now:number) {
    this.phase=this.state==='working'?'work-loop':this.state==='needs_you'?'needs-you':this.state==='blocked'?'blocked':'base';this.began=now;this.blinkBegan=-Infinity;this.nextBlink=Math.max(this.nextBlink,now+this.timing.interval);
  }
  sample(now:number,allowBlink=true):CharacterPose {
    if(quiet(this.state))return {...neutralPose(),interruptible:false};
    let elapsed=Math.max(0,now-this.began);
    if(this.phase==='entry') {
      if(elapsed<160)return {...neutralPose(),interruptible:false};
      this.phase=this.destination();this.began+=160;elapsed-=160;
    }
    if(this.phase==='work-enter') {
      if(elapsed<400)return pose('work-enter','actions',elapsed<100?0:1);
      this.phase='work-loop';this.began+=400;elapsed-=400;
    }
    if(this.phase==='stop') {
      if(elapsed<400)return pose('stop','actions',elapsed<240?4:0);
      this.phase='base';this.began+=400;elapsed-=400;
    }
    if(this.phase==='message') {
      if(elapsed<160)return {...neutralPose(),interruptible:false};
      if(elapsed<640)return pose('message','actions',elapsed<400?7:8);
      this.phase=this.state==='working'?'work-loop':'base';this.began+=640;elapsed-=640;
    }
    if(this.phase==='needs-you')return pose('needs-you','actions',5);
    if(this.phase==='blocked')return pose('blocked','actions',6);
    if(this.phase==='work-loop')return pose('work-loop','actions',2+Math.floor((elapsed+this.timing.offset)*this.timing.rate/420)%2,true);
    // Talking: a short speaking pose every few seconds, otherwise the resting face.
    if(this.state==='talking'){const beat=((elapsed+this.timing.offset)*this.timing.rate)%2600;if(beat<520)return pose('message','actions',beat<260?7:8,true);}
    // A due blink waits for gaze/reward ownership to finish. Advancing its
    // deadline only when it actually starts avoids dropping or replaying blinks.
    if(now-this.blinkBegan<140)return pose('blink','reactions',1,true);
    if(now>=this.nextBlink&&allowBlink){this.blinkBegan=now;this.nextBlink=now+this.timing.interval;return pose('blink','reactions',1,true);}
    return neutralPose();
  }
}
