/**
 * Filesystem helpers. All filesystem access in core goes through `core/storage` (ADR-0012), and this
 * module holds the primitives: hashing, atomic writes, exclusive creation and path-containment checks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitboardError } from '../errors';

export function contentHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** True when `child` equals `parent` or is inside it. Both must already be absolute. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/** Throws PATH_OUTSIDE_REPO if the path is a symlink (issue files and config are never symlinks). */
export async function assertNotSymlink(target: string): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    throw new GitboardError('PATH_OUTSIDE_REPO', `Refusing to follow symlink: ${target}`);
  }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `rename` can fail transiently on Windows when a scanner or watcher holds the file (ADR-0013), so it
 * is retried with a short backoff.
 */
export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !RETRYABLE.has(code)) throw error;
      await sleep(20 * attempt);
    }
  }
}

function tempNameFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
}

/** Writes via a temp file in the same directory followed by an atomic rename. */
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  const tmp = tempNameFor(file);
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    await renameWithRetry(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const LINK_FALLBACK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES', 'EMLINK']);

/**
 * Creates `file` only if it does not exist (ADR-0003). The content is written to a temp file and then
 * hard-linked into place, so readers never see a partial file and an existing file is never replaced.
 * Filesystems without hard links fall back to an exclusive (`wx`) write.
 * Throws an error with `code === 'EEXIST'` if the file already exists.
 */
export async function createFileExclusive(file: string, data: string | Buffer): Promise<void> {
  const tmp = tempNameFor(file);
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    await link(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && LINK_FALLBACK.has(code)) {
      await rm(tmp, { force: true });
      await writeFile(file, data, { flag: 'wx' });
      return;
    }
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}
