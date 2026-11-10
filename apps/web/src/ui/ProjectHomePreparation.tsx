import { projectRoute, type Route } from '../route';
import { Button } from './Button';

/** A real project can exist before its repository/runtime setup is configured. */
export function ProjectHomePreparation({ owner, closed, projectId, go }: {
  owner: boolean; closed: boolean; projectId: string; go: (route: Route) => void;
}) {
  return <section className="k42-swarm-panel" aria-labelledby="project-preparation-title">
    <h2 id="project-preparation-title">{closed ? 'Project closed' : 'Project preparation'}</h2>
    <p>{closed ? 'This project is closed. Community and project details remain available.'
      : owner ? 'Finish setup in Control center to open the stage.'
      : 'The owner is preparing this project.'}</p>
    {owner && <Button type="button" onClick={() => go(projectRoute(projectId, 'control-center'))}>Open Control center</Button>}
  </section>;
}
