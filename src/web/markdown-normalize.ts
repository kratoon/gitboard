const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * CommonMark only lets a list interrupt a paragraph when it starts at 1 (or is a bullet), so a numbered list
 * that continues its numbering (8., 9., ...) directly under a line of text is folded into that paragraph.
 * Insert the missing blank line before the first item of such a list. Fenced code is left untouched.
 */
export function normalizeMarkdown(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let prevIsText = false;
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      out.push(line);
      prevIsText = false;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? null;
      out.push(line);
      prevIsText = false;
      continue;
    }
    const isItem = LIST_ITEM.test(line);
    if (isItem && prevIsText) out.push('');
    out.push(line);
    // List items, blank lines, quotes, headings, tables and indented lines do not start a paragraph we care about.
    prevIsText = line.trim() !== '' && !isItem && !/^(\s{4,}|\s*[>#|])/.test(line);
  }
  return out.join('\n');
}
