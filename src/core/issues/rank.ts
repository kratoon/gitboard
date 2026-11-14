import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { Priority } from '../types';

/** Thin wrapper so the ranking library is used in exactly one place (ADR-0006). */
export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  return count === 0 ? [] : generateNKeysBetween(before, after, count);
}

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // same alphabet as the ranks
const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
const TIME_DIGITS = 7; // 62^7 milliseconds reaches the year 2080

function toBase62(value: number, width: number): string {
  let rest = Math.max(0, Math.floor(value));
  let out = '';
  for (let i = 0; i < width; i++) {
    out = DIGITS.charAt(rest % 62) + out;
    rest = Math.floor(rest / 62);
  }
  return rest > 0 ? DIGITS.charAt(61).repeat(width) : out; // clamp instead of overflowing
}

/**
 * The sort key of a card that has no `rank`. It is a valid rank in its own right (a head character, an
 * 8-digit integer part, then a fractional tail), and it sorts exactly like "priority (highest first), then
 * creation time, then id". Because ranked and unranked cards share this one scale, a card can be placed
 * between any two neighbours by choosing a rank between their keys, without ever writing to the neighbours
 * (ADR-0006). Explicit ranks written by older versions (`a0`, `a1`, ...) sort before every such key, which is
 * where ranked cards always were.
 */
export function implicitKey(priority: Priority | undefined, createdAt: string, id: string): string {
  const weight = PRIORITY_WEIGHT[priority ?? 'medium'];
  const time = Date.parse(createdAt);
  // Ids are lowercase hex, which are base-62 digits in the same order; a rank may not end in "0".
  return `h${3 - weight}${toBase62(Number.isFinite(time) ? time : 0, TIME_DIGITS)}${id.replace(/0+$/, '')}`;
}
