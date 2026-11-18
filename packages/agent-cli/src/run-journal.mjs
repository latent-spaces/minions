
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
  lstatSync,
  realpathSync,
} from 'node:fs';

import { join, resolve } from 'node:path';

import {
  validateTarget,
  validateUuid,
  validateGeneration,
  validateExecution,
  sameTarget,
} from './service/contracts.mjs';

const RUN_JOURNAL_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  text: 4000,
  page: 200,
});

const PROMPT_BLOCK_LIMITS = Object.freeze({
  count: 32,
  name: 80,
  bytes: 1_000_000_000,
});

const FILE = 'run-evidence.jsonl';
const RESERVE = 2048;

const identifier = value =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_:.-]{1,150}$/.test(value);

const own = stat =>
  (process.platform === 'win32' || !(stat.mode & 0o077)) &&
  (typeof process.getuid !== 'function' || stat.uid === process.getuid());

const fault = code =>
  Object.assign(new Error('Private run evidence is unavailable.'), { code });

function validateIdentity(identity) {
  if (
    !identity ||
    Object.keys(identity).sort().join(',') !==
      'generation,missionId,model,provider,target'
  ) {
    throw fault('journal_identity');
  }

  validateTarget(identity.target);
  validateUuid(identity.missionId, 'missionId');
  validateGeneration(identity.generation);

  validateExecution({
    provider: identity.provider,
    model: identity.model,
  });

  return structuredClone(identity);
}

// Validate the per-turn prompt manifest.
const validPromptBlocks = blocks =>
  Array.isArray(blocks) &&
  blocks.length <= PROMPT_BLOCK_LIMITS.count &&
  blocks.every(
    block =>
      block &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      Object.keys(block).sort().join(',') ===
        'bytes,delivery,name,sha256,source' &&
      typeof block.name === 'string' &&
      block.name.length > 0 &&
      block.name.length <= PROMPT_BLOCK_LIMITS.name &&
      identifier(block.source) &&
      Number.isSafeInteger(block.bytes) &&
      block.bytes >= 0 &&
      block.bytes <= PROMPT_BLOCK_LIMITS.bytes &&
      typeof block.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(block.sha256) &&
      ['full', 'unchanged'].includes(block.delivery)
  );

function sameIdentity(a, b) {
  return (
    sameTarget(a?.target, b.target) &&
    a.missionId === b.missionId &&
    a.generation === b.generation &&
    a.provider === b.provider &&
    a.model === b.model
  );
}

function pathFor(directory) {
  directory = resolve(directory);

  if (process.platform === 'darwin') {
    directory = directory
      .replace(/^\/var(?=\/)/, '/private/var')
      .replace(/^\/tmp(?=\/)/, '/private/tmp');
  }

  const stat = lstatSync(directory);

  // Refuse a replaced parent rather than traversing a symlink.
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !own(stat) ||
    realpathSync(directory) !== resolve(directory)
  ) {
    throw fault('journal_unsafe_directory');
  }

  return join(directory, FILE);
}

function checkFile(fd) {
  const stat = fstatSync(fd);

  if (!stat.isFile() || stat.nlink !== 1 || !own(stat)) {
    throw fault('journal_unsafe_file');
  }

  return stat;
}

function openFile(path, flags) {
  const named = lstatSync(path);

  if (named.isSymbolicLink()) {
    throw fault('journal_unsafe_file');
  }

  const fd = openSync(path, flags | constants.O_NOFOLLOW);

  try {
    checkFile(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function validateRecord(record) {
  const common = ['kind', 'turnId', 'attemptId', 'seq', 'at'];

  const fields = {
    assistant_text: ['text', 'textTruncated'],
    status: ['text', 'textTruncated'],
    tool: ['name'],
    permission: ['name'],
    model: ['name'],
    session: ['sessionId'],
    native_started: ['pid'],
    guard_started: ['pid'],
    attempt_finished: [
      'failed',
      'interrupted',
      'cleanupConfirmed',
      'collectorTruncated',
      'failureCode',
      'delivery',
    ],
    attempt_started: [],
    submitted: [],
    acknowledged: [],
    capture_truncated: [],
    prompt_manifest: ['blocks'],
  };

  const extra = fields[record?.kind];

  if (
    !extra ||
    Object.keys(record).some(
      key => !common.includes(key) && !extra.includes(key)
    ) ||
    common.some(key => !Object.hasOwn(record, key))
  ) {
    throw fault('journal_corrupt_record');
  }

  validateUuid(record.turnId, 'turnId');
  validateUuid(record.attemptId, 'attemptId');

  if (
    ['assistant_text', 'status'].includes(record.kind) &&
    (
      typeof record.text !== 'string' ||
      [...record.text].length >
        (record.kind === 'status' ? 180 : RUN_JOURNAL_LIMITS.text) ||
      record.text.includes('\0') ||
      typeof record.textTruncated !== 'boolean'
    )
  ) {
    throw fault('journal_corrupt_record');
  }

  if (
    ['tool', 'permission', 'model'].includes(record.kind) &&
    !identifier(record.name)
  ) {
    throw fault('journal_corrupt_record');
  }

  if (record.kind === 'session') {
    validateUuid(record.sessionId, 'sessionId');
  }

  if (
    ['native_started', 'guard_started'].includes(record.kind) &&
    (!Number.isSafeInteger(record.pid) || record.pid < 1)
  ) {
    throw fault('journal_corrupt_record');
  }

  if (record.kind === 'attempt_finished') {
    for (const key of [
      'failed',
      'interrupted',
      'cleanupConfirmed',
      'collectorTruncated',
    ]) {
      if (
        record[key] !== undefined &&
        typeof record[key] !== 'boolean'
      ) {
        throw fault('journal_corrupt_record');
      }
    }

    for (const key of ['failureCode', 'delivery']) {
      if (record[key] !== undefined && !identifier(record[key])) {
        throw fault('journal_corrupt_record');
      }
    }
  }

  if (
    record.kind === 'prompt_manifest' &&
    !validPromptBlocks(record.blocks)
  ) {
    throw fault('journal_corrupt_record');
  }

  return record;
}

function scan(directory, identity) {
  const path = pathFor(directory);
  const fd = openFile(path, constants.O_RDONLY);

  try {
    const stat = checkFile(fd);

    if (stat.size > RUN_JOURNAL_LIMITS.bytes) {
      throw fault('journal_oversize');
    }

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;

    while (offset < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset
      );

      if (!count) {
        throw fault('journal_changed');
      }

      offset += count;
    }

    if (checkFile(fd).size !== stat.size) {
      throw fault('journal_changed');
    }

    const bytes = buffer;
    const tail = bytes.length && bytes.at(-1) !== 10;

    const lines = bytes.toString('utf8').split('\n');
    lines.pop();

    const records = [];
    let corrupt = false;
    let header;

    try {
      header = JSON.parse(lines.shift());
    } catch {
      throw fault('journal_corrupt_header');
    }

    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      throw fault('journal_corrupt_header');
    }

    if (
      header.version !== 1 ||
      header.kind !== 'identity' ||
      !sameIdentity(validateIdentity(header.identity), identity)
    ) {
      throw fault('journal_identity');
    }

    for (const line of lines) {
      try {
        const record = validateRecord(JSON.parse(line));

        const allowedKinds = [
          'attempt_started',
          'assistant_text',
          'tool',
          'status',
          'model',
          'session',
          'permission',
          'submitted',
          'acknowledged',
          'native_started',
          'guard_started',
          'attempt_finished',
          'capture_truncated',
          'prompt_manifest',
        ];

        if (
          record.seq !== records.length + 1 ||
          !Number.isSafeInteger(record.at) ||
          record.at < 1 ||
          !allowedKinds.includes(record.kind)
        ) {
          throw fault('journal_corrupt_record');
        }

        records.push(record);
      } catch {
        corrupt = true;
        break;
      }
    }

    return {
      records,
      partialTail: Boolean(tail),
      corrupt,
      bytes: stat.size,
      device: stat.dev,
      inode: stat.ino,
      truncated: records.some(
        record => record.kind === 'capture_truncated'
      ),
    };
  } finally {
    closeSync(fd);
  }
}

const normalizeFault = error =>
  typeof error?.code === 'string' &&
  error.code.startsWith('journal_')
    ? error.code
    : error?.code === 'ENOENT'
      ? 'journal_missing'
      : 'journal_io';

export function readRunJournal({
  directory,
  identity,
  after = 0,
  limit = 100,
}) {
  identity = validateIdentity(identity);

  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > RUN_JOURNAL_LIMITS.page
  ) {
    throw fault('journal_invalid_page');
  }

  const base = {
    scope: 'collector-visible',
    records: [],
    nextAfter: after,
    hasMore: false,
    truncated: false,
    partialTail: false,
    interruptedAttempts: [],
    faults: [],
  };

  let data;

  try {
    data = scan(directory, identity);
  } catch (error) {
    const code = normalizeFault(error);

    return {
      ...base,
      availability: /corrupt|identity/.test(code)
        ? 'corrupt'
        : 'unavailable',
      faults: [code],
    };
  }

  const records = data.records
    .filter(record => record.seq > after)
    .slice(0, limit);

  const attempts = new Map();

  for (const record of data.records) {
    if (record.kind === 'attempt_started') {
      attempts.set(record.attemptId, {
        turnId: record.turnId,
        attemptId: record.attemptId,
      });
    }

    if (record.kind === 'attempt_finished') {
      attempts.delete(record.attemptId);
    }
  }

  return {
    ...base,
    availability: data.corrupt ? 'corrupt' : 'available',
    records,
    nextAfter: records.at(-1)?.seq ?? after,
    hasMore: data.records.some(
      record => record.seq > (records.at(-1)?.seq ?? after)
    ),
    truncated: data.truncated,
    partialTail: data.partialTail,
    interruptedAttempts: [...attempts.values()],
    faults: [
      ...(data.corrupt ? ['journal_corrupt_record'] : []),
      ...(data.partialTail ? ['journal_partial_tail'] : []),
    ],
  };
}

export function createRunJournal({
  directory,
  identity,
  redact = [],
}) {
  identity = validateIdentity(identity);

  const secrets = redact
    .filter(value => typeof value === 'string' && value.length)
    .sort((a, b) => b.length - a.length);

  const clean = (value, maximum) => {
    let text = value.replace(/\0/g, '');

    for (const secret of secrets) {
      text = text.split(secret).join('[REDACTED]');
    }

    return [...text].slice(0, maximum).join('');
  };

  let bytes = 0;
  let sequence = 0;
  let device;
  let inode;
  let truncated = false;
  let failure = null;

  const status = () => ({
    availability: failure ? 'unavailable' : 'available',
    truncated,
    faults: failure ? [failure] : [],
    scope: 'collector-visible',
  });

  try {
    const path = pathFor(directory);

    try {
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );

      try {
        const header = Buffer.from(
          `${JSON.stringify({
            version: 1,
            kind: 'identity',
            identity,
          })}\n`
        );

        let offset = 0;

        while (offset < header.length) {
          offset += writeSync(
            fd,
            header,
            offset,
            header.length - offset
          );
        }

        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      // Make first-file creation durable as well as its contents.
      if (process.platform !== 'win32') {
        const dir = openSync(directory, constants.O_RDONLY);

        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    const data = scan(directory, identity);

    if (data.corrupt || data.partialTail) {
      throw fault(
        data.partialTail
          ? 'journal_partial_tail'
          : 'journal_corrupt_record'
      );
    }

    bytes = data.bytes;
    device = data.device;
    inode = data.inode;
    sequence = data.records.length;
    truncated = data.truncated;
  } catch (error) {
    failure = normalizeFault(error);
  }

  function write(record) {
    const line = Buffer.from(
      `${JSON.stringify({
        ...record,
        seq: sequence + 1,
        at: Date.now(),
      })}\n`
    );

    if (bytes + line.length > RUN_JOURNAL_LIMITS.bytes) {
      throw fault('journal_capacity');
    }

    const fd = openFile(
      pathFor(directory),
      constants.O_WRONLY | constants.O_APPEND
    );

    try {
      const stat = checkFile(fd);

      if (
        stat.size !== bytes ||
        stat.dev !== device ||
        stat.ino !== inode
      ) {
        throw fault('journal_changed');
      }

      let offset = 0;

      while (offset < line.length) {
        offset += writeSync(
          fd,
          line,
          offset,
          line.length - offset
        );
      }

      fsyncSync(fd);
      bytes += line.length;
      sequence++;
    } finally {
      closeSync(fd);
    }
  }

  return {
    status,

    append(event) {
      if (failure || truncated) {
        return status();
      }

      try {
        validateUuid(event.turnId, 'turnId');
        validateUuid(event.attemptId, 'attemptId');

        const record = {
          kind: event.kind,
          turnId: event.turnId,
          attemptId: event.attemptId,
        };

        if (['assistant_text', 'status'].includes(event.kind)) {
          if (typeof event.text !== 'string') {
            throw fault('journal_invalid_event');
          }

          // Redaction can expand the text, so validate its final length.
          const maximum =
            event.kind === 'status'
              ? 180
              : RUN_JOURNAL_LIMITS.text;

          const full = [...clean(event.text, Infinity)];

          record.text = full.slice(0, maximum).join('');

          record.textTruncated =
            [...event.text].length > maximum ||
            full.length > maximum ||
            event.sourceTruncated === true;
        } else if (
          ['tool', 'permission', 'model'].includes(event.kind)
        ) {
          if (!identifier(event.name)) {
            throw fault('journal_invalid_event');
          }

          record.name = secrets.some(secret =>
            event.name.includes(secret)
          )
            ? 'redacted'
            : event.name;
        } else if (event.kind === 'session') {
          record.sessionId = validateUuid(
            event.sessionId,
            'sessionId'
          );
        } else if (
          ['native_started', 'guard_started'].includes(event.kind)
        ) {
          if (
            !Number.isSafeInteger(event.pid) ||
            event.pid < 1
          ) {
            throw fault('journal_invalid_event');
          }

          record.pid = event.pid;
        } else if (event.kind === 'attempt_finished') {
          for (const key of [
            'failed',
            'interrupted',
            'cleanupConfirmed',
            'collectorTruncated',
          ]) {
            if (typeof event[key] === 'boolean') {
              record[key] = event[key];
            }
          }

          for (const key of ['failureCode', 'delivery']) {
            if (identifier(event[key])) {
              record[key] = event[key];
            }
          }
        } else if (event.kind === 'prompt_manifest') {
          if (!validPromptBlocks(event.blocks)) {
            throw fault('journal_invalid_event');
          }

          record.blocks = event.blocks.map(block => ({
            name: block.name,
            source: block.source,
            bytes: block.bytes,
            sha256: block.sha256,
            delivery: block.delivery,
          }));
        } else if (
          !['attempt_started', 'submitted', 'acknowledged'].includes(
            event.kind
          )
        ) {
          throw fault('journal_invalid_event');
        }

        if (
          bytes +
            Buffer.byteLength(JSON.stringify(record)) +
            100 >
          RUN_JOURNAL_LIMITS.bytes - RESERVE
        ) {
          write({
            kind: 'capture_truncated',
            turnId: event.turnId,
            attemptId: event.attemptId,
          });

          truncated = true;
        } else {
          write(record);
        }
      } catch (error) {
        failure = normalizeFault(error);
      }

      return status();
    },
  };
}
