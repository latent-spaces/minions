// Pure configuration validation: safe to read before opening a database.
export type GithubOAuthConfig = { clientId: string; clientSecret: string; origin: string };

/** The public web origin: HTTPS, or plain HTTP on 127.0.0.1 for an engine used on this computer only. */
export function publicOrigin(value: string | undefined): string | null {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { return null; }
  // Not 'localhost', which a hosts file or resolver can point elsewhere.
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || loopback) || url.origin !== value || url.username || url.password) return null;
  return url.origin;
}

/** Self-hosted GitHub sign-in settings. Partial or malformed settings are refused rather than half-enabled. */
export function readGithubOAuthConfig(env: NodeJS.ProcessEnv = process.env): GithubOAuthConfig {
  const clientId = env.MLSWARM_GITHUB_CLIENT_ID ?? '', clientSecret = env.MLSWARM_GITHUB_CLIENT_SECRET ?? '';
  const origin = publicOrigin(env.MLSWARM_PUBLIC_ORIGIN);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId) || !/^[A-Za-z0-9_-]{20,128}$/.test(clientSecret) || !origin) {
    throw new Error('Self-hosted GitHub sign-in needs MLSWARM_GITHUB_CLIENT_ID, MLSWARM_GITHUB_CLIENT_SECRET and an https (or loopback http) MLSWARM_PUBLIC_ORIGIN.');
  }
  return { clientId, clientSecret, origin };
}

