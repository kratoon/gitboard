import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Thin wrapper so the ranking library is used in exactly one place (ADR-0006). */
export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  return count === 0 ? [] : generateNKeysBetween(before, after, count);
}
