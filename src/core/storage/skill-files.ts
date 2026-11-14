/**
 * Filesystem side of skill installation (ADR-992ea64, ADR-9b39f45): locating the packaged skill, hashing and
 * copying skill trees, and creating symlinks or Windows junctions.
 */
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitboardError } from '../errors';
import { atomicWriteFile, contentHash } from './fs-safe';

export const MANIFEST_FILE = '.gitboard-skill.json';

export interface Manifest {
  version: string;
  files: Record<string, string>;
}

/** Walks up from this module until it finds the package root that contains `skills/gitboard`. */
export async function findPackageRoot(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      await lstat(path.join(dir, 'skills', 'gitboard', 'SKILL.md'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new GitboardError('UNEXPECTED', 'Could not locate the packaged skills directory.');
      dir = parent;
    }
  }
}

export async function readPackageVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile() && rel !== MANIFEST_FILE) out.push(rel);
  }
  return out.sort();
}

/** Reads a skill directory into memory: relative path (with `/`) to file content. */
export async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const tree = new Map<string, Buffer>();
  for (const rel of await listFiles(dir)) tree.set(rel, await readFile(path.join(dir, ...rel.split('/'))));
  return tree;
}

export function hashTree(tree: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries([...tree].map(([rel, data]) => [rel, contentHash(data)]));
}

export function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export type DestState =
  | { kind: 'none' }
  | { kind: 'file' }
  | { kind: 'symlink'; target: string | null }
  | { kind: 'dir'; manifest: Manifest | null; hashes: Record<string, string>; modified: boolean };

async function readManifest(dest: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dest, MANIFEST_FILE), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

export async function inspectDest(dest: string): Promise<DestState> {
  let info;
  try {
    info = await lstat(dest);
  } catch {
    return { kind: 'none' };
  }
  if (info.isSymbolicLink()) {
    try {
      return { kind: 'symlink', target: await realpath(dest) };
    } catch {
      return { kind: 'symlink', target: null };
    }
  }
  if (!info.isDirectory()) return { kind: 'file' };

  const hashes = hashTree(await readTree(dest));
  const manifest = await readManifest(dest);
  return { kind: 'dir', manifest, hashes, modified: manifest === null || !sameHashes(hashes, manifest.files) };
}

export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** Writes a skill copy plus its manifest, removing files that are no longer part of the skill. */
export async function writeCopy(dest: string, tree: Map<string, Buffer>, version: string): Promise<void> {
  const state = await inspectDest(dest);
  if (state.kind === 'symlink' || state.kind === 'file') await removePath(dest);
  await mkdir(dest, { recursive: true });
  const existing = state.kind === 'dir' ? await listFiles(dest) : [];
  for (const rel of existing) if (!tree.has(rel)) await rm(path.join(dest, ...rel.split('/')), { force: true });
  for (const [rel, data] of tree) {
    const file = path.join(dest, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, data);
  }
  const manifest: Manifest = { version, files: hashTree(tree) };
  await atomicWriteFile(path.join(dest, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Links `dest` to `canonical`. POSIX uses a relative symlink; Windows uses a directory junction, which
 * needs no administrator rights (ADR-9b39f45). Returns false if linking is not possible.
 */
export async function makeLink(dest: string, canonical: string): Promise<boolean> {
  await removePath(dest);
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    if (process.platform === 'win32') await symlink(canonical, dest, 'junction');
    else await symlink(path.relative(path.dirname(dest), canonical), dest, 'dir');
    return true;
  } catch {
    return false;
  }
}

export async function linkPointsTo(dest: string, canonical: string): Promise<boolean> {
  try {
    await readlink(dest);
    return (await realpath(dest)) === (await realpath(canonical));
  } catch {
    return false;
  }
}
