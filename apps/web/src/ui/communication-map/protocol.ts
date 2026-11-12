import type { PublicPhoto } from '../../profile-photo-api';
import type {Traffic} from './layout.js';
export type MapNode={provider?:string|null;id:string;name:string|null;ownerId?:string|null;ownerName?:string|null;personId?:string;photo?:PublicPhoto|null;character?:import('@mlswarm/contracts').PersonCharacter|null};
export type MapRequest={kind:'init';dimensions?:2|3;peopleRing?:boolean;nodes:(Pick<MapNode,'id'|'ownerId'>&{person?:boolean})[];traffic:Traffic[]}|{kind:'traffic';traffic:Traffic[]}|{kind:'step';sequence:number;at:number;elapsedMs:number};
export type MapReply={kind:'seed';points:Float64Array}|{kind:'frame';sequence:number;points:Float64Array}|{kind:'error';message:string};

/** Callers may hold full message objects; project explicitly at the worker boundary. */
export const metadataTraffic=(rows:Traffic[]):Traffic[]=>rows.map(({agentId,to,audience,createdAt})=>({agentId,to:[...to],audience,createdAt}));
