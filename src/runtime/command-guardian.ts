// Host-owned command lifetime. A dead supervisor cannot run its finally blocks;
// this child remains responsible for aborting and reaping its own command.
import { BashTool } from '../tools/bash.ts';
import { commandExecutor, type ExecutionEnvironment } from './execution.ts';

const controller = new AbortController();
let active: Promise<void> | undefined;
process.on('disconnect', () => { controller.abort(); if (!active) process.exit(0); });
process.on('SIGTERM', () => { controller.abort(); if (!active) process.exit(0); });
process.on('message', (message: { type: string; environment: ExecutionEnvironment; args: unknown; cwd: string; artifacts: string }) => {
  if (message.type === 'cancel') { controller.abort(); return; }
  if (message.type !== 'execute' || active) return;
  active = (async () => {
    let response: { result?: unknown; error?: string };
    try {
      const tool = new BashTool(16_384, undefined, commandExecutor(message.environment));
      response = { result: await tool.execute(message.args, { cwd: message.cwd, artifactDir: message.artifacts, signal: controller.signal }) };
    } catch { response = { error: 'Command execution failed or parameters were invalid' }; }
    if (process.connected) process.send?.(response, () => { process.disconnect(); });
  })().finally(() => { if (!process.connected) process.exit(0); });
});
