import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GUIDE_SECTIONS = Object.freeze(['projects', 'agents', 'work-in-chat', 'project-work', 'updates-and-help', 'computer']);
export const guideFile = section => {
  if (section === undefined) return 'SKILL.md';
  if (!GUIDE_SECTIONS.includes(section)) throw new Error(`Choose a guide section: ${GUIDE_SECTIONS.join(', ')}.`);
  return `references/${section}.md`;
};
const normalizeSkillText = text => text.replaceAll('\r\n', '\n').trimEnd() + '\n';
export const skillTextHash = text => createHash('sha256').update(normalizeSkillText(text)).digest('hex');
export const referenceHash = files => skillTextHash(JSON.stringify(GUIDE_SECTIONS.map(section => [guideFile(section), normalizeSkillText(files[guideFile(section)])])));
export const readBundledGuide = section => readFileSync(new URL(`../skills/mlswarm/${guideFile(section)}`, import.meta.url), 'utf8');
export const bundledGuideFiles = () => Object.fromEntries([undefined, ...GUIDE_SECTIONS].map(section => [guideFile(section), readBundledGuide(section)]));

// Inspect only regular files in the skill itself. Do not follow linked skill/reference
// directories or files, including Windows directory junctions. Preserve POSIX no-follow
// and nonblocking flags where supported; compare the opened identity on every platform.
export function readInstalledGuideFile(root, relative) {
  const path = join(root, relative);
  for (const directory of new Set([root, dirname(path)])) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) throw Object.assign(new Error('Linked skill needs review.'), { code: 'ELOOP' });
    if (!stat.isDirectory()) throw new Error('Skill directory is not a directory.');
  }
  const named = lstatSync(path);
  if (named.isSymbolicLink()) throw Object.assign(new Error('Linked skill needs review.'), { code: 'ELOOP' });
  if (!named.isFile() || named.size > 64 * 1024) throw new Error('Skill file is not a bounded regular file.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error('Skill file changed during inspection.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function skillMetadata(text) {
  const header = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const metadata = /^metadata:\s*\r?\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(header)?.[1] ?? '';
  const revision = /^[ \t]+guide-revision: *["']?([1-9]\d{0,5})["']? *\r?$/m.exec(metadata)?.[1];
  const references = /^[ \t]+references-sha256: *["']?([a-f0-9]{64})["']? *\r?$/m.exec(metadata)?.[1];
  return { guide_revision: revision ? Number(revision) : null, sha256: skillTextHash(text), ...(references ? { references_sha256: references } : {}) };
}
export const BUNDLED_SKILL = skillMetadata(readBundledGuide());

// Compares an installed client skill with the target guide; it never writes the skill.
export function installedSkill(location, target) {
  try {
    const root = dirname(location.path);
    const metadata = skillMetadata(readInstalledGuideFile(root, 'SKILL.md'));
    // A router alone is not an installed skill. The router's own hash covers this
    // reference digest, so one hash covers all workflows.
    if (metadata.references_sha256) {
      const files = {};
      for (const section of GUIDE_SECTIONS) {
        const file = guideFile(section);
        try { files[file] = readInstalledGuideFile(root, file); }
        catch (error) {
          if (error.code === 'ENOENT') return { ...location, ...metadata, status: 'incomplete' };
          throw error;
        }
      }
      if (referenceHash(files) !== metadata.references_sha256) return { ...location, ...metadata, status: 'modified' };
    }
    const status = metadata.guide_revision === null ? 'unversioned'
      : metadata.guide_revision < target.guide_revision ? 'update_available'
      : metadata.guide_revision > target.guide_revision ? 'newer'
      : metadata.sha256 === target.sha256 ? 'current' : 'modified';
    return { ...location, ...metadata, status };
  } catch (error) { return { ...location, status: error.code === 'ENOENT' ? 'not_installed' : error.code === 'ELOOP' ? 'symlink_review_required' : 'unreadable' }; }
}
