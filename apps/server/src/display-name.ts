import { z } from 'zod';

/** The one display-name rule, checked wherever a name is saved, so every stored name can be shown as it is. */
export const DISPLAY_NAME = z.string().trim().min(1, 'Enter your name.').max(80, 'Use a name of 80 characters or fewer.')
  .regex(/^[^\x00-\x1f\x7f-\x9f\u2028\u2029]+$/u, 'Use a name without control characters.').refine(name => !name.includes('@'), 'Use a name, not an email address.');
