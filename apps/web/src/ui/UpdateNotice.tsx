import { useEffect, useState } from 'react';
import { RefreshCw } from './icons';
import { BUILD, newerBuildServed } from '../build-version';
import { refreshOnReturn } from '../refresh-on-return';
import './update-notice.css';

const CHECK_MS = 5 * 60_000;

// A tab opened before an update keeps running the old app, so it asks to be reloaded once a newer build is served.
// It never reloads by itself: the person may be in the middle of typing.
export function UpdateNotice() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV || stale) return;
    let live = true;
    const check = () => { void newerBuildServed(BUILD).then(newer => { if (live && newer) setStale(true); }); };
    const timer = window.setInterval(check, CHECK_MS), stop = refreshOnReturn(check);
    return () => { live = false; window.clearInterval(timer); stop(); };
  }, [stale]);
  if (!stale) return null;
  return <div className="k42-update-notice" role="status">
    <span>Minions was updated. Reload to get the new version.</span>
    <button type="button" className="primary" onClick={() => window.location.reload()}><RefreshCw size={16} aria-hidden="true" />Reload</button>
  </div>;
}
