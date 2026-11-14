import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyBetween } from 'fractional-indexing';
import { describe, expect, it } from 'vitest';
import { createIssue, listIssues, moveIssue } from '../../src/core/issues/service';
import { implicitKey } from '../../src/core/issues/rank';
import type { Priority } from '../../src/core/types';
import { makeRepo, runCli, snapshotTree, useTestHome } from '../helpers';

useTestHome();

const issuesDir = (root: string) => path.join(root, '.gitboard', 'issues');
const titles = async (repo: Parameters<typeof listIssues>[0], status = 'todo') => (await listIssues(repo, { status })).map((i) => i.title);

/** A small deterministic generator, so a failing run can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('moving a card writes only that card (ADR-0006)', () => {
  it('matches a simple model through many random moves, and never writes another issue', async () => {
    const { repo, root } = await makeRepo();
    const priorities: Array<Priority | undefined> = [undefined, 'high', 'low', 'urgent', undefined, 'medium', 'high', 'low', 'urgent'];
    for (const [i, priority] of priorities.entries()) await createIssue(repo, { title: `card-${i}`, ...(priority ? { priority } : {}) });
    let model = (await listIssues(repo, { status: 'todo' })).map((i) => i.id);
    const random = mulberry32(20261114);
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)] as T;

    for (let step = 0; step < 120; step++) {
      const mover = pick(model);
      const others = model.filter((id) => id !== mover);
      const kind = pick(['top', 'bottom', 'before', 'after']);
      const anchor = pick(others);
      let expected: string[];
      let input: Parameters<typeof moveIssue>[1];
      if (kind === 'top') {
        input = { ref: mover, position: 'top' };
        expected = [mover, ...others];
      } else if (kind === 'bottom') {
        input = { ref: mover, position: 'bottom' };
        expected = [...others, mover];
      } else {
        const at = others.indexOf(anchor);
        input = kind === 'before' ? { ref: mover, before: anchor } : { ref: mover, after: anchor };
        expected = [...others.slice(0, kind === 'before' ? at : at + 1), mover, ...others.slice(kind === 'before' ? at : at + 1)];
      }

      const before = await snapshotTree(issuesDir(root));
      const result = await moveIssue(repo, input);
      const after = await snapshotTree(issuesDir(root));
      const changed = Object.keys(after).filter((file) => after[file] !== before[file]);

      expect(result.reranked, `step ${step} ${kind}`).toEqual([]);
      expect(changed.every((file) => file === `${mover}.md`), `step ${step} ${kind} wrote ${changed.join(', ')}`).toBe(true);
      model = expected;
      expect((await listIssues(repo, { status: 'todo' })).map((i) => i.id), `step ${step} ${kind}`).toEqual(model);
    }
    // 120 moves of 9 cards never touched a card's updatedAt either
    for (const id of model) expect(await readFile(path.join(issuesDir(root), `${id}.md`), 'utf8')).not.toContain('updatedAt');
  });

  it('keeps working in a column that mixes ranked and unranked cards, across statuses', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a', status: 'done' });
    await createIssue(repo, { title: 'b', status: 'done' });
    const c = await createIssue(repo, { title: 'c', status: 'done' });
    const x = await createIssue(repo, { title: 'x' });
    await moveIssue(repo, { ref: c.id, before: a.id });
    const before = await snapshotTree(issuesDir(root));
    await moveIssue(repo, { ref: x.id, status: 'done', after: a.id });
    const after = await snapshotTree(issuesDir(root));
    expect(Object.keys(after).filter((f) => after[f] !== before[f])).toEqual([`${x.id}.md`]);
    expect(await titles(repo, 'done')).toEqual(['c', 'a', 'x', 'b']);
  });
});

describe('where cards sort', () => {
  it('"top" stays above cards that arrive later, whatever their priority', async () => {
    const { repo } = await makeRepo();
    await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    await moveIssue(repo, { ref: b.id, position: 'top' });
    await createIssue(repo, { title: 'urgent', priority: 'urgent' });
    await createIssue(repo, { title: 'late' });
    expect(await titles(repo)).toEqual(['b', 'urgent', 'a', 'late']);
  });

  it('puts a card you placed between two neighbours between them, and lets later arrivals find their own place', async () => {
    const { repo } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    await moveIssue(repo, { ref: c.id, after: a.id }); // a, c, b
    await createIssue(repo, { title: 'new urgent', priority: 'urgent' });
    await createIssue(repo, { title: 'new medium' });
    expect(await titles(repo)).toEqual(['new urgent', 'a', 'c', 'b', 'new medium']);
  });

  it('keeps ranks written by older versions ahead of everything else, as before', async () => {
    const { repo, root } = await makeRepo();
    await createIssue(repo, { title: 'plain', priority: 'urgent' });
    const old = await createIssue(repo, { title: 'old rank', priority: 'low' });
    const file = path.join(issuesDir(root), `${old.id}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('type: story', 'type: story\nrank: a0'));
    expect(await titles(repo)).toEqual(['old rank', 'plain']);
    const [first] = await listIssues(repo);
    await moveIssue(repo, { ref: first?.id as string, position: 'bottom' });
    expect(await titles(repo)).toEqual(['plain', 'old rank']);
  });
});

describe('the key of an unranked card', () => {
  const sample = (n: number) => {
    const random = mulberry32(n);
    const priorities: Array<Priority | undefined> = [undefined, 'low', 'medium', 'high', 'urgent'];
    return Array.from({ length: 200 }, () => ({
      priority: priorities[Math.floor(random() * priorities.length)],
      createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 5e9)).toISOString(),
      id: Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join(''),
    }));
  };

  it('sorts exactly like priority (highest first), then creation time, then id', () => {
    const rank = { urgent: 3, high: 2, medium: 1, low: 0 };
    const items = sample(7);
    const byKey = [...items].sort((a, b) => {
      const ka = implicitKey(a.priority, a.createdAt, a.id);
      const kb = implicitKey(b.priority, b.createdAt, b.id);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const byRule = [...items].sort(
      (a, b) =>
        rank[b.priority ?? 'medium'] - rank[a.priority ?? 'medium'] ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : 1),
    );
    expect(byKey.map((i) => i.id)).toEqual(byRule.map((i) => i.id));
  });

  it('is always a valid rank that a new rank can be generated around', () => {
    const keys = [...sample(11), { priority: undefined, createdAt: 'not a date', id: 'abcdef000000' }, { priority: 'urgent' as const, createdAt: '2300-01-01T00:00:00Z', id: '000000000000' }].map(
      (i) => implicitKey(i.priority, i.createdAt, i.id),
    );
    const sorted = [...keys].sort();
    for (let i = 0; i < sorted.length - 1; i++) {
      const [lo, hi] = [sorted[i] as string, sorted[i + 1] as string];
      if (lo !== hi) {
        const between = generateKeyBetween(lo, hi);
        expect(between > lo && between < hi).toBe(true);
      }
    }
    expect(() => generateKeyBetween(sorted[0] as string, null)).not.toThrow();
    expect(() => generateKeyBetween(null, sorted[0] as string)).not.toThrow();
    expect(implicitKey('low', '2026-11-14T10:00:00Z', 'abc000000000').endsWith('0')).toBe(false);
  });
});

describe('the one case that still writes other cards', () => {
  it('re-ranks the column when two neighbours have the same rank (left by a merge)', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    for (const id of [a.id, b.id]) {
      const file = path.join(issuesDir(root), `${id}.md`);
      await writeFile(file, (await readFile(file, 'utf8')).replace('type: story', 'type: story\nrank: a5'));
    }
    const [firstOfTheTie, secondOfTheTie] = (await listIssues(repo)).filter((i) => i.rank === 'a5');
    const result = await moveIssue(repo, { ref: c.id, before: secondOfTheTie?.id as string });
    expect(result.reranked.length).toBeGreaterThan(0);
    const order = (await listIssues(repo)).map((i) => i.id);
    expect(order).toEqual([firstOfTheTie?.id, c.id, secondOfTheTie?.id]);
    // and afterwards moves are single-file again
    const before = await snapshotTree(issuesDir(root));
    await moveIssue(repo, { ref: c.id, position: 'bottom' });
    const after = await snapshotTree(issuesDir(root));
    expect(Object.keys(after).filter((f) => after[f] !== before[f])).toEqual([`${c.id}.md`]);
  });

  it('copes with a hand-written rank that is not a valid key', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const file = path.join(issuesDir(root), `${a.id}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('type: story', 'type: story\nrank: not-a-key'));
    await moveIssue(repo, { ref: b.id, before: a.id });
    expect((await listIssues(repo)).map((i) => i.title)).toEqual(['b', 'a']);
  });
});

describe('the command line', () => {
  it('writes only the moved issue for --top, --bottom, --before and --after', async () => {
    const { root } = await makeRepo();
    const make = async (title: string) => (await runCli(['issue', 'create', title, '--json'], { cwd: root })).json.data.id as string;
    const [a, b, c, d] = [await make('a'), await make('b'), await make('c'), await make('d')] as [string, string, string, string];
    const run = async (args: string[], moved: string) => {
      const before = await snapshotTree(issuesDir(root));
      expect((await runCli(['issue', 'move', ...args, '--json'], { cwd: root })).code).toBe(0);
      const after = await snapshotTree(issuesDir(root));
      expect(Object.keys(after).filter((f) => after[f] !== before[f])).toEqual([`${moved}.md`]);
    };
    await run([d, '--top'], d);
    await run([a, '--bottom'], a);
    await run([c, '--before', b], c);
    await run([b, '--after', d], b);
    const order = (await runCli(['issue', 'list', '--json'], { cwd: root })).json.data.map((i: { title: string }) => i.title);
    expect(order).toEqual(['d', 'b', 'c', 'a']);
  });
});
