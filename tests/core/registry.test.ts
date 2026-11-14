import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSshUrl, isRemoteUrl, repoNameFromUrl } from '../../src/core/repos/remote';
import { listRepos, registerRepo, removeRepo, resolveRepo, setDefaultRepo } from '../../src/core/repos/registry';
import { getGitStatus } from '../../src/core/repos/git-status';
import { createIssue } from '../../src/core/issues/service';
import { configFile, git, makeRepo, tmpDir, useTestHome } from '../helpers';

useTestHome();

describe('project registration', () => {
  it('registers a local repository, lists it, and is idempotent', async () => {
    const { root } = await makeRepo();
    const info = await registerRepo(root);
    expect(info).toMatchObject({ name: 'sample-app', path: root, source: 'local', initialized: true, exists: true, isDefault: false });
    expect((await registerRepo(root)).id).toBe(info.id);
    expect(await listRepos()).toHaveLength(1);
  });

  it('registers the repository root when given a subdirectory, and makes names unique', async () => {
    const first = await makeRepo();
    const second = await makeRepo();
    await mkdir(path.join(first.root, 'src', 'deep'), { recursive: true });
    const a = await registerRepo(path.join(first.root, 'src', 'deep'));
    expect(a.path).toBe(first.root);
    const b = await registerRepo(second.root);
    expect(b.name).toBe('sample-app-2');
  });

  it('supports explicit names, uninitialised repos and clear errors', async () => {
    const { root } = await makeRepo({ init: false });
    expect(await registerRepo(root, 'mine')).toMatchObject({ name: 'mine', initialized: false });
    const plain = await tmpDir();
    await expect(registerRepo(plain)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
    await expect(registerRepo(path.join(plain, 'missing'))).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });

  it('removes only the registry entry, never the repository', async () => {
    const { root } = await makeRepo();
    const info = await registerRepo(root);
    await removeRepo(info.name);
    expect(await listRepos()).toEqual([]);
    expect((await stat(await configFile(root))).isFile()).toBe(true);
    await expect(removeRepo('sample-app')).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });

  it('tracks a default repository and clears it on removal', async () => {
    const { root } = await makeRepo();
    const info = await registerRepo(root);
    expect((await setDefaultRepo(info.name)).isDefault).toBe(true);
    expect((await listRepos())[0]?.isDefault).toBe(true);
    await removeRepo(info.id);
    await expect(resolveRepo({})).rejects.toMatchObject({ code: 'NOT_IN_REPO' });
  });

  it('reports a registered repository that disappeared from disk', async () => {
    const { root } = await makeRepo();
    const info = await registerRepo(root);
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
    expect((await listRepos())[0]).toMatchObject({ exists: false, initialized: false });
    await expect(resolveRepo({ repo: info.id })).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });
});

describe('repository resolution', () => {
  it('finds the enclosing repo from a nested directory', async () => {
    const { root } = await makeRepo();
    const nested = path.join(root, 'src', 'a', 'b');
    await mkdir(nested, { recursive: true });
    const resolved = await resolveRepo({ cwd: nested });
    expect(resolved.repo.root).toBe(root);
    expect(resolved.initialized).toBe(true);
  });

  it('falls back to the Git root for an uninitialised repo', async () => {
    const { root } = await makeRepo({ init: false });
    const resolved = await resolveRepo({ cwd: root });
    expect(resolved).toMatchObject({ initialized: false });
    expect(resolved.repo.root).toBe(root);
  });

  it('prefers an explicit selector, by name, id or path', async () => {
    const one = await makeRepo();
    const two = await makeRepo();
    const info = await registerRepo(two.root, 'two');
    expect((await resolveRepo({ repo: 'two', cwd: one.root })).repo.root).toBe(two.root);
    expect((await resolveRepo({ repo: info.id })).repo.root).toBe(two.root);
    expect((await resolveRepo({ repo: one.root })).repo.root).toBe(one.root);
    await expect(resolveRepo({ repo: 'nope' })).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });

  it('uses the default repository outside any repo', async () => {
    const { root } = await makeRepo();
    const info = await registerRepo(root);
    await setDefaultRepo(info.id);
    const outside = await tmpDir();
    expect((await resolveRepo({ cwd: outside })).repo.root).toBe(root);
  });
});

describe('remote URLs (ADR-0005)', () => {
  it('accepts ssh and scp-style URLs', () => {
    for (const url of ['git@github.com:acme/widgets.git', 'ssh://git@example.com/acme/widgets.git', 'ssh://example.com:2222/acme/w.git', 'deploy@host.example:/srv/git/app.git']) {
      expect(isRemoteUrl(url)).toBe(true);
      expect(assertSshUrl(url)).toBe(url);
    }
  });

  it('rejects option injection, other schemes, whitespace and Windows paths', () => {
    expect(() => assertSshUrl('--upload-pack=touch /tmp/pwned')).toThrow(/Invalid repository URL/);
    expect(() => assertSshUrl('-oProxyCommand=evil git@host:x')).toThrow(/Invalid repository URL/);
    expect(() => assertSshUrl('https://github.com/acme/widgets.git')).toThrow(/Only SSH/);
    expect(() => assertSshUrl('ext::sh -c evil')).toThrow();
    expect(() => assertSshUrl('file:///etc/passwd')).toThrow(/Only SSH/);
    expect(() => assertSshUrl('git@host:acme/with space.git')).toThrow();
    expect(isRemoteUrl('C:\\repos\\app')).toBe(false);
    expect(isRemoteUrl('C:/repos/app')).toBe(false);
  });

  it('refuses malicious remotes before anything runs', async () => {
    await expect(registerRepo('https://example.com/x.git')).rejects.toMatchObject({ code: 'INVALID_REMOTE_URL' });
    await expect(registerRepo('--upload-pack=x')).rejects.toBeDefined();
    expect(await listRepos()).toEqual([]);
  });

  it('derives repository names from URLs', () => {
    expect(repoNameFromUrl('git@github.com:acme/widgets.git')).toBe('widgets');
    expect(repoNameFromUrl('ssh://git@example.com/acme/tools')).toBe('tools');
  });
});

describe('git status', () => {
  it('reports the branch and uncommitted .gitboard changes without modifying anything', async () => {
    const { repo, root } = await makeRepo();
    git(root, 'checkout', '-q', '-b', 'feature/x');
    expect(await getGitStatus(repo)).toMatchObject({ isGitRepo: true, branch: 'feature/x', dirty: true });

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    expect(await getGitStatus(repo)).toMatchObject({ dirty: false, changes: 0 });

    await createIssue(repo, { title: 'x' });
    expect(await getGitStatus(repo)).toMatchObject({ dirty: true, changes: 1 });

    await writeFile(path.join(root, 'unrelated.txt'), 'x');
    expect((await getGitStatus(repo)).changes).toBe(1);
    expect(git(root, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('handles directories that are not Git repositories', async () => {
    const dir = await tmpDir();
    const { openRepo } = await import('../../src/core/storage/repo-files');
    expect(await getGitStatus(await openRepo(dir))).toEqual({ isGitRepo: false, dirty: false, changes: 0 });
  });
});
