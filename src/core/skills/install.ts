/**
 * `gitboard skills install | sync | status` (ADR-0007). Installs the packaged skill into a repository
 * or the user's home: one canonical copy in `.agents/skills/gitboard`, plus per-agent locations for
 * agents that do not read that directory. Customised installs are never overwritten without `force`.
 */
import path from 'node:path';
import { GitboardError } from '../errors';
import { findRepoRoot } from '../storage/repo-files';
import {
  findPackageRoot,
  hashTree,
  inspectDest,
  linkPointsTo,
  makeLink,
  readPackageVersion,
  readTree,
  sameHashes,
  writeCopy,
} from '../storage/skill-files';
import { userHome } from '../storage/userdirs';
import type { SkillLocationResult, SkillsResult } from '../types';
import { AGENTS, DEFAULT_AGENTS, SHARED_GLOBAL_DIR, SHARED_PROJECT_DIR, SKILL_NAME, findAgent } from './agents';

export interface SkillsRequest {
  cwd: string;
  agents?: string[] | undefined;
  global?: boolean | undefined;
  mode?: 'copy' | 'link' | undefined;
  path?: string | undefined;
  force?: boolean | undefined;
}

interface Location {
  path: string;
  kind: 'canonical' | 'agent';
  agents: string[];
}
type Action = 'install' | 'update' | 'unchanged' | 'conflict';

interface Packaged {
  version: string;
  tree: Map<string, Buffer>;
  hashes: Record<string, string>;
}

async function loadPackaged(): Promise<Packaged> {
  const root = await findPackageRoot();
  const tree = await readTree(path.join(root, 'skills', SKILL_NAME));
  return { version: await readPackageVersion(root), tree, hashes: hashTree(tree) };
}

async function baseDirFor(request: SkillsRequest): Promise<string> {
  if (request.global) return userHome();
  return (await findRepoRoot(request.cwd))?.root ?? path.resolve(request.cwd);
}

function groupLocations(request: SkillsRequest, base: string, agentIds: readonly string[]): { canonical: Location; others: Location[] } {
  const sharedDir = request.global ? SHARED_GLOBAL_DIR : SHARED_PROJECT_DIR;
  const canonical: Location = { path: path.join(base, ...sharedDir.split('/'), SKILL_NAME), kind: 'canonical', agents: [] };
  const others = new Map<string, Location>();

  for (const id of agentIds) {
    const agent = findAgent(id);
    if (!agent) {
      const known = AGENTS.map((a) => a.id).join(', ');
      throw new GitboardError('INVALID_INPUT', `Unknown agent "${id}". Known agents: ${known}. Use --path for others.`);
    }
    if (agent.readsAgentsDir) {
      canonical.agents.push(id);
      continue;
    }
    const dir = request.global ? agent.globalDir : agent.projectDir;
    if (dir === undefined) continue;
    const target = path.join(base, ...dir.split('/'), SKILL_NAME);
    const existing = others.get(target);
    if (existing) existing.agents.push(id);
    else others.set(target, { path: target, kind: 'agent', agents: [id] });
  }
  if (request.path !== undefined) {
    const target = path.join(path.resolve(request.cwd, request.path), SKILL_NAME);
    others.set(target, { path: target, kind: 'agent', agents: ['custom'] });
  }
  return { canonical, others: [...others.values()] };
}

async function analyse(location: Location, mode: 'copy' | 'link', canonical: string, packaged: Packaged): Promise<Action> {
  const state = await inspectDest(location.path);
  const wantsLink = location.kind === 'agent' && mode === 'link';
  if (state.kind === 'none') return 'install';
  if (state.kind === 'file') return 'conflict';
  if (state.kind === 'symlink') {
    if (wantsLink && (await linkPointsTo(location.path, canonical))) return 'unchanged';
    return 'conflict';
  }
  if (state.modified) return 'conflict';
  if (wantsLink) return 'update'; // an unmodified copy is replaced by a link
  return sameHashes(state.hashes, packaged.hashes) ? 'unchanged' : 'update';
}

async function applyLocation(
  location: Location,
  mode: 'copy' | 'link',
  canonical: string,
  packaged: Packaged,
): Promise<'copy' | 'link'> {
  if (location.kind === 'agent' && mode === 'link' && (await makeLink(location.path, canonical))) return 'link';
  await writeCopy(location.path, packaged.tree, packaged.version);
  return 'copy';
}

const STATUS: Record<Action, SkillLocationResult['status']> = {
  install: 'installed',
  update: 'updated',
  unchanged: 'unchanged',
  conflict: 'conflict',
};

async function run(request: SkillsRequest, candidates: (c: { canonical: Location; others: Location[] }) => Promise<Location[]>): Promise<SkillsResult> {
  const packaged = await loadPackaged();
  const base = await baseDirFor(request);
  const agentIds = request.agents && request.agents.length > 0 ? request.agents : DEFAULT_AGENTS;
  const groups = groupLocations(request, base, agentIds);
  const mode = request.mode ?? (request.global ? 'link' : 'copy');
  const selected = await candidates(groups);

  const planned: Array<{ location: Location; action: Action }> = [];
  for (const location of selected) {
    planned.push({ location, action: await analyse(location, mode, groups.canonical.path, packaged) });
  }

  const conflicts = planned.filter((p) => p.action === 'conflict');
  if (conflicts.length > 0 && !request.force) {
    throw new GitboardError(
      'SKILL_MODIFIED',
      `Existing skill files differ from what Gitboard installed (customised or foreign): ${conflicts.map((c) => c.location.path).join(', ')}. Re-run with --force to overwrite them.`,
      { locations: conflicts.map((c) => c.location.path) },
    );
  }

  const locations: SkillLocationResult[] = [];
  for (const { location, action } of planned) {
    const effective: Action = action === 'conflict' ? 'update' : action;
    let actual: 'copy' | 'link' = location.kind === 'agent' && mode === 'link' ? 'link' : 'copy';
    if (effective !== 'unchanged') actual = await applyLocation(location, mode, groups.canonical.path, packaged);
    locations.push({ path: location.path, kind: location.kind, mode: actual, status: STATUS[effective], agents: location.agents });
  }
  return { version: packaged.version, locations };
}

export function installSkills(request: SkillsRequest): Promise<SkillsResult> {
  return run(request, async ({ canonical, others }) => [canonical, ...others]);
}

/** Updates installs that already exist. Locations that were never installed are left alone. */
export function syncSkills(request: SkillsRequest): Promise<SkillsResult> {
  return run(request, async ({ canonical, others }) => {
    const all = [canonical, ...others];
    const existing: Location[] = [];
    for (const location of all) if ((await inspectDest(location.path)).kind !== 'none') existing.push(location);
    return existing;
  });
}

/** Read-only: reports whether each location is installed, current, outdated or customised. */
export async function skillsStatus(request: SkillsRequest): Promise<SkillsResult> {
  const packaged = await loadPackaged();
  const base = await baseDirFor(request);
  const agentIds = request.agents && request.agents.length > 0 ? request.agents : DEFAULT_AGENTS;
  const groups = groupLocations(request, base, agentIds);
  const mode = request.mode ?? (request.global ? 'link' : 'copy');

  const locations: SkillLocationResult[] = [];
  for (const location of [groups.canonical, ...groups.others]) {
    const state = await inspectDest(location.path);
    const action = await analyse(location, mode, groups.canonical.path, packaged);
    let status: SkillLocationResult['status'];
    if (state.kind === 'none') status = 'missing';
    else if (action === 'unchanged') status = 'unchanged';
    else if (state.kind === 'dir' && !state.modified) status = 'outdated';
    else status = 'modified';
    const actual = state.kind === 'symlink' ? 'link' : 'copy';
    locations.push({ path: location.path, kind: location.kind, mode: actual, status, agents: location.agents });
  }
  return { version: packaged.version, locations };
}
