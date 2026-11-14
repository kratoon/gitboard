import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server';
import { configFile, makeRepo, tmpDir, useTestHome } from '../helpers';

useTestHome();

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  text: string;
}

function request(
  server: RunningServer,
  method: string,
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: url, method, headers: { ...(payload !== undefined && method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function boot(): Promise<{ server: RunningServer; repoId: string; root: string }> {
  const server = await startServer({ port: 0, webRoot: null });
  running = server;
  const { root } = await makeRepo();
  const added = await request(server, 'POST', '/api/ops/repo.add', { body: { source: root } });
  expect(added.status).toBe(200);
  return { server, repoId: added.body.data.id, root };
}

describe('operations over HTTP', () => {
  it('binds to the loopback interface only', async () => {
    running = await startServer({ port: 0, webRoot: null });
    const probe = http.request({ host: '127.0.0.1', port: running.port, path: '/api/health' });
    const reply = await new Promise<number>((resolve) => probe.on('response', (r) => resolve(r.statusCode ?? 0)).end());
    expect(reply).toBe(200);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
  });

  it('manages repositories and issues through the shared core', async () => {
    const { server, repoId, root } = await boot();
    const op = (name: string, body: unknown) => request(server, 'POST', `/api/repos/${repoId}/ops/${name}`, { body });

    const repos = await request(server, 'POST', '/api/ops/repo.list', { body: {} });
    expect(repos.body.data[0]).toMatchObject({ id: repoId, initialized: true });

    const created = await op('issue.create', { title: 'From the UI', priority: 'high' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, data: { title: 'From the UI', status: 'todo' } });
    const id = created.body.data.id;
    expect(await readFile(path.join(root, '.gitboard', 'issues', `${id}.md`), 'utf8')).toContain('title: From the UI');

    const board = await op('board.get', {});
    expect(board.body.data[0].columns[0].issues.map((i: { id: string }) => i.id)).toEqual([id]);

    const moved = await op('issue.move', { ref: id, status: 'done' });
    expect(moved.body.data.issue.status).toBe('done');
    const detail = await op('issue.get', { ref: id });
    expect(detail.body.data.status).toBe('done');
    const status = await op('git.status', {});
    expect(status.body.data).toMatchObject({ isGitRepo: true, dirty: true });
    expect((await op('validate', {})).body.data.ok).toBe(true);

    const deleted = await op('issue.delete', { id });
    expect(deleted.body.ok).toBe(true);
  });

  it('maps core error codes to HTTP statuses', async () => {
    const { server, repoId } = await boot();
    const op = (name: string, body: unknown) => request(server, 'POST', `/api/repos/${repoId}/ops/${name}`, { body });
    const created = await op('issue.create', { title: 'x' });
    const id = created.body.data.id;

    expect(await op('issue.get', { ref: 'ffffffff' })).toMatchObject({ status: 404, body: { ok: false, error: { code: 'ISSUE_NOT_FOUND' } } });
    expect(await op('issue.move', { ref: id, status: 'blocked' })).toMatchObject({ status: 422, body: { error: { code: 'INVALID_STATUS' } } });
    expect(await op('issue.create', { title: '' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_INPUT' } } });
    expect(await op('issue.update', { ref: id, title: 'y', expectedHash: 'stale' })).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT' } } });
    expect(await op('nope.nothing', {})).toMatchObject({ status: 404, body: { error: { code: 'OPERATION_NOT_FOUND' } } });
  });

  it('only exposes operations on the right route and surface', async () => {
    const { server, repoId } = await boot();
    // repository operation on the global route, and the reverse
    expect((await request(server, 'POST', '/api/ops/issue.list', { body: {} })).status).toBe(404);
    expect((await request(server, 'POST', `/api/repos/${repoId}/ops/repo.list`, { body: {} })).status).toBe(404);
    // skills are CLI-only
    expect((await request(server, 'POST', '/api/ops/skills.install', { body: {} })).status).toBe(404);
  });
});

describe('security (ADR-b9d4018)', () => {
  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const { server } = await boot();
    const reply = await request(server, 'GET', '/api/health', { headers: { Host: 'evil.example.com' } });
    expect(reply.status).toBe(403);
    expect((await request(server, 'GET', '/api/health', { headers: { Host: `localhost:${server.port}` } })).status).toBe(200);
    expect((await request(server, 'GET', '/api/health', { headers: { Host: `localhost:9` } })).status).toBe(403);
  });

  it('rejects cross-origin and cross-site writes', async () => {
    const { server, repoId, root } = await boot();
    const url = `/api/repos/${repoId}/ops/issue.create`;
    const evil = await request(server, 'POST', url, { body: { title: 'pwned' }, headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const sameSiteLie = await request(server, 'POST', url, { body: { title: 'pwned' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(sameSiteLie.status).toBe(403);
    const localOther = await request(server, 'POST', url, { body: { title: 'pwned' }, headers: { Origin: 'http://localhost:9999' } });
    expect(localOther.status).toBe(403);

    const list = await request(server, 'POST', `/api/repos/${repoId}/ops/issue.list`, { body: {} });
    expect(list.body.data).toEqual([]);
    const ok = await request(server, 'POST', url, { body: { title: 'fine' }, headers: { Origin: `http://127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'same-origin' } });
    expect(ok.status).toBe(200);
    expect(await readFile(await configFile(root), 'utf8')).toContain('projects');
  });

  it('requires a JSON content type, so cross-origin form posts cannot write', async () => {
    const { server, repoId } = await boot();
    const reply = await request(server, 'POST', `/api/repos/${repoId}/ops/issue.create`, {
      raw: 'title=x',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(reply.status).toBe(415);
    const text = await request(server, 'POST', `/api/repos/${repoId}/ops/issue.create`, { raw: '{"title":"x"}', headers: { 'Content-Type': 'text/plain' } });
    expect(text.status).toBe(415);
  });

  it('only operates on registered repositories, never on paths', async () => {
    const { server } = await boot();
    const outside = await makeRepo({ name: 'unregistered' });
    for (const selector of [encodeURIComponent(outside.root), '..', encodeURIComponent('../..'), 'unregistered']) {
      const reply = await request(server, 'POST', `/api/repos/${selector}/ops/issue.create`, { body: { title: 'x' } });
      expect(reply.status).toBe(404);
      // A bare `..` is normalised away by URL parsing and lands on the global route instead.
      expect(['REPO_NOT_FOUND', 'OPERATION_NOT_FOUND']).toContain(reply.body.error.code);
    }
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(outside.root, '.gitboard', 'issues'));
    expect(files.filter((f) => f.endsWith('.md'))).toEqual([]);
    const listed = await request(server, 'POST', '/api/repos/ghost/ops/issue.list', { body: {} });
    expect(listed.status).toBe(404);
  });

  it('limits request bodies and rejects malformed JSON', async () => {
    const { server, repoId } = await boot();
    const url = `/api/repos/${repoId}/ops/issue.create`;
    const huge = await request(server, 'POST', url, { raw: JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(huge.status).toBe(400);
    const bad = await request(server, 'POST', url, { raw: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('sends security headers', async () => {
    const { server } = await boot();
    const reply = await request(server, 'GET', '/api/health');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['content-security-policy']).toContain("default-src 'self'");
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not let static file requests escape the web root', async () => {
    const parent = await tmpDir();
    const web = path.join(parent, 'web');
    await mkdir(web);
    await writeFile(path.join(web, 'index.html'), '<h1>ui</h1>');
    await writeFile(path.join(parent, 'secret.txt'), 'top secret');
    running = await startServer({ port: 0, webRoot: web });
    expect((await request(running, 'GET', '/')).text).toContain('<h1>ui</h1>');
    expect((await request(running, 'GET', '/some/client/route')).text).toContain('<h1>ui</h1>');
    for (const attempt of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt']) {
      const reply = await request(running, 'GET', attempt);
      expect(reply.text).not.toContain('top secret');
    }
  });
});

describe('live updates', () => {
  it('pushes an event when files change outside the app', async () => {
    const { server, repoId, root } = await boot();
    const created = await request(server, 'POST', `/api/repos/${repoId}/ops/issue.create`, { body: { title: 'before' } });
    const id = created.body.data.id;

    const received: string[] = [];
    const stream = http.get({ host: '127.0.0.1', port: server.port, path: `/api/repos/${repoId}/events` }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => received.push(chunk));
    });
    const waitFor = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > 8000) throw new Error(`timed out; got: ${received.join('|')}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await waitFor(() => received.join('').includes('event: ready'));
      const file = path.join(root, '.gitboard', 'issues', `${id}.md`);
      await writeFile(file, (await readFile(file, 'utf8')).replace('title: before', 'title: edited by an agent'));
      await waitFor(() => received.join('').includes('event: change'));
      expect(received.join('')).toContain(`${id}.md`);
    } finally {
      stream.destroy();
    }
  });

  it('refuses event streams for unregistered repositories and foreign hosts', async () => {
    const { server } = await boot();
    expect((await request(server, 'GET', '/api/repos/ghost/events')).status).toBe(404);
    expect((await request(server, 'GET', '/api/repos/ghost/events', { headers: { Host: 'evil.test' } })).status).toBe(403);
  });
});
