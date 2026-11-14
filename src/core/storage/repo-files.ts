/**
 * All reads and writes of a repository's `.gitboard/` directory. Higher layers never touch the
 * filesystem directly (ADR-0012). Every path is built from a validated ID and checked against the repo
 * root after resolving symlinks (ADR-0005).
 */
import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitboardError } from '../errors';
import { ID_PATTERN } from '../types';
import {
  assertNotSymlink,
  atomicWriteFile,
  contentHash,
  createFileExclusive,
  isInside,
  realpathOrNull,
} from './fs-safe';

export const GITBOARD_DIR = '.gitboard';

/** A repository handle. `root` is a canonical (symlink-resolved) absolute path. */
export interface Repo {
  root: string;
}

export interface FileContent {
  text: string;
  hash: string;
}

const ISSUE_FILE = /^[0-9a-f]{12}\.md$/;

export async function openRepo(root: string): Promise<Repo> {
  const real = await realpathOrNull(path.resolve(root));
  if (real === null) throw new GitboardError('REPO_NOT_FOUND', `Directory does not exist: ${root}`);
  const info = await stat(real);
  if (!info.isDirectory()) throw new GitboardError('REPO_NOT_FOUND', `Not a directory: ${root}`);
  return { root: real };
}

/** The repo config is YAML by default; JSON is also read and written (ADR-0016). */
export const CONFIG_FILE_NAMES = ['config.yaml', 'config.yml', 'config.json'] as const;
export const DEFAULT_CONFIG_FILE = 'config.yaml';
export type ConfigFormat = 'yaml' | 'json';

export interface ConfigFile extends FileContent {
  /** File name inside `.gitboard/`. */
  name: string;
  format: ConfigFormat;
}

export function configFormatOf(name: string): ConfigFormat {
  return name.endsWith('.json') ? 'json' : 'yaml';
}

const configPath = (repo: Repo, name: string) => path.join(repo.root, GITBOARD_DIR, name);

export async function existingConfigNames(repo: Repo): Promise<string[]> {
  const found: string[] = [];
  for (const name of CONFIG_FILE_NAMES) {
    try {
      await lstat(configPath(repo, name));
      found.push(name);
    } catch {
      /* not there */
    }
  }
  return found;
}

export async function isInitialized(repo: Repo): Promise<boolean> {
  return (await existingConfigNames(repo)).length > 0;
}

/** The single config file, or NOT_INITIALIZED, or INVALID_CONFIG when several formats exist side by side. */
async function currentConfigName(repo: Repo): Promise<string> {
  const names = await existingConfigNames(repo);
  if (names.length === 0) {
    throw new GitboardError('NOT_INITIALIZED', 'This repository is not initialised for Gitboard. Run `gitboard init`.');
  }
  if (names.length > 1) {
    throw new GitboardError('INVALID_CONFIG', `Found more than one config file in .gitboard/ (${names.join(', ')}). Keep exactly one.`);
  }
  return names[0] as string;
}

/** Walks up from `start` looking for `.gitboard/`, then for a `.git` entry (an uninitialised repo). */
export async function findRepoRoot(start: string): Promise<{ root: string; initialized: boolean } | null> {
  let dir = path.resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (await exists(path.join(dir, GITBOARD_DIR))) return { root: dir, initialized: true };
    if (gitRoot === null && (await exists(path.join(dir, '.git')))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot === null ? null : { root: gitRoot, initialized: false };
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** The canonical issues directory, verified to live inside the repo root. */
async function issuesDir(repo: Repo): Promise<string> {
  const dir = await realpathOrNull(path.join(repo.root, GITBOARD_DIR, 'issues'));
  if (dir === null) throw new GitboardError('NOT_INITIALIZED', 'This repository has no .gitboard/issues directory. Run `gitboard init`.');
  if (!isInside(repo.root, dir)) {
    throw new GitboardError('PATH_OUTSIDE_REPO', '.gitboard/issues resolves outside the repository.');
  }
  return dir;
}

function issueFileName(id: string): string {
  if (!ID_PATTERN.test(id)) throw new GitboardError('INVALID_INPUT', `Invalid issue id: ${id}`);
  return `${id}.md`;
}

export async function readIssueFile(repo: Repo, id: string): Promise<FileContent> {
  const file = path.join(await issuesDir(repo), issueFileName(id));
  return readIssueFileAt(file, id);
}

async function readIssueFileAt(file: string, id: string): Promise<FileContent> {
  try {
    await assertNotSymlink(file);
    const buffer = await readFile(file);
    return { text: buffer.toString('utf8'), hash: contentHash(buffer) };
  } catch (error) {
    if (error instanceof GitboardError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitboardError('ISSUE_NOT_FOUND', `Issue not found: ${id}`);
    }
    throw error;
  }
}

export interface IssueFileListing {
  /** Files named `<12 hex>.md`. */
  ids: string[];
  /** Other Markdown files in the issues directory (reported by `validate`). */
  strangers: string[];
}

export async function listIssueFiles(repo: Repo): Promise<IssueFileListing> {
  const entries = await readdir(await issuesDir(repo));
  const ids: string[] = [];
  const strangers: string[] = [];
  for (const name of entries) {
    if (ISSUE_FILE.test(name)) ids.push(name.slice(0, -3));
    else if (name.endsWith('.md') && !name.startsWith('.')) strangers.push(name);
  }
  ids.sort();
  strangers.sort();
  return { ids, strangers };
}

export interface RawIssueFile {
  id: string;
  /** Present unless the file could not be read (for example, a symlink). */
  file?: FileContent;
  error?: string;
}

export async function readAllIssueFiles(repo: Repo): Promise<{ files: RawIssueFile[]; strangers: string[] }> {
  const dir = await issuesDir(repo);
  const { ids, strangers } = await listIssueFiles(repo);
  const files: RawIssueFile[] = [];
  const batch = 32;
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    const results = await Promise.all(
      slice.map(async (id): Promise<RawIssueFile> => {
        try {
          return { id, file: await readIssueFileAt(path.join(dir, `${id}.md`), id) };
        } catch (error) {
          return { id, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    files.push(...results);
  }
  return { files, strangers };
}

/**
 * Replaces an existing issue file atomically. If `expectedHash` is given and the file no longer matches
 * it, nothing is written and CONFLICT is thrown (ADR-0004).
 */
export async function writeIssueFile(repo: Repo, id: string, text: string, expectedHash: string): Promise<void> {
  const file = path.join(await issuesDir(repo), issueFileName(id));
  const current = await readIssueFileAt(file, id);
  if (current.hash !== expectedHash) {
    throw new GitboardError('CONFLICT', `Issue ${id} changed on disk since it was read. Reload and try again.`);
  }
  await atomicWriteFile(file, text);
}

/** Creates a new issue file. Returns false if a file with that ID already exists. */
export async function createIssueFile(repo: Repo, id: string, text: string): Promise<boolean> {
  const file = path.join(await issuesDir(repo), issueFileName(id));
  try {
    await createFileExclusive(file, text);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export async function deleteIssueFile(repo: Repo, id: string, expectedHash?: string): Promise<void> {
  const file = path.join(await issuesDir(repo), issueFileName(id));
  const current = await readIssueFileAt(file, id);
  if (expectedHash !== undefined && current.hash !== expectedHash) {
    throw new GitboardError('CONFLICT', `Issue ${id} changed on disk since it was read. Reload and try again.`);
  }
  await rm(file);
}

export async function readConfigFile(repo: Repo): Promise<ConfigFile> {
  const name = await currentConfigName(repo);
  const file = configPath(repo, name);
  try {
    await assertNotSymlink(file);
    const buffer = await readFile(file);
    return { name, format: configFormatOf(name), text: buffer.toString('utf8'), hash: contentHash(buffer) };
  } catch (error) {
    if (error instanceof GitboardError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitboardError('NOT_INITIALIZED', 'This repository is not initialised for Gitboard. Run `gitboard init`.');
    }
    throw error;
  }
}

/** Writes the config back to the file it came from (so the format never changes by accident). */
export async function writeConfigFile(repo: Repo, text: string, expectedHash: string): Promise<void> {
  const current = await readConfigFile(repo);
  if (current.hash !== expectedHash) {
    throw new GitboardError('CONFLICT', `.gitboard/${current.name} changed on disk since it was read. Try again.`);
  }
  await atomicWriteFile(configPath(repo, current.name), text);
}

/**
 * Switches the config to another file (and so another format): the new file is created first, then the
 * old one removed, so an interruption never leaves the repository without a config.
 */
export async function replaceConfigFile(repo: Repo, newName: string, text: string, expectedHash: string): Promise<void> {
  const current = await readConfigFile(repo);
  if (current.hash !== expectedHash) {
    throw new GitboardError('CONFLICT', `.gitboard/${current.name} changed on disk since it was read. Try again.`);
  }
  try {
    await createFileExclusive(configPath(repo, newName), text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GitboardError('INVALID_CONFIG', `.gitboard/${newName} already exists.`);
    }
    throw error;
  }
  await rm(configPath(repo, current.name));
}

/** Creates `.gitboard/` with its config, issues directory and line-ending rule. */
export async function createGitboardFiles(repo: Repo, configText: string, configName: string = DEFAULT_CONFIG_FILE): Promise<void> {
  const dir = path.join(repo.root, GITBOARD_DIR);
  const issues = path.join(dir, 'issues');
  await mkdir(issues, { recursive: true });
  await atomicWriteFile(path.join(dir, '.gitattributes'), '* text eol=lf\n');
  await atomicWriteFile(path.join(issues, '.gitkeep'), '');
  await atomicWriteFile(configPath(repo, configName), configText);
}
