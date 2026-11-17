// The background engine's graceful stop (owner, 13 November 2026). `minions stop` runs on the same computer and can
// read owner.json, so it proves itself with a key derived from that file's signing secret. Windows has no graceful
// signal for a detached process, so every platform stops through this one loopback request.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

/** The stop key for this owner file. It authorizes nothing but stopping this engine. */
export function engineStopKey(signingSecretHex: string): string {
  return createHmac('sha256', Buffer.from(signingSecretHex, 'hex')).update('minions-engine-stop-v1').digest('base64url');
}

export function engineStopRoute({ key, requestStop }: { key: string; requestStop(): void }) {
  const expected = Buffer.from(`Bearer ${key}`);
  const router = express.Router();
  router.post('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const given = Buffer.from(req.headers.authorization ?? '');
    // Browsers always send Origin on a POST; the stop command never does, so no web page can ask for a stop.
    if (!LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress ?? '') || req.headers.origin !== undefined
      || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(403).json({ message: 'Stop the engine with minions stop on this computer.' }); return;
    }
    res.status(202).json({ stopping: true });
    res.once('finish', () => setImmediate(requestStop));
  });
  return router;
}
