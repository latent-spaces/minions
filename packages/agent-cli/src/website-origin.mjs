// Public connector policy: standalone package code, independent of cloud tooling.
// The default is the local engine that npm run setup starts (owner decision, 10 November 2026);
// this repository no longer connects to the live site, so its hosts are refused even as an enrolled origin.
export const DEFAULT_WEBSITE_ORIGIN = 'http://127.0.0.1:8787';
const liveSite = ['karma42.ai', 'karma42-launch.web.app'];
// Subdomains such as www. are the live site too.
const isLiveSite = hostname => liveSite.some(host => hostname === host || hostname.endsWith(`.${host}`));

// An operator opts into exactly one independent service. Project/tool inputs
// cannot add origins. Require the canonical spelling, including any HTTPS port.
export function selfHostedWebsiteOrigin(env = process.env) {
  const value = env.MLSWARM_SELF_HOSTED_ORIGIN;
  if (value === undefined) return null;
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.origin !== value || url.username || url.password
    || url.hostname.endsWith('.') || url.hostname.includes('*') || isLiveSite(url.hostname)) {
    throw new Error('MLSWARM_SELF_HOSTED_ORIGIN must be one canonical HTTPS origin, without a path, credentials, query or fragment.');
  }
  return url.origin;
}

export function configuredWebsiteOrigin(env = process.env) {
  const enrolled = selfHostedWebsiteOrigin(env);
  if (enrolled && env.MLSWARM_SITE_URL !== undefined && env.MLSWARM_SITE_URL !== enrolled) {
    throw new Error('MLSWARM_SITE_URL must match MLSWARM_SELF_HOSTED_ORIGIN when a self-hosted origin is enrolled. Unset MLSWARM_SITE_URL or select the same canonical origin.');
  }
  return env.MLSWARM_SITE_URL ?? enrolled ?? DEFAULT_WEBSITE_ORIGIN;
}

export function trustedWebsiteUrl(value, env = process.env) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  // Configuration errors must remain actionable, including an empty export.
  configuredWebsiteOrigin(env);
  const enrolled = selfHostedWebsiteOrigin(env);
  return enrolled !== null && url.origin === enrolled
    || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
}
