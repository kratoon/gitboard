// Verifies that `npm pack` would publish everything Gitboard needs and nothing it should not.
// Run after `npm run build` (it is part of `prepublishOnly` and CI).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const raw = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const [report] = JSON.parse(raw);
const files = report.files.map((f) => f.path.replaceAll('\\', '/'));

const problems = [];
const need = (path) => {
  if (!files.includes(path)) problems.push(`missing from package: ${path}`);
};

for (const path of ['package.json', 'README.md', 'dist/cli.js', 'dist/web/index.html', 'skills/gitboard/SKILL.md']) need(path);
if (!files.some((f) => /^dist\/web\/assets\/.+\.js$/.test(f))) problems.push('missing from package: dist/web/assets/*.js');
if (!files.some((f) => /^dist\/web\/assets\/.+\.css$/.test(f))) problems.push('missing from package: dist/web/assets/*.css');

for (const file of files) {
  if (/^(src|tests|docs|scripts|\.github|node_modules)\//.test(file)) problems.push(`should not be published: ${file}`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.bin?.gitboard !== 'dist/cli.js') problems.push('package.json bin.gitboard must be dist/cli.js');
if (!readFileSync('dist/cli.js', 'utf8').startsWith('#!/usr/bin/env node')) problems.push('dist/cli.js is missing its shebang');
if (process.platform !== 'win32' && (statSync('dist/cli.js').mode & 0o111) === 0) problems.push('dist/cli.js is not executable');
if (pkg.scripts?.postinstall || pkg.scripts?.preinstall || pkg.scripts?.install) {
  problems.push('install scripts are not allowed: Gitboard must not run code in consuming repositories (ADR-0007)');
}

if (problems.length > 0) {
  console.error(`Package check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Package OK: ${report.name}@${report.version}, ${files.length} files, ${(report.size / 1024).toFixed(0)} kB packed.`);
