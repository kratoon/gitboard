import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId, shortPrefixLengths } from '../../src/core/issues/id';
import { createStoredIssue } from '../../src/core/issues/store';
import { resetRuntime, setRuntime } from '../../src/core/runtime';
import { ID_PATTERN } from '../../src/core/types';
import { makeRepo } from '../helpers';

afterEach(() => resetRuntime());

const fm = {
  title: 'T',
  status: 'todo',
  project: 'SAMP',
  type: 'story' as const,
  labels: [] as string[],
  createdAt: '2026-11-14T10:00:00.000Z',
};

describe('id generation', () => {
  it('produces 12 lowercase hex characters from 6 random bytes', () => {
    const randomBytes = vi.fn((size: number) => Buffer.from('a3f91c2e8b40', 'hex').subarray(0, size));
    setRuntime({ randomBytes });
    expect(generateId()).toBe('a3f91c2e8b40');
    expect(randomBytes).toHaveBeenCalledWith(6);
  });

  it('generates well-formed, distinct ids with the real random source', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });

  it('retries on collision and never overwrites an existing issue', async () => {
    const { repo, root } = await makeRepo();
    const first = await createStoredIssue(repo, fm, 'first', { randomId: () => 'aaaaaaaaaaaa' });
    expect(first.id).toBe('aaaaaaaaaaaa');

    const sequence = ['aaaaaaaaaaaa', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    const second = await createStoredIssue(repo, { ...fm, title: 'second' }, 'second', { randomId: () => sequence.shift() as string });
    expect(second.id).toBe('bbbbbbbbbbbb');
    expect(sequence).toHaveLength(0);

    const files = (await readdir(path.join(root, '.gitboard', 'issues'))).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['aaaaaaaaaaaa.md', 'bbbbbbbbbbbb.md']);
    // The first issue is untouched by the colliding attempts.
    const { loadIssue } = await import('../../src/core/issues/store');
    expect((await loadIssue(repo, 'aaaaaaaaaaaa')).fm.title).toBe('T');
  });

  it('gives up with ID_GENERATION_FAILED when every attempt collides', async () => {
    const { repo } = await makeRepo();
    await createStoredIssue(repo, fm, '', { randomId: () => 'cccccccccccc' });
    await expect(createStoredIssue(repo, fm, '', { randomId: () => 'cccccccccccc' }, 3)).rejects.toMatchObject({
      code: 'ID_GENERATION_FAILED',
    });
  });

  it('leaves no temporary files behind', async () => {
    const { repo, root } = await makeRepo();
    await createStoredIssue(repo, fm, '');
    const names = await readdir(path.join(root, '.gitboard', 'issues'));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('short references', () => {
  it('uses 7 characters unless that is ambiguous', () => {
    const lengths = shortPrefixLengths(['a3f91c2e8b40', 'a3f91c2e0000', 'ffffffffffff']);
    expect(lengths.get('ffffffffffff')).toBe(7);
    expect(lengths.get('a3f91c2e8b40')).toBe(9);
    expect(lengths.get('a3f91c2e0000')).toBe(9);
  });
});

describe('ids that look like numbers to YAML', () => {
  // About 0.4% of random ids are all digits (or digits around one "e"), which YAML would read as numbers.
  it.each(['123456789012', '000000000001', '12345e678901', '1e0000000001'])('round-trips %s as a string through create, update, parent links and validate', async (digits) => {
    const { repo } = await makeRepo();
    const { createIssue, getIssue, updateIssue, moveIssue, listIssues } = await import('../../src/core/issues/service');
    const { validateRepo } = await import('../../src/core/validation/validate');
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' }, { warn: () => undefined }, { randomId: () => digits });
    expect(epic.id).toBe(digits);
    const story = await createIssue(repo, { title: 'Story', parent: digits });
    expect(story.parent).toBe(digits);

    await updateIssue(repo, { ref: story.id, title: 'renamed', priority: 'high' });
    await moveIssue(repo, { ref: story.id, status: 'done', position: 'top' });
    await updateIssue(repo, { ref: digits, addLabels: ['x'] });
    expect((await getIssue(repo, digits)).children?.map((c) => c.id)).toEqual([story.id]);
    expect((await listIssues(repo, { parent: digits })).map((i) => i.id)).toEqual([story.id]);
    expect(await validateRepo(repo)).toMatchObject({ ok: true, problems: [] });
  });
});
