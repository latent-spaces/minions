import { Check } from './icons';
import { useEffect, useState } from 'react';
import { PERSON_CHARACTERS, type MyProfile, type PersonCharacter, type SaveMyProfile } from '@minions/contracts';
import { community, session } from '../api';
import { saveProfile } from '../profile-photo-api';
import type { SessionUser } from '../session-identity';
import { PERSON_PORTRAITS } from './character-set';
import { CharacterAvatar } from './CharacterAvatar';
import { rememberPersonCharacter } from './person-character-store';
import { Button } from './Button';
import { pokeCharacter } from './AvatarPoke';
import './my-character.css';

// Each person character has its own name (owner, 16 November 2026).
const CHARACTER_NAMES: Record<string, string> = { 'person-01': 'Juno', 'person-02': 'Sage', 'person-03': 'Ruby', 'person-04': 'Maple', 'person-robot': 'Bolt', 'person-alien': 'Zib' };

export function MyCharacter({ user, active, onSaved }: { user: SessionUser; active: boolean; onSaved: () => void }) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [choice, setChoice] = useState<PersonCharacter | null>(null);
  const [pending, setPending] = useState<SaveMyProfile | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setError('');
    community<MyProfile>(user, '/my-profile').then(value => {
      if (!current || session.currentUid() !== user.uid) return;
      setProfile(value); setChoice(value.character ?? null); setPending(null);
      rememberPersonCharacter(value.id, value.character ?? null);
    }, failure => { if (current && session.currentUid() === user.uid) setError(failure.message); });
    return () => { current = false; };
  }, [user.uid, active, attempt]);
  async function save() {
    if (!profile || busy) return;
    const body = pending ?? { name: profile.name, bio: profile.bio,
      linkedinProfileUrl: profile.linkedinProfileUrl, expected_revision: profile.revision,
      client_request_id: crypto.randomUUID(), photo: profile.photo ? { id: profile.photo.id, publicConsent: true as const } : null,
      character: choice };
    setPending(body); setBusy(true); setError('');
    try {
      const value: MyProfile = await saveProfile(user, profile.id, body);
      if (session.currentUid() !== user.uid) return;
      setProfile(value); setChoice(value.character ?? null); setPending(null);
      rememberPersonCharacter(value.id, value.character ?? null); onSaved();
    } catch (failure) {
      if (session.currentUid() === user.uid) setError(failure instanceof Error ? failure.message : 'Could not save your character. Try again.');
    } finally { if (session.currentUid() === user.uid) setBusy(false); }
  }
  return <section className="settings-card my-character" aria-labelledby="my-character-title">
    <h3 id="my-character-title" className="settings-group-title">My character</h3>
    <div><p className="muted">Choose how you appear across your projects.</p>
      {!profile && !error && <p role="status">Loading your character…</p>}
      {profile && <><div className="my-character-choices" role="group" aria-label="Choose my character">
        {PERSON_CHARACTERS.map((id, index) => <button key={id} type="button" aria-pressed={choice === id}
          aria-label={CHARACTER_NAMES[id] ?? `Character ${index + 1}`} disabled={busy}
          onClick={event => { pokeCharacter(event.currentTarget); setChoice(id); setPending(null); setError(''); }}>
          <span className="my-character-preview" data-character-motion-root=""><CharacterAvatar character={id} animationKey={`choice:${id}`} src={PERSON_PORTRAITS[id]} /></span><span>{CHARACTER_NAMES[id] ?? `Character ${index + 1}`}</span>
        </button>)}
      </div><div className="my-character-save"><Button type="button" className="soft card-edit"
        disabled={busy || !pending && choice === (profile.character ?? null)}
        onClick={() => void save()}><Check size={14} aria-hidden="true" />{busy ? 'Saving…' : pending ? 'Try saving again' : 'Save character'}</Button>
      </div></>}
      {error && <p role="alert">{error}</p>}
      {error && <Button type="button" className="soft" disabled={busy}
        onClick={() => { setProfile(null); setPending(null); setAttempt(n => n + 1); }}>Reload my profile</Button>}
    </div>
  </section>;
}
