import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIssue } from '../../src/core/issues/service';
import { validateRepo } from '../../src/core/validation/validate';
import { makeRepo, useTestHome } from '../helpers';

useTestHome();

const issues = (root: string) => path.join(root, '.gitboard', 'issues');
const codes = async (repo: Parameters<typeof validateRepo>[0]) => (await validateRepo(repo)).problems.map((p) => p.code).sort();

describe('validate', () => {
  it('passes for a healthy repo', async () => {
    const { repo } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    await createIssue(repo, { title: 'story', parent: epic.id });
    expect(await validateRepo(repo)).toMatchObject({ ok: true, problems: [], issueCount: 2 });
  });

  it('detects a filename that does not match the frontmatter id, and duplicate ids', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    await copyFile(path.join(issues(root), `${issue.id}.md`), path.join(issues(root), 'bbbbbbbbbbbb.md'));
    const result = await validateRepo(repo);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code).sort()).toEqual(['DUPLICATE_ID', 'ID_MISMATCH']);
    expect(result.problems.find((p) => p.code === 'DUPLICATE_ID')?.message).toContain('bbbbbbbbbbbb.md');
  });

  it('flags an issue without a project, with a fix hint', async () => {
    const { repo, root } = await makeRepo();
    const issue = await createIssue(repo, { title: 'x' });
    const file = path.join(issues(root), `${issue.id}.md`);
    await writeFile(file, (await readFile(file, 'utf8')).replace('project: SAMP\n', ''));
    const result = await validateRepo(repo);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: 'MISSING_PROJECT', id: issue.id });
    expect(result.problems[0]?.message).toMatch(/project: <KEY>/);
  });

  it('flags unknown projects, unknown statuses and bad frontmatter', async () => {
    const { repo, root } = await makeRepo();
    const a = await createIssue(repo, { title: 'a' });
    const b = await createIssue(repo, { title: 'b' });
    const c = await createIssue(repo, { title: 'c' });
    const edit = async (id: string, from: string, to: string) => {
      const file = path.join(issues(root), `${id}.md`);
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
    };
    await edit(a.id, 'project: SAMP', 'project: GONE');
    await edit(b.id, 'status: todo', 'status: limbo');
    await edit(c.id, 'title: c', 'title: [unclosed');
    expect(await codes(repo)).toEqual(['INVALID_FRONTMATTER', 'UNKNOWN_PROJECT', 'UNKNOWN_STATUS']);
  });

  it('flags broken parent links', async () => {
    const { repo, root } = await makeRepo();
    const epic = await createIssue(repo, { title: 'Epic', type: 'epic' });
    const story = await createIssue(repo, { title: 'story', parent: epic.id });
    const other = await createIssue(repo, { title: 'other' });
    const file = (id: string) => path.join(issues(root), `${id}.md`);

    // Ids that look like numbers are quoted in YAML, so match the whole line instead of `parent: <id>`.
    const setParent = async (value: string) =>
      writeFile(file(story.id), (await readFile(file(story.id), 'utf8')).replace(/^parent: .*$/m, `parent: ${value}`));
    await setParent(other.id);
    expect(await codes(repo)).toEqual(['PARENT_NOT_EPIC']);

    await setParent('ffffffffffff');
    expect(await codes(repo)).toEqual(['PARENT_MISSING']);

    await writeFile(file(epic.id), (await readFile(file(epic.id), 'utf8')).replace('type: epic', `type: epic\nparent: ${other.id}`));
    expect(await codes(repo)).toEqual(['EPIC_HAS_PARENT', 'PARENT_MISSING']);
  });

  it('flags duplicate project keys and invalid config', async () => {
    const { repo, root } = await makeRepo();
    const configFile = path.join(root, '.gitboard', 'config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.projects.push({ key: 'SAMP', name: 'Again' });
    await writeFile(configFile, JSON.stringify(config));
    expect(await codes(repo)).toEqual(['DUPLICATE_PROJECT_KEY']);

    await writeFile(configFile, '{ not json');
    expect(await codes(repo)).toEqual(['INVALID_CONFIG']);
  });

  it('reports stray markdown files in the issues directory', async () => {
    const { repo, root } = await makeRepo();
    await writeFile(path.join(issues(root), 'notes.md'), '# notes\n');
    expect(await codes(repo)).toEqual(['UNEXPECTED_FILE']);
  });
});
