/**
 * The local HTTP adapter (ADR-9b13ab6, ADR-b9d4018). It exposes the shared operation registry over HTTP and
 * pushes file-change events to the UI. It contains no business logic: every request is passed to
 * `executeOperation`, exactly like the CLI.
 *
 *   POST /api/ops/:name                     global operations (repositories)
 *   POST /api/repos/:repo/ops/:name         repository operations; `:repo` must be a registered id or name
 *   GET  /api/repos/:repo/events            server-sent events when files under .gitboard/ change
 *   GET  /api/health
 *   GET  /*                                 the built web UI
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GitboardError,
  executeOperation,
  getOperation,
  httpStatusFor,
  resolveRepo,
  toGitboardError,
  watchRepoFiles,
  type RepoWatcher,
} from '../core';
import { SECURITY_HEADERS, checkRequest } from './security';
import { findWebRoot, serveStatic } from './static';

export interface ServerOptions {
  port?: number;
  /** Always loopback. Exposed only so tests can pick an ephemeral port. */
  host?: '127.0.0.1';
  webRoot?: string | null;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  const err = toGitboardError(error);
  send(res, httpStatusFor(err.code), {
    ok: false,
    error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
  });
}

const MAX_DRAIN = 32 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      // Keep reading (without storing) so the client receives our response instead of a reset.
      tooLarge = true;
      chunks.length = 0;
      if (size > MAX_DRAIN) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) throw new GitboardError('INVALID_INPUT', 'Request body is too large.');
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GitboardError('INVALID_INPUT', 'Request body is not valid JSON.');
  }
}

interface WatchEntry {
  watcher: RepoWatcher;
  listeners: Set<(paths: string[]) => void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const webRoot = options.webRoot === undefined ? await findWebRoot() : options.webRoot;
  const watchers = new Map<string, WatchEntry>();
  const streams = new Set<ServerResponse>();
  let boundPort = options.port ?? 4317;

  async function subscribe(root: string, listener: (paths: string[]) => void): Promise<() => void> {
    let entry = watchers.get(root);
    if (!entry) {
      const listeners = new Set<(paths: string[]) => void>();
      const watcher = watchRepoFiles(root, (event) => listeners.forEach((l) => l(event.paths)));
      entry = { watcher, listeners };
      watchers.set(root, entry);
      await watcher.ready;
    }
    entry.listeners.add(listener);
    const current = entry;
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size === 0 && watchers.get(root) === current) {
        watchers.delete(root);
        void current.watcher.close();
      }
    };
  }

  async function handleEvents(req: IncomingMessage, res: ServerResponse, repoRef: string): Promise<void> {
    const { repo } = await resolveRepo({ repo: repoRef, registeredOnly: true });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    streams.add(res);
    const unsubscribe = await subscribe(repo.root, (paths) => {
      res.write(`event: change\ndata: ${JSON.stringify({ paths })}\n\n`);
    });
    res.write('event: ready\ndata: {}\n\n');
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      streams.delete(res);
    });
  }

  async function handleOperation(req: IncomingMessage, res: ServerResponse, name: string, repoRef: string | undefined): Promise<void> {
    const op = getOperation(name);
    const allowedHere = op.surfaces.includes('http') && (repoRef === undefined ? op.scope === 'global' : op.scope !== 'global');
    if (!allowedHere) throw new GitboardError('OPERATION_NOT_FOUND', `Unknown operation: ${name}`);
    const input = await readJson(req);
    const result = await executeOperation(name, input, { repo: repoRef, registeredOnly: true });
    send(res, 200, { ok: true, data: result.data, ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) });
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      try {
        const rejection = checkRequest(req, boundPort);
        if (rejection) {
          send(res, rejection.status, { ok: false, error: { code: 'FORBIDDEN', message: rejection.message } });
          return;
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const method = req.method ?? 'GET';

        if (parts[0] === 'api') {
          if (method === 'GET' && parts[1] === 'health' && parts.length === 2) return void send(res, 200, { ok: true });
          if (method === 'POST' && parts[1] === 'ops' && parts.length === 3) return await handleOperation(req, res, parts[2] as string, undefined);
          if (parts[1] === 'repos' && parts.length >= 4) {
            const repoRef = parts[2] as string;
            if (method === 'POST' && parts[3] === 'ops' && parts.length === 5) return await handleOperation(req, res, parts[4] as string, repoRef);
            if (method === 'GET' && parts[3] === 'events' && parts.length === 4) return await handleEvents(req, res, repoRef);
          }
          send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
          return;
        }
        if (method === 'GET' || method === 'HEAD') return await serveStatic(webRoot, url.pathname, res, method === 'HEAD');
        send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
      } catch (error) {
        if (!res.headersSent) sendError(res, error);
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new GitboardError('INVALID_INPUT', `Port ${boundPort} is already in use. Choose another with --port.`)
          : error,
      );
    });
    server.listen(options.port ?? 4317, host, () => resolve());
  });
  boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: async () => {
      for (const stream of streams) stream.end();
      streams.clear();
      await Promise.all([...watchers.values()].map((entry) => entry.watcher.close()));
      watchers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
