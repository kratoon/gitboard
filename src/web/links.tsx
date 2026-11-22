import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import type { Navigate } from './route';

/** An issue reference such as `FEAT-6930f51`: a project key, a dash and 7 to 12 hex characters of the issue id. */
const REF_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-([0-9a-f]{7,12})\b/g;

/** An issue found for a reference in text. */
export interface ResolvedRef {
  path: string;
  /** The canonical reference. */
  ref: string;
  title: string;
}

export interface Links {
  /** The issue a reference in text points to, or null when no issue in this repository matches. */
  resolve: (ref: string) => ResolvedRef | null;
  navigate: Navigate;
}

const LinksContext = createContext<Links | null>(null);
export const LinksProvider = LinksContext.Provider;
export const useLinks = () => useContext(LinksContext);

/** `FEAT-6930f51: Open an issue on its own page` */
export const previewText = (found: ResolvedRef) => `${found.ref}: ${found.title}`;

/** Plain left-clicks navigate inside the app; modified clicks keep the browser's default (new tab). */
export function internalClick(links: Links, path: string) {
  return (event: MouseEvent) => {
    event.stopPropagation(); // inside a card or row: do not also open the drawer
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    links.navigate(path);
  };
}

/** Text with every resolvable issue reference replaced by a link that previews it as `REF: title`. */
export function LinkedText({ text }: { text: string }): ReactNode {
  const links = useLinks();
  if (!links) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    const found = links.resolve(match[0]);
    if (found === null) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a
        key={`${match.index}`}
        className="issue-ref"
        href={found.path}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={internalClick(links, found.path)}
      >
        {previewText(found)}
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

/** A remark plugin that turns issue references in Markdown text into preview links (never inside code or existing links). */
export function remarkIssueRefs(options: { resolve: (ref: string) => ResolvedRef | null }) {
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
      for (const match of text.matchAll(REF_PATTERN)) {
        const found = options.resolve(match[0]);
        if (found === null) continue;
        if (match.index > last) next.push({ type: 'text', value: text.slice(last, match.index) });
        next.push({ type: 'link', url: found.path, children: [{ type: 'text', value: previewText(found) }] });
        last = match.index + match[0].length;
      }
      if (last === 0) next.push(child);
      else if (last < text.length) next.push({ type: 'text', value: text.slice(last) });
    }
    node.children = next;
  };
  return (tree: MdNode) => visit(tree);
}
