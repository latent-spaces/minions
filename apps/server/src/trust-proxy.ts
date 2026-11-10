import { isIP } from 'node:net';

// Express trusts no proxy by default, so req.ip is the socket peer. Behind Hosting and Cloud Run that peer is
// likely Google’s front end, so every limit keyed on req.ip would be one bucket shared by all visitors. TRUST_PROXY
// opts in explicitly: a hop count, or named subnets and CIDRs. `true` is refused because it lets any caller
// choose its own address through X-Forwarded-For. Unset keeps the default.
export type TrustProxy = number | string[];

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

function subnet(token: string): boolean {
  if (NAMED.has(token)) return true;
  const [address, prefix, extra] = token.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  return prefix === undefined || (/^(?:0|[1-9]\d{0,2})$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
}

export function trustProxySetting(raw: string | undefined): TrustProxy | undefined {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false' || value === '0') return undefined;
  if (/^[1-9]\d?$/.test(value)) return Number(value);
  const tokens = value.split(',').map(token => token.trim());
  if (tokens.every(subnet)) return tokens;
  throw new Error(`TRUST_PROXY must be a hop count from 1 to 99, or a comma-separated list of loopback, linklocal, `
    + `uniquelocal and IP/CIDR values. ${JSON.stringify(raw)} is neither.`);
}
