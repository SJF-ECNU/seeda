import { parseArgs, help } from '../cli-arguments.ts';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { projectDirectory, runtimeRoot, libraryRoot } from './paths.ts';
import { readFile } from 'node:fs/promises';
import { safeText } from '../tui/text.ts';
import { selectStrain, SelectionCancelled } from '../strains/select.ts';
import { StrainLibrary } from '../strains/library.ts';
import { fileURLToPath } from 'node:url';
import { VersionStore } from '../versions/store.ts';
import { Supervisor } from './supervisor.ts';
import { RuntimeClient } from './client.ts';

let parsed: ReturnType<typeof parseArgs>;
try { parsed = parseArgs(process.argv.slice(2), true); } catch (error) { console.error(error instanceof Error ? error.message : '参数错误'); process.exit(2); }
if (parsed.kind === 'help') { console.log(help); process.exit(0); }
if (parsed.kind === 'version') { console.log(`seeda ${JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}`); process.exit(0); }
if (parsed.kind !== 'manage') { console.error('管理入口需要控制命令'); process.exit(2); }
const workspace = projectDirectory(process.cwd());
const root = runtimeRoot(workspace);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [command, ...args] = parsed.args!;
try {
if (command === 'strains' || command === 'seed' || command === 'publish') {
  const library = await StrainLibrary.open(libraryRoot());
  try {
    if (command === 'strains') {
      await library.ensureOrigin(source);
      if (args[0] === 'default') { if (!args[1]) throw new Error('Use strains default NAME'); const strain = library.setDefault(args[1]); console.log(process.stdout.isTTY ? safeText(`默认种系已设为 ${strain.name}`) : JSON.stringify(strain, null, 2)); }
      else if (process.stdout.isTTY) console.log(library.list().map(strain => safeText(`${strain.is_default ? '★ ' : '  '}${strain.name}  ${strain.intro?.summary ?? '介绍缺失 · ' + strain.description}  ${strain.id}`).replace(/\n/g, ' ')).join('\n'));
      else console.log(JSON.stringify(library.list(), null, 2));
    }
    else {
      const store = await VersionStore.open(root);
      try {
        if (command === 'publish') {
          if (!args[0]) throw new Error('Use publish <new-strain-name> [version-id]');
          const position = args.indexOf('--intro');
          if (position < 0 || !args[position + 1]) throw new Error('Use publish NAME [VERSION] --intro FILE (summary/improvements/scenarios/limitations/validation JSON)');
          const profile = JSON.parse(await readFile(resolve(args[position + 1]), 'utf8'));
          const version = store.version(position > 1 ? args[1] : store.state().current_version ?? '');
          const strain = await library.publish(args[0], store, version, workspace, profile);
          console.log(process.stdout.isTTY ? safeText(`种系已发布：${strain.name} · ${strain.intro!.summary}`) : JSON.stringify(strain, null, 2));
        } else {
          if (store.state().current_version) throw new Error('Project already seeded; existing versions are retained');
          await library.ensureOrigin(source);
          const selected = args[0] ? library.get(args[0]) : process.stdin.isTTY && process.stdout.isTTY ? await selectStrain(library.list()) : library.defaultStrain();
          store.db.exec('BEGIN IMMEDIATE');
          try {
            if (store.state().current_version) throw new Error('Project already seeded; existing versions are retained');
            if (!args[0] || args[0] === 'origin') await library.ensureOrigin(source);
            const strain = selected;
            const snapshot = await library.checkout(strain);
            let version: import('../versions/store.ts').Version;
            try { version = await store.seed(snapshot.path, { strain_id: strain.id, strain_name: strain.name, strain_commit: strain.git_commit }); } finally { await snapshot.close(); }
            store.db.exec('COMMIT'); console.log(process.stdout.isTTY ? safeText(`项目已播种：${workspace} · ${strain.name}`) : JSON.stringify({ project: workspace, strain, version }, null, 2));
          } catch (error) { store.db.exec('ROLLBACK'); throw error; }
        }
      } finally { store.close(); }
    }
  } finally { library.close(); }
} else if (command === 'init') {
  const store = await VersionStore.open(root);
  try { const source = resolve(args[0] ?? join(dirname(fileURLToPath(import.meta.url)), '../..')); console.log(JSON.stringify(await store.initialize(source), null, 2)); }
  finally { store.close(); }
} else if (command === 'serve' || command === 'auto-serve') {
  const activeWorkspace = projectDirectory(resolve(args[0] ?? workspace));
  const store = await VersionStore.open(runtimeRoot(activeWorkspace)); const supervisor = new Supervisor(store, activeWorkspace);
  try {
    let seed: import('../strains/library.ts').Strain | undefined;
    let snapshot: { path: string; close: () => Promise<void> } | undefined;
    if (command === 'auto-serve' && !store.state().current_version) {
      const library = await StrainLibrary.open(libraryRoot());
      try { await library.ensureOrigin(source); seed = library.defaultStrain(); snapshot = await library.checkout(seed); } finally { library.close(); }
    }
    try { await supervisor.start(snapshot?.path, seed ? { strain_id: seed.id, strain_name: seed.name, strain_commit: seed.git_commit } : undefined); } finally { await snapshot?.close(); } console.log(`seeda supervisor: ${supervisor.socketPath}`);
    process.once('SIGINT', () => { void supervisor.close(); }); process.once('SIGTERM', () => { void supervisor.close(); });
  } catch (error) { await supervisor.close(); store.close(); throw error; }
} else {
  const client = await RuntimeClient.connect(join(root, 'control.sock'));
  try {
    let result: unknown;
    if (command === 'select') result = await client.request('select', { version: args[0] });
    else if (command === 'stop') result = await client.request('stop');
    else {
      const names: Record<string, string[]> = { status: [], draft: [], submit: ['draft', 'reason'], evaluate: ['version', 'task', 'sandbox'], evidence: ['evaluation'], decide: ['evaluation', 'decision', 'reason'], promote: ['version', 'evaluation', 'reason'], rollback: ['reason'] };
      if (!names[command]) throw new Error('Use strains, seed, publish, init, serve, status, draft, submit, evaluate, evidence, decide, promote, rollback, select or stop');
      result = await client.request('manage', { operation: command, ...Object.fromEntries(names[command].filter((_, index) => args[index] !== undefined).map((name, index) => [name, args[index]])) });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { client.close(); }
}

} catch (error) {
  console.error(error instanceof Error ? error.message : '命令失败'); process.exitCode = error instanceof SelectionCancelled ? 130 : 1;
}
