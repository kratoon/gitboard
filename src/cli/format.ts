/** Human-readable rendering of operation results. Plain text only: no colour, safe to pipe. */
import type {
  Backlog,
  Board,
  ColumnsChangeResult,
  ColumnsInfo,
  DeleteResult,
  GitStatus,
  Issue,
  IssueDetail,
  MoveResult,
  ProjectInfo,
  RepoInfo,
  SkillsResult,
  ValidateResult,
  ViewsInfo,
} from '../core/types';

export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

const priorityOf = (issue: Issue) => issue.priority ?? '';

export function renderRepos(repos: RepoInfo[]): string {
  if (repos.length === 0) return 'No repositories registered. Add one with `gitboard repo add <path-or-ssh-url>`.';
  return table(
    ['NAME', 'SOURCE', 'STATE', 'PATH'],
    repos.map((r) => [
      `${r.name}${r.isDefault ? ' *' : ''}`,
      r.source,
      !r.exists ? 'missing' : r.initialized ? 'ready' : 'not initialised',
      r.path,
    ]),
  );
}

export function renderRepo(repo: RepoInfo): string {
  return `${repo.name}  ${repo.path}${repo.initialized ? '' : '  (not initialised: run `gitboard init` inside it)'}`;
}

export function renderProjects(projects: ProjectInfo[]): string {
  if (projects.length === 0) return 'No projects. Create one with `gitboard project create <KEY> --name <name>`.';
  return table(
    ['KEY', 'NAME', 'ISSUES', 'COLUMNS'],
    projects.map((p) => [p.key, p.name, String(p.issueCount), p.columns ? p.columns.map((c) => c.id).join(',') : '(inherited)']),
  );
}

export function renderIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'No issues.';
  return table(
    ['REF', 'TYPE', 'STATUS', 'PRIORITY', 'TITLE', 'LABELS'],
    issues.map((i) => [i.ref, i.type, i.status, priorityOf(i), i.title, i.labels.join(',')]),
  );
}

export function renderIssue(issue: IssueDetail): string {
  const lines = [
    `${issue.ref}  ${issue.title}`,
    `  id:       ${issue.id}`,
    `  project:  ${issue.project}`,
    `  type:     ${issue.type}`,
    `  status:   ${issue.status}`,
    `  priority: ${issue.priority ?? '(none)'}`,
    `  labels:   ${issue.labels.join(', ') || '(none)'}`,
  ];
  if (issue.parentIssue) lines.push(`  parent:   ${issue.parentIssue.ref}  ${issue.parentIssue.title}`);
  lines.push(`  created:  ${issue.createdAt}`);
  if (issue.updatedAt) lines.push(`  updated:  ${issue.updatedAt}`);
  if (issue.progress) {
    lines.push(`  progress: ${issue.progress.done}/${issue.progress.total} done`);
  }
  if (issue.children && issue.children.length > 0) {
    lines.push('  children:');
    for (const child of issue.children) lines.push(`    ${child.ref}  [${child.status}]  ${child.title}`);
  }
  lines.push('', issue.body.trimEnd());
  return lines.join('\n');
}

export function renderCreated(issue: Issue): string {
  return `Created ${issue.ref} (${issue.id}): ${issue.title}`;
}
export function renderUpdated(issue: Issue): string {
  return `Updated ${issue.ref}: ${issue.title}  [${issue.status}]`;
}
export function renderMoved(result: MoveResult): string {
  return `Moved ${result.issue.ref} to ${result.issue.status}`;
}
export function renderDeleted(result: DeleteResult): string {
  const extra = result.unlinked.length > 0 ? ` (unlinked ${result.unlinked.length} child issue(s))` : '';
  return `Deleted ${result.id}${extra}`;
}
export function renderChecklist(issue: Issue): string {
  if (issue.checklist.length === 0) return `${issue.ref} has no checklist items.`;
  return [issue.ref, ...issue.checklist.map((c) => `  ${c.index}. [${c.checked ? 'x' : ' '}] ${c.text}`)].join('\n');
}

export function renderBoards(boards: Board[]): string {
  if (boards.length === 0) return 'No projects.';
  return boards
    .map((board) => {
      const header = `${board.project.key}  ${board.project.name}  (columns: ${board.columnSource})`;
      const cols = board.columns.map((column) => {
        const cards = column.issues.map((i) => `    ${i.ref}  ${i.priority ? `[${i.priority}] ` : ''}${i.title}`);
        return [`  ${column.name} (${column.issues.length})`, ...cards].join('\n');
      });
      const epics = board.epics.map((e) => `    ${e.ref}  ${e.title}  (${e.progress.done}/${e.progress.total} done)`);
      return [header, ...cols, ...(epics.length > 0 ? ['  Epics', ...epics] : [])].join('\n');
    })
    .join('\n\n');
}

export function renderColumns(info: ColumnsInfo): string {
  const scope = info.project ? `project ${info.project}` : 'repository';
  return [`Columns for ${scope} (from ${info.source}):`, ...info.columns.map((c) => `  ${c.id}  (${c.name})`)].join('\n');
}
export function renderColumnsChange(info: ColumnsChangeResult): string {
  const note = info.remapped > 0 ? `\nRemapped ${info.remapped} issue(s).` : '';
  return `${renderColumns(info)}${note}`;
}

export function renderValidate(result: ValidateResult): string {
  if (result.ok) return `OK: ${result.issueCount} issue(s), no problems found.`;
  const lines = result.problems.map((p) => `  ${p.code}  ${p.file ?? p.id ?? ''}\n      ${p.message}`);
  return [`${result.problems.length} problem(s) found in ${result.issueCount} valid issue(s):`, ...lines].join('\n');
}

export function renderGitStatus(status: GitStatus): string {
  if (!status.isGitRepo) return 'Not a Git repository (or git is not installed).';
  const where = status.detached ? `detached at ${status.branch}` : `branch ${status.branch}`;
  return `${where}; ${status.dirty ? `${status.changes} uncommitted change(s) under .gitboard/` : 'no uncommitted .gitboard changes'}`;
}

export function renderSkills(result: SkillsResult): string {
  if (result.locations.length === 0) return 'No installed skills found. Run `gitboard skills install`.';
  return [
    `Gitboard skill v${result.version}`,
    table(
      ['STATUS', 'MODE', 'PATH', 'AGENTS'],
      result.locations.map((l) => [l.status, l.mode, l.path, l.agents.join(',')]),
    ),
  ].join('\n');
}

export function renderViews(info: ViewsInfo): string {
  const scope = info.project ? `project ${info.project}` : 'repository';
  return `Views for ${scope} (from ${info.source}): ${info.views.join(', ')}\nThe first view is the default.`;
}

export function renderBacklog(backlogs: Backlog[]): string {
  if (backlogs.length === 0) return 'No projects.';
  return backlogs
    .map((backlog) => {
      const header = `${backlog.project.key}  ${backlog.project.name}  (open work)`;
      const sections = backlog.sections.map((section) => {
        const rows = section.issues.map(
          (i) => `    ${i.ref}  ${i.priority ? `[${i.priority}] ` : ''}${i.title}${i.labels.length > 0 ? `  #${i.labels.join(' #')}` : ''}`,
        );
        return [`  ${section.name} (${section.issues.length})`, ...rows].join('\n');
      });
      const epics = backlog.epics.map((e) => `    ${e.ref}  ${e.title}  (${e.progress.done}/${e.progress.total} done)`);
      const hidden =
        backlog.hiddenCount > 0 ? [`  ${backlog.hiddenCount} issue(s) in "${backlog.doneStatus}" hidden. Use --all to include them.`] : [];
      return [header, ...sections, ...(epics.length > 0 ? ['  Epics', ...epics] : []), ...hidden].join('\n');
    })
    .join('\n\n');
}
