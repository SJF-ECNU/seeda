import { cp, lstat, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const snapshotFiles = ['src', 'tests', '.agents', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'bin', 'scripts'];

export function snapshotPath(name: string): boolean {
  return !name.startsWith('/') && !/[\x00-\x1f\x7f\\]/.test(name) && snapshotFiles.includes(name.split('/')[0]) &&
    !name.split('/').some(part => part === '..' || ['.git', '.seeda', '.ssh', '.aws', '.npmrc', '.netrc', 'node_modules'].includes(part) ||
      part === '.env' || part.startsWith('.env.') || /^state\.db(?:-|$)/.test(part));
}

export async function snapshotEntries(root: string): Promise<string[]> {
  const names = await readdir(root);
  return snapshotFiles.filter(name => names.includes(name));
}

export async function stageSnapshot(root: string): Promise<void> {
  const files: string[] = [];
  const visit = async (name: string): Promise<void> => {
    if (!snapshotPath(name)) return;
    const info = await lstat(join(root, name));
    if (info.isDirectory()) { for (const child of await readdir(join(root, name))) await visit(`${name}/${child}`); }
    else if (info.isFile()) files.push(name);
    else throw new Error(`Unsupported implementation file: ${name}`);
  };
  for (const name of await snapshotEntries(root)) await visit(name);
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { maxBuffer: 4_000_000 })).stdout;
  const tracked = (await git('ls-files', '-z')).split('\0').filter(snapshotPath);
  const paths = [...new Set([...tracked, ...files])];
  if (paths.length) await git('add', '--', ...paths.map(path => `:(literal)${path}`));
  const staged = (await git('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
  if (staged.some(path => !snapshotPath(path))) throw new Error('Staged files outside the implementation snapshot');
}

export async function copyAgent(source: string, target: string): Promise<void> {
  const entries = await snapshotEntries(source);
  for (const file of snapshotFiles) {
    await rm(join(target, file), { recursive: true, force: true });
    if (entries.includes(file)) await cp(join(source, file), join(target, file), {
      recursive: true, filter: path => snapshotPath(relative(source, path)),
    });
  }
}
