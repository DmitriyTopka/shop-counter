/**
 * The hosted demo on the same Lambda Function URL as /mcp, so a judge opens one link and needs nothing else:
 *   /sim/...        the Echo Show simulator (apps/echo-sim, `vite build` with relative paths), static files
 *   /               redirect to /sim/
 *   /brain/...      the Alexa brain on Amazon Bedrock (brain.ts)
 * Same origin as /mcp and /auth/demo-login, so the browser needs no CORS. Returns null for every other path.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostedEvent {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
}
export interface HostedResult { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean }

const HERE = dirname(fileURLToPath(import.meta.url));
/** Next to the bundle on Lambda (/var/task/sim, copied by scripts/build.mjs), else the echo-sim build in the repo. */
const SIM_CANDIDATES = [process.env.SHOP_COUNTER_SIM_DIR, join(HERE, 'sim'), resolve(HERE, '..', '..', 'echo-sim', 'dist')];
export const simDir = () => SIM_CANDIDATES.find((d) => d && existsSync(join(d, 'index.html'))) ?? null;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map']);

const text = (statusCode: number, body: string, headers: Record<string, string> = {}): HostedResult =>
  ({ statusCode, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body, isBase64Encoded: false });

export function serveSim(rawPath: string, dir = simDir()): HostedResult {
  if (rawPath === '/' || rawPath === '/sim') return text(302, 'see /sim/', { location: '/sim/' });
  if (!dir) return text(404, 'simulator not built into this package (run npm run build in apps/echo-sim, then npm run package)');
  let rel: string;
  try { rel = decodeURIComponent(rawPath.slice('/sim/'.length)); } catch { return text(400, 'bad path'); }
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const root = resolve(dir);
  const file = resolve(root, normalize(rel));
  if (file !== root && !file.startsWith(root + sep)) return text(404, 'not found');
  if (!existsSync(file) || !statSync(file).isFile()) return text(404, 'not found');
  const ext = extname(file).toLowerCase();
  const headers: Record<string, string> = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    // Vite puts a content hash in every asset name; index.html must always be fresh.
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  const buf = readFileSync(file);
  return TEXT.has(ext)
    ? { statusCode: 200, headers, body: buf.toString('utf8'), isBase64Encoded: false }
    : { statusCode: 200, headers, body: buf.toString('base64'), isBase64Encoded: true };
}

export async function hostedRoute(event: HostedEvent): Promise<HostedResult | null> {
  const path = event.rawPath;
  const method = event.requestContext.http.method;
  if (path === '/' || path === '/sim' || path.startsWith('/sim/')) {
    return method === 'GET' || method === 'HEAD' ? serveSim(path) : text(405, 'method not allowed');
  }
  if (path === '/brain' || path.startsWith('/brain/')) {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
    const { brainRoute } = await import('./brain.js');
    const r = await brainRoute(method, path, raw, event.requestContext.http.sourceIp ?? 'unknown');
    return { statusCode: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body), isBase64Encoded: false };
  }
  return null;
}
