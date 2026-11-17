import { createContext } from 'react';

/** Labs can inspect continuous gaze using the production renderer. App default is occasional. */
export const CharacterPreview = createContext<'gaze' | null>(null);
