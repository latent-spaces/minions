import { useEffect, useState } from 'react';
import { readProjectScreenshot } from './progress-api';
import type { SessionUser } from './session-identity';

// A project's cover is the screenshot on its newest update. Each image is read once per account
// and kept for the page's life; the few stamps a page shows make that cheap.
const loaded = new Map<string, Promise<string | null>>();
function coverUrl(user: SessionUser, projectId: string, cover: string) {
  const key = `${user.uid}\0${projectId}\0${cover}`;
  let url = loaded.get(key);
  if (!url) {
    url = readProjectScreenshot(projectId, user, { id: cover }).then(blob => URL.createObjectURL(blob), () => { loaded.delete(key); return null; });
    loaded.set(key, url);
  }
  return url;
}

/** Loaded cover URLs by project id, for the projects that have one. */
export function useProjectCovers(user: SessionUser, projects: { id: string; cover?: string }[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const wanted = projects.filter(p => p.cover).map(p => `${p.id}\0${p.cover}`).sort().join('\n');
  useEffect(() => {
    let alive = true;
    for (const line of wanted ? wanted.split('\n') : []) {
      const [id, cover] = line.split('\0');
      void coverUrl(user, id, cover).then(url => { if (alive && url) setUrls(current => current[id] === url ? current : { ...current, [id]: url }); });
    }
    return () => { alive = false; };
  }, [user, wanted]);
  return urls;
}
