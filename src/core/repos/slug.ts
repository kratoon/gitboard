/**
 * Repository slugs for portable web URLs (FEAT-130c757). Pure functions, shared by the server and the web app.
 *
 * A slug is `<owner>/<name>` taken from the `origin` URL, so every clone of a repository has the same URL.
 * It gains a provider prefix (`github/acme/api`) only when two registered repositories would otherwise share
 * a path across providers. A repository with no origin uses the `id` from its config, and as a last resort
 * `local/<registry id>`.
 */

export const REPO_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const KNOWN_PROVIDERS: Record<string, string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

export interface ParsedOrigin {
  host: string;
  /** `owner/name` (more segments for nested groups), lowercase, without `.git`. */
  path: string;
}

/** Understands https://, ssh:// and git:// URLs and scp-like `git@host:owner/name.git`. Local paths give null. */
export function parseOrigin(url: string): ParsedOrigin | null {
  const text = url.trim();
  let host: string;
  let pathname: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
      host = parsed.hostname;
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else if (scp && !text.startsWith('/') && !text.startsWith('.')) {
    host = scp[1] ?? '';
    pathname = scp[2] ?? '';
  } else {
    return null;
  }
  const segments = pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase());
  const last = segments.pop();
  if (last === undefined) return null;
  segments.push(last.replace(/\.git$/, ''));
  if (segments.length < 2 || !segments.every((s) => SEGMENT.test(s)) || host === '') return null;
  return { host: host.toLowerCase(), path: segments.join('/') };
}

export function providerOf(host: string): string {
  return KNOWN_PROVIDERS[host] ?? host;
}

export interface SlugInput {
  /** Registry id. */
  id: string;
  origin?: ParsedOrigin | undefined;
  configId?: string | undefined;
}

export interface SlugInfo {
  slug: string;
  /** The slug without a provider prefix. */
  slugBase: string;
  provider?: string;
  slugSource: 'config' | 'origin' | 'registry';
}

export function assignSlugs(inputs: SlugInput[]): Map<string, SlugInfo> {
  const result = new Map<string, SlugInfo>();
  const byBase = new Map<string, SlugInput[]>();
  for (const input of inputs) {
    if (input.configId !== undefined || !input.origin) continue;
    byBase.set(input.origin.path, [...(byBase.get(input.origin.path) ?? []), input]);
  }
  for (const input of inputs) {
    if (input.configId !== undefined) {
      result.set(input.id, { slug: input.configId, slugBase: input.configId, slugSource: 'config' });
    } else if (input.origin) {
      const provider = providerOf(input.origin.host);
      const group = byBase.get(input.origin.path) ?? [];
      const providers = new Set(group.map((g) => providerOf(g.origin?.host ?? '')));
      const slug = providers.size > 1 ? `${provider}/${input.origin.path}` : input.origin.path;
      result.set(input.id, { slug, slugBase: input.origin.path, provider, slugSource: 'origin' });
    } else {
      const slug = `local/${input.id}`;
      result.set(input.id, { slug, slugBase: slug, slugSource: 'registry' });
    }
  }
  return result;
}

export type SlugMatch<T> = { kind: 'found'; repo: T } | { kind: 'ambiguous'; repos: T[] } | { kind: 'missing' };

/**
 * Finds the repository for a URL slug. The provider-qualified form is always accepted, and the plain form
 * when only one repository has that path. Matching ignores case.
 */
export function resolveSlug<T extends SlugInfo & { id: string }>(repos: T[], slug: string): SlugMatch<T> {
  const wanted = slug.toLowerCase();
  const exact = repos.filter((r) => r.slug === wanted);
  if (exact.length > 0) return { kind: 'found', repo: exact[0] as T };
  const byBase = repos.filter((r) => r.slugBase === wanted);
  if (byBase.length === 1) return { kind: 'found', repo: byBase[0] as T };
  if (byBase.length > 1) return { kind: 'ambiguous', repos: byBase };
  const [provider, ...rest] = wanted.split('/');
  if (provider !== undefined && rest.length > 0) {
    const qualified = repos.filter((r) => r.provider === provider && r.slugBase === rest.join('/'));
    if (qualified.length > 0) return { kind: 'found', repo: qualified[0] as T };
  }
  return { kind: 'missing' };
}
