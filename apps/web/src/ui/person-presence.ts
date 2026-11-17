import { createContext } from 'react';

// Presentation reads one shared observation; avatars never fetch individually.
export const PersonPresence = createContext<{
  register: (id: string, element: HTMLElement) => () => void;
  deadlines: ReadonlyMap<string, number>;
  now: number;
}>({ register: () => () => {}, deadlines: new Map(), now: 0 });
