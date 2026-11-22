import { useCallback, useEffect, useState } from 'react';

/**
 * Web routes (FEAT-130c757):
 *   /repos/<slug>                  the board of a repository
 *   /repos/<slug>/issues/<ref>     one issue on its own page
 * A slug is `owner/name`, `provider/owner/name` on a provider conflict, or a configured id (see repos/slug.ts).
 * The server serves the app for every path, so no server change is needed.
 */
export interface Route {
  slug: string | null;
  ref: string | null;
}

export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  if (segments[0] !== 'repos') return { slug: null, ref: null };
  const rest = segments.slice(1);
  const at = rest.length - 2;
  if (at >= 1 && rest[at] === 'issues') return { slug: rest.slice(0, at).join('/'), ref: rest[rest.length - 1] ?? null };
  return { slug: rest.length > 0 ? rest.join('/') : null, ref: null };
}

const encodePath = (slug: string) => slug.split('/').map(encodeURIComponent).join('/');
export const repoPath = (slug: string) => `/repos/${encodePath(slug)}`;
export const issuePath = (slug: string, ref: string) => `${repoPath(slug)}/issues/${encodeURIComponent(ref)}`;

export type Navigate = (path: string, options?: { replace?: boolean }) => void;

/** Marks history entries created by the app, so "back" can return to the board the user came from. */
const APP_ENTRY = { gitboard: true };
export const cameFromApp = () => (window.history.state as { gitboard?: boolean } | null)?.gitboard === true;

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback<Navigate>((path, options) => {
    if (options?.replace) window.history.replaceState(window.history.state, '', path);
    else window.history.pushState(APP_ENTRY, '', path);
    setRoute(parseRoute(path));
  }, []);
  return [route, navigate];
}
