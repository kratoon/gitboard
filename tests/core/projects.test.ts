import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIssue, getBoard, listIssues, moveIssue } from '../../src/core/issues/service';
import {
  createProject,
  deleteProject,
  deriveProjectKey,
  initRepo,
  listProjects,
  resetColumns,
  setColumns,
  showColumns,
  updateProject,
} from '../../src/core/projects/config';
import { validateRepo } from '../../src/core/validation/validate';
import { makeRepo, useTestHome } from '../helpers';

useTestHome();

describe('init', () => {
  it('creates config, issues dir and a line-ending rule, with a default project', async () => {
    const { root } = await makeRepo({ init: false, name: 'my-cool-app' });
    const result = await initRepo(root);
    expect(result.projectKey).toBe('MCA');
    const config = JSON.parse(await readFile(path.join(root, '.gitboard', 'config.json'), 'utf8'));
    expect(config).toEqual({ version: 1, projects: [{ key: 'MCA', name: 'my-cool-app' }] });
    expect(await readFile(path.join(root, '.gitboard', '.gitattributes'), 'utf8')).toBe('* text eol=lf\n');
    await expect(initRepo(root)).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
  });

  it('never stores absolute paths in the committed config', async () => {
    const { root } = await makeRepo();
    const text = await readFile(path.join(root, '.gitboard', 'config.json'), 'utf8');
    expect(text).not.toContain(root);
  });

  it('derives sensible project keys', () => {
    expect(deriveProjectKey('gitboard')).toBe('GITB');
    expect(deriveProjectKey('my-cool-app')).toBe('MCA');
    expect(deriveProjectKey('123')).toBe('MAIN');
    expect(deriveProjectKey('')).toBe('MAIN');
  });

  it('accepts a custom key and columns', async () => {
    const { repo } = await makeRepo({ projectKey: 'WORK', columns: ['backlog', 'doing', 'done'] });
    expect((await showColumns(repo)).columns.map((c) => c.id)).toEqual(['backlog', 'doing', 'done']);
    expect((await listProjects(repo))[0]?.key).toBe('WORK');
  });
});

describe('projects', () => {
  it('creates, lists, updates and deletes projects with unique keys', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'WEB', name: 'Website', description: 'Public site' });
    await expect(createProject(repo, { key: 'WEB', name: 'Again' })).rejects.toMatchObject({ code: 'DUPLICATE_PROJECT' });
    expect((await listProjects(repo)).map((p) => p.key)).toEqual(['SAMP', 'WEB']);

    const updated = await updateProject(repo, { key: 'WEB', name: 'Web', description: null });
    expect(updated).toMatchObject({ key: 'WEB', name: 'Web' });
    expect(updated.description).toBeUndefined();
    await expect(updateProject(repo, { key: 'NOPE', name: 'x' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    await deleteProject(repo, 'WEB');
    expect((await listProjects(repo)).map((p) => p.key)).toEqual(['SAMP']);
  });

  it('refuses to delete a project that still has issues', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'x' });
    await expect(deleteProject(repo, 'SAMP')).rejects.toMatchObject({ code: 'PROJECT_NOT_EMPTY' });
  });
});

describe('layered columns', () => {
  it('resolves project, then repo, then built-in', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions' });
    expect(await showColumns(repo, 'ADR')).toMatchObject({ source: 'builtin' });
    expect((await showColumns(repo)).columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);

    await setColumns(repo, { columns: ['backlog', 'doing', 'done'] });
    expect(await showColumns(repo, 'ADR')).toMatchObject({ source: 'repo' });

    await setColumns(repo, { project: 'ADR', columns: [{ id: 'proposed' }, { id: 'accepted', name: 'Accepted!' }] });
    const adr = await showColumns(repo, 'ADR');
    expect(adr.source).toBe('project');
    expect(adr.columns).toEqual([{ id: 'proposed', name: 'Proposed' }, { id: 'accepted', name: 'Accepted!' }]);
    expect((await showColumns(repo, 'SAMP')).source).toBe('repo');

    await resetColumns(repo, { project: 'ADR' });
    expect((await showColumns(repo, 'ADR')).source).toBe('repo');
    await resetColumns(repo, {});
    expect((await showColumns(repo, 'ADR')).source).toBe('builtin');
  });

  it('replaces rather than merges, and validates column lists', async () => {
    const { repo } = await makeRepo();
    await expect(setColumns(repo, { columns: ['a', 'a'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(setColumns(repo, { columns: ['Bad Id'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(setColumns(repo, { columns: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('shows each project its own columns on the board', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted'] });
    const boards = await getBoard(repo);
    expect(boards.map((b) => [b.project.key, b.columns.map((c) => c.id), b.columnSource])).toEqual([
      ['SAMP', ['todo', 'in-progress', 'done'], 'builtin'],
      ['ADR', ['proposed', 'accepted'], 'project'],
    ]);
    expect((await getBoard(repo, { project: 'ADR' }))).toHaveLength(1);
  });

  it('refuses to orphan issues unless they are remapped', async () => {
    const { repo } = await makeRepo();
    const a = await createIssue(repo, { title: 'a', status: 'in-progress' });
    await createIssue(repo, { title: 'b', status: 'done' });
    await expect(setColumns(repo, { columns: ['todo', 'done'] })).rejects.toMatchObject({ code: 'ORPHANED_STATUS' });
    await expect(setColumns(repo, { columns: ['todo', 'done'], remap: { 'in-progress': 'nonexistent' } })).rejects.toMatchObject({ code: 'ORPHANED_STATUS' });

    const result = await setColumns(repo, { columns: ['todo', 'done'], remap: { 'in-progress': 'todo' } });
    expect(result.remapped).toBe(1);
    expect((await listIssues(repo, { status: 'todo' })).map((i) => i.id)).toEqual([a.id]);
    expect((await validateRepo(repo)).ok).toBe(true);
  });

  it('only checks projects whose effective columns actually change', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted'] });
    await createIssue(repo, { title: 'decision', project: 'ADR', status: 'accepted' });
    // ADR overrides the repo columns, so changing the repo columns cannot orphan it.
    await setColumns(repo, { columns: ['backlog', 'done'] });
    expect((await validateRepo(repo)).ok).toBe(true);
  });

  it('uses project columns for moves', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted'] });
    const issue = await createIssue(repo, { title: 'd', project: 'ADR' });
    expect(issue.status).toBe('proposed');
    await expect(moveIssue(repo, { ref: issue.id, status: 'done' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    expect((await moveIssue(repo, { ref: issue.id, status: 'accepted' })).issue.status).toBe('accepted');
  });
});
