import { createContext, type CSSProperties } from 'react';
import measurements from './assets/characters/offbeat/poses/hat-gaze.json';

/** Only comparison labs opt out; production always follows the measured crown during gaze. */
export const FixedHatPreview = createContext(false);

type Offset = {dx:number;dy:number;rotate:number};
const styles = Object.fromEntries(Object.entries(measurements as Record<string,Offset[]>).map(([character,offsets]) => [character,
  Object.fromEntries(offsets.flatMap((offset,index) => [
    [`--hat-gaze-x${index}`,offset.dx], [`--hat-gaze-y${index}`,offset.dy], [`--hat-gaze-r${index}`,`${offset.rotate}deg`],
  ])) as CSSProperties,
])) as Record<string,CSSProperties>;
export const gazeHatStyle = (character:string) => styles[character];
