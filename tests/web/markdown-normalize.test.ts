import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from '../../src/web/markdown-normalize';

describe('normalizeMarkdown', () => {
  it('adds a blank line before a list that continues its numbering under a paragraph', () => {
    expect(normalizeMarkdown('**Credentials**\n8. One\n9. Two')).toBe('**Credentials**\n\n8. One\n9. Two');
  });

  it('leaves lists that already follow a blank line or a list alone', () => {
    const src = '**A**\n\n1. One\n2. Two\n\ntext\n\n- a\n- b';
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it('does not touch fenced code', () => {
    const src = '```\ntext\n8. not a list\n```';
    expect(normalizeMarkdown(src)).toBe(src);
  });

  it('does not touch a wrapped paragraph line that merely starts with a number', () => {
    expect(normalizeMarkdown('Intro\nmore')).toBe('Intro\nmore');
  });
});
