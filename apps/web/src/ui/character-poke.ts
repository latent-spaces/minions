// Squash poses/timing adapted from page-mascot, Copyright (c) 2026 Kamran Ahmed.
// MIT license: ./licenses/page-mascot.txt. Upstream 76a44ed9180063bf4852b9dd724b656f4a828ac7.
export const SQUASH_MS=420;
export const SQUASH:Keyframe[]=[
  {transform:'scale(1, 1)',easing:'ease-in'},
  {transform:'scale(1.10, 0.86)',offset:.18,easing:'ease-out'},
  {transform:'scale(0.95, 1.08)',offset:.45,easing:'ease-in-out'},
  {transform:'scale(1.03, 0.97)',offset:.72,easing:'ease-in-out'},
  {transform:'scale(1, 1)'},
];
export const POKE_WEIGHTS=[['poke',55],['smile',20],['wink',15],['surprise',7],['rare',3]] as const;
export type PokeReaction=typeof POKE_WEIGHTS[number][0];
export function choosePoke(random:number):PokeReaction {
  if(!Number.isFinite(random)||random<0||random>=1)throw new RangeError('Poke randomness must be between zero and one.');
  let cumulative=0;
  for(const [reaction,weight] of POKE_WEIGHTS){cumulative+=weight;if(random*100<cumulative)return reaction;}
  return 'rare';
}
export const pokeDuration=(reaction:PokeReaction)=>reaction==='rare'?1200:reaction==='smile'?850:reaction==='wink'?650:reaction==='surprise'?800:560;
export function pokeCell(reaction:PokeReaction,elapsed:number):number {
  if(elapsed<120)return 1;
  if(reaction==='rare')return elapsed<300?6:elapsed<900?7:8;
  return reaction==='smile'?2:reaction==='wink'?5:reaction==='surprise'?4:0;
}
export class CharacterPoke {
  private began=-Infinity;
  private reaction:PokeReaction='poke';
  sample(now:number):{reaction:PokeReaction;cell:number;elapsed:number}|null {
    const elapsed=now-this.began;
    return elapsed<pokeDuration(this.reaction)?{reaction:this.reaction,cell:pokeCell(this.reaction,elapsed),elapsed}:null;
  }
  start(now:number,reaction:PokeReaction):boolean {
    if(this.sample(now))return false;
    this.began=now;this.reaction=reaction;return true;
  }
  cancel(){this.began=-Infinity;}
}
/** Direct pokes have no autonomous cooldown, but only one wild reward starts at a time. */
export class RarePokeGate {
  private until=0;
  claim(now:number){if(now<this.until)return false;this.until=now+1200;return true;}
}
export const rarePokeGate=new RarePokeGate();
