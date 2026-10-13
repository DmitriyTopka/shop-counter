// structuredContent shapes, mirrored from docs/CONTRACT.md (v1.3). Keep in sync with the contract.

export interface Product {
  id: string;
  handle?: string;
  title: string;
  vendor?: string;
  /** option value of this variant ("Black", "US"), null for single-variant products (contract v1.1) */
  variant?: string | null;
  price: number;
  currency?: string;
  compare_at_price?: number | null;
  available: boolean;
  image?: string | null;
  url?: string;
  highlights?: string[];
  compatible_with?: string[];
  why?: string[];
}

export interface LineItem { product: Product; qty: number; line_total: number }

export interface Order {
  id: string;
  status: string;
  created_at?: string;
  eta?: string;
  items?: LineItem[];
  subtotal?: number;
  shipping?: number | null;
  total: number;
  currency?: string;
  payment?: string;
  store?: string;
}

export type Structured =
  | { kind: 'products'; store?: string; need?: string; for_devices?: string[]; max_price?: number | null; products: Product[]; more_available?: number }
  | { kind: 'compare'; products: Product[]; rows: { label: string; values: (string | null)[] }[]; verdict?: string }
  | {
      kind: 'compat';
      product: Product;
      device?: string;
      status: 'confirmed' | 'not_listed' | 'incompatible';
      evidence?: { source: string; quote: string } | null;
      note?: string;
      alternatives?: Product[];
      also?: { device: string; status: 'confirmed' | 'not_listed' | 'incompatible'; evidence?: { source: string; quote: string } | null }[];
      /** v1.3: "closet" = the shopper did not name a device, the remembered one was used */
      device_source?: 'said' | 'closet';
    }
  | {
      kind: 'closet';
      devices: string[];
      home?: { pets?: string[]; notes?: string } | null;
      /** v1.3: the store that answered; the closet itself is shared by every store */
      store?: string;
      /** v1.3: one accessory the store lists for a remembered device, with its quote */
      suggestion?: { device: string; product: Product; evidence: { source: string; quote: string } } | null;
    }
  | {
      kind: 'order_preview';
      items: LineItem[];
      subtotal: number;
      /** null = store policy unknown, total is before shipping and tax (contract v1.1) */
      shipping: number | null;
      total: number;
      currency?: string;
      confirmation_token: string;
      expires_at?: string;
    }
  | { kind: 'order'; order: Order; already_placed?: boolean }
  | { kind: 'orders'; orders: Order[] }
  | { kind: 'handoff'; ticket_id: string; message: string }
  | { kind: 'error'; code?: string; message: string };

export interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** What the renderer needs from its host. In the real view this is backed by ext-apps `App`. */
export interface ViewHost {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResultLike>;
  /** Show a new result on screen (used after a button-triggered tool call). */
  show(result: ToolResultLike): void;
  /**
   * The shopper marked cards in the carousel. The host gets it as model context
   * (MCP Apps `ui/update-model-context`), so "compare them" by voice uses these cards.
   */
  select?(products: Product[]): void;
}
