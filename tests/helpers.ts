import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach } from 'vitest';
import { main } from '../src/cli/program';
import { resetRuntime, setRuntime } from '../src/core/runtime';
import { initRepo } from '../src/core/projects/config';
import { openRepo, type Repo } from '../src/core/storage/repo-files';

const cleanups: string[] = [];

export async function tmpDir(prefix = 'gitboard-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

export interface TestRepo {
  root: string;
  repo: Repo;
}

/** A fresh Git repo, initialised for Gitboard unless `init: false`. */
export async function makeRepo(options: { init?: boolean; name?: string; columns?: string[]; projectKey?: string } = {}): Promise<TestRepo> {
  const parent = await tmpDir();
  const root = path.join(parent, options.name ?? 'sample-app');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  if (options.init !== false) {
    await initRepo(root, {
      ...(options.columns ? { columns: options.columns } : {}),
      projectKey: options.projectKey ?? 'SAMP',
    });
  }
  return { root, repo: await openRepo(root) };
}

/** Isolates the user-level registry in a temp directory for every test. */
export function useTestHome(): void {
  const previous = process.env.GITBOARD_HOME;
  beforeEach(async () => {
    process.env.GITBOARD_HOME = await tmpDir('gitboard-home-');
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.GITBOARD_HOME;
    else process.env.GITBOARD_HOME = previous;
  });
}

/** Deterministic clock and ids, so separate runs can be compared byte for byte. */
export function useDeterministicRuntime(): void {
  beforeEach(() => {
    let counter = 0;
    let tick = 0;
    setRuntime({
      now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)),
      randomBytes: () => {
        counter++;
        return Buffer.from(counter.toString(16).padStart(12, '0'), 'hex');
      },
    });
  });
  afterEach(() => resetRuntime());
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop() as string;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// CLI and filesystem helpers
// ---------------------------------------------------------------------------------------------

export interface CliRun {
  code: number;
  out: string;
  err: string;
  /** Parsed stdout when `--json` was used. */
  json: { ok: boolean; data?: any; error?: { code: string; message: string; details?: unknown }; warnings?: string[] };
}

export async function runCli(
  args: string[],
  options: { cwd: string; stdin?: string; tty?: boolean; answers?: string[] },
): Promise<CliRun> {
  let out = '';
  let err = '';
  const answers = [...(options.answers ?? [])];
  const code = await main(args, {
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    cwd: options.cwd,
    stdinIsTTY: options.tty ?? false,
    stdoutIsTTY: options.tty ?? false,
    readStdin: async () => options.stdin ?? '',
    prompt: async () => answers.shift() ?? '',
  });
  let json: CliRun['json'] = { ok: false };
  if (args.includes('--json')) {
    try {
      json = JSON.parse(out);
    } catch {
      json = { ok: false, error: { code: 'NOT_JSON', message: out } };
    }
  }
  return { code, out, err, json };
}

/** Every file under `dir` as relative path to content, for byte-for-byte comparisons. */
export async function snapshotTree(dir: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await snapshotTree(path.join(dir, entry.name), rel));
    else result[rel] = await readFile(path.join(dir, entry.name), 'utf8');
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Config file helpers (the config is YAML by default but may be JSON, ADR-0016)
// ---------------------------------------------------------------------------------------------

/** Absolute path of the repo's config file, whichever format it uses. */
export async function configFile(root: string): Promise<string> {
  for (const name of ['config.yaml', 'config.yml', 'config.json']) {
    const file = path.join(root, '.gitboard', name);
    try {
      await readFile(file);
      return file;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`no config file in ${root}`);
}

/** The parsed config. JSON is valid YAML, so one parser handles both formats. */
export async function readConfigObject(root: string): Promise<any> {
  return parseYaml(await readFile(await configFile(root), 'utf8'));
}

/** Overwrites the config file in place (as JSON text, which is also valid YAML). */
export async function writeConfigObject(root: string, config: unknown): Promise<void> {
  await writeFile(await configFile(root), JSON.stringify(config));
}
