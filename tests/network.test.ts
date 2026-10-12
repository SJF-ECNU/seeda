import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProxyEnvironment, systemProxyEnvironment, networkError } from '../src/model/network.ts';
test('network uses explicit proxy first and converts macOS static proxy exceptions', async () => {
  const explicit = { HTTPS_PROXY: 'http://127.0.0.1:1234' };
  assert.equal(await resolveProxyEnvironment(explicit, 'darwin', async () => { throw new Error('must not query'); }), explicit);
  const source = 'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\nExceptionsList : <array> {\n 0 : 10.0.0.0/8\n 1 : *.local\n}';
  const proxy = systemProxyEnvironment(source, {});
  assert.equal(proxy?.HTTPS_PROXY, 'http://127.0.0.1:7890'); assert.match(proxy!.NO_PROXY!, /10.0.0.0-10.255.255.255/);
  assert.equal(await resolveProxyEnvironment({ SEEDA_SYSTEM_PROXY: '0' }, 'darwin', async () => source), undefined);
  assert.equal(await resolveProxyEnvironment({}, 'linux', async () => source), undefined);
  const cancelled = new DOMException('cancelled', 'AbortError'); assert.equal(networkError(cancelled), cancelled);
  assert.match(networkError({ cause: { code: 'ECONNREFUSED' } }).message, /ECONNREFUSED/);
  assert.equal(networkError({ cause: { code: 'secret-body' } }).message.includes('secret-body'), false);
});

test('CLI native fetch actually uses an explicit local HTTP proxy', { timeout: 10000 }, async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-proxy-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  let requested = '';
  const proxy = createServer((req, res) => {
    requested = req.url ?? ''; res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: '+JSON.stringify({ choices: [{ delta: { content: 'proxy confirmed' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
  });
  proxy.on('connect', (req, socket) => {
    requested = req.url ?? '';
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      const body = 'data: '+JSON.stringify({ choices: [{ delta: { content: 'proxy confirmed' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n';
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); }); const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), 'run', 'hello'], { cwd, env: { ...process.env, SEEDA_MANAGED: '0', DEEPSEEK_API_KEY: 'local-test', DEEPSEEK_BASE_URL: 'http://unreachable.invalid', http_proxy: `http://127.0.0.1:${address.port}`, HTTP_PROXY: '', https_proxy: '', HTTPS_PROXY: '', NO_PROXY: '', no_proxy: '', SEEDA_SYSTEM_PROXY: '0' } });
  t.after(() => child.kill()); let output = ''; let error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise<number | null>(resolve => child.once('close', resolve));
  assert.equal(code, 0, error); assert.match(requested, /^(?:http:\/\/unreachable\.invalid\/chat\/completions|unreachable\.invalid:80)$/); assert.match(output, /proxy confirmed/);
});
