/** Everything the CLI needs from its environment, injected so tests can run it in-process. */
export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  readStdin: () => Promise<string>;
  /** Asks a question on the terminal. Only called when `stdinIsTTY && stdoutIsTTY`. */
  prompt: (question: string) => Promise<string>;
}
