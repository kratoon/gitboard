/**
 * Filesystem watching for the server (ADR-7a20520). Detects edits made outside the app (agents, editors,
 * `git checkout`) so the UI can refresh. Events whose content hash matches what was last seen are
 * dropped, which filters duplicate events from the OS and from our own atomic writes.
 */
import chokidar from 'chokidar';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from './fs-safe';

export interface WatchEvent {
  /** Paths changed since the previous notification, relative to the repo root. */
  paths: string[];
}

export interface RepoWatcher {
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function watchRepoFiles(root: string, onChange: (event: WatchEvent) => void, debounceMs = 75): RepoWatcher {
  const dir = path.join(root, '.gitboard');
  const known = new Map<string, string>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let isReady = false;

  const flush = () => {
    timer = undefined;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    onChange({ paths });
  };
  const schedule = (relative: string) => {
    pending.add(relative);
    if (timer === undefined) timer = setTimeout(flush, debounceMs);
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: false,
    depth: 2,
    ignored: (file) => file.endsWith('.tmp'),
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });

  const handleFile = async (file: string) => {
    const relative = path.relative(root, file);
    let hash: string;
    try {
      hash = contentHash(await readFile(file));
    } catch {
      return; // vanished again; an unlink event will follow
    }
    const previous = known.get(file);
    known.set(file, hash);
    if (isReady && previous !== hash) schedule(relative);
  };

  watcher.on('add', (file) => void handleFile(file));
  watcher.on('change', (file) => void handleFile(file));
  watcher.on('unlink', (file) => {
    if (known.delete(file) && isReady) schedule(path.relative(root, file));
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      // Hashing is async, so give in-flight initial reads a moment to land before reporting events.
      setTimeout(() => {
        isReady = true;
        resolve();
      }, 50);
    });
  });

  return {
    ready,
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
