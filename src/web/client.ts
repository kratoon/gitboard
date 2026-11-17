/**
 * The only thing the UI knows about its backend (FEAT-054ad75). Everything else is built on `call` and
 * `subscribe`, so a future deployment could supply a different implementation.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export interface CallResult<T> {
  data: T;
  warnings: string[];
}

export interface GitboardClient {
  /** Runs an operation. Repository operations pass the registered repository id. */
  call<T>(operation: string, input: unknown, repoId?: string): Promise<CallResult<T>>;
  /** Calls `onChange` whenever files in the repository change on disk. Returns an unsubscribe function. */
  subscribe(repoId: string, onChange: () => void): () => void;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: { code: string; message: string; details?: unknown };
}

export function createHttpClient(base = ''): GitboardClient {
  return {
    async call<T>(operation: string, input: unknown, repoId?: string): Promise<CallResult<T>> {
      const url = repoId === undefined ? `${base}/api/ops/${operation}` : `${base}/api/repos/${encodeURIComponent(repoId)}/ops/${operation}`;
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input ?? {}) });
      } catch {
        throw new ApiError('NETWORK', 'Cannot reach the Gitboard server. Is `gitboard start` still running?');
      }
      let envelope: Envelope<T>;
      try {
        envelope = (await response.json()) as Envelope<T>;
      } catch {
        throw new ApiError('BAD_RESPONSE', `Unexpected response from the server (${response.status}).`);
      }
      if (!envelope.ok || envelope.data === undefined) {
        const error = envelope.error ?? { code: 'UNKNOWN', message: 'Unknown error.' };
        throw new ApiError(error.code, error.message, error.details);
      }
      return { data: envelope.data, warnings: envelope.warnings ?? [] };
    },

    subscribe(repoId, onChange) {
      const source = new EventSource(`${base}/api/repos/${encodeURIComponent(repoId)}/events`);
      source.addEventListener('change', onChange);
      return () => source.close();
    },
  };
}
