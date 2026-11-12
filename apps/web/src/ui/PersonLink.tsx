import type { PublicPhoto } from '../profile-photo-api';
import { PersonAvatar } from './PersonAvatar';
import './profile-page.css';

/** A person's name, with their avatar when asked. */
export function PersonLink({ id, name, photo, character, avatar = false }: { id: string; name: string | null; photo?: PublicPhoto | null; character?: import('@mlswarm/contracts').PersonCharacter | null; avatar?: boolean }) {
  return <span className="k42-person-link">
    {avatar && <PersonAvatar id={id} name={name} photo={photo} character={character} />}<span>{name ?? 'Removed person'}</span>
  </span>;
}
