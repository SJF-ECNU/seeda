import { readFile } from 'node:fs/promises';

export async function sessionMetrics(path: string) {
  const records = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const observations = records.filter(row => row.type === 'runtime').map(row => row.observation);
  const models = observations.filter(row => row.kind === 'model');
  const tools = observations.filter(row => row.kind === 'tool');
  const usage = models.filter(row => row.usage).reduce((sum, row) => {
    for (const key of Object.keys(sum)) sum[key] += row.usage[key] ?? 0;
    return sum;
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0 });
  return {
    path, scope: 'cumulative_session', requests: records.filter(row => row.type === 'request'),
    instructions: records.filter(row => row.type === 'instructions'),
    ends: records.filter(row => row.type === 'end'),
    model_calls: models.length, tool_calls: tools.length,
    tool_failures: tools.filter(row => row.status !== 'completed').length,
    model_duration_ms: models.reduce((sum, row) => sum + row.durationMs, 0),
    tool_duration_ms: tools.reduce((sum, row) => sum + row.durationMs, 0),
    missing_usage: models.filter(row => !row.usage).length,
    observed_usage: models.some(row => row.usage) ? usage : null,
    recording_complete: !records.some(row => row.recordingComplete === false),
    accounting_note: 'Native model calls may contain HTTP retries; external proxy attempts are authoritative. Durations may overlap and are not wall time.',
  };
}
