import { runtime } from '../runtime';

/** A 12-character lowercase hex ID from 6 cryptographically secure random bytes (ADR-30abf7d). */
export function generateId(): string {
  return runtime().randomBytes(6).toString('hex');
}

/** Shortest unique prefix length (minimum 7) for every id, used for display issue keys (ADR-18de7e0). */
export function shortPrefixLengths(ids: string[]): Map<string, number> {
  const sorted = [...ids].sort();
  const lengths = new Map<string, number>();
  const common = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  sorted.forEach((id, i) => {
    const before = i > 0 ? common(id, sorted[i - 1] ?? '') : 0;
    const after = i < sorted.length - 1 ? common(id, sorted[i + 1] ?? '') : 0;
    lengths.set(id, Math.min(id.length, Math.max(7, Math.max(before, after) + 1)));
  });
  return lengths;
}
