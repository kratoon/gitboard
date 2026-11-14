import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program';
import { operations } from '../../src/core';
import { makeRepo, runCli, snapshotTree, tmpDir, useTestHome } from '../helpers';

useTestHome();

const noIo = {
  out: () => undefined,
  err: () => undefined,
  cwd: '.',
  stdinIsTTY: false,
  stdoutIsTTY: false,
  readStdin: async () => '',
  prompt: async () => '',
};

describe('CLI is the complete interface', () => {
  it('has a command for every registered operation', () => {
    const program = buildProgram(noIo, { exit: 0, json: false });
    for (const op of operations) {
      let command = program;
      for (const part of op.cli.split(' ')) {
        const next = command.commands.find((c) => c.name() === part);
        expect(next, `operation ${op.name} should be exposed as "gitboard ${op.cli}"`).toBeDefined();
        command = next as typeof command;
      }
    }
  });

  it('exposes every operation the HTTP server exposes', () => {
    for (const op of operations.filter((o) => o.surfaces.includes('http'))) {
      expect(op.surfaces).toContain('cli');
    }
  });
});

describe('issue workflow without a server', () => {
  it('runs init, create, update, move, check and delete non-interactively', async () => {
    const { root } = await makeRepo({ init: false, name: 'demo-app' });
    const cwd = root;

    const init = await runCli(['init', '--json'], { cwd });
    expect(init.code).toBe(0);
    expect(init.json).toMatchObject({ ok: true, data: { projectKey: 'DA' } });

    const created = await runCli(['issue', 'create', 'Implement authentication', '--priority', 'high', '--label', 'backend,api', '--body', '## Acceptance Criteria\n\n- [ ] one\n- [ ] two\n', '--json'], { cwd });
    expect(created.code).toBe(0);
    const issue = created.json.data;
    expect(issue).toMatchObject({ title: 'Implement authentication', status: 'todo', priority: 'high', labels: ['backend', 'api'], project: 'DA' });

    const list = await runCli(['issue', 'list', '--json'], { cwd });
    expect(list.json.data).toHaveLength(1);

    const show = await runCli(['issue', 'show', issue.ref], { cwd });
    expect(show.code).toBe(0);
    expect(show.out).toContain('Implement authentication');
    expect(show.out).toContain('- [ ] one');

    const update = await runCli(['issue', 'update', issue.ref, '--priority', 'low', '--add-label', 'ui', '--remove-label', 'api', '--json'], { cwd });
    expect(update.json.data).toMatchObject({ priority: 'low', labels: ['backend', 'ui'] });

    const moved = await runCli(['issue', 'move', issue.id.slice(0, 7), 'in-progress', '--json'], { cwd });
    expect(moved.json.data.issue.status).toBe('in-progress');

    const checked = await runCli(['issue', 'check', issue.ref, '2', '--json'], { cwd });
    expect(checked.json.data.checklist[1].checked).toBe(true);
    const unchecked = await runCli(['issue', 'check', issue.ref, '2', '--uncheck', '--json'], { cwd });
    expect(unchecked.json.data.checklist[1].checked).toBe(false);

    const search = await runCli(['issue', 'list', '-q', 'authentication', '--status', 'in-progress', '--json'], { cwd });
    expect(search.json.data).toHaveLength(1);

    const deleted = await runCli(['issue', 'delete', issue.id, '--yes', '--json'], { cwd });
    expect(deleted.json.data.id).toBe(issue.id);
    expect((await runCli(['issue', 'list', '--json'], { cwd })).json.data).toEqual([]);
  });

  it('reads bodies from files and stdin', async () => {
    const { root } = await makeRepo();
    await writeFile(path.join(root, 'body.md'), '## From file\n');
    const fromFile = await runCli(['issue', 'create', 'a', '--body-file', 'body.md', '--json'], { cwd: root });
    expect(fromFile.json.data.body).toBe('## From file\n');
    const fromStdin = await runCli(['issue', 'create', 'b', '--stdin', '--json'], { cwd: root, stdin: 'piped body\n' });
    expect(fromStdin.json.data.body).toBe('piped body\n');
    const both = await runCli(['issue', 'create', 'c', '--body', 'x', '--stdin', '--json'], { cwd: root });
    expect(both.code).toBe(2);
    const missing = await runCli(['issue', 'create', 'd', '--body-file', 'nope.md', '--json'], { cwd: root });
    expect(missing.json.error?.code).toBe('INVALID_INPUT');
  });

  it('manages projects, columns and epics', async () => {
    const { root } = await makeRepo();
    const cwd = root;
    expect((await runCli(['project', 'create', 'ADR', '--name', 'Decisions', '--columns', 'proposed,accepted', '--json'], { cwd })).code).toBe(0);
    const projects = await runCli(['project', 'list', '--json'], { cwd });
    expect(projects.json.data.map((p: { key: string }) => p.key)).toEqual(['SAMP', 'ADR']);

    const cols = await runCli(['columns', 'show', '--project', 'ADR', '--json'], { cwd });
    expect(cols.json.data).toMatchObject({ source: 'project' });

    const epic = await runCli(['issue', 'create', 'Epic', '--type', 'epic', '--project', 'SAMP', '--json'], { cwd });
    const story = await runCli(['issue', 'create', 'Story', '--project', 'SAMP', '--parent', epic.json.data.ref, '--json'], { cwd });
    expect(story.json.data.parent).toBe(epic.json.data.id);
    const shown = await runCli(['issue', 'show', epic.json.data.id, '--json'], { cwd });
    expect(shown.json.data.progress).toMatchObject({ total: 1, done: 0 });
    const unparented = await runCli(['issue', 'update', story.json.data.id, '--no-parent', '--json'], { cwd });
    expect(unparented.json.data.parent).toBeUndefined();

    const board = await runCli(['board', '--project', 'ADR'], { cwd });
    expect(board.out).toContain('Proposed (0)');
    const deletedProject = await runCli(['project', 'delete', 'ADR', '--json'], { cwd });
    expect(deletedProject.code).toBe(0);
  });

  it('moves cards within a column', async () => {
    const { root } = await makeRepo();
    const make = async (title: string) => (await runCli(['issue', 'create', title, '--json'], { cwd: root })).json.data.id as string;
    const a = await make('a');
    await make('b');
    const c = await make('c');
    await runCli(['issue', 'move', c, '--top'], { cwd: root });
    await runCli(['issue', 'move', a, '--bottom'], { cwd: root });
    const titles = (await runCli(['issue', 'list', '--json'], { cwd: root })).json.data.map((i: { title: string }) => i.title);
    expect(titles).toEqual(['c', 'b', 'a']);
    expect((await runCli(['issue', 'move', a, '--top', '--bottom'], { cwd: root })).code).toBe(2);
  });
});

describe('exit codes and JSON errors', () => {
  it('uses meaningful exit codes', async () => {
    const { root } = await makeRepo();
    const outside = await tmpDir();
    const created = await runCli(['issue', 'create', 'x', '--json'], { cwd: root });
    const id = created.json.data.id as string;

    expect((await runCli(['issue', 'show', 'ffffffff', '--json'], { cwd: root })).code).toBe(3); // not found
    expect((await runCli(['issue', 'move', id, 'blocked', '--json'], { cwd: root })).code).toBe(4); // validation
    expect((await runCli(['issue', 'update', id, '--title', 'y', '--expected-hash', 'stale', '--json'], { cwd: root })).code).toBe(5); // conflict
    expect((await runCli(['issue', 'list', '--json'], { cwd: outside })).code).toBe(6); // not in a repo
    expect((await runCli(['issue', 'list', '--bogus'], { cwd: root })).code).toBe(2); // usage
    expect((await runCli(['nonsense'], { cwd: root })).code).toBe(2);
    expect((await runCli(['--help'], { cwd: root })).code).toBe(0);
    expect((await runCli(['--version'], { cwd: root })).code).toBe(0);
  });

  it('prints a JSON error envelope and nothing on stderr in --json mode', async () => {
    const { root } = await makeRepo();
    const result = await runCli(['issue', 'show', 'ffffffff', '--json'], { cwd: root });
    expect(result.json).toMatchObject({ ok: false, error: { code: 'ISSUE_NOT_FOUND' } });
    expect(result.err).toBe('');
    const usage = await runCli(['issue', 'list', '--bogus', '--json'], { cwd: root });
    expect(usage.json).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reports validation problems with exit code 4', async () => {
    const { root } = await makeRepo();
    const ok = await runCli(['validate', '--json'], { cwd: root });
    expect(ok).toMatchObject({ code: 0, json: { ok: true } });
    await writeFile(path.join(root, '.gitboard', 'issues', 'aaaaaaaaaaaa.md'), '---\nid: bbbbbbbbbbbb\n---\n');
    const bad = await runCli(['validate', '--json'], { cwd: root });
    expect(bad.code).toBe(4);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.data.problems.length).toBeGreaterThan(0);
    expect((await runCli(['validate'], { cwd: root })).out).toContain('problem(s) found');
  });

  it('surfaces core warnings without failing', async () => {
    const { root } = await makeRepo();
    const created = await runCli(['issue', 'create', 'x', '--json'], { cwd: root });
    const ref = `OTHER-${created.json.data.id.slice(0, 7)}`;
    const json = await runCli(['issue', 'show', ref, '--json'], { cwd: root });
    expect(json.code).toBe(0);
    expect(json.json.warnings?.[0]).toMatch(/names project OTHER/);
    const human = await runCli(['issue', 'show', ref], { cwd: root });
    expect(human.err).toMatch(/^warning: /);
  });
});

describe('non-interactive behaviour', () => {
  it('never prompts when not attached to a terminal', async () => {
    const { root } = await makeRepo();
    const noTitle = await runCli(['issue', 'create', '--json'], { cwd: root, answers: ['should not be used'] });
    expect(noTitle.json.error?.code).toBe('MISSING_INPUT');

    const created = await runCli(['issue', 'create', 'x', '--json'], { cwd: root });
    const noYes = await runCli(['issue', 'delete', created.json.data.id, '--json'], { cwd: root, answers: ['y'] });
    expect(noYes.json.error?.code).toBe('MISSING_INPUT');
    expect((await runCli(['issue', 'list', '--json'], { cwd: root })).json.data).toHaveLength(1);
  });

  it('asks only when interactive, and honours "no"', async () => {
    const { root } = await makeRepo();
    const created = await runCli(['issue', 'create', '--json'], { cwd: root, tty: false });
    expect(created.code).toBe(2);

    const prompted = await runCli(['issue', 'create'], { cwd: root, tty: true, answers: ['Typed title'] });
    expect(prompted.code).toBe(0);
    expect(prompted.out).toContain('Typed title');

    const id = (await runCli(['issue', 'list', '--json'], { cwd: root })).json.data[0].id as string;
    const declined = await runCli(['issue', 'delete', id], { cwd: root, tty: true, answers: ['n'] });
    expect(declined.out).toContain('Cancelled');
    const accepted = await runCli(['issue', 'delete', id], { cwd: root, tty: true, answers: ['y'] });
    expect(accepted.out).toContain('Deleted');
  });

  it('requires the full id for delete', async () => {
    const { root } = await makeRepo();
    const created = await runCli(['issue', 'create', 'x', '--json'], { cwd: root });
    const short = await runCli(['issue', 'delete', created.json.data.ref, '--yes', '--json'], { cwd: root });
    expect(short.json.error?.message).toMatch(/full 12-character id/);
  });
});

describe('repository selection', () => {
  it('detects the repo from a nested directory', async () => {
    const { root } = await makeRepo();
    const nested = path.join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const result = await runCli(['issue', 'create', 'from nested', '--json'], { cwd: nested });
    expect(result.code).toBe(0);
    const text = await readFile(path.join(root, '.gitboard', 'issues', `${result.json.data.id}.md`), 'utf8');
    expect(text).toContain('from nested');
  });

  it('registers, lists, selects, defaults and removes repositories', async () => {
    const a = await makeRepo({ name: 'alpha' });
    const b = await makeRepo({ name: 'beta' });
    const outside = await tmpDir();

    expect((await runCli(['repo', 'add', a.root, '--json'], { cwd: outside })).code).toBe(0);
    expect((await runCli(['repo', 'add', b.root, '--name', 'second', '--json'], { cwd: outside })).json.data.name).toBe('second');
    const list = await runCli(['repo', 'list', '--json'], { cwd: outside });
    expect(list.json.data.map((r: { name: string }) => r.name)).toEqual(['alpha', 'second']);
    expect((await runCli(['repo', 'list'], { cwd: outside })).out).toContain('second');

    await runCli(['issue', 'create', 'in beta', '--repo', 'second', '--json'], { cwd: outside });
    expect((await runCli(['issue', 'list', '--repo', 'second', '--json'], { cwd: outside })).json.data).toHaveLength(1);
    expect((await runCli(['issue', 'list', '--repo', 'alpha', '--json'], { cwd: outside })).json.data).toHaveLength(0);

    await runCli(['repo', 'default', 'second'], { cwd: outside });
    expect((await runCli(['issue', 'list', '--json'], { cwd: outside })).json.data).toHaveLength(1);

    const removed = await runCli(['repo', 'remove', 'second', '--json'], { cwd: outside });
    expect(removed.code).toBe(0);
    expect((await runCli(['issue', 'list', '--json'], { cwd: outside })).code).toBe(6);
    expect((await runCli(['issue', 'list', '--json'], { cwd: b.root })).json.data).toHaveLength(1); // still on disk
  });

  it('reports a clear error for uninitialised repositories', async () => {
    const { root } = await makeRepo({ init: false });
    const result = await runCli(['issue', 'list', '--json'], { cwd: root });
    expect(result.code).toBe(6);
    expect(result.json.error?.code).toBe('NOT_INITIALIZED');
  });
});

describe('init registers the repository', () => {
  it('makes a freshly initialised repo show up in `repo list` (and so in the web UI)', async () => {
    const { root } = await makeRepo({ init: false, name: 'fresh-app' });
    const outside = await tmpDir();
    expect((await runCli(['repo', 'list', '--json'], { cwd: outside })).json.data).toEqual([]);

    const init = await runCli(['init', '--json'], { cwd: root });
    expect(init.json.data.registered).toBe(true);
    const list = await runCli(['repo', 'list', '--json'], { cwd: outside });
    expect(list.json.data).toMatchObject([{ name: 'fresh-app', path: root, initialized: true }]);

    // registering again (or via `repo add`) never creates a duplicate
    await runCli(['repo', 'add', root, '--json'], { cwd: outside });
    expect((await runCli(['repo', 'list', '--json'], { cwd: outside })).json.data).toHaveLength(1);
  });

  it('still initialises a directory that is not a Git repository', async () => {
    const dir = await tmpDir();
    const init = await runCli(['init', '--repo', dir, '--json'], { cwd: dir });
    expect(init.code).toBe(0);
    expect(init.json.data.registered).toBe(false);
  });
});

describe('init is idempotent', () => {
  it('can be re-run: it changes nothing but re-registers the repo', async () => {
    const { root } = await makeRepo({ init: false, name: 'again-app' });
    const outside = await tmpDir();
    const first = await runCli(['init', '--project-key', 'AGN', '--json'], { cwd: root });
    expect(first.json.data).toMatchObject({ created: true, registered: true, projectKey: 'AGN' });
    await runCli(['issue', 'create', 'keep me', '--json'], { cwd: root });
    const before = await snapshotTree(path.join(root, '.gitboard'));

    const second = await runCli(['init', '--json'], { cwd: root });
    expect(second.code).toBe(0);
    expect(second.json.data).toMatchObject({ created: false, registered: true, projectKey: 'AGN' });
    expect(second.json.warnings).toBeUndefined();
    expect(await snapshotTree(path.join(root, '.gitboard'))).toEqual(before);
    expect((await runCli(['repo', 'list', '--json'], { cwd: outside })).json.data).toHaveLength(1);

    // after removing it from the registry, running init again registers it once more
    await runCli(['repo', 'remove', 'again-app'], { cwd: outside });
    expect((await runCli(['repo', 'list', '--json'], { cwd: outside })).json.data).toEqual([]);
    const third = await runCli(['init'], { cwd: root });
    expect(third.code).toBe(0);
    expect(third.out).toContain('already initialised');
    expect((await runCli(['repo', 'list', '--json'], { cwd: outside })).json.data).toHaveLength(1);
  });

  it('warns, rather than silently ignoring, options that cannot apply to an initialised repo', async () => {
    const { root } = await makeRepo({ name: 'warn-app' });
    const before = await snapshotTree(path.join(root, '.gitboard'));
    const result = await runCli(['init', '--columns', 'a,b', '--project-key', 'ZZ', '--json'], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.json.data.created).toBe(false);
    expect(result.json.warnings?.[0]).toMatch(/were ignored/);
    expect(await snapshotTree(path.join(root, '.gitboard'))).toEqual(before);
    expect((await runCli(['init', '--columns', 'a,b'], { cwd: root })).err).toMatch(/^warning: /);
  });
});
