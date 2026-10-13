import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, isAbort, retry, retryDelay } from '../src/model/retry.ts';

const until = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as Error);

test('only transport, throttle and server faults are retryable', () => {
  assert.equal(isRetryable(new Error('Model HTTP error 500')), true);
  assert.equal(isRetryable(new Error('Model HTTP error 502')), true);
  assert.equal(isRetryable(new Error('Model HTTP error 429')), true);
  assert.equal(isRetryable(new Error('Model HTTP error 408')), true);
  assert.equal(isRetryable(new Error('Model stream was interrupted before completion')), true);
  const network = new Error('Model network request failed (ECONNRESET).'); (network as any).cause = { code: 'ECONNRESET' };
  assert.equal(isRetryable(network), true);

  assert.equal(isRetryable(new Error('Model HTTP error 400')), false);
  assert.equal(isRetryable(new Error('Model HTTP error 401')), false);
  assert.equal(isRetryable(new Error('Model HTTP error 404')), false);
  assert.equal(isRetryable(new Error('Tool fragment missing index')), false);
  assert.equal(isRetryable('not an error'), false);
});

test('abort and timeout are distinguished, and abort is never retryable', () => {
  const abort = new Error('aborted'); abort.name = 'AbortError';
  const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
  assert.equal(isAbort(abort), true);
  assert.equal(isRetryable(abort), false);      // user cancellation
  assert.equal(isRetryable(timeout), true);     // a request timeout may clear
  const wrapped = new Error('wrapped') as any; wrapped.cause = { name: 'AbortError' };
  assert.equal(isAbort(wrapped), true);
});

test('backoff grows and stays within the cap', () => {
  assert.ok(retryDelay(1, 100, 1000, () => 0) >= 50);
  assert.ok(retryDelay(1, 100, 1000, () => 1) <= 100);
  assert.equal(retryDelay(10, 100, 1000, () => 1), 1000);
});

test('retry returns on the first success without further calls', async () => {
  let calls = 0;
  const value = await retry(async () => { calls++; return 'done'; }, new AbortController().signal, { baseDelayMs: 1 });
  assert.equal(value, 'done'); assert.equal(calls, 1);
});

test('retry exhausts the attempt budget and rethrows the last error', async () => {
  let calls = 0; const attempts: number[] = [];
  const error = await until(retry(async () => { calls++; throw new Error('Model HTTP error 503'); }, new AbortController().signal,
    { attempts: 3, baseDelayMs: 1, onRetry: info => attempts.push(info.attempt) }));
  assert.equal(calls, 3);
  assert.ok(error);
  assert.equal(error.message, 'Model HTTP error 503');
  assert.deepEqual(attempts, [2, 3]);
});

test('a non-retryable error is raised immediately', async () => {
  let calls = 0;
  const error = await until(retry(async () => { calls++; throw new Error('Model HTTP error 401'); }, new AbortController().signal, { baseDelayMs: 1 }));
  assert.equal(calls, 1); assert.ok(error); assert.equal(error.message, 'Model HTTP error 401');
});

test('an abort during backoff stops retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = retry(async () => { calls++; throw new Error('Model HTTP error 500'); }, controller.signal, { attempts: 5, baseDelayMs: 50 });
  setTimeout(() => controller.abort(), 10);
  await until(promise);
  assert.equal(calls, 1);
});

test('shouldRetry can veto a retry after a side effect', async () => {
  let calls = 0;
  const error = await until(retry(async () => { calls++; throw new Error('Model HTTP error 500'); }, new AbortController().signal,
    { attempts: 5, baseDelayMs: 1, shouldRetry: () => false }));
  assert.equal(calls, 1); assert.ok(error); assert.equal(error.message, 'Model HTTP error 500');
});
