import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../src/core/agent.ts';
import { Session } from '../src/core/session.ts';
import type { AgentEvent, ModelResponse, Tool } from '../src/core/types.ts';

for (const mode of ['batch', 'incomplete', 'ordinary', 'truncated'] as const) {
  test(`handover boundary: ${mode}`, async t => {
    const root = await mkdtemp('/tmp/seeda-handover-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'session.jsonl'), session = await Session.open(path, root);
    const events: AgentEvent[] = [], effects: number[] = [];
    let calls = 0, wantsYield = mode !== 'ordinary';
    const tool: Tool = {
      definition: { type: 'function', function: { name: 'effect', description: 'record effect', parameters: { type: 'object' } } },
      execute: async args => {
        effects.push((args as { value: number }).value);
        if (mode === 'incomplete') session.runtime.recordingComplete = false;
        return { status: 'completed', effect: effects.at(-1) };
      },
    };
    const batch: ModelResponse = { message: { role: 'assistant', content: null, tool_calls: [1, 2].map(value => ({ id: `effect-${value}`, type: 'function', function: { name: 'effect', arguments: JSON.stringify({ value }) } })) }, finishReason: 'tool_calls' };
    const agent = new Agent({ cwd: root, artifactDir: root, session, tools: [tool], onEvent: e => events.push(e), shouldYield: () => wantsYield, model: { complete: async () => {
      calls++;
      if (calls === 1) return mode === 'truncated' ? { ...batch, finishReason: 'length', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, promptCacheHitTokens: 0, promptCacheMissTokens: 1 } } : batch;
      return { message: { role: 'assistant', content: 'finished' }, finishReason: 'stop' };
    } } });
    if (mode === 'incomplete') await assert.rejects(agent.run('work'), /incomplete execution records/);
    else assert.equal(await agent.run('work'), mode === 'batch' ? '' : 'finished');
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (mode === 'batch') {
      assert.equal(calls, 1);
      assert.deepEqual(effects, [1, 2]);
      assert.deepEqual(records.filter(r => r.type === 'message' && r.message.role === 'tool').map(r => r.message.tool_call_id), ['effect-1', 'effect-2']);
      assert.equal(records.at(-1).status, 'yielded');
      assert.equal(events.filter(e => e.type === 'end').length, 0);
      // The existing resume path consumes completed results without another user or side effect.
      wantsYield = false;
      assert.equal(await agent.run('work', { userCountBefore: 0 }), 'finished');
      assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
      assert.deepEqual(effects, [1, 2]);
    } else if (mode === 'incomplete') {
      assert.equal(calls, 1);
      assert.equal(records.at(-1).status, 'failed');
      assert.equal(records.some(r => r.status === 'yielded'), false);
      assert.equal(events.filter(e => e.type === 'end').length, 1);
    } else {
      assert.equal(calls, 2, 'no reflection or extra model request');
      assert.deepEqual(effects, mode === 'truncated' ? [] : [1, 2]);
      assert.equal(records.some(r => r.status === 'yielded'), false);
      assert.equal(events.filter(e => e.type === 'end').length, 1);
      if (mode === 'truncated') assert.equal(session.messages.some(m => m.tool_calls), false);
    }
  });
}
