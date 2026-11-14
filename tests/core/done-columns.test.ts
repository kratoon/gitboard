import { describe, expect, it } from 'vitest';
import { executeOperation } from '../../src/core';
import { createIssue, getBacklog, getBoard, getIssue, moveIssue } from '../../src/core/issues/service';
import { effectiveColumns } from '../../src/core/projects/columns';
import { createProject, loadConfig, resetColumns, setColumns, showColumns } from '../../src/core/projects/config';
import { makeRepo, runCli, useTestHome } from '../helpers';

useTestHome();

const doneIds = (info: { columns: Array<{ id: string; done: boolean }> }) => info.columns.filter((c) => c.done).map((c) => c.id);

describe('done columns (ADR-f8d6236)', () => {
  it('flags the built-in done column and falls back to "the last column" when nothing is said', async () => {
    const { repo } = await makeRepo();
    expect(doneIds(await showColumns(repo))).toEqual(['done']);
    await setColumns(repo, { columns: ['backlog', 'doing', 'shipped'] });
    expect(doneIds(await showColumns(repo))).toEqual(['shipped']);
    await setColumns(repo, { columns: ['only'] });
    expect(doneIds(await showColumns(repo))).toEqual([]); // a single column is never "done" implicitly
  });

  it('lets any number of columns be done, and an explicit false overrides the fallback', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, {
      key: 'ADR',
      name: 'Decisions',
      columns: [{ id: 'proposed' }, { id: 'accepted' }, { id: 'superseded', done: true }, { id: 'rejected', done: true }],
    });
    expect(doneIds(await showColumns(repo, 'ADR'))).toEqual(['superseded', 'rejected']);

    await setColumns(repo, { project: 'ADR', columns: [{ id: 'a', done: false }, { id: 'b', done: false }] });
    expect(doneIds(await showColumns(repo, 'ADR'))).toEqual([]); // explicit: no column is done
    await setColumns(repo, { project: 'ADR', columns: [{ id: 'a' }, { id: 'b' }, { id: 'c', done: true }] });
    expect(doneIds(await showColumns(repo, 'ADR'))).toEqual(['c']); // once any column says, unmarked ones are not done
  });

  it('keeps each column\'s done flag when columns are re-set without mentioning it', async () => {
    const { repo } = await makeRepo();
    await setColumns(repo, { columns: [{ id: 'todo', done: false }, { id: 'review', done: true }, { id: 'merged', done: true }] });
    await setColumns(repo, { columns: ['merged', 'todo', 'review', 'archived'] }); // reorder, plus a new column
    const info = await showColumns(repo);
    expect(info.columns.map((c) => [c.id, c.done])).toEqual([['merged', true], ['todo', false], ['review', true], ['archived', false]]);
    // an explicit value always wins over the carried one
    await setColumns(repo, { columns: [{ id: 'merged', done: false }, { id: 'todo' }, { id: 'review' }] });
    expect(doneIds(await showColumns(repo))).toEqual(['review']);
  });

  it('stores the flag in the config and a reset restores the layer below', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: [{ id: 'proposed' }, { id: 'old', done: true }] });
    const { config } = await loadConfig(repo);
    expect(config.projects[1]?.columns).toEqual([{ id: 'proposed' }, { id: 'old', done: true }]);
    await resetColumns(repo, { project: 'ADR' });
    expect(doneIds(await showColumns(repo, 'ADR'))).toEqual(['done']);
  });

  it('resolves the flag from the config schema, and rejects a non-boolean value', async () => {
    const { repo } = await makeRepo();
    await expect(setColumns(repo, { columns: [{ id: 'a', done: 'yes' as unknown as boolean }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const { config } = await loadConfig(repo);
    expect(effectiveColumns({ ...config, columns: [{ id: 'x', done: true }, { id: 'y' }] }).columns.map((c) => c.done)).toEqual([true, false]);
  });

  it('counts every done column in epic progress', async () => {
    const { repo } = await makeRepo();
    await setColumns(repo, { columns: [{ id: 'todo', done: false }, { id: 'merged', done: true }, { id: 'dropped', done: true }] });
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const a = await createIssue(repo, { title: 'a', parent: epic.id });
    const b = await createIssue(repo, { title: 'b', parent: epic.id });
    await createIssue(repo, { title: 'c', parent: epic.id });
    await moveIssue(repo, { ref: a.id, status: 'merged' });
    await moveIssue(repo, { ref: b.id, status: 'dropped' });
    expect((await getIssue(repo, epic.id)).progress).toEqual({ total: 3, done: 2, byStatus: { todo: 1, merged: 1, dropped: 1 } });
    const [board] = await getBoard(repo);
    expect(board?.epics[0]?.progress.done).toBe(2);
    expect(board?.columns.map((c) => [c.id, c.done])).toEqual([['todo', false], ['merged', true], ['dropped', true]]);
  });

  it('hides all done columns in the backlog unless asked', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: [{ id: 'proposed' }, { id: 'accepted' }, { id: 'superseded', done: true }, { id: 'rejected', done: true }] });
    await createIssue(repo, { title: 'new idea', project: 'ADR' });
    await createIssue(repo, { title: 'settled', project: 'ADR', status: 'accepted' });
    await createIssue(repo, { title: 'replaced', project: 'ADR', status: 'superseded' });
    await createIssue(repo, { title: 'declined', project: 'ADR', status: 'rejected' });

    const [open] = await getBacklog(repo, { project: 'ADR' });
    expect(open?.sections.map((s) => s.id)).toEqual(['proposed', 'accepted']);
    expect(open).toMatchObject({ doneStatuses: ['superseded', 'rejected'], hiddenCount: 2 });
    const [all] = await getBacklog(repo, { project: 'ADR', includeDone: true });
    expect(all?.sections.map((s) => s.id)).toEqual(['proposed', 'accepted', 'superseded', 'rejected']);
    expect(all?.hiddenCount).toBe(0);
  });
});

describe('done columns on the command line', () => {
  it('sets done columns with --done and shows them', async () => {
    const { root } = await makeRepo();
    const set = await runCli(['columns', 'set', '--columns', 'proposed,accepted,superseded,rejected', '--done', 'superseded,rejected', '--project', 'SAMP', '--json'], { cwd: root });
    expect(set.code).toBe(0);
    expect(set.json.data.columns.filter((c: { done: boolean }) => c.done).map((c: { id: string }) => c.id)).toEqual(['superseded', 'rejected']);
    const text = await runCli(['columns', 'show', '--project', 'SAMP'], { cwd: root });
    expect(text.out).toContain('superseded  (Superseded)  [done]');
    expect(text.out).not.toContain('accepted  (Accepted)  [done]');
  });

  it('rejects a --done id that is not one of the columns', async () => {
    const { root } = await makeRepo();
    const result = await runCli(['columns', 'set', '--columns', 'a,b', '--done', 'c', '--json'], { cwd: root });
    expect(result.code).toBe(2);
    expect(result.json.error?.message).toMatch(/--done lists c, which is not in --columns/);
  });

  it('works for init and project create too, and keeps flags when only reordering', async () => {
    const { root } = await makeRepo({ init: false, name: 'done-app' });
    expect((await runCli(['init', '--columns', 'todo,review,merged', '--done', 'merged', '--json'], { cwd: root })).code).toBe(0);
    await runCli(['project', 'create', 'ADR', '--columns', 'proposed,accepted,superseded', '--done', 'accepted,superseded', '--json'], { cwd: root });
    const adr = await runCli(['columns', 'show', '--project', 'ADR', '--json'], { cwd: root });
    expect(adr.json.data.columns.map((c: { id: string; done: boolean }) => [c.id, c.done])).toEqual([['proposed', false], ['accepted', true], ['superseded', true]]);
    const reordered = await runCli(['columns', 'set', '--columns', 'superseded,proposed,accepted', '--project', 'ADR', '--json'], { cwd: root });
    expect(reordered.json.data.columns.map((c: { id: string; done: boolean }) => [c.id, c.done])).toEqual([['superseded', true], ['proposed', false], ['accepted', true]]);
    expect((await executeOperation('columns.show', { project: 'ADR' }, { cwd: root })).data).toMatchObject({ source: 'project' });
  });
});

describe('re-setting columns keeps the stored list tidy', () => {
  it('writes done: true only where needed, and keeps a deliberate "nothing is done"', async () => {
    const { repo } = await makeRepo();
    await setColumns(repo, { columns: [{ id: 'todo' }, { id: 'review' }, { id: 'merged', done: true }] });
    await setColumns(repo, { columns: ['todo', 'review', 'qa', 'merged'] });
    const { config } = await loadConfig(repo);
    // `todo` keeps the built-in display name "To Do" that it had before
    expect(config.columns).toEqual([{ id: 'todo', name: 'To Do' }, { id: 'review' }, { id: 'qa' }, { id: 'merged', done: true }]);

    await setColumns(repo, { columns: [{ id: 'a', done: false }, { id: 'b', done: false }] });
    await setColumns(repo, { columns: ['b', 'a', 'c'] });
    expect(doneIds(await showColumns(repo))).toEqual([]); // still nothing is done, not "the last column"
  });
});

describe('re-setting columns keeps custom display names', () => {
  it('keeps "To Do" and "In Progress" when only the ids are sent again', async () => {
    const { repo } = await makeRepo();
    await setColumns(repo, { columns: ['todo', 'in-progress', 'done'] }); // the built-in names are "To Do" / "In Progress"
    expect((await showColumns(repo)).columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
    const { config } = await loadConfig(repo);
    expect(config.columns).toEqual([{ id: 'todo', name: 'To Do' }, { id: 'in-progress' }, { id: 'done', done: true }]);

    await setColumns(repo, { columns: [{ id: 'todo', name: 'Backlog' }, 'in-progress', 'done'] }); // an explicit name wins
    expect((await showColumns(repo)).columns.map((c) => c.name)).toEqual(['Backlog', 'In Progress', 'Done']);
  });
});
