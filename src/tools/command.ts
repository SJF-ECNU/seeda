import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../core/types.ts';

export interface CommandInput { command: string; cwd?: string; timeout?: number; }
export type CommandExecutor = (input: CommandInput, context: ToolContext) => Promise<unknown>;
export interface CommandInvocation {
  program: string;
  args: string[];
  cwd: string;
  environment: { kind: 'local' | 'docker'; cwd: string; container?: string };
  cleanup?: () => Promise<void>;
  artifactLocation?: 'host' | 'execution';
}

export function localCommand(maxOutputBytes: number, onProcess?: (pid: number, started: boolean) => void): CommandExecutor {
  return (input, context) => {
    const cwd = resolve(context.cwd, input.cwd ?? '.');
    return runCommand(input, context, { program: 'bash', args: ['--noprofile', '--norc', '-c', input.command], cwd, environment: { kind: 'local', cwd } }, maxOutputBytes, onProcess);
  };
}

export async function runCommand(input: CommandInput, context: ToolContext, invocation: CommandInvocation, maxOutputBytes = 16_384, onProcess?: (pid: number, started: boolean) => void): Promise<unknown> {
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
  let errorCode: string | undefined;
  const child = spawn(invocation.program, invocation.args, {
    cwd: invocation.cwd,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) onProcess?.(child.pid, true);
  const kill = () => {
    if (!child.pid || child.pid <= 1) return;
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        failure = `Cannot terminate Bash process group (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`;
        try { child.kill('SIGKILL'); } catch { /* Report the cleanup failure without crashing the Agent. */ }
      }
    }
  };
  const onAbort = () => { cancelled = true; kill(); };
  const onData = (chunk: Buffer) => {
    bytes += chunk.length;
    if (visible.length < maxOutputBytes) visible = Buffer.concat([visible, chunk.subarray(0, maxOutputBytes - visible.length)]);
    if (!log.write(chunk)) { child.stdout.pause(); child.stderr.pause(); }
  };
  log.on('drain', () => { child.stdout.resume(); child.stderr.resume(); });
  log.on('error', () => { failure = 'Cannot save tool output'; kill(); });
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  // Background descendants are unsupported; clean them when the shell exits.
  child.on('exit', () => { kill(); if (child.pid) onProcess?.(child.pid, false); });
  const timer = setTimeout(() => { timedOut = true; kill(); }, Number(input.timeout ?? 30) * 1000);
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
      child.on('error', error => { failure = 'Could not start command in the requested environment'; errorCode = (error as NodeJS.ErrnoException).code; });
      child.on('close', (code, signal) => resolveExit({ code, signal }));
    });
    if (invocation.cleanup) {
      try { await invocation.cleanup(); } catch { failure = 'Command environment cleanup failed'; }
    }
    log.end();
    await logDone;
    return {
      output: visible.toString('utf8'), exit_code: exit.code, signal: exit.signal,
      status: failure ? 'failed' : cancelled ? 'cancelled' : timedOut ? 'timed_out' : exit.code === 0 ? 'completed' : 'failed',
      ...(failure ? { error: failure } : {}), ...(errorCode ? { error_code: errorCode } : {}), truncated: bytes > maxOutputBytes,
      ...(bytes > maxOutputBytes ? { full_output_path: outputPath } : {}),
      environment: invocation.environment,
      ...(bytes > maxOutputBytes ? { artifact_location: invocation.artifactLocation ?? 'execution' } : {}),
      wall_time_seconds: (Date.now() - started) / 1000,
    };
  } finally {
    clearTimeout(timer); context.signal.removeEventListener('abort', onAbort);
    if (!log.writableEnded) log.end();
  }
}
