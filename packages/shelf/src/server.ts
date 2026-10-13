/**
 * MCP adapter: registers the shop assistant's tools and the MCP App view on an McpServer.
 * Stateless by design: build one server per HTTP request with `createShelfServer`.
 */
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ANONYMOUS, fail, ShelfService, type ToolOutcome } from './service.js';

export const DEFAULT_VIEW_URI = 'ui://shop-counter/view.html';

export interface ShelfServerOptions {
  service: ShelfService;
  /** Server name reported in `initialize`. */
  name?: string;
  version?: string;
  /** MCP App resource (one HTML for every card). Defaults to a minimal built-in view. */
  view?: { uri?: string; html: () => string | Promise<string> };
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RequestContext {
  /** Stable shopper id (from the `x-user-id` header). Missing -> "anonymous". */
  userId?: string;
}

/** Accept only plain ids; anything else is treated as anonymous. */
export function sanitizeUserId(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  return /^[A-Za-z0-9._:@-]{1,128}$/.test(v) ? v : ANONYMOUS;
}

type CallResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function toResult(o: ToolOutcome): CallResult {
  return {
    content: [{ type: 'text', text: o.text }],
    structuredContent: o.structured as unknown as Record<string, unknown>,
    ...(o.isError ? { isError: true } : {}),
  };
}

/** Minimal view used when no real one is configured: shows the spoken text and the result kind. */
export const FALLBACK_VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Shop view</title>
<style>body{font:18px system-ui,sans-serif;margin:16px;color:#111;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head><body><p id="t">Shop Counter</p><script>
addEventListener('message',(e)=>{const m=e.data;if(m&&m.method==='ui/notifications/tool-result'){const r=m.params||{};
document.getElementById('t').textContent=((r.content||[])[0]||{}).text||((r.structuredContent||{}).kind||'');}});
</script></body></html>`;

const deviceList = z.array(z.string()).describe('Device names, e.g. ["iPhone 15", "MacBook Air M2"]');

export function createShelfServer(opts: ShelfServerOptions, ctx: RequestContext = {}): McpServer {
  const { service } = opts;
  const userId = sanitizeUserId(ctx.userId);
  const store = service.store.name;
  const uri = opts.view?.uri ?? DEFAULT_VIEW_URI;
  const log = opts.log ?? ((m, e) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: m, ...e })));
  const server = new McpServer({ name: opts.name ?? 'shelf-to-alexa', version: opts.version ?? '0.1.0' });

  const guard = (tool: string, fn: () => Promise<ToolOutcome>) => async (): Promise<CallResult> => {
    try {
      return toResult(await fn());
    } catch (err) {
      log('tool_error', { tool, user: userId, error: (err as Error).stack ?? String(err) });
      return toResult(fail('internal', 'Sorry, something went wrong on my side. Please try again.'));
    }
  };

  const _meta = { ui: { resourceUri: uri } };
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  registerAppTool(
    server,
    'find_products',
    {
      _meta,
      annotations: ro,
      title: 'Find products',
      description:
        `Recommend up to 3 products from the ${store} catalog for a shopper's need, with reasons. ` +
        "Prices and stock come from the live store feed. If the shopper names devices, they are matched against the store's own compatibility lists; " +
        "otherwise the shopper's remembered devices are used.",
      inputSchema: z.object({
        need: z.string().describe('What the shopper wants, in their words, e.g. "charger for my iPhone 15 and MacBook Air"'),
        max_price: z.number().optional().describe('Budget ceiling in store currency'),
        category: z.string().optional().describe('Optional category, e.g. "Wall Chargers", "Hubs"'),
        must_have: z.array(z.string()).optional().describe('Hard requirements, e.g. ["100W", "Qi2", "3 ports"]'),
        for_devices: deviceList.optional(),
      }),
    },
    async (a) => guard('find_products', () => service.findProducts(userId, a))(),
  );

  registerAppTool(
    server,
    'compare_products',
    {
      _meta,
      annotations: ro,
      title: 'Compare products',
      description: 'Side-by-side comparison of 2 or 3 products by id (ids come from find_products), with a short verdict.',
      inputSchema: z.object({ ids: z.array(z.string()).describe('2 or 3 product ids') }),
    },
    async (a) => guard('compare_products', () => service.compareProducts(userId, a))(),
  );

  registerAppTool(
    server,
    'check_compatibility',
    {
      _meta,
      annotations: ro,
      title: 'Check compatibility',
      description:
        'Check whether a product works with a device. Answers "confirmed" only when the store itself lists this exact model (with a quote), ' +
        '"family_only" when the store lists only the series or family (e.g. "iPhone 17" for an iPhone 17 Pro), ' +
        '"incompatible" when the store rules it out or the connector cannot fit, otherwise "not_listed". ' +
        'Pass the device the shopper named. Without a device, or with "my phone" / "my laptop", the remembered devices are used; ' +
        'if several remembered devices fit, the answer is error "device_ambiguous" with the options to ask about.',
      inputSchema: z.object({
        product_id: z.string().describe('Product id from find_products'),
        device: z.string().optional().describe('e.g. "iPhone 15 Pro"'),
      }),
    },
    async (a) => guard('check_compatibility', () => service.checkCompatibility(userId, a))(),
  );

  // The closet tools are screen tools too: "My devices" shows what is remembered (shared by every store)
  // and the one accessory this store lists for it, with the store's quote.
  registerAppTool(
    server,
    'remember_my_devices',
    {
      _meta,
      title: 'Remember my devices',
      description:
        "Save the shopper's devices and home details (pets, notes) for future sessions, or forget some. " +
        'The closet belongs to the shopper and is shared by every store. May return one accessory this store lists for a remembered device.',
      inputSchema: z.object({
        devices: deviceList.optional(),
        home: z.object({ pets: z.array(z.string()).optional(), notes: z.string().optional() }).optional(),
        forget: z.array(z.string()).optional().describe('Devices to remove'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => guard('remember_my_devices', () => service.rememberDevices(userId, a))(),
  );

  registerAppTool(
    server,
    'my_devices',
    {
      _meta,
      title: 'My devices',
      description: "List the devices and home details remembered for this shopper (shared by every store), with at most one accessory tip from this store's own data.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard('my_devices', () => service.myDevices(userId))(),
  );

  registerAppTool(
    server,
    'prepare_order',
    {
      _meta,
      annotations: ro,
      title: 'Prepare order',
      description:
        'Step 1 of 2: price the items and return a confirmation token valid for 10 minutes. Nothing is ordered yet. ' +
        'Always read the total to the shopper and ask for a yes before place_order.',
      inputSchema: z.object({
        items: z.array(z.object({ id: z.string(), qty: z.number().int().optional() })).describe('Products and quantities'),
      }),
    },
    async (a) => guard('prepare_order', () => service.prepareOrder(userId, a))(),
  );

  registerAppTool(
    server,
    'place_order',
    {
      _meta,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Place order',
      description: 'Step 2 of 2: place the order after the shopper said yes, using the confirmation_token from prepare_order. Payment is simulated.',
      inputSchema: z.object({ confirmation_token: z.string() }),
    },
    async (a) => guard('place_order', () => service.placeOrder(userId, a))(),
  );

  registerAppTool(
    server,
    'order_status',
    {
      _meta,
      annotations: ro,
      title: 'Order status',
      description: "Where is my order: the shopper's orders, latest first, or one order by id. Works across sessions.",
      inputSchema: z.object({ order_id: z.string().optional() }),
    },
    async (a) => guard('order_status', () => service.orderStatus(userId, a))(),
  );

  server.registerTool(
    'talk_to_staff',
    {
      title: 'Talk to staff',
      description: `Hand the conversation to a person at ${store}: warranty, returns, complaints, or anything the assistant cannot answer from the catalog.`,
      inputSchema: z.object({
        reason: z.string().describe('What the shopper needs, in one sentence'),
        contact: z.string().optional().describe('Phone or email, only if the shopper offered it'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => guard('talk_to_staff', () => service.talkToStaff(userId, a))(),
  );

  {
    const html = opts.view?.html ?? (() => FALLBACK_VIEW_HTML);
    registerAppResource(
      server,
      `${store} shop view`,
      uri,
      { description: 'Echo Show style cards: products, comparison, compatibility, order', mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: await html(),
            _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['https://cdn.shopify.com'] } } },
          },
        ],
      }),
    );
  }

  return server;
}
