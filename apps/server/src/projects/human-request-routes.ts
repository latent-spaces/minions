import express, { type Response } from 'express';
import { personIdentityFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { answerHumanRequest, readHumanRequests } from './human-requests.js';

function fail(res: Response, error: unknown) {
  if (error instanceof Refusal) sendRefusal(res, error);
  else { console.error('Needs you request failed.',error); res.status(500).json({error:'internal_error',message:'Something went wrong saving this. Try again in a moment.'}); }
}
export function humanRequestRoutes(now: () => number) {
  const router = express.Router(), limit = requestLimits.limiter(() => 'human-requests',60,60_000);
  router.use((_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.use(express.json({limit:'12kb'}));
  router.use((req,res,next) => {
    if (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body),'utf8') > 12*1024) { res.status(413).json({error:'bad_input',message:'This request is too large.'}); return; }
    const token = bearerToken(req.headers.authorization);
    if (!token) { fail(res,new Refusal('unauthorized','Sign in to open Needs you.')); return; }
    void personIdentityFromIdToken(token).then(async ({ person }) => {
      if (req.get('X-Mlswarm-Profile-Id') !== person.id) throw new Refusal('unauthorized','You’re now signed in to a different MyLittleSwarm account. Reload the page, then try again.');
      // Only answers and other writes have a budget; the owner's reads of Needs you are never refused.
      const delay = req.method === 'GET' ? 0 : limit(person.id,now());
      if (delay > 0) throw new Refusal('rate_limited','Too many requests. Wait a moment, then try again.',Math.ceil(delay/1000));
      res.locals.profileId = person.id; next();
    }).catch(error => fail(res,error));
  });
  router.get('/',(req,res) => { void readHumanRequests(res.locals.profileId,req.query).then(page=>res.json(page),error=>fail(res,error)); });
  router.post('/:id/answer',(req,res) => {
    if (Object.keys(req.query).length) { fail(res,new Refusal('bad_input','Answer requests do not accept filters.')); return; }
    void answerHumanRequest(res.locals.profileId,String(req.params.id),req.body,now).then(receipt=>res.json(receipt),error=>fail(res,error));
  });
  router.use((error: unknown,_req: express.Request,res: Response,next: express.NextFunction) => {
    const type = (error as {type?:string})?.type;
    if (type === 'entity.too.large' || type === 'entity.parse.failed') res.status(type === 'entity.too.large' ? 413 : 400).json({error:'bad_input',message:'Send a valid JSON request within 12 KiB.'});
    else next(error);
  });
  return router;
}
