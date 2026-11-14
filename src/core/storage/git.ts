/**
 * Git runner. Always `execFile` with an argument array and no shell (ADR-0005), so nothing in an issue,
 * URL or path can be interpreted by a shell. Reads ambient process state (environment) on purpose.
 */
import { execFile } from 'node:child_process';
import { GitboardError } from '../errors';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string | undefined, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new GitboardError('GIT_MISSING', 'git was not found on PATH. Install git to use this command.'));
            return;
          }
          reject(new GitboardError('GIT_FAILED', `git ${args[0] ?? ''} failed: ${String(stderr).trim() || error.message}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
