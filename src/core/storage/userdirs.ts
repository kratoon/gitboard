/**
 * User-level directories (ADR-9d88632, ADR-9b39f45). Together with the repo resolver and git runner, this is
 * one of the few places in core that reads ambient process state.
 */
import os from 'node:os';
import path from 'node:path';

export interface UserDirs {
  /** Registry and user defaults. */
  config: string;
  /** Managed clones live under `<data>/repos`. */
  data: string;
}

/** `GITBOARD_HOME` overrides everything (used by tests). */
export function userDirs(env: NodeJS.ProcessEnv = process.env): UserDirs {
  const override = env.GITBOARD_HOME;
  if (override) {
    return { config: path.join(override, 'config'), data: path.join(override, 'data') };
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roaming = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return { config: path.join(roaming, 'gitboard'), data: path.join(local, 'gitboard') };
  }
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return { config: path.join(configHome, 'gitboard'), data: path.join(home, '.gitboard') };
}

/** The home directory used for global (user-level) skill installs. */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITBOARD_USER_HOME ?? os.homedir();
}
