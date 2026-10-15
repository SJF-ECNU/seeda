// Compatibility adapter for retained workers that use Node's process IPC API.
// This runs INSIDE the sandbox and is not a security boundary.
import { pathToFileURL } from 'node:url';
const output = process.stdout.write.bind(process.stdout);
const send = message => output(JSON.stringify(message) + '\n');
const pending = new Map();
let sequence = 0;
let verified;
const verification = new Promise(resolve => { verified = resolve; });
Object.defineProperty(process, 'connected', { get: () => true, configurable: true });
process.send = message => { send(message); return true; };
const modelUrl = process.env.DEEPSEEK_BASE_URL + '/chat/completions';
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== modelUrl || options.method !== 'POST' || typeof options.body !== 'string') throw new Error('Sandbox permits only model inference through the host');
  options.signal?.throwIfAborted();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(new DOMException('Cancelled', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, finish: () => options.signal?.removeEventListener('abort', abort) });
    send({ type: 'model', id, body: options.body });
  });
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 8 * 1024 * 1024) process.exit(2);
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.type === 'sandbox_verified') verified();
    else if (message.type === 'model_response') {
      const request = pending.get(message.id); pending.delete(message.id);
      if (!request) continue;
      request.finish();
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(new Response(message.body, { status: message.status }));
    } else process.emit('message', message);
  }
});
process.stdin.on('end', () => { process.emit('disconnect'); process.exit(0); });
const [entry, ...args] = process.argv.slice(2);
process.argv = [process.execPath, entry, ...args];
if (process.env.SEEDA_SANDBOX_VERIFY === '1') { send({ type: 'heartbeat' }); await verification; }
await import(pathToFileURL(entry).href);
