import { useEffect, useRef } from 'react';
import { Activity, Bot, FolderGit2, GitMerge, SlidersHorizontal } from 'lucide-react';
import { controlCenterRoute, formatRoute, type Route, type ControlCenterSection } from '../route';

export const controlCenterSections = [
  { id: 'status', label: 'Project status', icon: Activity },
  { id: 'merging', label: 'Merge rules', icon: GitMerge },
  { id: 'repository', label: 'Repository', icon: FolderGit2 },
  { id: 'agents', label: 'Agent instructions', icon: Bot },
  { id: 'features', label: 'Project features', icon: SlidersHorizontal },
] as const;

export function visibleControlSections({ owner }: { owner: boolean }) {
  return owner ? [...controlCenterSections] : [];
}

export function ControlCenterNavigation({ projectId, section, owner, go }: {
  projectId: string; section: ControlCenterSection; owner: boolean; go: (route: Route) => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const reveal = () => {
      const nav = navigation.current, selected = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !selected) return;
      const strip = nav.getBoundingClientRect(), item = selected.getBoundingClientRect();
      if (item.left < strip.left || item.right > strip.right) nav.scrollLeft += item.left - strip.left - (strip.width - item.width) / 2;
    };
    reveal(); window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [section]);
  return <nav ref={navigation} className="control-center-nav" aria-label="Settings sections">
    {visibleControlSections({ owner }).map(({ id, label, icon: Icon }) => <a key={id}
      href={formatRoute(controlCenterRoute(projectId, id))} aria-current={section === id ? 'page' : undefined}
      onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); go(controlCenterRoute(projectId, id)); }}>
      <Icon size={18} aria-hidden="true" /><span>{label}</span>
    </a>)}
  </nav>;
}
