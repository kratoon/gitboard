import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIssue } from '../../src/core/issues/service';
import { watchRepoFiles } from '../../src/core/storage/watch';
import { makeRepo, useTestHome } from '../helpers';

useTestHome();

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a file change event');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('watching for external changes', () => {
  it('reports edits, creations and deletions made outside the app', async () => {
    const { repo, root } = await makeRepo();
    const existing = await createIssue(repo, { title: 'existing' });
    const seen: string[] = [];
    const watcher = watchRepoFiles(root, (event) => seen.push(...event.paths), 30);
    try {
      await watcher.ready;
      expect(seen).toEqual([]); // the initial scan is silent

      const file = path.join(root, '.gitboard', 'issues', `${existing.id}.md`);
      await writeFile(file, (await readFile(file, 'utf8')).replace('title: existing', 'title: edited by an agent'));
      await waitFor(() => seen.some((p) => p.endsWith(`${existing.id}.md`)));

      seen.length = 0;
      const created = await createIssue(repo, { title: 'created elsewhere' });
      await waitFor(() => seen.some((p) => p.endsWith(`${created.id}.md`)));

      seen.length = 0;
      await rm(file);
      await waitFor(() => seen.some((p) => p.endsWith(`${existing.id}.md`)));
    } finally {
      await watcher.close();
    }
  });

  it('ignores rewrites that leave the content identical', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'same' });
    const seen: string[] = [];
    const watcher = watchRepoFiles(root, (event) => seen.push(...event.paths), 30);
    try {
      await watcher.ready;
      const file = path.join(root, '.gitboard', 'issues', `${issue.id}.md`);
      await writeFile(file, await readFile(file, 'utf8'));
      await new Promise((r) => setTimeout(r, 600));
      expect(seen).toEqual([]);
    } finally {
      await watcher.close();
    }
  });
});
