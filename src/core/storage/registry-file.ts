/** Reads and writes the user-level registry file and prepares managed clone directories (ADR-0008). */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './fs-safe';
import { userDirs } from './userdirs';

export function registryPath(): string {
  return path.join(userDirs().config, 'repos.json');
}

export async function readRegistryText(): Promise<string | null> {
  try {
    return await readFile(registryPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRegistryText(text: string): Promise<void> {
  const file = registryPath();
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, text);
}

export function managedReposDir(): string {
  return path.join(userDirs().data, 'repos');
}

/** An empty directory used as `core.hooksPath` so cloning never runs hooks (ADR-0005). */
export async function emptyHooksDir(): Promise<string> {
  const dir = path.join(userDirs().data, 'no-hooks');
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
