import type { PublicPhoto } from '../profile-photo-api';
import { PersonAvatar } from './PersonAvatar';
import type { ReactNode } from 'react';
import type { MyProfileData } from '../community-api';
import './profile-page.css';
import { GitHubIcon } from './GitHubIcon';
import { LinkedInIcon } from './LinkedInIcon';

export function ProfileSummary({ profile, own = false, hideName = false, children }: { profile: Pick<MyProfileData, 'name' | 'bio' | 'githubUsername' | 'linkedinProfileUrl'> & { id?: string; photo?: PublicPhoto | null }; own?: boolean; hideName?: boolean; children?: ReactNode }) {
  return <div className="k42-profile-summary">
    <div className="k42-profile-identity"><PersonAvatar id={profile.id} name={profile.name} photo={profile.photo} size={56} /><div>{!hideName && <h2>{profile.name}</h2>}
      <p className={profile.bio ? 'body' : 'muted'}>{profile.bio || (own ? 'Add a short bio to introduce yourself.' : 'No bio added yet.')}</p></div></div>
    {(profile.githubUsername || profile.linkedinProfileUrl || own) && <div className="k42-profile-links">
      {profile.githubUsername && <a href={`https://github.com/${profile.githubUsername}`} target="_blank" rel="noreferrer"><GitHubIcon />github.com/{profile.githubUsername}</a>}
      {profile.linkedinProfileUrl && <a href={profile.linkedinProfileUrl} target="_blank" rel="noreferrer"><LinkedInIcon />{profile.linkedinProfileUrl.replace('https://','')}</a>}
      {!profile.githubUsername && !profile.linkedinProfileUrl && <p className="muted">No profile links added yet.</p>}
    </div>}
    {children}
  </div>;
}
