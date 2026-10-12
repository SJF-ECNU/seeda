import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function projectDirectory(cwd: string): string {
  const initial = realpathSync(cwd);
  for (let directory = initial; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.seeda/runtime/state.db')) || existsSync(join(directory, '.git'))) return directory;
    if (directory === dirname(directory)) return initial;
  }
}
export function runtimeRoot(cwd: string): string {
  return resolve(process.env.SEEDA_HOME ?? join(projectDirectory(cwd), '.seeda/runtime'));
}
export function libraryRoot(): string {
  return resolve(process.env.SEEDA_LIBRARY ?? join(homedir(), '.local/share/seeda/strains-library'));
}
