import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeOperation } from '../../src/core';
import { createIssue, getBacklog, getBoard, moveIssue } from '../../src/core/issues/service';
import { createProject, setColumns } from '../../src/core/projects/config';
import { effectiveViews, resetViews, setViews, showViews } from '../../src/core/projects/views';
import { validateRepo } from '../../src/core/validation/validate';
import { configFile, makeRepo, readConfigObject, useTestHome, writeConfigObject } from '../helpers';

useTestHome();


describe('enabled views are layered like columns (ADR-0014)', () => {
  it('defaults to every view, then repository, then project', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions' });
    expect(await showViews(repo)).toEqual({ views: ['kanban', 'backlog'], source: 'builtin' });
    expect(await showViews(repo, 'ADR')).toEqual({ project: 'ADR', views: ['kanban', 'backlog'], source: 'builtin' });

    await setViews(repo, { views: ['backlog'] });
    expect(await showViews(repo, 'SAMP')).toMatchObject({ views: ['backlog'], source: 'repo' });
    expect(await showViews(repo, 'ADR')).toMatchObject({ views: ['backlog'], source: 'repo' });

    await setViews(repo, { views: ['kanban', 'backlog'], project: 'ADR' });
    expect(await showViews(repo, 'ADR')).toMatchObject({ views: ['kanban', 'backlog'], source: 'project' });
    expect(await showViews(repo, 'SAMP')).toMatchObject({ views: ['backlog'], source: 'repo' });

    expect(await resetViews(repo, { project: 'ADR' })).toMatchObject({ views: ['backlog'], source: 'repo' });
    expect(await resetViews(repo, {})).toMatchObject({ views: ['kanban', 'backlog'], source: 'builtin' });
  });

  it('keeps the configured order, whose first entry is the default view', async () => {
    const { repo } = await makeRepo();
    await setViews(repo, { views: ['backlog', 'kanban'] });
    expect((await showViews(repo)).views).toEqual(['backlog', 'kanban']);
  });

  it('stores the setting in the committed config and resetting restores the original file', async () => {
    const { repo, root } = await makeRepo();
    const original = await readFile(await configFile(root), 'utf8');
    await setViews(repo, { views: ['kanban'], project: 'SAMP' });
    expect((await readConfigObject(root)).projects[0].views).toEqual(['kanban']);
    await setViews(repo, { views: ['backlog'] });
    expect((await readConfigObject(root)).views).toEqual(['backlog']);
    await resetViews(repo, { project: 'SAMP' });
    await resetViews(repo, {});
    expect(await readFile(await configFile(root), 'utf8')).toBe(original);
  });

  it('rejects unknown, duplicate and empty lists and unknown projects', async () => {
    const { root } = await makeRepo();
    const run = (input: unknown) => executeOperation('views.set', input, { cwd: root });
    await expect(run({ views: ['timeline'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run({ views: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run({ views: ['kanban', 'kanban'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run({ views: ['kanban'], project: 'NOPE' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(executeOperation('views.show', { project: 'NOPE' }, { cwd: root })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('ignores unknown ids found in a hand-edited config, and validate reports them', async () => {
    const { repo, root } = await makeRepo();
    const config = await readConfigObject(root);
    config.views = ['timeline', 'backlog'];
    config.projects[0].views = ['calendar'];
    await writeConfigObject(root, config);

    // A project list with no known view is skipped; the repo list keeps only what this version knows.
    expect(await showViews(repo, 'SAMP')).toMatchObject({ views: ['backlog'], source: 'repo' });
    config.views = ['timeline'];
    expect(effectiveViews(config, 'SAMP')).toMatchObject({ views: ['kanban', 'backlog'], source: 'builtin' });

    await writeConfigObject(root, { ...config, views: ['timeline', 'backlog'] });
    const result = await validateRepo(repo);
    expect(result.problems.map((p) => p.code)).toEqual(['UNKNOWN_VIEW', 'UNKNOWN_VIEW']);
    expect(result.problems[0]?.message).toMatch(/timeline/);
  });

  it('tells the board which views to offer', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions' });
    await setViews(repo, { views: ['backlog'], project: 'ADR' });
    const boards = await getBoard(repo);
    expect(boards.map((b) => [b.project.key, b.views.views, b.views.source])).toEqual([
      ['SAMP', ['kanban', 'backlog'], 'builtin'],
      ['ADR', ['backlog'], 'project'],
    ]);
  });
});

describe('backlog data', () => {
  const titles = (sections: Array<{ issues: Array<{ title: string }> }>) => sections.map((s) => s.issues.map((i) => i.title));

  it('lists open work grouped by status and hides the done column by default', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'a' });
    await createIssue(repo, { title: 'b' });
    await createIssue(repo, { title: 'wip', status: 'in-progress' });
    await createIssue(repo, { title: 'shipped', status: 'done' });
    await createIssue(repo, { title: 'also shipped', status: 'done' });

    const [backlog] = await getBacklog(repo);
    expect(backlog?.sections.map((s) => s.id)).toEqual(['todo', 'in-progress']);
    expect(titles(backlog?.sections ?? [])).toEqual([['a', 'b'], ['wip']]);
    expect(backlog).toMatchObject({ doneStatuses: ['done'], hiddenCount: 2 });

    const [all] = await getBacklog(repo, { includeDone: true });
    expect(all?.sections.map((s) => s.id)).toEqual(['todo', 'in-progress', 'done']);
    expect(all?.hiddenCount).toBe(0);
  });

  it('uses the same order as the board, and lists epics separately', async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const a = await createIssue(repo, { title: 'a', parent: epic.id });
    await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    await moveIssue(repo, { ref: c.id, position: 'top' });
    await moveIssue(repo, { ref: a.id, status: 'in-progress' });

    const [board] = await getBoard(repo);
    const [backlog] = await getBacklog(repo);
    expect(titles(backlog?.sections ?? [])).toEqual(titles((board?.columns ?? []).slice(0, 2)));
    expect(titles(backlog?.sections ?? []).flat()).not.toContain('Epic');
    expect(backlog?.epics.map((e) => [e.title, e.progress.total])).toEqual([['Epic', 1]]);
  });

  it('follows the project columns: the last column of that project is "done"', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted', 'superseded'] });
    await createIssue(repo, { title: 'p', project: 'ADR' });
    await createIssue(repo, { title: 'old', project: 'ADR', status: 'superseded' });
    const [backlog] = await getBacklog(repo, { project: 'ADR' });
    expect(backlog?.sections.map((s) => s.id)).toEqual(['proposed', 'accepted']);
    expect(backlog).toMatchObject({ doneStatuses: ['superseded'], hiddenCount: 1 });
  });

  it('hides nothing when a project has a single column', async () => {
    const { repo } = await makeRepo();
    await setColumns(repo, { columns: ['open'] });
    await createIssue(repo, { title: 'only' });
    const [backlog] = await getBacklog(repo);
    expect(backlog?.sections.map((s) => s.id)).toEqual(['open']);
    expect(backlog?.doneStatuses).toEqual([]);
    expect(backlog?.hiddenCount).toBe(0);
  });

  it('keeps issues with an unknown status visible and rejects unknown projects', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    const file = path.join(root, '.gitboard', 'issues', `${issue.id}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('status: todo', 'status: legacy'));
    const [backlog] = await getBacklog(repo);
    expect(backlog?.sections.at(-1)).toMatchObject({ id: 'legacy', name: 'legacy (unknown)' });
    await expect(getBacklog(repo, { project: 'NOPE' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
