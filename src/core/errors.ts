import { ZodError } from 'zod';

/**
 * Stable error codes. The CLI maps each to an exit code and the HTTP server to a status; both read the
 * single table below, so the two adapters cannot disagree (ADR-9b13ab6).
 */
export const ERROR_TABLE = {
  UNEXPECTED: { exit: 1, http: 500 },
  GIT_FAILED: { exit: 1, http: 500 },
  GIT_MISSING: { exit: 1, http: 500 },
  ID_GENERATION_FAILED: { exit: 1, http: 500 },
  INVALID_INPUT: { exit: 2, http: 400 },
  MISSING_INPUT: { exit: 2, http: 400 },
  AMBIGUOUS_ID: { exit: 2, http: 400 },
  ISSUE_NOT_FOUND: { exit: 3, http: 404 },
  PROJECT_NOT_FOUND: { exit: 3, http: 404 },
  REPO_NOT_FOUND: { exit: 3, http: 404 },
  OPERATION_NOT_FOUND: { exit: 3, http: 404 },
  VALIDATION_FAILED: { exit: 4, http: 422 },
  INVALID_STATUS: { exit: 4, http: 422 },
  INVALID_POSITION: { exit: 4, http: 422 },
  INVALID_REMOTE_URL: { exit: 4, http: 422 },
  INVALID_CONFIG: { exit: 4, http: 422 },
  INVALID_FRONTMATTER: { exit: 4, http: 422 },
  NOT_A_GIT_REPO: { exit: 4, http: 422 },
  BAD_PARENT: { exit: 4, http: 422 },
  DUPLICATE_PROJECT: { exit: 4, http: 409 },
  PROJECT_NOT_EMPTY: { exit: 4, http: 409 },
  HAS_CHILDREN: { exit: 4, http: 409 },
  ORPHANED_STATUS: { exit: 4, http: 409 },
  ALREADY_INITIALIZED: { exit: 4, http: 409 },
  PATH_OUTSIDE_REPO: { exit: 4, http: 403 },
  CONFLICT: { exit: 5, http: 409 },
  SKILL_MODIFIED: { exit: 5, http: 409 },
  NOT_IN_REPO: { exit: 6, http: 404 },
  NOT_INITIALIZED: { exit: 6, http: 409 },
} as const;

export type ErrorCode = keyof typeof ERROR_TABLE;

export class GitboardError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GitboardError';
    this.code = code;
    this.details = details;
  }
}

export function exitCodeFor(code: ErrorCode): number {
  return ERROR_TABLE[code].exit;
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_TABLE[code].http;
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${where}${issue.message}`;
    })
    .join('; ');
}

/** Normalises anything thrown into a GitboardError. */
export function toGitboardError(error: unknown): GitboardError {
  if (error instanceof GitboardError) return error;
  if (error instanceof ZodError) return new GitboardError('INVALID_INPUT', formatZodError(error), error.issues);
  const message = error instanceof Error ? error.message : String(error);
  return new GitboardError('UNEXPECTED', message);
}
