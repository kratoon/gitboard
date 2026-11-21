import { describe, expect, it } from 'vitest';
import { createIssue, getBoard, getIssue } from '../../src/core/issues/service';
import { effectiveEpicColumns } from '../../src/core/projects/epic-columns';
import { validateRepo } from '../../src/core/validation/validate';
import { makeRepo, readConfigObject, useTestHome, writeConfigObject } from '../helpers';

useTestHome();

describe('epic child table columns', () => {
  it('defaults to key, title, status, then repository, then project', async () => {
    const { repo, root } = await makeRepo();
    expect((await getBoard(repo))[0]?.epicColumns).toEqual(['key', 'title', 'status']);

    const config = await readConfigObject(root);
    config.epicColumns = ['key', 'title', 'priority', 'labels'];
    await writeConfigObject(root, config);
    expect((await getBoard(repo))[0]?.epicColumns).toEqual(['key', 'title', 'priority', 'labels']);

    config.projects[0].epicColumns = ['title', 'status'];
    await writeConfigObject(root, config);
    expect((await getBoard(repo))[0]?.epicColumns).toEqual(['title', 'status']);
  });

  it('ignores unknown ids and duplicates, and validate reports them', async () => {
    const { repo, root } = await makeRepo();
    const config = await readConfigObject(root);
    config.epicColumns = ['key', 'owner', 'key', 'status'];
    config.projects[0].epicColumns = ['owner'];
    await writeConfigObject(root, config);
    expect(effectiveEpicColumns(config, 'SAMP')).toEqual(['key', 'status']);
    const result = await validateRepo(repo);
    expect(result.problems.map((p) => p.code)).toEqual(['UNKNOWN_EPIC_COLUMN', 'UNKNOWN_EPIC_COLUMN']);
    expect(result.problems[0]?.message).toMatch(/owner/);
  });

  it("gives an epic's children their priority and labels", async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'epic', type: 'epic' });
    await createIssue(repo, { title: 'child', parent: epic.id, priority: 'high', labels: ['ui'] });
    await createIssue(repo, { title: 'plain', parent: epic.id });
    const children = (await getIssue(repo, epic.id)).children ?? [];
    expect(children.find((c) => c.title === 'child')).toMatchObject({ priority: 'high', labels: ['ui'] });
    expect(children.find((c) => c.title === 'plain')).toMatchObject({ labels: [] });
    expect(children.find((c) => c.title === 'plain')).not.toHaveProperty('priority');
  });
});
