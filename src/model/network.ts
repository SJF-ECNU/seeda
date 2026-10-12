import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setGlobalProxyFromEnv } from 'node:http';

type ProxyEnvironment = Record<string, string | undefined>;
const proxyKeys = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'];

function exception(value: string): string {
  const cidr = value.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!cidr) return value;
  const octets = cidr[1].split('.').map(Number); const prefix = Number(cidr[2]);
  if (prefix > 32 || octets.some(n => n > 255)) return value;
  const ip = octets.reduce((number, octet) => number * 256 + octet, 0);
  const size = 2 ** (32 - prefix); const start = Math.floor(ip / size) * size;
  const format = (number: number) => [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.');
  return `${format(start)}-${format(start + size - 1)}`;
}
export function systemProxyEnvironment(source: string, env: ProxyEnvironment): ProxyEnvironment | undefined {
  const field = (name: string) => source.match(new RegExp(`^\\s*${name} : (.+)$`, 'm'))?.[1]?.trim();
  const proxy: ProxyEnvironment = {};
  for (const type of ['HTTP', 'HTTPS']) {
    const host = field(`${type}Proxy`); const port = Number(field(`${type}Port`));
    if (field(`${type}Enable`) === '1' && host && Number.isInteger(port) && port > 0 && port <= 65535) {
      const url = new URL('http://localhost'); url.hostname = host.includes(':') ? `[${host}]` : host; url.port = String(port);
      proxy[`${type}_PROXY`] = url.origin;
    }
  }
  if (!proxyKeys.some(key => proxy[key])) return undefined;
  const block = source.match(/ExceptionsList : <array> \{([\s\S]*?)\}/)?.[1] ?? '';
  const exceptions = [...block.matchAll(/^\s*\d+ : (.+)$/gm)].map(match => exception(match[1].trim()));
  proxy.NO_PROXY = env.no_proxy ?? env.NO_PROXY ?? ['localhost', '127.0.0.1', '::1', ...exceptions].join(',');
  return proxy;
}
export async function resolveProxyEnvironment(env: ProxyEnvironment, platform = process.platform,
  readSystem = async () => (await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 })).stdout): Promise<ProxyEnvironment | undefined> {
  if (proxyKeys.some(key => env[key])) return env;
  if (platform !== 'darwin' || env.SEEDA_SYSTEM_PROXY === '0') return undefined;
  try { return systemProxyEnvironment(await readSystem(), env); }
  catch { return undefined; } // No system query available: preserve normal direct networking.
}
export async function configureNetwork(): Promise<void> {
  const proxy = await resolveProxyEnvironment(process.env);
  if (proxy) setGlobalProxyFromEnv(proxy);
}
export function networkError(error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return error;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
  return new Error(`Model network request failed${detail}. Check connectivity and HTTP(S) proxy settings.`, { cause: error });
}
