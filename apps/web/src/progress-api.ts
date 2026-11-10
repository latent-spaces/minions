import { session } from './api';
import { createProgressClient } from './progress-client';

export const { readProjectProgress, readProjectScreenshot } = createProgressClient(() => session.currentUid());
