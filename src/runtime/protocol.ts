import type { AgentEvent, Message } from '../core/types.ts';
export type WorkerMessage =
  | { type: 'ready'; messages: Message[]; compact?: boolean }
  | { type: 'heartbeat' }
  | { type: 'process'; pid: number; started: boolean }
  | { type: 'event'; event: AgentEvent }
  | { type: 'result'; answer?: string; error?: string }
  | { type: 'management'; id: string; args: Record<string, unknown> };
export type ManagerMessage =
  | { type: 'run'; input: string }
  | { type: 'compact' }
  | { type: 'cancel' | 'stop' }
  | { type: 'management_result'; id: string; result?: unknown; error?: string };
