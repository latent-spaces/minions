import { z } from 'zod';
import { db, profiles, type Profile } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertCommunityActor, type CommunityActor } from './identity.js';
import { GITHUB_USERNAME } from '../projects/github-username.js';
import express from 'express';
import { requestLimits } from '../request-state.js';
import { createHash } from 'node:crypto';
import { publicPersonAppearance } from './profile-photo-ref.js';
import { githubPhotoSource, profileOperations, preparePhotoPublication, readProfilePhoto } from './profile-photos.js';
import { PERSON_CHARACTERS, type MyProfile } from '@mlswarm/contracts';
import { DISPLAY_NAME } from '../display-name.js';

export const MY_PROFILE = z.object({
  name: DISPLAY_NAME,
  bio: z.string().trim().max(500),
  linkedinProfileUrl: z.string().trim().max(300).regex(/^https:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?$/, 'Enter your LinkedIn profile URL.').nullable(),
  expected_revision: z.number().int().min(0),
  client_request_id: z.uuid(),
  photo: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), publicConsent: z.literal(true) }).strict().nullable(),
  character: z.enum(PERSON_CHARACTERS).nullable().optional(),
}).strict();

function profileOf(person: Profile, id: string, githubPhotoAvailable = false): MyProfile {
  return { id, name: person.name, bio: person.profile?.bio ?? '',
    linkedinProfileUrl: person.profile?.linkedinProfileUrl ?? null, revision: person.profileRevision ?? 0,
    ...publicPersonAppearance(person, id), githubPhotoAvailable, githubUsername: person.githubUsername ?? null, email: person.email };
}

// Public identity is deliberately independent of private memberships, invitation
// emails, provider accounts and profile write metadata.
async function readPublicProfile(id: string) {
  const missing = () => new Refusal('not_found', 'This profile is unavailable.');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw missing();
  const person = (await profiles.doc(id).get()).data();
  if (!person || person.removedAt !== null) throw missing();
  // Match the directory's display-name boundary, including legacy invitation records.
  const name = MY_PROFILE.shape.name.safeParse(person.name);
  if (!name.success) throw missing();
  const github = GITHUB_USERNAME.safeParse(person.githubUsername);
  const linkedin = MY_PROFILE.shape.linkedinProfileUrl.safeParse(person.profile?.linkedinProfileUrl);
  const bio = MY_PROFILE.shape.bio.safeParse(person.profile?.bio ?? '');
  return { id, name: name.data, ...publicPersonAppearance(person, id), bio: bio.success ? bio.data : '',
    githubUsername: github.success ? github.data : null, linkedinProfileUrl: linkedin.success ? linkedin.data : null };
}

export function publicProfileRoutes(now: () => number) {
  const router = express.Router(), admission = requestLimits.limiter(() => 'public-person-profile', 60, 60_000);
  // Two 50-message history pages plus surrounding identities fit each 30-second burst without consuming JSON quota.
  const photoAdmission = requestLimits.limiter(() => 'public-person-photo', 120, 30_000);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.status(405).set('Allow', 'GET').json({ message: 'Profiles are read-only here.' }); return; }
    const isPhoto = /^\/[^/]+\/photo\/[^/]+\/?$/.test(req.path);
    const retry = (isPhoto ? photoAdmission : admission)(req.ip ?? 'unknown', now());
    if (retry > 0) { res.status(429).set('Retry-After', String(Math.ceil(retry / 1000))).json({ message: isPhoto ? 'Wait before loading more profile photos.' : 'Wait before loading another profile.' }); return; }
    next();
  });
  router.get('/:personId/photo/:photoId', (req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ message: 'Photo reads do not accept filters.' }); return; }
    void readProfilePhoto(String(req.params.personId), String(req.params.photoId), null, now).then(bytes =>
      res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').type('image/webp').send(bytes),
      () => res.status(404).json({ message: 'This photo is unavailable.' }));
  });
  router.get('/:id', (req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ message: 'A profile lookup does not accept filters.' }); return; }
    void readPublicProfile(String(req.params.id)).then(profile => res.json(profile), error => {
      if (error instanceof Refusal) res.status(404).json({ message: error.message });
      else { console.error('Public profile read failed.', error); res.status(500).json({ message: 'Something went wrong loading this profile. Try again in a moment.' }); }
    });
  });
  router.use((_req, res) => res.status(404).json({ message: 'This profile is unavailable.' }));
  return router;
}
export async function readMyProfile(actor: CommunityActor) {
  if (actor.kind !== 'person') throw new Refusal('forbidden', 'Sign in to read your profile.');
  const githubAvailable = await githubPhotoSource(actor).then(Boolean).catch(() => false);
  return db.runTransaction(async tx => { const { operator } = await assertCommunityActor(tx, actor); return profileOf(operator, operator.id, githubAvailable); });
}
export async function saveMyProfile(actor: CommunityActor, input: unknown, now: () => number = Date.now) {
  if (actor.kind !== 'person') throw new Refusal('forbidden', 'Only you can edit your profile.');
  const parsed = MY_PROFILE.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', z.prettifyError(parsed.error));
  const { expected_revision, client_request_id, photo, character, ...desired } = parsed.data;
  const fingerprint = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  const githubAvailable = await githubPhotoSource(actor).then(Boolean).catch(() => false);
  const result = await db.runTransaction(async tx => {
    const { operator } = await assertCommunityActor(tx, actor), current = profileOf(operator, operator.id, githubAvailable);
    const receiptRef = profileOperations(operator.id).doc(client_request_id);
    const prior = (await tx.get(receiptRef)).data();
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      // A receipt acknowledges the earlier save. It never writes or revives old state.
      return prior.profile as MyProfile;
    }
    if (current.revision !== expected_revision) throw new Refusal('proposal_conflict', 'Your profile was changed somewhere else. Reload it, then edit again.');
    const publication = await preparePhotoPublication(tx, operator.id, operator, photo, now);
    const same = current.name === desired.name && current.bio === desired.bio
      && current.linkedinProfileUrl === desired.linkedinProfileUrl && (current.photo?.id ?? null) === (photo?.id ?? null)
      && (character === undefined || (current.character ?? null) === character);
    const updated: Profile = { ...operator, name: desired.name, profile: { bio: desired.bio, linkedinProfileUrl: desired.linkedinProfileUrl },
      profileRevision: current.revision + (same ? 0 : 1), photo: publication.photo,
      ...(character !== undefined ? { character } : {}) };
    const saved = profileOf(updated, operator.id, githubAvailable);
    if (!same) {
      tx.update(profiles.doc(operator.id), { name: updated.name, profile: updated.profile!, profileRevision: saved.revision, photo: publication.photo,
        ...(character !== undefined ? { character } : {}) });
      publication.commit();
    }
    tx.create(receiptRef, { fingerprint, profile: saved, createdAt: now() });
    return saved;
  });
  return result;
}
