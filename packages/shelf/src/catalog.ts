/** Catalog sources: where products come from, with an in-memory cache on top of the disk cache. */
import { buildCatalog, type Catalog } from './normalize.js';
import { buildIndex, type SearchIndex } from './search.js';
import { DEFAULT_TTL_MS, loadRawFeed, type FetchFeedOptions, type ShopifyProduct } from './shopify.js';
import type { StoreConfig } from './types.js';

export interface LoadedCatalog {
  catalog: Catalog;
  index: SearchIndex;
}

export interface CatalogSource {
  readonly store: StoreConfig;
  load(): Promise<LoadedCatalog>;
}

function prepare(raw: ShopifyProduct[], store: StoreConfig, fetchedAt: string, stale: boolean): LoadedCatalog {
  const catalog = buildCatalog(raw, store, fetchedAt, stale);
  return { catalog, index: buildIndex(catalog) };
}

/** Live Shopify storefront. Concurrent loads share one fetch; memory copy lives as long as the disk TTL. */
export function shopifyCatalog(store: StoreConfig, opts: FetchFeedOptions = {}): CatalogSource {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: LoadedCatalog } | null = null;
  let inflight: Promise<LoadedCatalog> | null = null;
  return {
    store,
    load() {
      if (cached && now() - cached.at < ttl && !cached.value.catalog.stale) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      inflight = loadRawFeed(store.url, opts)
        .then((feed) => {
          const value = prepare(feed.products, store, feed.fetched_at, feed.stale);
          cached = { at: feed.stale ? now() - ttl + 5 * 60 * 1000 : Date.parse(feed.fetched_at), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/** Fixed product list (tests, demos, or a feed you already have). */
export function staticCatalog(store: StoreConfig, products: ShopifyProduct[], fetchedAt = new Date().toISOString()): CatalogSource {
  const value = prepare(products, store, fetchedAt, false);
  return { store, load: () => Promise.resolve(value) };
}
