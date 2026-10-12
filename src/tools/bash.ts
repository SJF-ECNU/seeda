import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '../core/types.ts';

export class BashTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'bash', description: 'Run a non-interactive Bash command. Each call has a fresh shell; cwd defaults to the project directory.',
      parameters: { type: 'object', properties: {
        command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number', description: 'Seconds, default 30' },
      }, required: ['command'], additionalProperties: false },
    },
  };
  private readonly maxOutputBytes: number;
  private readonly onProcess?: (pid: number, started: boolean) => void;
  constructor(maxOutputBytes = 16_384, onProcess?: (pid: number, started: boolean) => void) { this.maxOutputBytes = maxOutputBytes; this.onProcess = onProcess; }
  async execute(args: unknown, context: ToolContext): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Bash parameters must be an object');
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !['command', 'cwd', 'timeout'].includes(key)) ||
      typeof input.command !== 'string' || !input.command.trim() ||
      (input.cwd !== undefined && typeof input.cwd !== 'string') ||
      (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 3600))) {
      throw new Error('Invalid Bash parameters');
    }
    context.signal.throwIfAborted();
    await mkdir(context.artifactDir, { recursive: true, mode: 0o700 });
    const outputPath = join(context.artifactDir, `bash-${randomUUID()}.log`);
    const log = createWriteStream(outputPath, { mode: 0o600 });
    const logDone = finished(log);
    // Catch immediately to avoid an unhandled rejection if the disk fails while running.
    void logDone.catch(() => {});
    const started = Date.now();
    let visible = Buffer.alloc(0);
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let failure: string | undefined;
    const child = spawn('bash', ['--noprofile', '--norc', '-c', input.command], {
      cwd: resolve(context.cwd, (input.cwd as string | undefined) ?? '.'),
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) this.onProcess?.(child.pid, true);
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const onAbort = () => { cancelled = true; kill(); };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (visible.length < this.maxOutputBytes) visible = Buffer.concat([visible, chunk.subarray(0, this.maxOutputBytes - visible.length)]);
      if (!log.write(chunk)) { child.stdout.pause(); child.stderr.pause(); }
    };
    log.on('drain', () => { child.stdout.resume(); child.stderr.resume(); });
    log.on('error', () => { failure = 'Cannot save tool output'; kill(); });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    // Background descendants are unsupported; clean them when the shell exits.
    child.on('exit', () => { kill(); if (child.pid) this.onProcess?.(child.pid, false); });
    const timer = setTimeout(() => { timedOut = true; kill(); }, Number(input.timeout ?? 30) * 1000);
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
        child.on('error', () => { failure = 'Could not start Bash in the requested directory'; });
        child.on('close', (code, signal) => resolveExit({ code, signal }));
      });
      log.end();
      await logDone;
      return {
        output: visible.toString('utf8'), exit_code: exit.code, signal: exit.signal,
        status: failure ? 'failed' : cancelled ? 'cancelled' : timedOut ? 'timed_out' : exit.code === 0 ? 'completed' : 'failed',
        ...(failure ? { error: failure } : {}), truncated: bytes > this.maxOutputBytes,
        ...(bytes > this.maxOutputBytes ? { full_output_path: outputPath } : {}),
        wall_time_seconds: (Date.now() - started) / 1000,
      };
    } finally {
      clearTimeout(timer); context.signal.removeEventListener('abort', onAbort);
      if (!log.writableEnded) log.end();
    }
  }
}
