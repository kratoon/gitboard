import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  bodyOf,
  checklistOf,
  parseFrontmatter,
  scanChecklist,
  serializeNewIssue,
  setChecklistItem,
  splitFile,
} from '../../src/core/issues/parse';
import { IssueFrontmatterSchema } from '../../src/core/types';

const sample = `---
# keep this comment
id: a3f91c2e8b40
title: Implement authentication service
status: todo
project: AUTH
labels:
  - backend
createdAt: 2026-11-14T10:00:00Z
---

## Description

Implement the authentication service.

## Acceptance Criteria

- [ ] Implement authentication
- [x] Add unit tests
`;

const split = (text: string) => {
  const parsed = splitFile(text);
  if (!parsed) throw new Error('no frontmatter');
  return parsed;
};

describe('frontmatter parsing', () => {
  it('splits frontmatter and body without altering bytes', () => {
    const p = split(sample);
    expect(p.prefix + p.fm + p.suffix + p.rest).toBe(sample);
    expect(parseFrontmatter(p)).toMatchObject({ id: 'a3f91c2e8b40', status: 'todo', labels: ['backend'] });
    expect(bodyOf(p).startsWith('## Description')).toBe(true);
  });

  it('returns null when there is no frontmatter', () => {
    expect(splitFile('# just markdown\n')).toBeNull();
    expect(splitFile('---\nid: x\nno closing delimiter\n')).toBeNull();
  });

  it('treats a horizontal rule in the body as body, not frontmatter', () => {
    const p = split('---\nid: x\n---\n\ntext\n\n---\n\nmore\n');
    expect(p.fm).toBe('id: x');
    expect(p.rest).toContain('more');
  });

  it('rejects invalid YAML and non-mapping frontmatter', () => {
    expect(() => parseFrontmatter(split('---\nid: [unclosed\n---\n'))).toThrow(/Invalid YAML/);
    expect(() => parseFrontmatter(split('---\n- a\n- b\n---\n'))).toThrow(/mapping/);
    expect(() => parseFrontmatter(split('---\nid: 1\nid: 2\n---\n'))).toThrow(/Invalid YAML/);
  });
});

describe('minimal patching', () => {
  it('reports no change, and returns the original text, when nothing differs', () => {
    const p = split(sample);
    const result = applyChanges(p, { fm: { status: 'todo', labels: ['backend'] }, body: bodyOf(p) }, '2026-12-01T00:00:00.000Z');
    expect(result.changed).toBe(false);
    expect(result.text).toBe(sample);
  });

  it('changes one field, keeps comments and body bytes, and stamps updatedAt', () => {
    const p = split(sample);
    const result = applyChanges(p, { fm: { status: 'done' } }, '2026-12-01T00:00:00.000Z');
    expect(result.changed).toBe(true);
    expect(result.text).toContain('# keep this comment');
    expect(result.text).toContain('status: done');
    expect(result.text).toContain('updatedAt: 2026-12-01T00:00:00.000Z');
    expect(result.text.endsWith(p.rest)).toBe(true);
    expect(result.text.indexOf('id: a3f91c2e8b40')).toBeLessThan(result.text.indexOf('status: done'));
  });

  it('removes keys when the value is undefined', () => {
    const p = split(sample.replace('status: todo', 'status: todo\npriority: high'));
    const result = applyChanges(p, { fm: { priority: undefined } }, '2026-12-01T00:00:00.000Z');
    expect(result.text).not.toContain('priority');
  });

  it('replaces the body while keeping the separator line', () => {
    const p = split(sample);
    const result = applyChanges(p, { fm: {}, body: 'New body' }, '2026-12-01T00:00:00.000Z');
    expect(result.text).toContain('---\n\nNew body\n');
    expect(result.text).not.toContain('Implement the authentication service.');
  });

  it('preserves CRLF line endings', () => {
    const crlf = sample.replace(/\n/g, '\r\n');
    const p = split(crlf);
    const result = applyChanges(p, { fm: { status: 'done' } }, '2026-12-01T00:00:00.000Z');
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(result.text.endsWith(p.rest)).toBe(true);
    expect(parseFrontmatter(split(result.text))).toMatchObject({ status: 'done' });
  });

  it('keeps unknown frontmatter keys', () => {
    const p = split(sample.replace('status: todo', 'status: todo\nteamNote: keep me'));
    const result = applyChanges(p, { fm: { status: 'done' } }, '2026-12-01T00:00:00.000Z');
    expect(result.text).toContain('teamNote: keep me');
  });

  it('quotes values that would otherwise be misread', () => {
    const p = split(sample);
    const title = 'Fix: "quotes" & # hashes, and 123';
    const result = applyChanges(p, { fm: { title } }, '2026-12-01T00:00:00.000Z');
    expect(parseFrontmatter(split(result.text)).title).toBe(title);
  });
});

describe('serialising new issues', () => {
  it('writes frontmatter in a stable order followed by the body', () => {
    const text = serializeNewIssue(
      { createdAt: '2026-11-14T10:00:00.000Z', title: 'T', id: 'a3f91c2e8b40', status: 'todo', project: 'AUTH', type: 'story', labels: [] },
      'Body',
    );
    expect(text).toBe(
      '---\nid: a3f91c2e8b40\ntitle: T\nstatus: todo\nproject: AUTH\ntype: story\nlabels: []\ncreatedAt: 2026-11-14T10:00:00.000Z\n---\n\nBody\n',
    );
    const fm = parseFrontmatter(split(text));
    expect(IssueFrontmatterSchema.safeParse(fm).success).toBe(true);
  });
});

describe('frontmatter schema', () => {
  const base = { id: 'a3f91c2e8b40', title: 'T', status: 'todo', project: 'AUTH', createdAt: '2026-11-14T10:00:00Z' };

  it('accepts a minimal issue and applies defaults', () => {
    const result = IssueFrontmatterSchema.parse(base);
    expect(result.type).toBe('story');
    expect(result.labels).toEqual([]);
  });

  it('rejects malformed ids, project keys, priorities and dates', () => {
    expect(IssueFrontmatterSchema.safeParse({ ...base, id: 'A3F91C2E8B40' }).success).toBe(false);
    expect(IssueFrontmatterSchema.safeParse({ ...base, id: 'abc' }).success).toBe(false);
    expect(IssueFrontmatterSchema.safeParse({ ...base, project: 'auth' }).success).toBe(false);
    expect(IssueFrontmatterSchema.safeParse({ ...base, priority: 'critical' }).success).toBe(false);
    expect(IssueFrontmatterSchema.safeParse({ ...base, createdAt: 'yesterday' }).success).toBe(false);
    expect(IssueFrontmatterSchema.safeParse({ ...base, title: '  ' }).success).toBe(false);
  });

  it('passes unknown keys through', () => {
    expect(IssueFrontmatterSchema.parse({ ...base, custom: 1 })).toMatchObject({ custom: 1 });
  });
});

describe('checklists', () => {
  const body = '- [ ] one\n- [x] two\n\n```\n- [ ] in code\n```\n\n* [ ] three\n1. [X] four\n';

  it('finds items outside fenced code', () => {
    expect(checklistOf(body)).toEqual([
      { index: 1, checked: false, text: 'one' },
      { index: 2, checked: true, text: 'two' },
      { index: 3, checked: false, text: 'three' },
      { index: 4, checked: true, text: 'four' },
    ]);
  });

  it('toggles exactly one character', () => {
    const next = setChecklistItem(body, 3, true);
    expect(next).toBe(body.replace('* [ ] three', '* [x] three'));
    expect(setChecklistItem(body, 2, false)).toBe(body.replace('[x] two', '[ ] two'));
    expect(setChecklistItem(body, 9, true)).toBeNull();
  });

  it('works with CRLF text', () => {
    const text = '- [ ] a\r\n- [ ] b\r\n';
    expect(scanChecklist(text)).toHaveLength(2);
    expect(setChecklistItem(text, 2, true)).toBe('- [ ] a\r\n- [x] b\r\n');
  });
});
