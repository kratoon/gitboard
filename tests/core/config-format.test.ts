import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeOperation } from '../../src/core';
import { createIssue } from '../../src/core/issues/service';
import {
  convertConfig,
  createProject,
  deleteProject,
  listProjects,
  loadConfig,
  setColumns,
  updateProject,
} from '../../src/core/projects/config';
import { resetViews, setViews } from '../../src/core/projects/views';
import { validateRepo } from '../../src/core/validation/validate';
import { configFile, makeRepo, readConfigObject, runCli, useTestHome } from '../helpers';

useTestHome();

const gitboardDir = (root: string) => path.join(root, '.gitboard');
const names = async (root: string) => (await readdir(gitboardDir(root))).filter((n) => n.startsWith('config')).sort();

const HAND_WRITTEN = `# Gitboard configuration for the shop
version: 1

# Columns used by every project unless it says otherwise
columns:
  - id: backlog
  - id: doing
  - id: shipped
    done: true # finished work

projects:
  # The storefront
  - key: SHOP
    name: Shop
  - key: OPS
    name: Operations
`;

describe('YAML is the default format (ADR-6c9f71b)', () => {
  it('creates config.yaml and no JSON file', async () => {
    const { root } = await makeRepo();
    expect(await names(root)).toEqual(['config.yaml']);
    expect(await readFile(path.join(gitboardDir(root), 'config.yaml'), 'utf8')).toBe('version: 1\nprojects:\n  - key: SAMP\n    name: sample-app\n');
  });

  it('writes init columns, including done flags, as YAML', async () => {
    const { root } = await makeRepo({ init: false });
    await executeOperation('repo.init', { columns: [{ id: 'todo' }, { id: 'merged', done: true }], projectKey: 'WEB' }, { cwd: root });
    expect(await readFile(await configFile(root), 'utf8')).toBe(
      'version: 1\ncolumns:\n  - id: todo\n  - id: merged\n    done: true\nprojects:\n  - key: WEB\n    name: sample-app\n',
    );
  });

  it('accepts config.yml as YAML too', async () => {
    const { repo, root } = await makeRepo();
    const yml = path.join(gitboardDir(root), 'config.yml');
    await writeFile(yml, HAND_WRITTEN);
    await (await import('node:fs/promises')).rm(path.join(gitboardDir(root), 'config.yaml'));
    expect((await listProjects(repo)).map((p) => p.key)).toEqual(['SHOP', 'OPS']);
    await createProject(repo, { key: 'NEW', name: 'New' });
    expect(await names(root)).toEqual(['config.yml']);
  });
});

describe('YAML updates keep comments and layout', () => {
  it('keeps every comment while projects, views and columns change', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), HAND_WRITTEN);

    await createProject(repo, { key: 'ADR', name: 'Decisions' });
    await setViews(repo, { views: ['backlog'] });
    await setViews(repo, { views: ['kanban'], project: 'OPS' });
    await updateProject(repo, { key: 'SHOP', name: 'Web shop', description: 'Public site' });
    await setColumns(repo, { columns: ['backlog', 'doing', 'review', 'shipped'] });

    const text = await readFile(await configFile(root), 'utf8');
    for (const comment of ['# Gitboard configuration for the shop', '# Columns used by every project unless it says otherwise', '# finished work', '# The storefront']) {
      expect(text).toContain(comment);
    }
    const config = await readConfigObject(root);
    expect(config.views).toEqual(['backlog']);
    expect(config.columns).toEqual([{ id: 'backlog' }, { id: 'doing' }, { id: 'review' }, { id: 'shipped', done: true }]);
    expect(config.projects.map((p: { key: string }) => p.key)).toEqual(['SHOP', 'OPS', 'ADR']);
    expect(config.projects[0]).toEqual({ key: 'SHOP', name: 'Web shop', description: 'Public site' });
    expect(config.projects[1]).toEqual({ key: 'OPS', name: 'Operations', views: ['kanban'] });
  });

  it('only changes the lines that need to change', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), HAND_WRITTEN);
    await setViews(repo, { views: ['backlog', 'kanban'] });
    const text = await readFile(await configFile(root), 'utf8');
    expect(text.startsWith(HAND_WRITTEN.trimEnd())).toBe(true);
    expect(text.slice(HAND_WRITTEN.trimEnd().length).trim().split('\n').map((l) => l.trim())).toEqual(['views:', '- backlog', '- kanban']);
  });

  it('does not rewrite the file when nothing changes, and a set then reset restores it byte for byte', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), HAND_WRITTEN);
    await setViews(repo, { views: ['backlog'] });
    const afterSet = await readFile(await configFile(root), 'utf8');
    await setViews(repo, { views: ['backlog'] });
    expect(await readFile(await configFile(root), 'utf8')).toBe(afterSet);
    await resetViews(repo, {});
    expect(await readFile(await configFile(root), 'utf8')).toBe(HAND_WRITTEN.replace(/\n$/, '\n'));
  });

  it('removing a project from the middle leaves the right content', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), HAND_WRITTEN);
    await createProject(repo, { key: 'ADR', name: 'Decisions' });
    await deleteProject(repo, 'OPS');
    const config = await readConfigObject(root);
    expect(config.projects).toEqual([{ key: 'SHOP', name: 'Shop' }, { key: 'ADR', name: 'Decisions' }]);
    expect(await readFile(await configFile(root), 'utf8')).toContain('# The storefront');
  });

  it('fills in defaults for a minimal hand-written file and for an empty one', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), 'projects:\n  - key: AA\n    name: A\n');
    await createProject(repo, { key: 'BB', name: 'B' });
    expect((await readConfigObject(root)).projects.map((p: { key: string }) => p.key)).toEqual(['AA', 'BB']);

    await writeFile(await configFile(root), '');
    expect((await loadConfig(repo)).config).toEqual({ version: 1, projects: [] });
    await createProject(repo, { key: 'CC', name: 'C' });
    expect((await readConfigObject(root)).projects).toEqual([{ key: 'CC', name: 'C' }]);
  });

  it('still produces exactly the requested config for YAML using anchors and aliases', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(
      await configFile(root),
      'version: 1\nprojects:\n  - key: AA\n    name: A\n    columns: &cols\n      - id: todo\n      - id: done\n  - key: BB\n    name: B\n    columns: *cols\n',
    );
    await updateProject(repo, { key: 'AA', name: 'Alpha' });
    await setViews(repo, { views: ['backlog'], project: 'BB' });
    const config = await readConfigObject(root);
    expect(config.projects[0].name).toBe('Alpha');
    expect(config.projects[1].columns).toEqual([{ id: 'todo' }, { id: 'done' }]);
    expect(config.projects[1].views).toEqual(['backlog']);
  });
});

describe('JSON configs keep working (ADR-6c9f71b)', () => {
  it('stays JSON through every update and never creates a YAML file', async () => {
    const { repo, root } = await makeRepo();
    await convertConfig(repo, 'json');
    expect(await names(root)).toEqual(['config.json']);

    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: [{ id: 'proposed' }, { id: 'old', done: true }] });
    await setViews(repo, { views: ['backlog'] });
    await createIssue(repo, { title: 'still works', project: 'SAMP' });
    expect(await names(root)).toEqual(['config.json']);
    const text = await readFile(await configFile(root), 'utf8');
    expect(JSON.parse(text).projects[1].columns).toEqual([{ id: 'proposed' }, { id: 'old', done: true }]);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  it('is respected by init, which stays idempotent', async () => {
    const { repo, root } = await makeRepo();
    await convertConfig(repo, 'json');
    const result = await executeOperation('repo.init', {}, { cwd: root });
    expect(result.data).toMatchObject({ created: false });
    expect(await names(root)).toEqual(['config.json']);
  });
});

describe('problems with the config file', () => {
  it('refuses to guess when two config files exist, and validate says so', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(path.join(gitboardDir(root), 'config.json'), '{"version":1,"projects":[]}');
    await expect(loadConfig(repo)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('config.yaml, config.json') });
    await expect(createIssue(repo, { title: 'x' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const result = await validateRepo(repo);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('reports invalid YAML and invalid JSON clearly', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(await configFile(root), 'projects: [unclosed');
    await expect(loadConfig(repo)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('is not valid YAML') });
    await writeFile(await configFile(root), 'version: 1\nprojects:\n  - key: lowercase\n    name: x\n');
    await expect(loadConfig(repo)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('config.yaml is invalid') });

    const json = await makeRepo();
    await convertConfig(json.repo, 'json');
    await writeFile(await configFile(json.root), '{ nope');
    await expect(loadConfig(json.repo)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('is not valid JSON') });
  });
});

describe('config convert', () => {
  it('moves between formats without changing the data, and is idempotent', async () => {
    const { repo, root } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: [{ id: 'proposed' }, { id: 'superseded', done: true }] });
    await setViews(repo, { views: ['backlog', 'kanban'] });
    const before = await readConfigObject(root);

    expect(await convertConfig(repo, 'json')).toEqual({ from: 'config.yaml', to: 'config.json', changed: true });
    expect(await names(root)).toEqual(['config.json']);
    expect(await readConfigObject(root)).toEqual(before);
    expect(await convertConfig(repo, 'json')).toEqual({ from: 'config.json', to: 'config.json', changed: false });

    expect(await convertConfig(repo)).toEqual({ from: 'config.json', to: 'config.yaml', changed: true }); // YAML is the default target
    expect(await names(root)).toEqual(['config.yaml']);
    expect(await readConfigObject(root)).toEqual(before);
  });

  it('is available on the command line', async () => {
    const { root } = await makeRepo();
    const toJson = await runCli(['config', 'convert', '--to', 'json', '--json'], { cwd: root });
    expect(toJson.json.data).toEqual({ from: 'config.yaml', to: 'config.json', changed: true });
    expect((await runCli(['config', 'convert', '--to', 'json'], { cwd: root })).out).toContain('already uses that format');
    expect((await runCli(['config', 'convert'], { cwd: root })).out).toContain('Converted .gitboard/config.json to .gitboard/config.yaml');
    expect((await runCli(['config', 'convert', '--to', 'xml', '--json'], { cwd: root })).code).toBe(2);
    expect((await runCli(['validate', '--json'], { cwd: root })).json.ok).toBe(true);
  });
});
