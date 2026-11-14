import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIssue, deleteIssue, getIssue, listIssues } from '../../src/core/issues/service';
import { loadIssues } from '../../src/core/issues/store';
import { atomicWriteFile, contentHash, createFileExclusive, detectEol, isInside, samePath } from '../../src/core/storage/fs-safe';
import { deleteIssueFile, readIssueFile } from '../../src/core/storage/repo-files';
import { configFile as findConfigFile, makeRepo, tmpDir, useTestHome } from '../helpers';

useTestHome();

async function trySymlink(target: string, linkPath: string, type?: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch {
    return false; // symlinks can need privileges on Windows
  }
}

describe('path containment', () => {
  it('knows what is inside a directory', () => {
    const base = path.resolve('/tmp/repo');
    expect(isInside(base, path.join(base, 'a', 'b'))).toBe(true);
    expect(isInside(base, base)).toBe(true);
    expect(isInside(base, path.resolve('/tmp/repo-other'))).toBe(false);
    expect(isInside(base, path.resolve('/tmp'))).toBe(false);
    expect(isInside(base, path.join(base, '..', 'x'))).toBe(false);
    expect(samePath(base, path.join(base, '.'))).toBe(true);
  });

  it('rejects ids that could traverse the filesystem', async () => {
    const { repo } = await makeRepo();
    for (const id of ['../../etc/passwd', '..', 'a3f91c2e8b4', 'A3F91C2E8B40', 'a3f91c2e8b40.md', 'a3f91c2e8b40/../../x']) {
      await expect(readIssueFile(repo, id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(deleteIssueFile(repo, id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('refuses an issues directory that is a symlink pointing outside the repo', async () => {
    const { repo, root } = await makeRepo();
    const outside = await tmpDir('gitboard-outside-');
    await rm(path.join(root, '.gitboard', 'issues'), { recursive: true });
    if (!(await trySymlink(outside, path.join(root, '.gitboard', 'issues'), 'dir'))) return;
    await expect(listIssues(repo)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_REPO' });
    await expect(createIssue(repo, { title: 'x' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_REPO' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses to read, update or delete through a symlinked issue file', async () => {
    const { repo, root } = await makeRepo();
    const secret = path.join(await tmpDir('gitboard-outside-'), 'secret.md');
    await writeFile(secret, '---\nid: aaaaaaaaaaaa\n---\nsecret\n');
    if (!(await trySymlink(secret, path.join(root, '.gitboard', 'issues', 'aaaaaaaaaaaa.md'), 'file'))) return;
    await expect(readIssueFile(repo, 'aaaaaaaaaaaa')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_REPO' });
    await expect(getIssue(repo, 'aaaaaaaaaaaa')).rejects.toBeDefined();
    await expect(deleteIssue(repo, { id: 'aaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_REPO' });
    const { problems } = await loadIssues(repo);
    expect(problems.map((p) => p.code)).toContain('UNREADABLE_FILE');
    expect(await readFile(secret, 'utf8')).toContain('secret');
  });

  it('refuses a symlinked config file', async () => {
    const { repo, root } = await makeRepo();
    const file = await findConfigFile(root);
    const elsewhere = path.join(await tmpDir('gitboard-outside-'), path.basename(file));
    await rename(file, elsewhere);
    if (!(await trySymlink(elsewhere, file, 'file'))) return;
    await expect(listIssues(repo)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_REPO' });
  });
});

describe('atomic writes', () => {
  it('replaces files without leaving temporary files', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'a.txt');
    await atomicWriteFile(file, 'one');
    await atomicWriteFile(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('creates exclusively: an existing file is never replaced', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'b.txt');
    await createFileExclusive(file, 'first');
    await expect(createFileExclusive(file, 'second')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('first');
    expect(await readdir(dir)).toEqual(['b.txt']);
  });

  it('hashes bytes and detects line endings', () => {
    expect(contentHash('a')).toBe(contentHash(Buffer.from('a')));
    expect(contentHash('a')).not.toBe(contentHash('b'));
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\nb\n')).toBe('\n');
  });

  it('keeps working in directories that need creating', async () => {
    const dir = await tmpDir();
    await mkdir(path.join(dir, 'x'));
    await atomicWriteFile(path.join(dir, 'x', 'y.txt'), 'ok');
    expect(await readFile(path.join(dir, 'x', 'y.txt'), 'utf8')).toBe('ok');
  });
});
