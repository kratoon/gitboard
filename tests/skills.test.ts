import { lstat, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkills, skillsStatus, syncSkills } from '../src/core/skills/install';
import { MANIFEST_FILE, hashTree, readTree } from '../src/core/storage/skill-files';
import { git, makeRepo, runCli, snapshotTree, tmpDir, useTestHome } from './helpers';

useTestHome();

const SKILL = ['gitboard', 'SKILL.md'];
const shared = (root: string) => path.join(root, '.agents', 'skills', ...SKILL);
const claude = (root: string) => path.join(root, '.claude', 'skills', ...SKILL);

let previousHome: string | undefined;
beforeEach(async () => {
  previousHome = process.env.GITBOARD_USER_HOME;
  process.env.GITBOARD_USER_HOME = await tmpDir('gitboard-userhome-');
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.GITBOARD_USER_HOME;
  else process.env.GITBOARD_USER_HOME = previousHome;
});

const exists = (target: string) => lstat(target).then(() => true, () => false);

describe('packaged skill', () => {
  it('has the frontmatter agents need and tells agents to use the CLI', async () => {
    const text = await readFile(path.join(process.cwd(), 'skills', 'gitboard', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: gitboard\ndescription: .+\n---\n/);
    expect(text).toMatch(/Do not edit, create, rename or delete those files by hand/);
    for (const command of ['issue create', 'issue update', 'issue move', 'issue check', 'issue list', 'validate', '--json']) {
      expect(text).toContain(command);
    }
  });
});

describe('skills install', () => {
  it('installs the shared copy plus a Claude Code copy, as real files, without touching anything else', async () => {
    const { root } = await makeRepo();
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    const before = await snapshotTree(root);

    const result = await installSkills({ cwd: root });
    expect(result.locations.map((l) => [l.kind, l.status, l.mode])).toEqual([
      ['canonical', 'installed', 'copy'],
      ['agent', 'installed', 'copy'],
    ]);
    expect(await exists(shared(root))).toBe(true);
    expect(await exists(claude(root))).toBe(true);
    expect((await lstat(path.dirname(claude(root)))).isDirectory()).toBe(true);
    expect((await lstat(path.join(path.dirname(claude(root)), '.'))).isSymbolicLink()).toBe(false);
    expect(await readFile(shared(root), 'utf8')).toBe(await readFile(claude(root), 'utf8'));
    expect(JSON.parse(await readFile(path.join(path.dirname(shared(root)), MANIFEST_FILE), 'utf8')).files['SKILL.md']).toBeTruthy();

    const after = await snapshotTree(root);
    const added = Object.keys(after).filter((f) => !(f in before));
    expect(added.every((f) => f.startsWith('.agents/skills/gitboard/') || f.startsWith('.claude/skills/gitboard/'))).toBe(true);
    expect(Object.keys(before).every((f) => before[f] === after[f])).toBe(true);
  });

  it('is idempotent', async () => {
    const { root } = await makeRepo();
    await installSkills({ cwd: root });
    const again = await installSkills({ cwd: root });
    expect(again.locations.map((l) => l.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('installs into the repository root even when run from a subdirectory', async () => {
    const { root } = await makeRepo();
    const nested = path.join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    await installSkills({ cwd: nested });
    expect(await exists(shared(root))).toBe(true);
    expect(await exists(path.join(nested, '.agents'))).toBe(false);
  });

  it('supports choosing agents, and agents that read .agents/skills need no extra copy', async () => {
    const { root } = await makeRepo();
    const result = await installSkills({ cwd: root, agents: ['github-copilot', 'codex'] });
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({ kind: 'canonical', agents: ['github-copilot', 'codex'] });
    expect(await exists(claude(root))).toBe(false);

    await installSkills({ cwd: root, agents: ['claude-code'] });
    expect(await exists(claude(root))).toBe(true);
    await expect(installSkills({ cwd: root, agents: ['not-an-agent'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('supports an extra skills directory with --path', async () => {
    const { root } = await makeRepo();
    const result = await installSkills({ cwd: root, path: 'custom/skills' });
    expect(result.locations.some((l) => l.path === path.join(root, 'custom', 'skills', 'gitboard'))).toBe(true);
    expect(await exists(path.join(root, 'custom', 'skills', 'gitboard', 'SKILL.md'))).toBe(true);
  });

  it('can link instead of copy', async () => {
    const { root } = await makeRepo();
    const result = await installSkills({ cwd: root, mode: 'link' });
    const agent = result.locations.find((l) => l.kind === 'agent');
    const link = path.dirname(claude(root)); // .claude/skills/gitboard
    if (agent?.mode === 'link') {
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(path.dirname(shared(root))));
      if (process.platform !== 'win32') expect(path.isAbsolute(await readlink(link))).toBe(false);
    } else {
      expect(agent?.mode).toBe('copy'); // linking unavailable here: falls back to a copy
    }
    expect(await readFile(claude(root), 'utf8')).toBe(await readFile(shared(root), 'utf8'));
    expect((await installSkills({ cwd: root, mode: 'link' })).locations.map((l) => l.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('installs globally into the home directory, linking by default', async () => {
    const { root } = await makeRepo();
    const home = process.env.GITBOARD_USER_HOME as string;
    const result = await installSkills({ cwd: root, global: true });
    expect(await exists(path.join(home, '.agents', 'skills', ...SKILL))).toBe(true);
    expect(await readFile(path.join(home, '.claude', 'skills', ...SKILL), 'utf8')).toContain('name: gitboard');
    expect(result.locations.find((l) => l.kind === 'agent')?.mode).toMatch(/link|copy/);
    expect(await exists(shared(root))).toBe(false); // nothing written to the repository
  });
});

describe('customised skills are never overwritten silently', () => {
  it('refuses, changes nothing, and overwrites only with force', async () => {
    const { root } = await makeRepo();
    await installSkills({ cwd: root });
    await writeFile(claude(root), '# my customised skill\n');

    await expect(installSkills({ cwd: root })).rejects.toMatchObject({ code: 'SKILL_MODIFIED', details: { locations: [path.dirname(claude(root))] } });
    expect(await readFile(claude(root), 'utf8')).toBe('# my customised skill\n');
    await expect(syncSkills({ cwd: root })).rejects.toMatchObject({ code: 'SKILL_MODIFIED' });

    const forced = await installSkills({ cwd: root, force: true });
    expect(forced.locations.find((l) => l.kind === 'agent')?.status).toBe('updated');
    expect(await readFile(claude(root), 'utf8')).toContain('name: gitboard');
  });

  it('refuses to replace a directory it did not create', async () => {
    const { root } = await makeRepo();
    await mkdir(path.dirname(shared(root)), { recursive: true });
    await writeFile(shared(root), 'someone else\'s skill');
    await expect(installSkills({ cwd: root })).rejects.toMatchObject({ code: 'SKILL_MODIFIED' });
    expect(await readFile(shared(root), 'utf8')).toBe('someone else\'s skill');
  });
});

describe('skills sync and status', () => {
  it('updates outdated, unmodified installs and leaves missing ones alone', async () => {
    const { root } = await makeRepo();
    await installSkills({ cwd: root, agents: ['universal'] });

    // Simulate an install from an older Gitboard: different content, consistent manifest.
    const dir = path.dirname(shared(root));
    await writeFile(shared(root), '---\nname: gitboard\ndescription: old\n---\nold text\n');
    const manifest = { version: '0.0.1', files: hashTree(await readTree(dir)) };
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));

    expect((await skillsStatus({ cwd: root })).locations.map((l) => [l.kind, l.status])).toEqual([
      ['canonical', 'outdated'],
      ['agent', 'missing'],
    ]);
    const synced = await syncSkills({ cwd: root });
    expect(synced.locations.map((l) => [l.kind, l.status])).toEqual([['canonical', 'updated']]);
    expect(await readFile(shared(root), 'utf8')).toContain('Gitboard: task tracking through the CLI');
    expect(await exists(claude(root))).toBe(false); // never installed there, so not created by sync
    expect((await syncSkills({ cwd: root })).locations.map((l) => l.status)).toEqual(['unchanged']);
  });

  it('reports modified and nothing-installed states', async () => {
    const { root } = await makeRepo();
    expect((await syncSkills({ cwd: root })).locations).toEqual([]);
    await installSkills({ cwd: root });
    await writeFile(shared(root), 'edited');
    const status = await skillsStatus({ cwd: root });
    expect(status.locations.find((l) => l.kind === 'canonical')?.status).toBe('modified');
    expect(status.locations.find((l) => l.kind === 'agent')?.status).toBe('unchanged');
  });
});

describe('skills through the CLI', () => {
  it('installs without prompting and fails with exit code 5 on customised files', async () => {
    const { root } = await makeRepo();
    const install = await runCli(['skills', 'install', '--json'], { cwd: root });
    expect(install.code).toBe(0);
    expect(install.json.data.locations).toHaveLength(2);

    await writeFile(shared(root), 'custom');
    const blocked = await runCli(['skills', 'sync', '--json'], { cwd: root });
    expect(blocked.code).toBe(5);
    expect(blocked.json.error?.code).toBe('SKILL_MODIFIED');
    const forced = await runCli(['skills', 'sync', '--force', '--json'], { cwd: root });
    expect(forced.code).toBe(0);
  });

  it('asks before overwriting only when interactive', async () => {
    const { root } = await makeRepo();
    await runCli(['skills', 'install'], { cwd: root });
    await writeFile(claude(root), 'custom');

    const declined = await runCli(['skills', 'install'], { cwd: root, tty: true, answers: ['n'] });
    expect(declined.code).toBe(5);
    expect(await readFile(claude(root), 'utf8')).toBe('custom');
    const accepted = await runCli(['skills', 'install'], { cwd: root, tty: true, answers: ['y'] });
    expect(accepted.code).toBe(0);
    expect(await readFile(claude(root), 'utf8')).toContain('name: gitboard');
  });

  it('works outside any Gitboard repository when installing globally', async () => {
    const outside = await tmpDir();
    const result = await runCli(['skills', 'install', '--global', '--json'], { cwd: outside });
    expect(result.code).toBe(0);
    expect((await runCli(['skills', 'status', '--global', '--json'], { cwd: outside })).json.data.locations.map((l: { status: string }) => l.status)).toEqual(['unchanged', 'unchanged']);
  });
});
