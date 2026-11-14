/**
 * Request guards for the local server (ADR-0005). The server has no authentication and can modify
 * local files, so it must refuse anything that did not come from its own page on localhost.
 */
import type { IncomingMessage } from 'node:http';

export interface Rejection {
  status: number;
  message: string;
}

export function allowedHosts(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

/** Returns a rejection, or null if the request is acceptable. */
export function checkRequest(req: IncomingMessage, port: number): Rejection | null {
  const hosts = allowedHosts(port);

  // DNS rebinding: a hostile name that resolves to 127.0.0.1 still carries its own Host header.
  const host = req.headers.host;
  if (host === undefined || !hosts.includes(host.toLowerCase())) {
    return { status: 403, message: 'Forbidden: unexpected Host header.' };
  }

  const method = req.method ?? 'GET';
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];

  if (origin !== undefined) {
    const sameOrigin = hosts.some((h) => origin.toLowerCase() === `http://${h}`);
    if (!sameOrigin) return { status: 403, message: 'Forbidden: cross-origin request.' };
  } else if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { status: 403, message: 'Forbidden: cross-site request.' };
  }

  if (method === 'POST') {
    // Requiring JSON forces cross-origin callers through a CORS preflight, which we never grant.
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      return { status: 415, message: 'Unsupported Media Type: send application/json.' };
    }
  }
  return null;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
