# Shelf to Alexa

Turn a Shopify storefront into an honest shop-assistant MCP server for Alexa+ and any other MCP host.

It reads the store's public `products.json`, and answers shoppers with tools for finding, comparing,
checking compatibility, remembering their devices, ordering in two confirmed steps and handing off to staff.
Every price, stock flag and compatibility claim comes from the store's own data. No LLM inside, no guessing.

## What it does

| Tool | What the shopper gets |
|---|---|
| `find_products` | Up to 3 picks for a need ("charger for my iPhone 15 and MacBook Air", budget), each with reasons |
| `compare_products` | A side-by-side table and a one-line verdict with the trade-off |
| `check_compatibility` | `confirmed` only with a literal quote from the store, `incompatible` only on a hard connector rule, else `not_listed` |
| `remember_my_devices` / `my_devices` | A device closet that survives across sessions, with at most one accessory the store itself lists for it |
| `prepare_order` / `place_order` | A priced preview with an HMAC confirmation token (10 minutes), then a simulated order; replays never double-order |
| `order_status` | "Where is my order", in any later session |
| `talk_to_staff` | A ticket for a human, with a pluggable notifier |

Each tool returns one or two sentences written to be spoken, plus `structuredContent` for a screen,
and screen tools point at an MCP App view (`ui://shop-counter/view.html` by default).

## Use

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createShelfServer, FileStateStore, ShelfService, shopifyCatalog } from 'shelf-to-alexa';

const store = { id: 'mystore', name: 'My Store', url: 'https://mystore.com', currency: 'USD', region: 'US', shipping: null };
const service = new ShelfService({
  catalog: shopifyCatalog(store, { cacheDir: './cache' }), // polite: 1 s between pages, 6 h disk cache
  state: new FileStateStore('./data/state'),
  secret: process.env.SHOP_SECRET!,
});
const handler = createMcpHandler(
  // userId must come from something you verified (an OAuth / account-linking token, a signed session),
  // never from a header the client can set. No userId = anonymous: no closet, no orders.
  (ctx) => createShelfServer({ service }, { userId: verifiedShopperId(ctx.requestInfo?.headers.get('authorization')) }),
  { legacy: 'stateless' },
);
// handler.fetch(request) -> Response  (Node, Lambda, Workers)
```

`verifiedShopperId` is yours to write. `apps/shop-counter/src/app.ts` shows one: an HMAC-signed demo session
(`identifyCaller`), plus `storeScopedState`, which keeps one device closet per shopper across several stores
while orders stay per store. `StateStore` is the seam for storage: `FileStateStore`, `MemoryStateStore`, or your
own (the app ships a DynamoDB one in `apps/shop-counter/src/dynamo.ts`).

See `apps/shop-counter` in this repo for a complete server (local HTTP + AWS Lambda entry).

## How the extraction stays honest

- Devices come from a dictionary (Apple, Samsung, Google, Microsoft). A bare "iPhone" never confirms a specific
  model, because the connector changed between generations. "iPhone 15" covers "iPhone 15 Pro" except for
  products that need an exact fit (cases, covers).
- Descriptions count as a compatibility listing only inside phrases like "designed for" or "compatible with".
  "Pairs naturally with MacBook Pro" is marketing, not a promise.
- Tags feed compatibility only. Stores use tags as merchandising labels ("magsafe charger" on a plain cable).
- Wattage is read from the title, or from explicit phrases ("delivers 15W", "240W total output"). Shopify HTML
  sometimes splits digits across tags ("1 5 W"); that is never read as 5 W or 15 W.

## Develop

```bash
npm test          # vitest, synthetic data only, no network
npm run typecheck
npm run build     # dist/ for publishing
```

MIT licensed.
