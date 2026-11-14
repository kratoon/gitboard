/** Serves the built web UI. Pure static files: no business logic lives in the server's web layer. */
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** The built UI lives in `dist/web` next to the bundled server, or in the repo's `dist/web` in dev. */
export async function findWebRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'web'), path.join(here, '..', 'web'), path.join(here, '..', '..', 'dist', 'web')]) {
    if (await isFile(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export async function serveStatic(root: string | null, urlPath: string, res: ServerResponse, headOnly: boolean): Promise<void> {
  if (root === null) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The web UI has not been built. Run `npm run build:web`.\n');
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  // Containment check: the resolved file must stay inside the web root.
  const inside = path.relative(root, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(403).end();
    return;
  }
  if (!(await isFile(file))) {
    if (path.extname(file) !== '') {
      res.writeHead(404).end();
      return;
    }
    file = path.join(root, 'index.html'); // single-page app fallback
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(headOnly ? undefined : body);
}
