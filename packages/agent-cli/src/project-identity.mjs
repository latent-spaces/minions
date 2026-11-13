import { isAbsolute } from 'node:path';
import { githubRepositoryUrl } from './github-repository.mjs';
function clean(value, label) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error(`Provide a valid ${label}.`);
  return value;
}
export function projectIdentity({ projectUrl, repo = 'https://github.com/placeholder/project', folder }) {
  let url;
  try { url = new URL(clean(projectUrl, 'project URL')); } catch { throw new Error('Use a MyLittleSwarm project service URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) || url.username || url.password || url.search || url.hash || !/^\/p\/[a-f0-9]{64}\/?$/.test(url.pathname)) throw new Error('Use an HTTPS project service URL ending in /p/PROJECT_ID, without credentials or query parameters.');
  clean(repo, 'GitHub repository URL');
  const repository = githubRepositoryUrl(repo);
  if (!repository) throw new Error('Use a GitHub repository URL without credentials, query parameters or fragments.');
  clean(folder, 'absolute project folder');
  if (!isAbsolute(folder)) throw new Error('Choose an absolute project folder.');
  // A bare "?" or "#" leaves search/hash empty but stays in href; build from parts.
  return { projectUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}`, repo: repository, folder };
}
