/** Raw Shopify products -> catalog items with variants, features and device evidence. */
import { classifyItem, extractDeviceEvidence, extractFeatures, highlightsFrom, type DeviceEvidence, type Features, type ItemKind, type SourceText } from './extract.js';
import type { ShopifyProduct, ShopifyVariant } from './shopify.js';
import { htmlToText, round2 } from './text.js';
import type { Product, StoreConfig } from './types.js';

export interface CatalogVariant {
  id: string;
  /** null for "Default Title" single-variant products. */
  label: string | null;
  price: number;
  compare_at_price: number | null;
  available: boolean;
  image: string | null;
}

export interface CatalogItem {
  productId: string;
  handle: string;
  title: string;
  vendor: string;
  categories: string[];
  source: SourceText;
  features: Features;
  /** Form and offer type read from the product's own words (not the store's collection). */
  kind: ItemKind;
  highlights: string[];
  devices: DeviceEvidence[];
  /** Specific devices for display (generic family names dropped), natural order. */
  compatibleWith: string[];
  variants: CatalogVariant[];
  /** The variant shown by default (region-preferred, else first in stock, else first). */
  primary: CatalogVariant;
}

export interface Catalog {
  store: StoreConfig;
  items: CatalogItem[];
  byVariant: Map<string, { item: CatalogItem; variant: CatalogVariant }>;
  fetchedAt: string;
  stale: boolean;
}

function parsePrice(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function normVariant(v: ShopifyVariant, fallbackImage: string | null): CatalogVariant | null {
  const price = parsePrice(v.price);
  if (price === null) return null;
  const cap = parsePrice(v.compare_at_price);
  return {
    id: String(v.id),
    label: !v.title || v.title === 'Default Title' ? null : v.title,
    price,
    compare_at_price: cap !== null && cap > price ? cap : null,
    available: v.available === true,
    image: v.featured_image?.src ?? fallbackImage,
  };
}

const naturalCmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export function normalizeProduct(raw: ShopifyProduct, store: StoreConfig): CatalogItem | null {
  const fallbackImage = raw.images?.[0]?.src ?? null;
  const variants = (raw.variants ?? []).map((v) => normVariant(v, fallbackImage)).filter((v): v is CatalogVariant => v !== null);
  if (variants.length === 0 || !raw.title) return null;

  const region = store.region?.toLowerCase();
  const regionVariant = region
    ? (raw.variants ?? []).find((v) => [v.option1, v.option2, v.option3].some((o) => o?.toLowerCase() === region))
    : undefined;
  const primary =
    (regionVariant && variants.find((v) => v.id === String(regionVariant.id))) ??
    variants.find((v) => v.available) ??
    variants[0];

  const source: SourceText = {
    title: raw.title,
    description: htmlToText(raw.body_html),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    options: (raw.options ?? []).flatMap((o) => o.values ?? []).filter((v) => v && v !== 'Default Title'),
  };
  const features = extractFeatures(source);
  const categories = (raw.product_type ?? '').split('##').map((s) => s.trim()).filter(Boolean);
  const devices = extractDeviceEvidence(source);
  const compatibleWith = [...new Set(devices.filter((d) => !d.device.generic).map((d) => d.device.name))].sort(naturalCmp);

  return {
    productId: String(raw.id),
    handle: raw.handle,
    title: raw.title,
    vendor: raw.vendor ?? '',
    categories,
    source,
    features,
    kind: classifyItem(source, categories),
    highlights: highlightsFrom(features),
    devices,
    compatibleWith,
    variants,
    primary,
  };
}

export function buildCatalog(raw: ShopifyProduct[], store: StoreConfig, fetchedAt: string, stale = false): Catalog {
  const items: CatalogItem[] = [];
  const byVariant = new Map<string, { item: CatalogItem; variant: CatalogVariant }>();
  for (const p of raw) {
    const item = normalizeProduct(p, store);
    if (!item) continue;
    items.push(item);
    for (const v of item.variants) byVariant.set(v.id, { item, variant: v });
  }
  return { store, items, byVariant, fetchedAt, stale };
}

/** Card images: Shopify serves 3000-4000 px originals (1.5 MB); its CDN resizes on `width` (600 px ~ 66 KB, ~21 KB as WebP). */
export const CARD_IMAGE_WIDTH = 600;

/** Ask the Shopify CDN for a resized image. Other hosts are returned unchanged. */
export function sizedImage(src: string | null, width = CARD_IMAGE_WIDTH): string | null {
  if (!src) return src;
  try {
    const u = new URL(src.startsWith('//') ? `https:${src}` : src);
    if (u.hostname !== 'cdn.shopify.com' && !u.pathname.startsWith('/cdn/shop/')) return src;
    u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return src;
  }
}

export function toProduct(item: CatalogItem, store: StoreConfig, variant: CatalogVariant = item.primary, why: string[] = []): Product {
  const base = store.url.replace(/\/+$/, '');
  const url = `${base}/products/${item.handle}${item.variants.length > 1 ? `?variant=${variant.id}` : ''}`;
  return {
    id: variant.id,
    handle: item.handle,
    title: item.title,
    vendor: item.vendor,
    variant: variant.label,
    price: variant.price,
    currency: store.currency,
    compare_at_price: variant.compare_at_price,
    available: variant.available,
    image: sizedImage(variant.image),
    url,
    highlights: item.highlights,
    compatible_with: item.compatibleWith.slice(0, 12),
    why,
  };
}
