/**
 * Public data shapes. These mirror docs/CONTRACT.md (the single source of truth);
 * if you change one, change the other.
 */

/** A product as the shopper sees it. One object = one purchasable variant. */
export interface Product {
  /** Shopify variant id (stable, purchasable). */
  id: string;
  handle: string;
  title: string;
  vendor: string;
  /** Option value of the chosen variant ("Silver", "US"), null for single-variant products. */
  variant: string | null;
  price: number;
  currency: string;
  /** Only set when the store shows a real markdown (compare_at > price). */
  compare_at_price: number | null;
  available: boolean;
  image: string | null;
  url: string;
  highlights: string[];
  /** Devices the store itself lists (tags, title, description, options). */
  compatible_with: string[];
  /** Reasons this product was picked for this shopper. Empty outside of search. */
  why: string[];
}

export type EvidenceSource = 'tags' | 'title' | 'description' | 'options';

export interface Evidence {
  source: EvidenceSource;
  /** A literal substring of the store data. */
  quote: string;
}

export interface Closet {
  devices: string[];
  home: { pets?: string[]; notes?: string };
}

export interface OrderLine {
  product: Product;
  qty: number;
  line_total: number;
}

export interface Order {
  id: string;
  status: 'confirmed';
  created_at: string;
  eta: string;
  items: OrderLine[];
  subtotal: number;
  shipping: number | null;
  total: number;
  currency: string;
  payment: string;
  store: string;
}

export interface HandoffTicket {
  ticket_id: string;
  created_at: string;
  reason: string;
  contact: string | null;
}

/* ---------- structuredContent kinds ---------- */

export interface ProductsResult {
  kind: 'products';
  store: string;
  need: string;
  /** Devices the search was matched against (from input or the shopper's closet). */
  for_devices: string[];
  max_price: number | null;
  products: Product[];
  more_available: number;
  /** The named product, when it is out of stock (available: false): never offered, but checkable for fit. */
  out_of_stock_match: Product | null;
}

export interface CompareRow {
  label: string;
  values: (string | null)[];
}

export interface CompareResult {
  kind: 'compare';
  products: Product[];
  rows: CompareRow[];
  verdict: string;
}

/**
 * confirmed: the store names this exact model. family_only (v1.6): the store names only the series or
 * family ("iPhone 17" for an iPhone 17 Pro), which is not proof of fit. not_listed: the store is silent.
 * incompatible: the store rules it out, or the connector cannot fit.
 */
export type CompatStatus = 'confirmed' | 'family_only' | 'not_listed' | 'incompatible';

export interface CompatResult {
  kind: 'compat';
  product: Product;
  device: string;
  status: CompatStatus;
  evidence: Evidence | null;
  /** Plain-language reason, e.g. which rule fired for "incompatible". */
  note: string;
  alternatives: Product[];
  /** When checked against the whole closet: the result for each other device. */
  also?: { device: string; status: CompatStatus; evidence: Evidence | null }[];
  /** "closet" when the shopper did not name a device and the remembered one was used. */
  device_source?: 'said' | 'closet';
}

/** One accessory the store itself lists for a remembered device (proactive, never invented). */
export interface ClosetSuggestion {
  device: string;
  product: Product;
  evidence: Evidence;
}

export type DeviceKindName = 'phone' | 'laptop' | 'tablet' | 'desktop' | 'watch' | 'earbuds' | 'robot' | 'other';

export interface ClosetResult {
  kind: 'closet';
  /** Each device as the shopper named it ("MacBook Pro 2017 Intel"). */
  devices: string[];
  /** v1.6: the same devices with their kind, for icons. Same order as `devices`. */
  items?: { name: string; kind: DeviceKindName }[];
  home: Closet['home'];
  /** The store that answered. The closet itself belongs to the shopper and is shared by every store. */
  store?: string;
  suggestion?: ClosetSuggestion | null;
}

export interface OrderPreviewResult {
  kind: 'order_preview';
  items: OrderLine[];
  subtotal: number;
  shipping: number | null;
  total: number;
  currency: string;
  confirmation_token: string;
  expires_at: string;
}

export interface OrderResult {
  kind: 'order';
  order: Order;
  /** True when the same confirmation was replayed and the existing order is returned. */
  already_placed?: boolean;
}

export interface OrdersResult {
  kind: 'orders';
  orders: Order[];
}

export interface HandoffResult {
  kind: 'handoff';
  ticket_id: string;
  message: string;
}

export type ErrorCode =
  | 'not_found'
  | 'out_of_stock'
  | 'invalid_input'
  | 'device_required'
  | 'device_ambiguous'
  | 'anonymous'
  | 'token_invalid'
  | 'token_expired'
  | 'token_wrong_user'
  | 'price_changed'
  | 'catalog_unavailable'
  | 'internal';

export interface ErrorResult {
  kind: 'error';
  code: ErrorCode;
  message: string;
  /** v1.6, device_ambiguous only: the remembered devices that fit what the shopper said ("my phone"). */
  options?: string[];
}

export type StructuredResult =
  | ProductsResult
  | CompareResult
  | CompatResult
  | ClosetResult
  | OrderPreviewResult
  | OrderResult
  | OrdersResult
  | HandoffResult
  | ErrorResult;

/* ---------- store configuration ---------- */

export interface StoreConfig {
  /** Short id used in URLs and state keys, e.g. "satechi". */
  id: string;
  /** Display / spoken name, e.g. "Satechi". */
  name: string;
  /** Storefront origin, e.g. "https://satechi.net". */
  url: string;
  /** ISO currency. Shopify products.json does not carry it, so it is configured. */
  currency: string;
  /** Preferred plug/region option value when a product has region variants, e.g. "US". */
  region?: string;
  /** Shipping policy for the order preview. null = unknown, we say "before shipping and tax". */
  shipping?: { flat: number; free_over?: number } | null;
  /** Demo delivery estimate in days (orders are simulated). */
  demo_delivery_days?: number;
}
