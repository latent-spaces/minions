import { useEffect, useState } from 'react';
import type { DirectoryMember } from '../community-directory';
import type { PublicProfileData } from '../community-api';
import { publicProfile } from '../api';
import { ParticipantPopup } from './ParticipantPopup';
import { ProfileSummary } from './ProfileSummary';
import { PersonAvatar } from './PersonAvatar';
import { Button } from './Button';

export function PersonProfilePopup({ person, onClose }: { person: DirectoryMember; onClose: () => void }) {
  const [profile, setProfile] = useState<PublicProfileData | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError('');
    publicProfile(person.id).then(result => { if (current) setProfile(result); }, failure => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [person.id, retry]);
  return <ParticipantPopup title={person.name ?? 'Project member'} onClose={onClose}>
    {profile ? <ProfileSummary profile={profile} hideName /> : <><PersonAvatar id={person.id} name={person.name} photo={person.photo} size={56} />{error ? <div role="alert"><p>{error}</p><Button onClick={() => setRetry(value => value + 1)}>Try again</Button></div> : <p role="status">Loading profile…</p>}</>}
  </ParticipantPopup>;
}
