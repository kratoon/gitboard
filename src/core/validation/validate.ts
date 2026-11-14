/**
 * `gitboard validate`: reports everything that makes a repo's issue storage inconsistent
 * (ADR-0003, ADR-0009, ADR-0010, ADR-0011). Purely read-only.
 */
import { loadIssues } from '../issues/store';
import { effectiveColumns } from '../projects/columns';
import { loadConfig } from '../projects/config';
import { isViewId } from '../projects/views';
import { GitboardError } from '../errors';
import type { Repo } from '../storage/repo-files';
import { VIEW_IDS, type Problem, type ValidateResult } from '../types';

const file = (id: string) => `.gitboard/issues/${id}.md`;

export async function validateRepo(repo: Repo): Promise<ValidateResult> {
  const problems: Problem[] = [];

  let config;
  try {
    config = (await loadConfig(repo)).config;
  } catch (error) {
    if (error instanceof GitboardError && error.code === 'INVALID_CONFIG') {
      problems.push({ code: 'INVALID_CONFIG', file: '.gitboard/config.json', message: error.message });
      const { issues, problems: issueProblems } = await loadIssues(repo);
      return { ok: false, problems: [...problems, ...issueProblems], issueCount: issues.length };
    }
    throw error;
  }

  const seen = new Set<string>();
  for (const project of config.projects) {
    if (seen.has(project.key)) {
      problems.push({
        code: 'DUPLICATE_PROJECT_KEY',
        file: '.gitboard/config.json',
        message: `Project key ${project.key} is defined more than once.`,
      });
    }
    seen.add(project.key);
  }

  const unknownViews = (owner: string, list: readonly string[] | undefined) => {
    const unknown = (list ?? []).filter((id) => !isViewId(id));
    if (unknown.length > 0) {
      problems.push({
        code: 'UNKNOWN_VIEW',
        file: '.gitboard/config.json',
        message: `${owner} lists unknown view(s): ${unknown.join(', ')}. Known views: ${VIEW_IDS.join(', ')}.`,
      });
    }
  };
  unknownViews('The repository', config.views);
  for (const project of config.projects) unknownViews(`Project ${project.key}`, project.views);

  const { issues, problems: issueProblems } = await loadIssues(repo);
  problems.push(...issueProblems);

  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    const { fm } = issue;
    const where = { id: issue.id, file: file(issue.id) };

    if (!seen.has(fm.project)) {
      problems.push({ code: 'UNKNOWN_PROJECT', ...where, message: `Project ${fm.project} is not defined in .gitboard/config.json.` });
    } else {
      const columns = effectiveColumns(config, fm.project).columns.map((c) => c.id);
      if (!columns.includes(fm.status)) {
        problems.push({
          code: 'UNKNOWN_STATUS',
          ...where,
          message: `Status "${fm.status}" is not a column of project ${fm.project} (${columns.join(', ')}).`,
        });
      }
    }

    if (fm.parent !== undefined) {
      const parent = byId.get(fm.parent);
      if (fm.type === 'epic') {
        problems.push({ code: 'EPIC_HAS_PARENT', ...where, message: 'An epic cannot have a parent.' });
      } else if (!parent) {
        problems.push({ code: 'PARENT_MISSING', ...where, message: `Parent ${fm.parent} does not exist.` });
      } else if (parent.fm.type !== 'epic') {
        problems.push({ code: 'PARENT_NOT_EPIC', ...where, message: `Parent ${fm.parent} is not an epic.` });
      } else if (parent.fm.project !== fm.project) {
        problems.push({
          code: 'PARENT_PROJECT_MISMATCH',
          ...where,
          message: `Parent ${fm.parent} is in project ${parent.fm.project}, but this issue is in ${fm.project}.`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, issueCount: issues.length };
}
