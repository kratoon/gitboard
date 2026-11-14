import { randomBytes } from 'node:crypto';

/**
 * The only sources of nondeterminism in core: the clock and the random generator. Tests replace them
 * through `setRuntime` so CLI, HTTP and core runs can be compared byte for byte.
 */
export interface Runtime {
  now: () => Date;
  randomBytes: (size: number) => Buffer;
}

const defaults: Runtime = {
  now: () => new Date(),
  randomBytes: (size) => randomBytes(size),
};

let current: Runtime = defaults;

export function runtime(): Runtime {
  return current;
}

export function setRuntime(overrides: Partial<Runtime>): void {
  current = { ...current, ...overrides };
}

export function resetRuntime(): void {
  current = defaults;
}

export function nowIso(): string {
  return current.now().toISOString();
}
