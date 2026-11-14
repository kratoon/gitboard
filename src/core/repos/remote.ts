import { GitboardError } from '../errors';

const SSH_URL = /^ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[^\s]+$/;
const SCP_LIKE = /^[\w.-]+@[\w.-]+:[^\s/][^\s]*$|^[\w.-]+@[\w.-]+:\/[^\s/][^\s]*$/;
const ANY_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * True for SSH remotes: `ssh://[user@]host[:port]/path` and scp-style `user@host:path`.
 * Windows paths such as `C:\\repos\\x` are local paths, never remotes.
 */
export function isRemoteUrl(source: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(source)) return false;
  return SSH_URL.test(source) || SCP_LIKE.test(source);
}

/** Validates a remote URL before it is passed to git (ADR-b9d4018). Only SSH remotes are supported. */
export function assertSshUrl(source: string): string {
  if (source.startsWith('-') || /\s/.test(source) || source.includes('\0')) {
    throw new GitboardError('INVALID_REMOTE_URL', `Invalid repository URL: ${source}`);
  }
  if (ANY_SCHEME.test(source) && !source.startsWith('ssh://')) {
    throw new GitboardError('INVALID_REMOTE_URL', 'Only SSH remotes are supported (ssh://host/path or git@host:path).');
  }
  if (!isRemoteUrl(source)) {
    throw new GitboardError('INVALID_REMOTE_URL', `Not a valid SSH repository URL: ${source}`);
  }
  return source;
}

/** `git@github.com:acme/widgets.git` becomes `widgets`. */
export function repoNameFromUrl(url: string): string {
  const last = url.split(/[/:]/).filter(Boolean).pop() ?? 'repo';
  const name = last.replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '-');
  return name === '' ? 'repo' : name;
}
