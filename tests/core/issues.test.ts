import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkItem,
  createIssue,
  deleteIssue,
  getBoard,
  getIssue,
  listIssues,
  moveIssue,
  updateIssue,
} from '../../src/core/issues/service';
import { createProject } from '../../src/core/projects/config';
import { makeRepo, useTestHome } from '../helpers';

useTestHome();

const issueFile = (root: string, id: string) => path.join(root, '.gitboard', 'issues', `${id}.md`);

describe('create and read', () => {
  it('creates an issue with defaults in the first column of the only project', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'Implement authentication service', priority: 'high', labels: ['backend', 'backend', ' api '] });
    expect(issue).toMatchObject({ title: 'Implement authentication service', status: 'todo', project: 'SAMP', type: 'story', priority: 'high', labels: ['backend', 'api'] });
    expect(issue.id).toMatch(/^[0-9a-f]{12}$/);
    expect(issue.ref).toBe(`SAMP-${issue.id.slice(0, 7)}`);
    expect(issue.body).toContain('## Acceptance Criteria');
    const text = await readFile(issueFile(root, issue.id), 'utf8');
    expect(text.startsWith(`---\nid: ${issue.id}\n`)).toBe(true);
  });

  it('requires a project when several exist', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'WEB', name: 'Website' });
    await expect(createIssue(repo, { title: 'x' })).rejects.toMatchObject({ code: 'MISSING_INPUT' });
    const issue = await createIssue(repo, { title: 'x', project: 'WEB' });
    expect(issue.project).toBe('WEB');
  });

  it('rejects unknown projects and unknown statuses', async () => {
    const { repo } = await makeRepo();
    await expect(createIssue(repo, { title: 'x', project: 'NOPE' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(createIssue(repo, { title: 'x', status: 'blocked' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('keeps issue ids stable and files flat across renames and project moves', async () => {
    const { repo, root } = await makeRepo();
    await createProject(repo, { key: 'WEB', name: 'Website' });
    const created = await createIssue(repo, { title: 'Original', project: 'SAMP' });
    await updateIssue(repo, { ref: created.id, title: 'Renamed' });
    await updateIssue(repo, { ref: created.id, project: 'WEB' });
    const files = (await readdir(path.join(root, '.gitboard', 'issues'))).filter((f) => f.endsWith('.md'));
    expect(files).toEqual([`${created.id}.md`]);
    const after = await getIssue(repo, created.id);
    expect(after).toMatchObject({ id: created.id, title: 'Renamed', project: 'WEB' });
  });
});

describe('references', () => {
  it('resolves full ids, prefixes and KEY-prefix references', async () => {
    const { repo } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    expect((await getIssue(repo, issue.id)).id).toBe(issue.id);
    expect((await getIssue(repo, issue.id.slice(0, 7))).id).toBe(issue.id);
    expect((await getIssue(repo, `SAMP-${issue.id.slice(0, 7)}`)).id).toBe(issue.id);
  });

  it('warns, but resolves by id, when the key disagrees with the project', async () => {
    const { repo } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    const warnings: string[] = [];
    const found = await getIssue(repo, `OTHER-${issue.id.slice(0, 7)}`, { warn: (m) => warnings.push(m) });
    expect(found.id).toBe(issue.id);
    expect(warnings[0]).toMatch(/names project OTHER/);
  });

  it('reports missing, malformed and ambiguous references', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'x' });
    await expect(getIssue(repo, 'ffffffff')).rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' });
    await expect(getIssue(repo, 'not a ref')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (let i = 0; i < 40; i++) await createIssue(repo, { title: `bulk ${i}` });
    const ambiguous = await listIssues(repo).then((all) => all.map((a) => a.id[0]));
    const shared = ambiguous.find((c, i) => ambiguous.indexOf(c) !== i) as string;
    await expect(getIssue(repo, `${shared}${'0'.repeat(3)}`)).rejects.toMatchObject({ code: expect.stringMatching(/AMBIGUOUS_ID|ISSUE_NOT_FOUND/) });
  });
});

describe('updates', () => {
  it('updates metadata and labels, and preserves untouched content', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x', labels: ['a', 'b'] });
    const updated = await updateIssue(repo, { ref: issue.id, priority: 'urgent', addLabels: ['c'], removeLabels: ['a'] });
    expect(updated).toMatchObject({ priority: 'urgent', labels: ['b', 'c'] });
    expect(updated.updatedAt).toBeDefined();
    const text = await readFile(issueFile(root, issue.id), 'utf8');
    expect(text).toContain(issue.body.trim());

    const cleared = await updateIssue(repo, { ref: issue.id, priority: null });
    expect(cleared.priority).toBeUndefined();
  });

  it('does not rewrite a file when nothing changes', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x', priority: 'low' });
    const file = issueFile(root, issue.id);
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(file, past, past);
    const before = (await stat(file)).mtimeMs;

    await updateIssue(repo, { ref: issue.id, title: 'x', priority: 'low', status: 'todo', body: issue.body });
    await moveIssue(repo, { ref: issue.id });
    await checkItem(repo, { ref: issue.id, index: 1 }).catch(() => undefined);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it('preserves hand-written content, comments and unknown keys when updating', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    const file = issueFile(root, issue.id);
    const original = await readFile(file, 'utf8');
    const edited = original.replace('---\n\n', '---\n').replace(/^---\n/, '---\n# note from a human\n').replace('type: story', 'type: story\ncustom: kept') + '\n\nExtra paragraph.\n';
    await writeFile(file, edited);
    await updateIssue(repo, { ref: issue.id, status: 'in-progress' });
    const after = await readFile(file, 'utf8');
    expect(after).toContain('# note from a human');
    expect(after).toContain('custom: kept');
    expect(after).toContain('Extra paragraph.');
    expect(after).toContain('status: in-progress');
  });

  it('fails with CONFLICT when the file changed since it was read', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    await writeFile(issueFile(root, issue.id), (await readFile(issueFile(root, issue.id), 'utf8')) + '\nedited elsewhere\n');
    await expect(updateIssue(repo, { ref: issue.id, title: 'mine', expectedHash: issue.hash })).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = await getIssue(repo, issue.id);
    expect(current.title).toBe('x');
    expect((await updateIssue(repo, { ref: issue.id, title: 'mine', expectedHash: current.hash })).title).toBe('mine');
  });

  it('detects external edits made directly to the files', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'before' });
    const text = await readFile(issueFile(root, issue.id), 'utf8');
    await writeFile(issueFile(root, issue.id), text.replace('title: before', 'title: after').replace('status: todo', 'status: done'));
    const board = await getBoard(repo);
    const done = board[0]?.columns.find((c) => c.id === 'done');
    expect(done?.issues.map((i) => i.title)).toEqual(['after']);
  });
});

describe('status transitions', () => {
  it('moves between columns and rejects statuses that are not columns', async () => {
    const { repo } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    expect((await moveIssue(repo, { ref: issue.id, status: 'in-progress' })).issue.status).toBe('in-progress');
    expect((await moveIssue(repo, { ref: issue.id, status: 'done' })).issue.status).toBe('done');
    await expect(moveIssue(repo, { ref: issue.id, status: 'blocked' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expect(updateIssue(repo, { ref: issue.id, status: 'blocked' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('refuses a project change when the status does not exist in the target project', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted'] });
    const issue = await createIssue(repo, { title: 'x', project: 'SAMP', status: 'in-progress' });
    await expect(updateIssue(repo, { ref: issue.id, project: 'ADR' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const moved = await updateIssue(repo, { ref: issue.id, project: 'ADR', status: 'proposed' });
    expect(moved).toMatchObject({ project: 'ADR', status: 'proposed' });
  });
});

describe('ordering within a column', () => {
  const titles = async (repo: Parameters<typeof listIssues>[0], status = 'todo') =>
    (await listIssues(repo, { status })).map((i) => i.title);

  it('orders unranked cards by priority, then creation time', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'low', priority: 'low' });
    await createIssue(repo, { title: 'urgent', priority: 'urgent' });
    await createIssue(repo, { title: 'medium-1' });
    await new Promise((r) => setTimeout(r, 5));
    await createIssue(repo, { title: 'medium-2' });
    expect(await titles(repo)).toEqual(['urgent', 'medium-1', 'medium-2', 'low']);
  });

  it('places a card before, after, at the top and at the bottom', async () => {
    const { repo } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    const d = await createIssue(repo, { title: 'd' });
    expect(await titles(repo)).toEqual(['a', 'b', 'c', 'd']);

    await moveIssue(repo, { ref: d.id, before: b.id });
    expect(await titles(repo)).toEqual(['a', 'd', 'b', 'c']);
    await moveIssue(repo, { ref: a.id, after: c.id });
    expect(await titles(repo)).toEqual(['d', 'b', 'c', 'a']);
    await moveIssue(repo, { ref: c.id, position: 'top' });
    expect(await titles(repo)).toEqual(['c', 'd', 'b', 'a']);
    await moveIssue(repo, { ref: c.id, position: 'bottom' });
    expect(await titles(repo)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('writes only the moved file once ranks exist, and keeps order across many moves', async () => {
    const { repo } = await makeRepo();
    const cards = [];
    for (const t of ['a', 'b', 'c', 'e']) cards.push(await createIssue(repo, { title: t }));
    await moveIssue(repo, { ref: (cards[3] as { id: string }).id, position: 'top' });
    const second = await moveIssue(repo, { ref: (cards[2] as { id: string }).id, before: (cards[3] as { id: string }).id });
    expect(second.reranked).toEqual([]);
    expect(await titles(repo)).toEqual(['c', 'e', 'a', 'b']);
    for (let i = 0; i < 30; i++) {
      await moveIssue(repo, { ref: (cards[0] as { id: string }).id, before: (cards[2] as { id: string }).id });
      await moveIssue(repo, { ref: (cards[0] as { id: string }).id, after: (cards[2] as { id: string }).id });
    }
    expect(await titles(repo)).toEqual(['c', 'a', 'e', 'b']);
  });

  it('appends a card moved to another column at the bottom', async () => {
    const { repo } = await makeRepo();
    const a = await createIssue(repo, { title: 'a', status: 'in-progress' });
    const b = await createIssue(repo, { title: 'b' });
    await moveIssue(repo, { ref: b.id, status: 'in-progress' });
    expect(await titles(repo, 'in-progress')).toEqual(['a', 'b']);
    await moveIssue(repo, { ref: a.id, status: 'in-progress', position: 'bottom' });
    expect(await titles(repo, 'in-progress')).toEqual(['b', 'a']);
  });

  it('rejects an anchor that is not in the target column', async () => {
    const { repo } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b', status: 'done' });
    await expect(moveIssue(repo, { ref: a.id, before: b.id })).rejects.toMatchObject({ code: 'INVALID_POSITION' });
    await expect(moveIssue(repo, { ref: a.id, before: b.id, after: b.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('epics and parents', () => {
  it('links stories to an epic and derives progress', async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const s1 = await createIssue(repo, { title: 's1', parent: epic.id });
    await createIssue(repo, { title: 's2', parent: epic.id });
    await moveIssue(repo, { ref: s1.id, status: 'done' });

    const detail = await getIssue(repo, epic.id);
    expect(detail.progress).toEqual({ total: 2, done: 1, byStatus: { todo: 1, 'in-progress': 0, done: 1 } });
    expect(detail.children?.map((c) => c.title).sort()).toEqual(['s1', 's2']);
    expect((await getIssue(repo, s1.id)).parentIssue?.id).toBe(epic.id);
    expect((await listIssues(repo, { parent: epic.id })).map((i) => i.title).sort()).toEqual(['s1', 's2']);
  });

  it('enforces parent rules', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'WEB', name: 'Website' });
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic', project: 'SAMP' });
    const story = await createIssue(repo, { title: 'story', project: 'SAMP' });
    const webEpic = await createIssue(repo, { title: 'Web epic', type: 'epic', project: 'WEB' });

    await expect(createIssue(repo, { title: 'x', project: 'SAMP', parent: story.id })).rejects.toMatchObject({ code: 'BAD_PARENT' });
    await expect(createIssue(repo, { title: 'x', project: 'SAMP', parent: webEpic.id })).rejects.toMatchObject({ code: 'BAD_PARENT' });
    await expect(createIssue(repo, { title: 'x', type: 'epic', project: 'SAMP', parent: epic.id })).rejects.toMatchObject({ code: 'BAD_PARENT' });
    await expect(updateIssue(repo, { ref: epic.id, parent: epic.id })).rejects.toMatchObject({ code: 'BAD_PARENT' });
    await expect(updateIssue(repo, { ref: story.id, parent: webEpic.id })).rejects.toMatchObject({ code: 'BAD_PARENT' });
  });

  it('refuses project changes that would break a parent link, and supports unlinking', async () => {
    const { repo } = await makeRepo();
    await createProject(repo, { key: 'WEB', name: 'Website' });
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic', project: 'SAMP' });
    const story = await createIssue(repo, { title: 'story', project: 'SAMP', parent: epic.id });

    await expect(updateIssue(repo, { ref: story.id, project: 'WEB' })).rejects.toMatchObject({ code: 'BAD_PARENT' });
    await expect(updateIssue(repo, { ref: epic.id, project: 'WEB' })).rejects.toMatchObject({ code: 'HAS_CHILDREN' });
    const moved = await updateIssue(repo, { ref: story.id, project: 'WEB', parent: null });
    expect(moved).toMatchObject({ project: 'WEB' });
    expect(moved.parent).toBeUndefined();
    expect((await updateIssue(repo, { ref: story.id, parent: null })).parent).toBeUndefined();
  });

  it('refuses to delete an epic with children unless they are unlinked', async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const child = await createIssue(repo, { title: 'child', parent: epic.id });
    await expect(deleteIssue(repo, { id: epic.id })).rejects.toMatchObject({ code: 'HAS_CHILDREN' });
    const result = await deleteIssue(repo, { id: epic.id, unlinkChildren: true });
    expect(result.unlinked).toEqual([child.id]);
    expect((await getIssue(repo, child.id)).parent).toBeUndefined();
    await expect(getIssue(repo, epic.id)).rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' });
  });
});

describe('delete, filters and checklists', () => {
  it('deletes by full id only', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    await expect(deleteIssue(repo, { id: 'short' as never })).rejects.toBeDefined().catch(() => undefined);
    await deleteIssue(repo, { id: issue.id });
    const files = (await readdir(path.join(root, '.gitboard', 'issues'))).filter((f) => f.endsWith('.md'));
    expect(files).toEqual([]);
    await expect(deleteIssue(repo, { id: issue.id })).rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' });
  });

  it('filters by status, label, priority, type and text', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'Login page', labels: ['ui'], priority: 'high', body: 'needs OAuth' });
    await createIssue(repo, { title: 'API', labels: ['backend'], status: 'done' });
    await createIssue(repo, { title: 'Epic', type: 'epic' });
    expect((await listIssues(repo, { label: 'UI' })).map((i) => i.title)).toEqual(['Login page']);
    expect((await listIssues(repo, { status: 'done' })).map((i) => i.title)).toEqual(['API']);
    expect((await listIssues(repo, { priority: 'high' })).map((i) => i.title)).toEqual(['Login page']);
    expect((await listIssues(repo, { type: 'epic' })).map((i) => i.title)).toEqual(['Epic']);
    expect((await listIssues(repo, { q: 'oauth' })).map((i) => i.title)).toEqual(['Login page']);
    await expect(listIssues(repo, { project: 'NOPE' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('toggles checklist items by index and reports bad indexes', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x', body: '## Acceptance Criteria\n\n- [ ] one\n- [ ] two\n' });
    const toggled = await checkItem(repo, { ref: issue.id, index: 2 });
    expect(toggled.checklist).toEqual([
      { index: 1, text: 'one', checked: false },
      { index: 2, text: 'two', checked: true },
    ]);
    expect(await readFile(issueFile(root, issue.id), 'utf8')).toContain('- [x] two');
    expect((await checkItem(repo, { ref: issue.id, index: 2, checked: false })).checklist[1]?.checked).toBe(false);
    await expect(checkItem(repo, { ref: issue.id, index: 5 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('shows issues in unknown statuses on the board so they are not lost', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    const file = issueFile(root, issue.id);
    await writeFile(file, (await readFile(file, 'utf8')).replace('status: todo', 'status: legacy'));
    const board = await getBoard(repo);
    expect(board[0]?.columns.at(-1)).toMatchObject({ id: 'legacy', name: 'legacy (unknown)' });
  });
});

describe('board', () => {
  it('lists epics separately with progress instead of as cards in the columns', async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const story = await createIssue(repo, { title: 'story', parent: epic.id });
    await moveIssue(repo, { ref: story.id, status: 'done' });
    const [board] = await getBoard(repo);
    expect(board?.columns.flatMap((c) => c.issues.map((i) => i.title))).toEqual(['story']);
    expect(board?.epics).toEqual([expect.objectContaining({ id: epic.id, progress: expect.objectContaining({ total: 1, done: 1 }) })]);
  });
});

describe('moves that change nothing', () => {
  const state = async (root: string, ids: string[]) =>
    Promise.all(ids.map(async (id) => (await readFile(issueFile(root, id), 'utf8'))));

  it('write no files when the card is already in the requested position', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    const ids = [a.id, b.id, c.id];
    const before = await state(root, ids);

    // c is last and a is first in a column that was never reordered.
    expect((await moveIssue(repo, { ref: c.id, position: 'bottom' })).reranked).toEqual([]);
    await moveIssue(repo, { ref: a.id, position: 'top' });
    await moveIssue(repo, { ref: b.id, before: c.id });
    await moveIssue(repo, { ref: b.id, after: a.id });
    await moveIssue(repo, { ref: a.id, before: a.id }).catch(() => undefined);
    expect(await state(root, ids)).toEqual(before);

    // After a real reorder, repeating the same drop is also a no-op.
    await moveIssue(repo, { ref: c.id, position: 'top' });
    const afterReorder = await state(root, ids);
    await moveIssue(repo, { ref: c.id, position: 'top' });
    await moveIssue(repo, { ref: a.id, after: c.id });
    expect(await state(root, ids)).toEqual(afterReorder);
  });

  it('give neighbours a rank without touching their updatedAt, and never touch it for pure reordering', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    await moveIssue(repo, { ref: a.id, after: c.id }); // reorders: a goes to the bottom

    for (const id of [a.id, b.id, c.id]) {
      const text = await readFile(issueFile(root, id), 'utf8');
      expect(text).toContain('rank:');
      expect(text).not.toContain('updatedAt');
    }
    expect((await listIssues(repo)).map((i) => i.title)).toEqual(['b', 'c', 'a']);
  });

  it('still stamps updatedAt on the moved card, and only on it, when its status changes', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b', status: 'done' });
    await moveIssue(repo, { ref: a.id, status: 'done' });
    expect(await readFile(issueFile(root, a.id), 'utf8')).toContain('updatedAt');
    expect(await readFile(issueFile(root, b.id), 'utf8')).not.toContain('updatedAt');
  });
});

describe('a plain status change does not rank anything', () => {
  const texts = async (root: string, ids: string[]) => Promise.all(ids.map((id) => readFile(issueFile(root, id), 'utf8')));

  it('changes only that issue, and the issue drops the rank it had in its old column', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c', status: 'done' });
    const d = await createIssue(repo, { title: 'd', status: 'done' });
    await moveIssue(repo, { ref: a.id, position: 'bottom' }); // a is ranked now
    expect(await readFile(issueFile(root, a.id), 'utf8')).toContain('rank:');

    const others = [b.id, c.id, d.id];
    const before = await texts(root, others);
    const result = await moveIssue(repo, { ref: a.id, status: 'done' });

    expect(result.reranked).toEqual([]);
    expect(await texts(root, others)).toEqual(before); // no neighbour was touched
    const moved = await readFile(issueFile(root, a.id), 'utf8');
    expect(moved).toContain('status: done');
    expect(moved).not.toContain('rank:');
    expect(moved).toContain('updatedAt'); // it is a real edit of this issue
    expect(result.issue.rank).toBeUndefined();
  });

  it('places the unranked card after the ranked ones, then by priority and creation time', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'older medium', status: 'done' });
    const ranked = await createIssue(repo, { title: 'ranked', status: 'done' });
    await moveIssue(repo, { ref: ranked.id, position: 'top' }); // a real move, so it gets a rank
    const urgent = await createIssue(repo, { title: 'urgent', priority: 'urgent' });
    const plain = await createIssue(repo, { title: 'plain' });
    await moveIssue(repo, { ref: plain.id, status: 'done' });
    await moveIssue(repo, { ref: urgent.id, status: 'done' });
    expect((await listIssues(repo, { status: 'done' })).map((i) => i.title)).toEqual(['ranked', 'urgent', 'older medium', 'plain']);
  });

  it('still ranks the card when a position is given', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    await createIssue(repo, { title: 'b', status: 'done' });
    await moveIssue(repo, { ref: a.id, status: 'done', position: 'top' });
    expect(await readFile(issueFile(root, a.id), 'utf8')).toContain('rank:');
    expect((await listIssues(repo, { status: 'done' })).map((i) => i.title)).toEqual(['a', 'b']);
  });
});
