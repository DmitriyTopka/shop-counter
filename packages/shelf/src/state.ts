/**
 * Shopper state between sessions: device closet, orders, staff tickets.
 * `StateStore` is the seam: FileStateStore for local dev, MemoryStateStore for tests,
 * a DynamoDB store later (one item per shopper, conditional writes).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Closet, HandoffTicket, Order } from './types.js';

export interface ShopperState {
  closet: Closet;
  orders: Order[];
  tickets: HandoffTicket[];
  /** nonce of a used confirmation token -> order id (replay protection / idempotency). */
  used_tokens: Record<string, { order_id: string; expires: number }>;
}

export interface StateStore {
  get(userId: string): Promise<ShopperState>;
  /** Read-modify-write, serialized per shopper. */
  update(userId: string, fn: (s: ShopperState) => ShopperState | Promise<ShopperState>): Promise<ShopperState>;
}

export function emptyState(): ShopperState {
  return { closet: { devices: [], home: {} }, orders: [], tickets: [], used_tokens: {} };
}

function withDefaults(s: Partial<ShopperState> | null | undefined): ShopperState {
  const e = emptyState();
  return {
    closet: { devices: s?.closet?.devices ?? e.closet.devices, home: s?.closet?.home ?? e.closet.home },
    orders: s?.orders ?? [],
    tickets: s?.tickets ?? [],
    used_tokens: s?.used_tokens ?? {},
  };
}

/** Per-key promise chain: concurrent updates for one shopper run one after another. */
class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

export class MemoryStateStore implements StateStore {
  private data = new Map<string, ShopperState>();
  private lock = new KeyedLock();
  async get(userId: string): Promise<ShopperState> {
    return structuredClone(this.data.get(userId) ?? emptyState());
  }
  update(userId: string, fn: (s: ShopperState) => ShopperState | Promise<ShopperState>): Promise<ShopperState> {
    return this.lock.run(userId, async () => {
      const next = await fn(await this.get(userId));
      this.data.set(userId, structuredClone(next));
      return structuredClone(next);
    });
  }
}

/** One JSON file per shopper, named by a hash of the id (no path tricks from user input). */
export class FileStateStore implements StateStore {
  private lock = new KeyedLock();
  constructor(private readonly dir: string) {}

  private file(userId: string): string {
    return join(this.dir, `${createHash('sha256').update(userId).digest('hex').slice(0, 32)}.json`);
  }

  async get(userId: string): Promise<ShopperState> {
    try {
      return withDefaults(JSON.parse(await readFile(this.file(userId), 'utf8')) as Partial<ShopperState>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
  }

  update(userId: string, fn: (s: ShopperState) => ShopperState | Promise<ShopperState>): Promise<ShopperState> {
    return this.lock.run(userId, async () => {
      const next = await fn(await this.get(userId));
      await mkdir(this.dir, { recursive: true });
      const path = this.file(userId);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 1));
      await rename(tmp, path);
      return next;
    });
  }
}
