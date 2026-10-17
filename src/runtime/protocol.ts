import type { AgentEvent, Message } from '../core/types.ts';
export type WorkerMessage =
  | { type: 'ready'; messages: Message[]; compact?: boolean; commandExecution?: boolean; resume?: boolean }
  | { type: 'heartbeat' }
  | { type: 'process'; pid: number; started: boolean }
  | { type: 'event'; event: AgentEvent }
  | { type: 'result'; answer?: string; error?: string }
  | { type: 'command'; id: string; args: unknown }
  | { type: 'command_cancel'; id: string }
  | { type: 'management'; id: string; args: Record<string, unknown> };
export type ManagerMessage =
  | { type: 'run'; input: string; resume?: { userCountBefore: number } }
  | { type: 'compact' }
  | { type: 'cancel' | 'stop' }
  | { type: 'command_result'; id: string; result?: unknown; error?: string }
  | { type: 'management_result'; id: string; result?: unknown; error?: string };
