/**
 * ADR-0002: CLI, HTTP and direct core calls must behave identically. The same scenario runs through
 * each interface in its own repo (with a fixed clock and id sequence), and the resulting files and
 * every result or error code must match exactly.
 */
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeOperation, resetRuntime, setRuntime, toGitboardError } from '../src/core';
import { startServer } from '../src/server';
import { git, runCli, snapshotTree, tmpDir, useTestHome } from './helpers';

useTestHome();
afterEach(() => resetRuntime());

interface Step {
  op: string;
  input: Record<string, unknown>;
  argv: string[];
}
interface Outcome {
  ok: boolean;
  data?: unknown;
  code?: string;
}

const body = '## Acceptance Criteria\n\n- [ ] a\n- [ ] b\n';
const id = (n: number) => n.toString(16).padStart(12, '0');
const EPIC = id(1);
const S1 = id(2);
const S2 = id(3);

const scenario: Step[] = [
  { op: 'repo.init', input: { projectKey: 'PAR' }, argv: ['init', '--project-key', 'PAR'] },
  { op: 'project.create', input: { key: 'ADR', name: 'Decisions', columns: ['proposed', 'accepted'] }, argv: ['project', 'create', 'ADR', '--name', 'Decisions', '--columns', 'proposed,accepted'] },
  { op: 'issue.create', input: { title: 'Epic', type: 'epic', project: 'PAR' }, argv: ['issue', 'create', 'Epic', '--type', 'epic', '--project', 'PAR'] },
  { op: 'issue.create', input: { title: 'Story one', project: 'PAR', parent: EPIC, priority: 'high', labels: ['backend'], body }, argv: ['issue', 'create', 'Story one', '--project', 'PAR', '--parent', EPIC, '--priority', 'high', '--label', 'backend', '--body', body] },
  { op: 'issue.create', input: { title: 'Story two', project: 'PAR', parent: EPIC }, argv: ['issue', 'create', 'Story two', '--project', 'PAR', '--parent', EPIC] },
  { op: 'issue.update', input: { ref: S1, priority: 'low', addLabels: ['ui'] }, argv: ['issue', 'update', S1, '--priority', 'low', '--add-label', 'ui'] },
  { op: 'issue.move', input: { ref: S2, status: 'in-progress', position: 'top' }, argv: ['issue', 'move', S2, 'in-progress', '--top'] },
  { op: 'issue.move', input: { ref: S1, status: 'in-progress', after: S2 }, argv: ['issue', 'move', S1, 'in-progress', '--after', S2] },
  { op: 'issue.check', input: { ref: S1, index: 1 }, argv: ['issue', 'check', S1, '1'] },
  { op: 'issue.get', input: { ref: EPIC }, argv: ['issue', 'show', EPIC] },
  { op: 'issue.list', input: { project: 'PAR', status: 'in-progress' }, argv: ['issue', 'list', '--project', 'PAR', '--status', 'in-progress'] },
  { op: 'board.get', input: {}, argv: ['board'] },
  // failures must fail identically
  { op: 'issue.move', input: { ref: S1, status: 'blocked' }, argv: ['issue', 'move', S1, 'blocked'] },
  { op: 'issue.get', input: { ref: 'ffffffff' }, argv: ['issue', 'show', 'ffffffff'] },
  { op: 'issue.create', input: { title: 'x', project: 'PAR', parent: S1 }, argv: ['issue', 'create', 'x', '--project', 'PAR', '--parent', S1] },
  { op: 'project.create', input: { key: 'ADR', name: 'again' }, argv: ['project', 'create', 'ADR', '--name', 'again'] },
  { op: 'issue.delete', input: { id: EPIC }, argv: ['issue', 'delete', EPIC, '--yes'] },
  { op: 'issue.update', input: { ref: S1, project: 'ADR' }, argv: ['issue', 'update', S1, '--project', 'ADR'] },
  { op: 'columns.set', input: { columns: ['todo', 'shipped'] }, argv: ['columns', 'set', '--columns', 'todo,shipped'] },
  { op: 'columns.set', input: { columns: ['todo', 'in-progress', 'shipped'], remap: { done: 'shipped' } }, argv: ['columns', 'set', '--columns', 'todo,in-progress,shipped', '--remap', 'done=shipped'] },
  { op: 'issue.delete', input: { id: S2 }, argv: ['issue', 'delete', S2, '--yes'] },
  { op: 'views.set', input: { views: ['backlog', 'kanban'], project: 'ADR' }, argv: ['views', 'set', '--views', 'backlog,kanban', '--project', 'ADR'] },
  { op: 'views.set', input: { views: ['backlog'] }, argv: ['views', 'set', '--views', 'backlog'] },
  { op: 'views.show', input: { project: 'ADR' }, argv: ['views', 'show', '--project', 'ADR'] },
  { op: 'backlog.get', input: { project: 'PAR' }, argv: ['backlog', '--project', 'PAR'] },
  { op: 'backlog.get', input: { includeDone: true }, argv: ['backlog', '--all'] },
  { op: 'views.set', input: { views: ['timeline'] }, argv: ['views', 'set', '--views', 'timeline'] },
  { op: 'views.reset', input: { project: 'ADR' }, argv: ['views', 'reset', '--project', 'ADR'] },
  { op: 'views.reset', input: {}, argv: ['views', 'reset'] },
  { op: 'validate', input: {}, argv: ['validate'] },
];

function deterministicRuntime(): void {
  let counter = 0;
  let tick = 0;
  setRuntime({
    now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)),
    randomBytes: () => Buffer.from((++counter).toString(16).padStart(12, '0'), 'hex'),
  });
}

async function freshRepo(): Promise<string> {
  const root = path.join(await tmpDir('gitboard-parity-'), 'parity-app');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  return root;
}

const normalise = (value: unknown, root: string): unknown => JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'));

async function viaCore(root: string): Promise<Outcome[]> {
  const results: Outcome[] = [];
  for (const step of scenario) {
    try {
      const { data } = await executeOperation(step.op, step.input, { cwd: root });
      results.push({ ok: true, data: normalise(data, root) });
    } catch (error) {
      results.push({ ok: false, code: toGitboardError(error).code });
    }
  }
  return results;
}

async function viaCli(root: string): Promise<Outcome[]> {
  const results: Outcome[] = [];
  for (const step of scenario) {
    const run = await runCli([...step.argv, '--json'], { cwd: root });
    if (step.op === 'validate') {
      results.push({ ok: run.json.ok, data: normalise(run.json.data, root) });
    } else if (run.json.ok) {
      results.push({ ok: true, data: normalise(run.json.data, root) });
    } else {
      results.push({ ok: false, code: run.json.error?.code });
    }
  }
  return results;
}

function post(port: number, url: string, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function viaHttp(root: string): Promise<Outcome[]> {
  const server = await startServer({ port: 0, webRoot: null });
  try {
    const added = await post(server.port, '/api/ops/repo.add', { source: root });
    const repoId = added.body.data.id as string;
    const results: Outcome[] = [];
    for (const step of scenario) {
      const reply = await post(server.port, `/api/repos/${repoId}/ops/${step.op}`, step.input);
      results.push(reply.body.ok ? { ok: true, data: normalise(reply.body.data, root) } : { ok: false, code: reply.body.error.code });
    }
    return results;
  } finally {
    await server.close();
  }
}

describe('CLI, HTTP and core behave identically', () => {
  it('produces identical results, error codes and files for the same scenario', async () => {
    deterministicRuntime();
    const coreRoot = await freshRepo();
    const core = await viaCore(coreRoot);
    const coreFiles = await snapshotTree(path.join(coreRoot, '.gitboard'));

    deterministicRuntime();
    const cliRoot = await freshRepo();
    const cli = await viaCli(cliRoot);
    const cliFiles = await snapshotTree(path.join(cliRoot, '.gitboard'));

    deterministicRuntime();
    const httpRoot = await freshRepo();
    const httpResults = await viaHttp(httpRoot);
    const httpFiles = await snapshotTree(path.join(httpRoot, '.gitboard'));

    // sanity: the scenario really exercised successes and failures
    expect(core.filter((r) => r.ok).length).toBeGreaterThan(12);
    expect(core.filter((r) => !r.ok).map((r) => r.code)).toEqual([
      'INVALID_STATUS',
      'ISSUE_NOT_FOUND',
      'BAD_PARENT',
      'DUPLICATE_PROJECT',
      'HAS_CHILDREN',
      'BAD_PARENT',
      'ORPHANED_STATUS',
      'INVALID_INPUT',
    ]);
    expect(Object.keys(coreFiles).length).toBeGreaterThan(4);

    expect(cli).toEqual(core);
    expect(httpResults).toEqual(core);
    expect(cliFiles).toEqual(coreFiles);
    expect(httpFiles).toEqual(coreFiles);
  });
});
