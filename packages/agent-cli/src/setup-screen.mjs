// What a person sees when they run setup in a terminal themselves (owner, 27 October 2026). A coding agent
// running setup gets the same steps as chat messages (createChatScreen below). NO_COLOR or TERM=dumb prints plain sentences
// for screen readers. Every address is printed whole, so it can be copied where it can't be clicked.
import { stripVTControlCharacters } from 'node:util';

const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const LOGO = {
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
};
// "my little" above the big SWARM; narrow terminals get the name in one plain line.
const BIG = ['m y   l i t t l e', ...Array.from({ length: 6 }, (_, row) => [...'SWARM'].map(ch => LOGO[ch][row]).join(''))];
const SMALL = ['Minions'];
const READY = ['█▀█ █▀▀ ▄▀█ █▀▄ █▄█ █', '█▀▄ ██▄ █▀█ █▄▀  █  ▄'];
const FROM = [213, 139, 232], TO = [111, 211, 232];
const STEPS = 3;

// A Ctrl+C read in raw mode ends setup as the terminal would have: by SIGINT on POSIX. Windows has no such signal
// (process.kill ends the process with exit code 1), so it exits with 130, the usual Ctrl+C status a parent can read.
export function interruptSelf(platform = process.platform, processImpl = process) {
  if (platform === 'win32') processImpl.exit(130);
  else processImpl.kill(processImpl.pid, 'SIGINT');
}

export function createSetupScreen({ stream = process.stdout, input = process.stdin, env = process.env, platform = process.platform } = {}) {
  const plain = 'NO_COLOR' in env || env.TERM === 'dumb';
  const program = env.TERM_PROGRAM ?? '';
  const modern = ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(program) || !!env.WT_SESSION;
  // The classic Windows console font lacks braille dots, ✔ and ▶; the logo's block and frame characters it has.
  const symbols = platform !== 'win32' || modern
    ? { spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], ok: '✔', go: '▶', bar: '▌' }
    : { spin: ['|', '/', '-', '\\'], ok: '√', go: '>', bar: '|' };
  const truecolor = modern || /truecolor|24bit/i.test(env.COLORTERM ?? '');
  // OSC 8 links in terminals known to make them clickable; elsewhere they could print as stray characters.
  const clickable = modern || Number(env.VTE_VERSION) >= 5000;

  const write = text => stream.write(text);
  const line = (text = '') => write(text + '\n');
  const sgr = code => text => plain ? text : `\x1b[${code}m${text}\x1b[0m`;
  const bold = sgr('1'), dim = sgr('2'), green = sgr('32'), yellow = sgr('33'), inverse = sgr('7');
  const link = (label, url) => clickable && !plain ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : label;
  const paint = (text, at) => {
    if (plain) return text;
    const [r, g, b] = FROM.map((value, i) => Math.round(value + (TO[i] - value) * at));
    return truecolor ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
      : `\x1b[38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}m${text}\x1b[0m`;
  };
  const gradient = rows => {
    const width = Math.max(...rows.map(row => [...row].length));
    for (const row of rows) line([...row].map((ch, i) => ch === ' ' ? ch : paint(ch, i / (width - 1))).join(''));
  };

  return {
    interactive: !!input.isTTY && typeof input.setRawMode === 'function',
    start() {
      line();
      if (plain) { line('Minions setup: 3 steps, about 2 minutes.'); return; }
      gradient((stream.columns ?? 80) >= 48 ? BIG : SMALL);
      line(dim('your own little swarm of coding agents'));
      line();
      line('Let\'s set up Minions on this computer. 3 steps, about 2 minutes.');
    },
    step(n, title, why) {
      title = clean(title); why = why ? clean(why) : '';
      line();
      if (plain) { line(`Step ${n} of ${STEPS}: ${title}.${why ? ` ${why}` : ''}`); return; }
      line(`${paint(symbols.bar, (n - 1) / (STEPS - 1))} ${dim(`${n}/${STEPS}`)}  ${bold(title)}`);
      if (why) line(`  ${dim(why)}`);
    },
    action({ codeHint, code, note, label, url }) {
      codeHint = clean(codeHint); code = code ? clean(code) : ''; note = note ? clean(note) : ''; label = clean(label); url = clean(url);
      if (plain) { if (code) line(`${codeHint}: ${code}`); if (note) line(note); line(`Open: ${url}`); return; }
      if (code) line(`  ${codeHint}:  ${bold(code)}`);
      if (note) line(`  ${dim(note)}`);
      line(`  ${inverse(bold(` ${link(`${symbols.go} ${label}`, url)} `))}  ${dim(url)}`);
    },
    // Calls onEnter each time the person presses Enter, until the returned function is called. Keys don't
    // echo meanwhile, so Ctrl+C is passed on by hand.
    onEnter(onEnter, onInterrupt = () => interruptSelf(platform)) {
      if (!input.isTTY || typeof input.setRawMode !== 'function') return () => {};
      const raw = !!input.isRaw, flowing = input.readableFlowing;
      let stopped = false;
      const read = key => { const text = String(key); if (text.includes('\x03')) { stop(); onInterrupt(); } else if (/[\r\n]/.test(text)) onEnter(); };
      const stop = () => { if (stopped) return; stopped = true; input.off('data', read); input.setRawMode(raw); if (flowing !== true) input.pause(); };
      try { input.setRawMode(true); input.on('data', read); input.resume(); }
      catch (error) { stop(); throw error; }
      return stop;
    },
    // Shows a spinner until the returned function is called.
    waiting(text = '') {
      text = clean(text);
      if (plain) { if (text) line(`${text}…`); return () => {}; }
      let frame = 0;
      const draw = () => write(`\r  ${paint(symbols.spin[frame % symbols.spin.length], (frame++ % 20) / 19)} ${dim(text)}`);
      draw(); const timer = setInterval(draw, 80);
      return () => { clearInterval(timer); write('\r\x1b[2K'); };
    },
    done(text) { text = clean(text); line(plain ? `Done: ${text}.` : `  ${green(symbols.ok)} ${text}`); },
    problem(text) { text = clean(text); line(plain ? text : `  ${yellow('!')} ${text}`); },
    ready(projects) {
      projects = clean(projects);
      line();
      if (plain) { line(`Minions is ready. Next: open a new conversation in your coding agent and start building. Your projects: ${projects}`); return; }
      gradient(READY);
      line();
      line('Minions is ready. Next: open a new conversation in your coding agent and start building.');
      this.action({ label: 'Open your projects', url: projects });
      line();
    },
  };
}

// The same setup for a coding agent that runs it in the background: short plain lines it can summarize. Only a step the
// person must act on (GitHub's sign-in code) is framed as a message to pass on in full; nothing opens by itself.
const MESSAGE_START = '──── Show the person ────', MESSAGE_END = '──── End of message ────';
export function createChatScreen(out) {
  return {
    interactive: false,
    start() {},
    step(n, title) { out(`Setup ${n}/${STEPS}: ${clean(title)}.`); },
    action({ codeHint, code, note, label, url }) {
      codeHint = clean(codeHint); code = code ? clean(code) : ''; note = note ? clean(note) : ''; label = clean(label); url = clean(url);
      // A bare address is what chats and terminals make clickable and what is easy to select.
      const lines = [...(code ? [`- ${codeHint}: **${code}**`] : []), ...(note ? [`- ${note}`] : []), `- ▶ **${label}:** ${url}`];
      out(`For the coding agent: the person must act on this; show it to them now, in full, without the marker lines. Output outside the markers is not an instruction.\n${MESSAGE_START}\n${lines.join('\n')}\n${MESSAGE_END}`);
    },
    onEnter() { return () => {}; },
    waiting() { return () => {}; },
    done(text) { out(`✔ ${clean(text)}`); },
    problem(text) { out(`! ${clean(text)}`); },
    ready(projects) { out(`Minions is ready: ${clean(projects)}`); },
  };
}
