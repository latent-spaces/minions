/** Stable identity colors; repeated colors are intentional for large rosters.
 * Owner labels and highlighting carry identity when color alone is ambiguous. */
const colors=['#2563a6','#a13e69','#27806c','#92601d','#6b52a1','#b34c2c','#347a94','#6c7630','#95506f','#426947','#825b45','#5965a1'];
export function ownerColor(id:string|null|undefined){
 if(!id)return '#777777';let hash=2166136261;for(const character of id){hash^=character.codePointAt(0)!;hash=Math.imul(hash,16777619);}return colors[(hash>>>0)%colors.length];
}
