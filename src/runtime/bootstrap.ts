import { spawn } from 'node:child_process';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectDirectory, runtimeRoot } from './paths.ts';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './client.ts';

export async function connectRuntime(cwd: string): Promise<RuntimeClient> {
  const root = runtimeRoot(cwd);
  const socket = join(root, 'control.sock'); const workspace = projectDirectory(cwd);
  let observed = false;
  const existing = async (): Promise<RuntimeClient | undefined> => {
    let client: RuntimeClient;
    try { client = await RuntimeClient.connect(socket); }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
    observed = true;
    try {
      let timer: NodeJS.Timeout | undefined;
      const state = await Promise.race([
        client.request('manage', { operation: 'status' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Supervisor control channel did not respond')), 2000); }),
      ]).finally(() => { if (timer) clearTimeout(timer); }) as { cwd: string; phase: string };
      if (state.cwd !== workspace) throw new Error('Supervisor belongs to a different project. Use a separate SEEDA_HOME for this project.');
      if (state.phase === 'failed') throw new Error(`Supervisor could not start its Agent. Check startup logs in ${root}.`);
      if (state.phase === 'running') return client;
      client.close(); return undefined;
    } catch (error) { client.close(); throw error; }
  };
  const connected = await existing(); if (connected) return connected;
  if (!observed && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required to start the managed Agent');
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const log = join(root, `startup-${process.pid}-${Date.now()}.log`);
  let exited = false; let spawnError: Error | undefined;
  if (!observed) {
    const descriptor = openSync(log, 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types', join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'auto-serve', workspace], {
        cwd: workspace, detached: true, env: { ...process.env, SEEDA_HOME: root }, stdio: ['ignore', descriptor, descriptor],
      });
      child.on('error', error => { spawnError = error; }); child.on('exit', () => { exited = true; }); child.unref();
    } finally { closeSync(descriptor); }
  }
  const deadline = Date.now() + 165_000;
  while (Date.now() < deadline) {
    const client = await existing(); if (client) return client;
    if (spawnError) throw new Error(`Could not launch supervisor: ${spawnError.message}`);
    if (exited) {
      const output = await readFile(log, 'utf8');
      // A simultaneous launcher may lose SQLite ownership; connect to its winning peer.
      if (!/database is locked|Supervisor is already running/.test(output)) throw new Error(`Automatic supervisor startup failed. See ${log}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the managed Agent. See ${log}`);
}
