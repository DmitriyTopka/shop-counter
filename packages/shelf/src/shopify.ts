/**
 * Shopify storefront adapter: reads the public `/products.json` feed politely
 * (one request at a time, a pause between pages, an honest User-Agent) and
 * caches the raw feed on disk with a TTL.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ShopifyImage {
  src: string;
}

export interface ShopifyVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  sku: string | null;
  available: boolean;
  price: string;
  compare_at_price: string | null;
  featured_image: ShopifyImage | null;
}

export interface ShopifyOption {
  name: string;
  position: number;
  values: string[];
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: ShopifyVariant[];
  options: ShopifyOption[];
  images: ShopifyImage[];
}

export interface RawFeed {
  url: string;
  fetched_at: string;
  products: ShopifyProduct[];
}

export interface FetchFeedOptions {
  /** Directory for the on-disk cache. Omit to disable disk caching. */
  cacheDir?: string;
  /** Cache time-to-live. Default 6 hours. */
  ttlMs?: number;
  /** Pause between page requests. Default 1000 ms. */
  pauseMs?: number;
  /** Safety cap on pages (250 products each). Default 20. */
  maxPages?: number;
  userAgent?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Ignore a fresh cache and refetch. */
  force?: boolean;
}

export const DEFAULT_USER_AGENT =
  'ShelfToAlexa/0.1 (Shop Counter, Amazon Developer Hackathon demo; read-only catalog fetch, cached 6h)';
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function cacheFileFor(storeUrl: string): string {
  const host = new URL(storeUrl).host.replace(/[^a-z0-9.-]/gi, '_');
  return `${host}.products.json`;
}

async function readCache(path: string): Promise<RawFeed | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as RawFeed;
    return Array.isArray(parsed.products) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(path: string, feed: RawFeed): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(feed));
  await rename(tmp, path);
}

/** Fetch every page of `/products.json`. Throws on HTTP or shape errors. */
export async function fetchAllProducts(storeUrl: string, opts: FetchFeedOptions = {}): Promise<ShopifyProduct[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pauseMs = opts.pauseMs ?? 1000;
  const maxPages = opts.maxPages ?? 20;
  const all: ShopifyProduct[] = [];
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(pauseMs);
    const url = new URL('/products.json', storeUrl);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const res = await fetchImpl(url, {
      headers: { 'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT, accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const body = (await res.json()) as { products?: unknown };
    if (!Array.isArray(body.products)) throw new Error(`products.json page ${page}: no products array`);
    const products = body.products as ShopifyProduct[];
    all.push(...products);
    if (products.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Load the raw feed: fresh disk cache if any, else the network, else a stale cache
 * (marked by `stale: true`) so a short store outage does not take the assistant down.
 */
export async function loadRawFeed(
  storeUrl: string,
  opts: FetchFeedOptions = {},
): Promise<RawFeed & { stale: boolean; from_cache: boolean }> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const path = opts.cacheDir ? join(opts.cacheDir, cacheFileFor(storeUrl)) : null;
  const cached = path ? await readCache(path) : null;
  if (cached && !opts.force && now() - Date.parse(cached.fetched_at) < ttl) {
    return { ...cached, stale: false, from_cache: true };
  }
  try {
    const products = await fetchAllProducts(storeUrl, opts);
    const feed: RawFeed = { url: storeUrl, fetched_at: new Date(now()).toISOString(), products };
    if (path && opts.cacheDir) {
      await mkdir(opts.cacheDir, { recursive: true });
      await writeCache(path, feed);
    }
    return { ...feed, stale: false, from_cache: false };
  } catch (err) {
    if (cached) return { ...cached, stale: true, from_cache: true };
    throw err;
  }
}
