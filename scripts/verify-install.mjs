// End-to-end check of the published artefact: pack the package, install the tarball into an empty
// project, and exercise the installed `gitboard` binary (CLI workflow, skill install, web server).
// Needs network access for `npm install`. Run after `npm run build`: `npm run verify:install`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'pipe'], ...options });

const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gitboard-verify-')));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`);
};

try {
  const packOut = sh(npm, ['pack', '--pack-destination', work, '--json', '--ignore-scripts']);
  const tarball = path.join(work, JSON.parse(packOut)[0].filename);

  const project = path.join(work, 'consumer');
  mkdirSync(project);
  writeFileSync(path.join(project, 'package.json'), '{"name":"consumer","version":"1.0.0","private":true}');
  sh(npm, ['install', tarball, '--no-audit', '--no-fund'], { cwd: project });
  const bin = path.join(project, 'node_modules', '.bin', isWin ? 'gitboard.cmd' : 'gitboard');
  check('installed binary exists', existsSync(bin));

  const repo = path.join(work, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, GITBOARD_HOME: path.join(work, 'home'), GITBOARD_USER_HOME: path.join(work, 'userhome') };
  const run = (...args) => sh(bin, args, { cwd: repo, env });
  const json = (...args) => JSON.parse(run(...args, '--json'));
  sh('git', ['init', '-q'], { cwd: repo });

  check('--version works', /\d+\.\d+\.\d+/.test(run('--version')));
  check('init', json('init').ok);
  const created = json('issue', 'create', 'Verify the package', '--priority', 'high');
  check('issue create', created.ok && created.data.title === 'Verify the package');
  check('issue move', json('issue', 'move', created.data.id, 'done').data.issue.status === 'done');
  check('validate passes', json('validate').ok);
  check('issue file exists in the repo', existsSync(path.join(repo, '.gitboard', 'issues', `${created.data.id}.md`)));

  check('skills install', json('skills', 'install').ok);
  check('skill copied to .agents/skills', existsSync(path.join(repo, '.agents', 'skills', 'gitboard', 'SKILL.md')));
  check('skill copied to .claude/skills', existsSync(path.join(repo, '.claude', 'skills', 'gitboard', 'SKILL.md')));
  check('skills sync is a no-op', json('skills', 'sync').data.locations.every((l) => l.status === 'unchanged'));

  json('repo', 'add', repo);
  const server = spawn(bin, ['start', '--no-open', '--port', '4398'], { cwd: repo, env, stdio: 'ignore', shell: isWin });
  try {
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 250));
      healthy = await fetch('http://127.0.0.1:4398/api/health').then((r) => r.ok, () => false);
    }
    check('server starts and answers /api/health', healthy);
    const page = await fetch('http://127.0.0.1:4398/').then((r) => r.text(), () => '');
    check('server serves the web UI', page.includes('<div id="root">'));
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    check('web UI assets are served', asset !== undefined && (await fetch(`http://127.0.0.1:4398${asset}`)).ok);
    const repos = await fetch('http://127.0.0.1:4398/api/ops/repo.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => r.json(), () => null);
    check('HTTP API sees the registered repository', repos?.ok === true && repos.data.length === 1);
  } finally {
    server.kill();
  }

  const skillText = readFileSync(path.join(repo, '.agents', 'skills', 'gitboard', 'SKILL.md'), 'utf8');
  check('installed skill tells agents to use the CLI', skillText.includes('gitboard'));
} catch (error) {
  check('verification ran to completion', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? `\nAll ${checks.length} checks passed.` : `\n${failed.length} of ${checks.length} checks FAILED.`);
process.exit(failed.length === 0 ? 0 : 1);
