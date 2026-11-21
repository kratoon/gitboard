import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import type { Navigate } from './route';

/** `FEAT-6930f51`: a project key, a dash and 7 to 12 hex characters of the issue id. */
const KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-([0-9a-f]{7,12})\b/g;

export interface Links {
  /** The page path for an issue key found in text, or null when no issue in this repository matches. */
  resolve: (key: string) => string | null;
  navigate: Navigate;
}

const LinksContext = createContext<Links | null>(null);
export const LinksProvider = LinksContext.Provider;
export const useLinks = () => useContext(LinksContext);

/** Plain left-clicks navigate inside the app; modified clicks keep the browser's default (new tab). */
export function internalClick(links: Links, path: string) {
  return (event: MouseEvent) => {
    event.stopPropagation(); // inside a card or row: do not also open the drawer
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    links.navigate(path);
  };
}

/** Text with every resolvable issue key turned into a link to the issue page. */
export function LinkedText({ text }: { text: string }): ReactNode {
  const links = useLinks();
  if (!links) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(KEY_PATTERN)) {
    const path = links.resolve(match[0]);
    if (path === null) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a
        key={`${match.index}`}
        className="issue-key"
        href={path}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={internalClick(links, path)}
      >
        {match[0]}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'image', 'imageReference']);

/** A remark plugin that turns issue keys in Markdown text into links (never inside code or existing links). */
export function remarkIssueKeys(options: { resolve: (key: string) => string | null }) {
  const visit = (node: MdNode) => {
    if (!node.children || SKIP.has(node.type)) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type !== 'text' || child.value === undefined) {
        visit(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      let last = 0;
      for (const match of text.matchAll(KEY_PATTERN)) {
        const path = options.resolve(match[0]);
        if (path === null) continue;
        if (match.index > last) next.push({ type: 'text', value: text.slice(last, match.index) });
        next.push({ type: 'link', url: path, children: [{ type: 'text', value: match[0] }] });
        last = match.index + match[0].length;
      }
      if (last === 0) next.push(child);
      else if (last < text.length) next.push({ type: 'text', value: text.slice(last) });
    }
    node.children = next;
  };
  return (tree: MdNode) => visit(tree);
}
