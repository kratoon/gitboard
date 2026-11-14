/**
 * `gitboard start`: the one CLI command that needs the HTTP server. It is also the only CLI file allowed
 * to import the server (see eslint.config.js); it only launches it and never calls server internals.
 */
import { execFile } from 'node:child_process';
import type { Command } from 'commander';
import { GitboardError } from '../../core';
import { startServer } from '../../server';
import type { CliIo } from '../io';
import type { CliState } from '../program';

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command, args, { windowsHide: true }, () => undefined); // best effort
}

export function registerStart(program: Command, io: CliIo, state: CliState): void {
  program
    .command('start')
    .description('Start the local web UI (binds to 127.0.0.1 only)')
    .option('--port <port>', 'port to listen on', '4317')
    .option('--no-open', 'do not open a browser')
    .action(async (opts) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new GitboardError('INVALID_INPUT', `Invalid port: ${opts.port}`);
      }
      const server = await startServer({ port });
      if (state.json) io.out(`${JSON.stringify({ ok: true, data: { url: server.url } })}\n`);
      else io.out(`Gitboard is running at ${server.url}\nPress Ctrl+C to stop.\n`);
      if (opts.open && !state.json) openBrowser(server.url);

      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      await server.close();
    });
}
