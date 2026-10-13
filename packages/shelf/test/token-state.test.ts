import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileStateStore } from '../src/state.js';
import { signOrderToken, verifyOrderToken, type OrderTokenPayload } from '../src/token.js';

const SECRET = 'test-secret';
const payload = (over: Partial<OrderTokenPayload> = {}): OrderTokenPayload => ({
  v: 1, u: 'user-1', s: 'acme', i: [['123', 2]], t: 19998, e: Date.now() + 60_000, n: 'nonce', ...over,
});

describe('order tokens', () => {
  it('round-trips a valid token', () => {
    const t = signOrderToken(payload(), SECRET);
    expect(verifyOrderToken(t, SECRET)).toMatchObject({ ok: true, payload: { u: 'user-1', t: 19998 } });
  });

  it('rejects expired, tampered, wrong-secret and malformed tokens', () => {
    expect(verifyOrderToken(signOrderToken(payload({ e: Date.now() - 1 }), SECRET), SECRET)).toMatchObject({ ok: false, code: 'token_expired' });
    const t = signOrderToken(payload(), SECRET);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload(), t: 1 })).toString('base64url');
    expect(verifyOrderToken(`${forged}.${sig}`, SECRET)).toMatchObject({ ok: false, code: 'token_invalid' });
    expect(verifyOrderToken(`${body}.${sig.slice(0, -2)}AA`, SECRET)).toMatchObject({ ok: false, code: 'token_invalid' });
    expect(verifyOrderToken(t, 'other-secret')).toMatchObject({ ok: false, code: 'token_invalid' });
    for (const bad of ['', 'abc', 'a.b.c', '..', 'x'.repeat(5000)]) expect(verifyOrderToken(bad, SECRET).ok).toBe(false);
  });
});

describe('FileStateStore', () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

  it('persists per shopper, hashes file names, serializes concurrent updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shelf-state-'));
    dirs.push(dir);
    const a = new FileStateStore(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => a.update('../../etc/passwd', (s) => ({ ...s, closet: { ...s.closet, devices: [...s.closet.devices, `d${i}`] } }))),
    );
    const b = new FileStateStore(dir); // a "new session"
    expect((await b.get('../../etc/passwd')).closet.devices).toHaveLength(20);
    expect((await b.get('someone-else')).closet.devices).toEqual([]);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });
});
