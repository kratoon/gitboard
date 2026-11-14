import { GitboardError } from '../errors';
import { runGit } from '../storage/git';
import type { Repo } from '../storage/repo-files';
import type { GitStatus } from '../types';

/** Read-only: current branch and whether `.gitboard/` has uncommitted changes (ADR-0012). */
export async function getGitStatus(repo: Repo): Promise<GitStatus> {
  try {
    await runGit(repo.root, ['rev-parse', '--git-dir']);
  } catch (error) {
    if (error instanceof GitboardError && (error.code === 'GIT_FAILED' || error.code === 'GIT_MISSING')) {
      return { isGitRepo: false, dirty: false, changes: 0 };
    }
    throw error;
  }

  let branch: string;
  let detached = false;
  try {
    branch = (await runGit(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  } catch {
    detached = true;
    try {
      branch = (await runGit(repo.root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    } catch {
      branch = 'HEAD';
    }
  }

  const status = await runGit(repo.root, ['status', '--porcelain=v1', '-uall', '--', '.gitboard']);
  const changes = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
  return { isGitRepo: true, branch, detached, dirty: changes > 0, changes };
}
