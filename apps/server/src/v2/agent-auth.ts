import type { Request } from 'express';
import { agentByToken } from '../store/profiles.js';

export async function agentFromRequest(req: Request) {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  return token ? agentByToken(token) : null;
}
