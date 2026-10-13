// Bounded retry policy for model requests.
//
// A single transient failure (a dropped connection, a 429/5xx, a truncated SSE
// stream) must not end an agent request. The policy is deliberately narrow:
// only failures that a retry can plausibly clear are retried, and a caller's
// cancellation is never retried.

export function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const name = (error as { cause?: { name?: unknown } })?.cause?.name;
  return name === 'AbortError';
}

// Retryable: transport failures, provider throttling, transient server faults,
// and streams that were cut off before a terminal event. A 4xx such as 401/404
// means the request itself is wrong, so retrying cannot help.
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false;
  if (error.name === 'TimeoutError') return true;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return true;
  const http = error.message.match(/^Model HTTP error (\d{3})$/);
  if (http) {
    const status = Number(http[1]);
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return error.message === 'Model stream was interrupted before completion' ||
    error.message === 'Model returned a stream error';
}

// Exponential backoff with bounded jitter so parallel retries do not synchronise.
export function retryDelay(attempt: number, baseMs = 500, maxMs = 8000, random = Math.random): number {
  const window = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(window / 2 + random() * window / 2);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(signal.reason); }
  signal.addEventListener('abort', onAbort, { once: true });
});

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  // Extra gate for callers that must not retry after a side effect, such as
  // text already streamed to a UI.
  shouldRetry?: (error: unknown) => boolean;
}

// Run `operation` until it succeeds, the budget is exhausted, or the signal is
// aborted. The final error is rethrown unchanged so callers keep their contract.
export async function retry<T>(operation: (attempt: number) => Promise<T>, signal: AbortSignal, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (signal.aborted || isAbort(error) || !isRetryable(error) || attempt === attempts ||
        options.shouldRetry?.(error) === false) throw error;
      const delayMs = retryDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: error instanceof Error ? error : new Error(String(error)) });
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}
