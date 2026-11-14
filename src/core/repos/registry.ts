/**
 * The user-level registry of known repositories (ADR-9d88632) and repository resolution.
 * Registry data lives outside any repo and holds machine-specific paths.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { GitboardError, formatZodError } from '../errors';
import { runGit } from '../storage/git';
import {
  emptyHooksDir,
  ensureDir,
  managedReposDir,
  readRegistryText,
  registryPath,
  writeRegistryText,
} from '../storage/registry-file';
import { findRepoRoot, isInitialized, openRepo, pathIsDirectory, type Repo } from '../storage/repo-files';
import type { RepoInfo } from '../types';
import { assertSshUrl, isRemoteUrl, repoNameFromUrl } from './remote';

const EntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  source: z.enum(['local', 'remote']),
  remoteUrl: z.string().optional(),
});
const RegistrySchema = z.object({
  version: z.literal(1).default(1),
  defaultRepo: z.string().optional(),
  repos: z.array(EntrySchema).default([]),
});
export type RegistryEntry = z.infer<typeof EntrySchema>;
type Registry = z.infer<typeof RegistrySchema>;

async function readRegistry(): Promise<Registry> {
  const text = await readRegistryText();
  if (text === null) return { version: 1, repos: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GitboardError('INVALID_CONFIG', `The repository registry is not valid JSON: ${registryPath()}`);
  }
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) throw new GitboardError('INVALID_CONFIG', `The repository registry is invalid: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

async function writeRegistry(registry: Registry): Promise<void> {
  await writeRegistryText(`${JSON.stringify(registry, null, 2)}\n`);
}

const shortHash = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 8);

function uniqueName(registry: Registry, wanted: string): string {
  let name = wanted;
  for (let n = 2; registry.repos.some((r) => r.name === name); n++) name = `${wanted}-${n}`;
  return name;
}

async function toInfo(entry: RegistryEntry, registry: Registry): Promise<RepoInfo> {
  const exists = await pathIsDirectory(entry.path);
  const initialized = exists ? await isInitialized({ root: entry.path }) : false;
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    source: entry.source,
    ...(entry.remoteUrl !== undefined ? { remoteUrl: entry.remoteUrl } : {}),
    initialized,
    exists,
    isDefault: registry.defaultRepo === entry.id,
  };
}

export async function listRepos(): Promise<RepoInfo[]> {
  const registry = await readRegistry();
  return Promise.all(registry.repos.map((entry) => toInfo(entry, registry)));
}

async function gitTopLevel(dir: string): Promise<string> {
  try {
    const { stdout } = await runGit(dir, ['rev-parse', '--show-toplevel']);
    return path.resolve(stdout.trim());
  } catch (error) {
    if (error instanceof GitboardError && error.code === 'GIT_FAILED') {
      throw new GitboardError('NOT_A_GIT_REPO', `${dir} is not inside a Git repository.`);
    }
    throw error;
  }
}

export async function registerRepo(source: string, name?: string): Promise<RepoInfo> {
  const registry = await readRegistry();

  if (isRemoteUrl(source) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source)) {
    const url = assertSshUrl(source);
    const existing = registry.repos.find((r) => r.remoteUrl === url);
    if (existing) return toInfo(existing, registry);

    const repoName = repoNameFromUrl(url);
    const dest = path.join(managedReposDir(), `${repoName}-${shortHash(url)}`);
    await ensureDir(managedReposDir());
    if (!(await pathIsDirectory(dest))) {
      const hooks = await emptyHooksDir();
      // `--` keeps the URL from being read as an option; hooks are disabled for the clone (ADR-b9d4018).
      await runGit(undefined, ['-c', `core.hooksPath=${hooks}`, '-c', 'protocol.ext.allow=never', 'clone', '--', url, dest]);
    }
    const repo = await openRepo(dest);
    const entry: RegistryEntry = {
      id: shortHash(repo.root),
      name: uniqueName(registry, name ?? repoName),
      path: repo.root,
      source: 'remote',
      remoteUrl: url,
    };
    registry.repos.push(entry);
    await writeRegistry(registry);
    return toInfo(entry, registry);
  }

  const given = await openRepo(source);
  const root = (await openRepo(await gitTopLevel(given.root))).root;
  const existing = registry.repos.find((r) => path.resolve(r.path) === root);
  if (existing) return toInfo(existing, registry);

  const entry: RegistryEntry = {
    id: shortHash(root),
    name: uniqueName(registry, name ?? path.basename(root)),
    path: root,
    source: 'local',
  };
  registry.repos.push(entry);
  await writeRegistry(registry);
  return toInfo(entry, registry);
}

function findEntry(registry: Registry, ref: string): RegistryEntry | undefined {
  return registry.repos.find((r) => r.id === ref) ?? registry.repos.find((r) => r.name === ref);
}

/** Removes the registry entry only. The repository and any managed clone stay on disk (ADR-9d88632). */
export async function removeRepo(ref: string): Promise<{ id: string; name: string }> {
  const registry = await readRegistry();
  const entry = findEntry(registry, ref);
  if (!entry) throw new GitboardError('REPO_NOT_FOUND', `No registered repository matches "${ref}".`);
  registry.repos = registry.repos.filter((r) => r.id !== entry.id);
  if (registry.defaultRepo === entry.id) delete registry.defaultRepo;
  await writeRegistry(registry);
  return { id: entry.id, name: entry.name };
}

export async function setDefaultRepo(ref: string): Promise<RepoInfo> {
  const registry = await readRegistry();
  const entry = findEntry(registry, ref);
  if (!entry) throw new GitboardError('REPO_NOT_FOUND', `No registered repository matches "${ref}".`);
  registry.defaultRepo = entry.id;
  await writeRegistry(registry);
  return toInfo(entry, registry);
}

export interface ResolvedRepo {
  repo: Repo;
  initialized: boolean;
  entry?: RegistryEntry;
}

/**
 * Resolves the repository an operation applies to:
 *  1. an explicit selector: a registry id, a registry name, or a directory path;
 *  2. otherwise the repo enclosing `cwd` (nearest `.gitboard/`, else the Git root);
 *  3. otherwise the registry's default repo.
 */
export async function resolveRepo(options: {
  repo?: string | undefined;
  cwd?: string | undefined;
  /** Only accept a registered repository: no paths, no cwd lookup, no default (used by the HTTP server). */
  registeredOnly?: boolean | undefined;
}): Promise<ResolvedRepo> {
  const registry = await readRegistry();

  const fromEntry = async (entry: RegistryEntry): Promise<ResolvedRepo> => {
    if (!(await pathIsDirectory(entry.path))) {
      throw new GitboardError('REPO_NOT_FOUND', `Registered repository "${entry.name}" is missing on disk: ${entry.path}`);
    }
    const repo = await openRepo(entry.path);
    return { repo, entry, initialized: await isInitialized(repo) };
  };

  if (options.repo !== undefined) {
    const entry = findEntry(registry, options.repo);
    if (entry) return fromEntry(entry);
    if (options.registeredOnly) {
      throw new GitboardError('REPO_NOT_FOUND', `No registered repository matches "${options.repo}".`);
    }
    const asPath = path.resolve(options.cwd ?? process.cwd(), options.repo);
    if (await pathIsDirectory(asPath)) {
      const found = await findRepoRoot(asPath);
      const repo = await openRepo(found?.root ?? asPath);
      return { repo, initialized: await isInitialized(repo) };
    }
    throw new GitboardError('REPO_NOT_FOUND', `No registered repository or directory matches "${options.repo}". See \`gitboard repo list\`.`);
  }

  if (options.registeredOnly) throw new GitboardError('REPO_NOT_FOUND', 'A registered repository is required.');

  if (options.cwd !== undefined) {
    const found = await findRepoRoot(options.cwd);
    if (found) {
      const repo = await openRepo(found.root);
      const entry = registry.repos.find((r) => path.resolve(r.path) === repo.root);
      return { repo, initialized: found.initialized, ...(entry ? { entry } : {}) };
    }
  }

  const fallback = registry.defaultRepo === undefined ? undefined : registry.repos.find((r) => r.id === registry.defaultRepo);
  if (fallback) return fromEntry(fallback);
  throw new GitboardError(
    'NOT_IN_REPO',
    'Not inside a Git repository with Gitboard, and no default repository is set. Run inside a repo, pass --repo, or use `gitboard repo default <name>`.',
  );
}

export async function requireInitialized(resolved: ResolvedRepo): Promise<Repo> {
  if (!resolved.initialized) {
    throw new GitboardError('NOT_INITIALIZED', `Gitboard is not initialised in ${resolved.repo.root}. Run \`gitboard init\`.`);
  }
  return resolved.repo;
}
