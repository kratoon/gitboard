/**
 * Loading, creating and patching issue files. This layer knows about files and frontmatter validity
 * but not about projects, columns or parents: those rules live in `service.ts` and `validation/`.
 */
import { GitboardError, formatZodError } from '../errors';
import { nowIso } from '../runtime';
import { createIssueFile, readAllIssueFiles, readIssueFile, writeIssueFile, type Repo } from '../storage/repo-files';
import { contentHash } from '../storage/fs-safe';
import { IssueFrontmatterSchema, type IssueFrontmatter, type Problem } from '../types';
import { generateId } from './id';
import {
  applyChanges,
  bodyOf,
  parseFrontmatter,
  serializeNewIssue,
  splitFile,
  type FileChanges,
  type ParsedFile,
} from './parse';

export interface StoredIssue {
  /** The filename stem. Equal to `fm.id` for any issue that is returned from `loadIssues`. */
  id: string;
  fm: IssueFrontmatter;
  parsed: ParsedFile;
  /** LF line endings, without the blank separator line. */
  body: string;
  hash: string;
}

type ParseOutcome = { ok: true; stored: StoredIssue } | { ok: false; code: string; message: string };

const relativeIssuePath = (id: string) => `.gitboard/issues/${id}.md`;

export function parseIssueText(fileId: string, text: string, hash: string): ParseOutcome {
  const parsed = splitFile(text);
  if (!parsed) {
    return { ok: false, code: 'INVALID_FRONTMATTER', message: 'File has no YAML frontmatter (expected a leading --- block).' };
  }
  let object: Record<string, unknown>;
  try {
    object = parseFrontmatter(parsed);
  } catch (error) {
    return { ok: false, code: 'INVALID_FRONTMATTER', message: error instanceof Error ? error.message : String(error) };
  }
  const result = IssueFrontmatterSchema.safeParse(object);
  if (!result.success) {
    const onlyProject = result.error.issues.every((issue) => issue.path[0] === 'project');
    if (onlyProject && object.project === undefined) {
      return {
        ok: false,
        code: 'MISSING_PROJECT',
        message: 'Issue has no `project`. Add `project: <KEY>` to its frontmatter (see `gitboard project list`).',
      };
    }
    return { ok: false, code: 'INVALID_FRONTMATTER', message: formatZodError(result.error) };
  }
  return { ok: true, stored: { id: fileId, fm: result.data, parsed, body: bodyOf(parsed), hash } };
}

export interface LoadedIssues {
  issues: StoredIssue[];
  problems: Problem[];
}

/** Loads every valid issue. Invalid or inconsistent files are reported as problems and excluded. */
export async function loadIssues(repo: Repo): Promise<LoadedIssues> {
  const { files, strangers } = await readAllIssueFiles(repo);
  const problems: Problem[] = [];
  const parsedOk: StoredIssue[] = [];

  for (const name of strangers) {
    problems.push({
      code: 'UNEXPECTED_FILE',
      file: `.gitboard/issues/${name}`,
      message: 'Markdown file name is not a 12-character lowercase hex id.',
    });
  }
  for (const entry of files) {
    if (!entry.file) {
      problems.push({ code: 'UNREADABLE_FILE', id: entry.id, file: relativeIssuePath(entry.id), message: entry.error ?? 'unreadable' });
      continue;
    }
    const outcome = parseIssueText(entry.id, entry.file.text, entry.file.hash);
    if (!outcome.ok) {
      problems.push({ code: outcome.code, id: entry.id, file: relativeIssuePath(entry.id), message: outcome.message });
      continue;
    }
    parsedOk.push(outcome.stored);
  }

  const claims = new Map<string, string[]>();
  for (const stored of parsedOk) {
    claims.set(stored.fm.id, [...(claims.get(stored.fm.id) ?? []), stored.id]);
  }
  for (const [id, stems] of claims) {
    if (stems.length > 1) {
      problems.push({
        code: 'DUPLICATE_ID',
        id,
        message: `Id ${id} is claimed by ${stems.length} files: ${stems.map((s) => `${s}.md`).join(', ')}.`,
      });
    }
  }

  const issues: StoredIssue[] = [];
  for (const stored of parsedOk) {
    if (stored.fm.id !== stored.id) {
      problems.push({
        code: 'ID_MISMATCH',
        id: stored.id,
        file: relativeIssuePath(stored.id),
        message: `Filename id ${stored.id} does not match frontmatter id ${stored.fm.id}.`,
      });
      continue;
    }
    issues.push(stored);
  }
  return { issues, problems };
}

export async function loadIssue(repo: Repo, id: string): Promise<StoredIssue> {
  const file = await readIssueFile(repo, id);
  const outcome = parseIssueText(id, file.text, file.hash);
  if (!outcome.ok) throw new GitboardError('INVALID_FRONTMATTER', `${relativeIssuePath(id)}: ${outcome.message}`);
  if (outcome.stored.fm.id !== id) {
    throw new GitboardError('INVALID_FRONTMATTER', `${relativeIssuePath(id)}: frontmatter id ${outcome.stored.fm.id} does not match the filename.`);
  }
  return outcome.stored;
}

/**
 * Applies changes to one issue. Unchanged content is never written. `expectedHash` lets a caller that
 * read the file earlier (the UI) fail with CONFLICT instead of overwriting newer edits.
 */
export async function saveChanges(
  repo: Repo,
  stored: StoredIssue,
  changes: FileChanges,
  expectedHash?: string,
): Promise<{ stored: StoredIssue; changed: boolean }> {
  if (expectedHash !== undefined && expectedHash !== stored.hash) {
    throw new GitboardError('CONFLICT', `Issue ${stored.id} changed since it was read. Reload and try again.`);
  }
  const result = applyChanges(stored.parsed, changes, nowIso());
  if (!result.changed) return { stored, changed: false };

  const hash = contentHash(result.text);
  const outcome = parseIssueText(stored.id, result.text, hash);
  if (!outcome.ok) throw new GitboardError('VALIDATION_FAILED', `Update would produce an invalid issue: ${outcome.message}`);
  await writeIssueFile(repo, stored.id, result.text, stored.hash);
  return { stored: outcome.stored, changed: true };
}

export interface IdSource {
  randomId?: () => string;
}

/**
 * Creates a new issue under a fresh random id using exclusive creation, retrying on collisions
 * (ADR-30abf7d). `fm` must not contain `id`; it is assigned here.
 */
export async function createStoredIssue(
  repo: Repo,
  fm: Omit<IssueFrontmatter, 'id'> & Record<string, unknown>,
  body: string,
  source: IdSource = {},
  maxAttempts = 8,
): Promise<StoredIssue> {
  const nextId = source.randomId ?? generateId;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = nextId();
    const text = serializeNewIssue({ id, ...fm }, body);
    if (await createIssueFile(repo, id, text)) {
      const outcome = parseIssueText(id, text, contentHash(text));
      if (!outcome.ok) throw new GitboardError('VALIDATION_FAILED', outcome.message);
      return outcome.stored;
    }
  }
  throw new GitboardError('ID_GENERATION_FAILED', `Could not find an unused issue id after ${maxAttempts} attempts.`);
}
