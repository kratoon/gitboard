/**
 * Markdown + YAML frontmatter parsing and minimal patching (ADR-0003, ADR-0004).
 *
 * Updates edit the YAML Document in place, so comments, key order and quoting survive. The Markdown
 * body is kept byte for byte unless an operation explicitly changes it, and a file whose content would
 * not change is reported as unchanged so callers skip the write.
 */
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { GitboardError } from '../errors';
import type { ChecklistItem } from '../types';

export interface ParsedFile {
  raw: string;
  bom: string;
  /** The opening delimiter line including its line ending. */
  prefix: string;
  /** Frontmatter text without its trailing line ending. */
  fm: string;
  /** Line ending plus closing delimiter line (including its line ending). */
  suffix: string;
  /** Everything after the closing delimiter line. */
  rest: string;
  eol: '\n' | '\r\n';
}

/** Splits a file into frontmatter and body without altering any bytes. Returns null if there is none. */
export function splitFile(raw: string): ParsedFile | null {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text = bom ? raw.slice(1) : raw;
  const open = /^---[ \t]*(\r?\n)/.exec(text);
  if (!open) return null;
  const eol = open[1] === '\r\n' ? '\r\n' : '\n';
  const start = open[0].length;
  const tail = text.slice(start);

  const emptyClose = /^---[ \t]*(\r?\n|$)/.exec(tail);
  if (emptyClose) {
    return { raw, bom, prefix: open[0], fm: '', suffix: emptyClose[0], rest: tail.slice(emptyClose[0].length), eol };
  }
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(tail);
  if (!close) return null;
  return {
    raw,
    bom,
    prefix: open[0],
    fm: tail.slice(0, close.index),
    suffix: close[0],
    rest: tail.slice(close.index + close[0].length),
    eol,
  };
}

/** Parses the frontmatter into a plain object, or throws INVALID_FRONTMATTER. */
export function parseFrontmatter(parsed: ParsedFile): Record<string, unknown> {
  const doc = parseDocument(parsed.fm);
  if (doc.errors.length > 0) {
    throw new GitboardError('INVALID_FRONTMATTER', `Invalid YAML frontmatter: ${doc.errors[0]?.message ?? 'unknown error'}`);
  }
  const value = doc.toJS() as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitboardError('INVALID_FRONTMATTER', 'Frontmatter must be a YAML mapping.');
  }
  return value as Record<string, unknown>;
}

/** The body as exposed to callers: LF line endings and without the blank separator line. */
export function bodyOf(parsed: ParsedFile): string {
  const lead = /^\r?\n/.exec(parsed.rest);
  const body = lead ? parsed.rest.slice(lead[0].length) : parsed.rest;
  return body.replace(/\r\n/g, '\n');
}

function normaliseEnd(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

export interface FileChanges {
  /** Frontmatter keys to set. A value of `undefined` removes the key. */
  fm: Record<string, unknown>;
  /** A replacement body (LF line endings). */
  body?: string;
  /** A raw replacement for everything after the frontmatter, used for byte-exact checklist toggles. */
  rest?: string;
}

export interface ApplyResult {
  text: string;
  changed: boolean;
}

/**
 * Applies changes and stamps `updatedAt`, but only if something actually differs. When nothing would
 * change, the original text is returned untouched.
 */
export function applyChanges(parsed: ParsedFile, changes: FileChanges, updatedAt: string): ApplyResult {
  const doc = parseDocument(parsed.fm);
  const current = (doc.toJS() ?? {}) as Record<string, unknown>;

  const diffs = Object.entries(changes.fm).filter(([key, value]) =>
    value === undefined ? key in current : !isDeepStrictEqual(current[key], value),
  );
  const bodyChanged =
    changes.body !== undefined && normaliseEnd(changes.body.replace(/\r\n/g, '\n')) !== normaliseEnd(bodyOf(parsed));
  const restChanged = changes.rest !== undefined && changes.rest !== parsed.rest;
  if (diffs.length === 0 && !bodyChanged && !restChanged) return { text: parsed.raw, changed: false };

  for (const [key, value] of diffs) {
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }
  doc.set('updatedAt', updatedAt);

  let fm = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  if (parsed.eol === '\r\n') fm = fm.replace(/\n/g, '\r\n');
  const suffix = parsed.fm === '' && fm !== '' ? `${parsed.eol}${parsed.suffix}` : parsed.suffix;

  let rest = parsed.rest;
  if (bodyChanged && changes.body !== undefined) {
    const hadBlank = /^\r?\n/.test(parsed.rest);
    const body = normaliseEnd(changes.body.replace(/\r\n/g, '\n'));
    rest = (hadBlank || parsed.rest === '' ? parsed.eol : '') + (parsed.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body);
  }
  if (restChanged && changes.rest !== undefined) rest = changes.rest;
  return { text: `${parsed.bom}${parsed.prefix}${fm}${suffix}${rest}`, changed: true };
}

const FRONTMATTER_ORDER = [
  'id',
  'title',
  'status',
  'project',
  'type',
  'priority',
  'labels',
  'parent',
  'rank',
  'createdAt',
  'updatedAt',
];

/** Serialises a brand-new issue file. New files always use LF line endings. */
export function serializeNewIssue(fm: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_ORDER) {
    if (fm[key] !== undefined) ordered[key] = fm[key];
  }
  for (const [key, value] of Object.entries(fm)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  const yamlText = stringify(ordered, { lineWidth: 0 });
  return `---\n${yamlText}---\n\n${normaliseEnd(body.replace(/\r\n/g, '\n'))}`;
}

// ---------------------------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------------------------

interface ChecklistHit extends ChecklistItem {
  /** Offset of the `[ ]` / `[x]` character within the scanned text. */
  position: number;
}

const ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Finds `- [ ]` / `- [x]` items outside fenced code blocks. Works on LF or CRLF text. */
export function scanChecklist(text: string): ChecklistHit[] {
  const hits: ChecklistHit[] = [];
  let fence: { char: string; length: number } | null = null;
  let pos = 0;
  for (;;) {
    let end = pos;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
    const line = text.slice(pos, end);

    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      const char = marker.charAt(0);
      if (fence === null) fence = { char, length: marker.length };
      else if (fence.char === char && marker.length >= fence.length) fence = null;
    } else if (fence === null) {
      const item = ITEM.exec(line);
      if (item) {
        hits.push({
          index: hits.length + 1,
          checked: item[2] !== ' ',
          text: (item[4] ?? '').trim(),
          position: pos + (item[1]?.length ?? 0),
        });
      }
    }

    if (end >= text.length) break;
    pos = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
  }
  return hits;
}

export function checklistOf(body: string): ChecklistItem[] {
  return scanChecklist(body).map(({ index, checked, text }) => ({ index, checked, text }));
}

/** Returns the new `rest` text with item `index` set, or null if there is no such item. */
export function setChecklistItem(rest: string, index: number, checked: boolean): string | null {
  const hit = scanChecklist(rest).find((item) => item.index === index);
  if (!hit) return null;
  return `${rest.slice(0, hit.position)}${checked ? 'x' : ' '}${rest.slice(hit.position + 1)}`;
}
