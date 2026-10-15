// Runs outside the sandbox. Only the host can configure this process over IPC.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let child;
let config;
let stopping;
let bytes = 0;
let verification;
const macCleanup = args => new Promise(resolve => {
  const helper = spawn('/usr/bin/python3', [fileURLToPath(new URL('./macos-cleanup.py', import.meta.url)), ...args], { stdio: 'ignore' });
  helper.on('error', () => resolve(false));
  helper.on('close', code => resolve(code === 0));
});
const send = message => { if (process.connected) process.send(message, () => {}); };
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (config?.macCleanup) {
      const cleaned = await macCleanup(config.macCleanup);
      if (!cleaned) {
        if (process.connected) process.send({ type: 'failure', error: 'macOS sandbox cleanup failed' }, () => process.exit(1));
        else process.exit(1);
        return;
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (config?.cleanup) {
      const run = args => new Promise(resolve => {
        const command = spawn(config.cleanup[0], args, { stdio: 'ignore' });
        const timer = setTimeout(() => command.kill('SIGKILL'), 10000);
        command.on('error', () => { clearTimeout(timer); resolve(-1); });
        command.on('close', code => { clearTimeout(timer); resolve(code); });
      });
      const name = config.cleanup.at(-1);
      let removed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await run(config.cleanup.slice(1));
        if (await run(['inspect', name]) !== 0 && await run(['info', '--format', '{{.OSType}}']) === 0) { removed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!removed) {
        if (process.connected) process.send({ type: 'failure', error: 'Sandbox container cleanup failed' }, () => process.exit(1));
        else process.exit(1);
        return;
      }
    }
    if (process.connected) process.send({ type: 'stopped' }, () => process.exit(0));
    else process.exit(0);
  })();
  return stopping;
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', message => {
  if (message.type === 'stop') { void stop(); return; }
  if (message.type === 'input') { if (child?.stdin.writable) child.stdin.write(message.data); return; }
  if (message.type !== 'start' || config || stopping) return;
  config = message;
  child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', data => {
      bytes += data.length;
      if (bytes > 16 * 1024 * 1024) { send({ type: 'failure', error: 'Sandbox output limit exceeded' }); void stop(); }
      else if (config.macCleanup && name === 'stdout') {
        verification ??= macCleanup(['--verify', String(child.pid), ...config.macCleanup]).then(valid => {
          if (valid) child.stdin.write('{"type":"sandbox_verified"}\n');
          return valid;
        });
        void verification.then(valid => {
          if (valid) send({ type: name, data: data.toString('base64') });
          else { send({ type: 'failure', error: 'Cannot verify macOS sandbox process ownership' }); void stop(); }
        });
      } else send({ type: name, data: data.toString('base64') });
    });
  }
  child.on('error', () => { send({ type: 'failure', error: 'Sandbox backend could not start; check its installation and permissions' }); void stop(); });
  child.on(config.macCleanup ? 'exit' : 'close', (code, signal) => { send({ type: 'exit', code, signal }); void stop(); });
  setTimeout(() => { send({ type: 'failure', error: 'Sandbox execution timed out' }); void stop(); }, config.timeoutMs).unref();
});
