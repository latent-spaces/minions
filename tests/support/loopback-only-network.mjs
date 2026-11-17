// Test-only guard for the standalone engine: while installed, this process may reach loopback
// addresses and local sockets (named pipes on Windows, Unix sockets elsewhere), and nothing else.
// - Every TCP/TLS connection in Node (fetch, http, https, http2 and gRPC) goes through
//   net.Socket.prototype.connect, which refuses outside hosts.
// - dns.lookup refuses outside names, and checks that loopback names really resolve to loopback.
// - dns.resolve*/reverse and dns.Resolver query a DNS server directly over UDP, so they are refused
//   outright; dgram sends to outside addresses are refused too.
// - Proxy settings are switched off, because a loopback proxy would tunnel to any outside host.
// Each refusal fails the call and is recorded, so a test can assert that nothing tried to leave the
// machine even when the caller retries or swallows the error.
// Scope: the current thread only. Worker threads and child processes load their own modules, so
// they need their own guard. No production code imports this module.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.']);
const loopbackName = name => LOOPBACK_NAMES.has(name) || name.endsWith('.localhost') || name.endsWith('.localhost.');
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true; // Node defaults to localhost.
  const name = String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (loopbackName(name) || name === '::1') return true;
  const v4 = name.startsWith('::ffff:') ? name.slice(7) : name;
  return net.isIPv4(v4) && v4.split('.')[0] === '127';
}

// Node calls connect(options, cb), connect(port, host, cb), connect(path, cb), or with its internal
// normalized [options, cb] array.
function target(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') return first.path !== undefined ? { path: first.path } : { host: first.host, port: first.port };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
}

// A proxy on loopback would let a client tunnel to any host through an allowed local connection
// (gRPC honours grpc_proxy/https_proxy). The guard turns proxies off and restores them exactly.
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GRPC_PROXY', 'NO_PROXY', 'NO_GRPC_PROXY']
  .flatMap(key => [key, key.toLowerCase()]);
const RESOLVER_METHOD = /^(resolve|reverse)/;

const refusal = what => Object.assign(new Error(`Loopback-only test network refused ${what}.`), { code: 'ERR_LOOPBACK_ONLY' });

let active = null;
/** Installs the guard for this thread. Returns the refusal log and uninstall(); only one guard at a time. */
export function installLoopbackOnlyNetwork() {
  if (active) throw new Error('The loopback-only network guard is already installed.');
  const refused = [];
  const restores = [];
  const patch = (owner, key, replace) => {
    const original = owner[key];
    owner[key] = replace(original);
    restores.push(() => { owner[key] = original; });
  };

  patch(net.Socket.prototype, 'connect', original => function guardedConnect(...args) {
    const to = target(args);
    if (to.path !== undefined || isLoopbackHost(to.host)) return original.apply(this, args);
    const what = `${to.host}:${to.port}`;
    refused.push(what);
    // Fail like a refused connection, asynchronously, so callers see their normal error path.
    process.nextTick(() => this.destroy(refusal(what)));
    return this;
  });

  // Loopback names still go through the system resolver (hosts file); only loopback answers pass.
  const onlyLoopbackAnswers = (hostname, done) => (error, address, family) => {
    if (error) return done(error);
    const answers = Array.isArray(address) ? address.map(entry => entry.address) : [address];
    if (answers.every(answer => isLoopbackHost(answer))) return done(null, address, family);
    refused.push(`dns:${hostname}->${answers.join(',')}`);
    done(refusal(`${hostname} resolving to ${answers.join(', ')}`));
  };
  // Looking up an IP literal sends no query (dgram binds 0.0.0.0 this way); connect/send check destinations.
  const ipLiteral = hostname => net.isIP(String(hostname ?? '').replace(/^\[(.*)\]$/, '$1')) !== 0;
  patch(dns, 'lookup', original => function guardedLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;
    if (ipLiteral(hostname)) return original.call(this, hostname, opts, done);
    if (isLoopbackHost(hostname)) return original.call(this, hostname, opts, onlyLoopbackAnswers(hostname, done));
    refused.push(`dns:${hostname}`);
    process.nextTick(() => done(refusal(`DNS lookup of ${hostname}`)));
    return {};
  });
  patch(dns.promises, 'lookup', original => async function guardedPromisesLookup(hostname, options) {
    if (ipLiteral(hostname)) return original.call(this, hostname, options);
    if (!isLoopbackHost(hostname)) { refused.push(`dns:${hostname}`); throw refusal(`DNS lookup of ${hostname}`); }
    const result = await original.call(this, hostname, options);
    const answers = (Array.isArray(result) ? result : [result]).map(entry => entry.address);
    if (answers.every(answer => isLoopbackHost(answer))) return result;
    refused.push(`dns:${hostname}->${answers.join(',')}`);
    throw refusal(`${hostname} resolving to ${answers.join(', ')}`);
  });

  // resolve*/reverse send queries to the configured DNS server over UDP, which is itself traffic.
  const resolverOwners = [[dns, false], [dns.Resolver.prototype, false], [dns.promises, true], [dns.promises.Resolver.prototype, true]];
  for (const [owner, promised] of resolverOwners) {
    for (const key of Object.getOwnPropertyNames(owner).filter(name => RESOLVER_METHOD.test(name) && typeof owner[name] === 'function')) {
      patch(owner, key, () => function guardedResolve(name, ...rest) {
        refused.push(`dns-${key}:${name}`);
        const error = refusal(`DNS ${key} of ${name}`);
        if (promised) return Promise.reject(error);
        const done = rest.findLast(value => typeof value === 'function');
        process.nextTick(() => done?.(error));
        return undefined;
      });
    }
  }

  patch(dgram.Socket.prototype, 'send', original => function guardedSend(...args) {
    const done = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
    const address = args.find((value, index) => index > 0 && typeof value === 'string');
    if (address === undefined || isLoopbackHost(address)) return original.apply(this, args);
    refused.push(`udp:${address}`);
    const error = refusal(`UDP to ${address}`);
    process.nextTick(() => (done ? done(error) : this.emit('error', error)));
  });

  patch(dgram.Socket.prototype, 'connect', original => function guardedUdpConnect(port, address, callback) {
    const host = typeof address === 'string' ? address : undefined;
    if (isLoopbackHost(host)) return original.apply(this, arguments);
    refused.push(`udp:${host}:${port}`);
    const error = refusal(`UDP to ${host}`), done = [address, callback].find(value => typeof value === 'function');
    process.nextTick(() => (done ? done(error) : this.emit('error', error)));
  });

  const savedProxies =Object.fromEntries(PROXY_KEYS.filter(key => key in process.env).map(key => [key, process.env[key]]));
  for (const key of PROXY_KEYS) delete process.env[key];
  for (const key of ['NO_PROXY', 'no_proxy', 'NO_GRPC_PROXY', 'no_grpc_proxy']) process.env[key] = '*';
  restores.push(() => { for (const key of PROXY_KEYS) delete process.env[key]; Object.assign(process.env, savedProxies); });

  const guard = {
    refused,
    uninstall() {
      if (active !== guard) return;
      for (const restore of restores.reverse()) restore();
      active = null;
    },
  };
  active = guard;
  return guard;
}
