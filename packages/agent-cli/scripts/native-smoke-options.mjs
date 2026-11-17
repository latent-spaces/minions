export function nativeSmokeOptions(args, { platform = process.platform, nodeMajor = Number(process.versions.node.split('.')[0]) } = {}) {
  const options = { executables: { claude: 'claude', codex: 'codex' }, models: {}, timeoutSeconds: 180, approved: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate smoke option: ${flag}`);
    seen.add(flag);
    if (flag === '--approved') { options.approved = true; continue; }
    if (!['--claude', '--codex', '--claude-model', '--codex-model', '--expect-platform', '--timeout-seconds'].includes(flag)) throw new Error(`Unknown smoke option: ${flag}`);
    const value = args[++index];
    if (typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) throw new Error(`Supply a value for ${flag}.`);
    if (flag === '--claude' || flag === '--codex') options.executables[flag.slice(2)] = value;
    else if (flag.endsWith('-model')) options.models[flag.slice(2, -6)] = value;
    else if (flag === '--expect-platform') options.expectedPlatform = value;
    else { if (!/^\d+$/.test(value)) throw new Error('Use an integer smoke timeout.'); options.timeoutSeconds = Number(value); }
  }
  if (!options.approved) throw new Error('Requires explicit operator approval and --approved. This starts real models.');
  if (nodeMajor !== 24) throw new Error('Use the pinned Node 24 runtime.');
  for (const provider of ['claude', 'codex']) if (!/^[A-Za-z0-9_:.-]{1,150}$/.test(options.models[provider] ?? '')) throw new Error(`Pin an available model with --${provider}-model before starting a real smoke test.`);
  if (!['win32', 'darwin', 'linux'].includes(options.expectedPlatform) || options.expectedPlatform !== platform) throw new Error('Supply --expect-platform matching the actual native host (win32, darwin or linux).');
  if (options.timeoutSeconds < 60 || options.timeoutSeconds > 300) throw new Error('Smoke timeout must be between 60 and 300 seconds.');
  return options;
}
