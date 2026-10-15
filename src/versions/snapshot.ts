import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const snapshotFiles = ['src', 'tests', '.agents', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json'];
const external = ['src/cli.ts', 'src/cli-arguments.ts', 'src/tui', 'src/versions', 'src/strains', 'src/sandbox', 'bin', 'scripts'];

export async function agentOnly(path: string): Promise<void> {
  for (const file of external) await rm(join(path, file), { recursive: true, force: true });
  for (const file of await readdir(join(path, 'src/runtime'))) {
    if (!['worker.ts', 'protocol.ts'].includes(file)) await rm(join(path, 'src/runtime', file), { recursive: true, force: true });
  }
  // Host integration tests stay with the installation that owns those modules.
  const filterTests = async (directory: string): Promise<void> => {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, file.name);
      if (file.isDirectory()) { await filterTests(target); continue; }
      if (!file.name.endsWith('.ts')) continue;
      const source = await readFile(target, 'utf8');
      if (/src\/(?:tui|versions|strains|runtime|sandbox|cli)|exec\(['"]seeda['"]/.test(source)) await rm(target);
    }
  };
  await filterTests(join(path, 'tests'));
  const manifestPath = join(path, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name === 'seeda') manifest.name = 'seeda-agent';
  delete manifest.bin;
  for (const name of Object.keys(manifest.scripts ?? {})) {
    if (!['check', 'test'].includes(name)) delete manifest.scripts[name];
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
export async function copyAgent(source: string, target: string): Promise<void> {
  for (const file of snapshotFiles) {
    await rm(join(target, file), { recursive: true, force: true });
    await cp(join(source, file), join(target, file), { recursive: true });
  }
  await agentOnly(target);
}
