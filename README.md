# Shop Counter

**"Alexa, will this work with my stuff?" Shop Counter remembers the devices you own and answers from the store's own words: it quotes the line that proves a fit, and says no (with a quote) when it doesn't.**

An Alexa+ add-on for shoppers who own a pile of gadgets, served as a self-hosted MCP server
(spec 2025-11-25, Streamable HTTP) with MCP App screens for Echo Show. Your device closet belongs to you,
not to a store: an iPhone you mention while shopping at one store is known at the next one.
Ordering is the last step, in two confirmed turns.

![Shop Counter on an Echo Show: "Works with your iPhone 15, the store confirms it" with the store's quote](apps/echo-sim/screenshots/09_compat_confirmed_show15.png)
<!-- TODO: replace with the demo GIF (two stores, one closet) once the video is recorded. -->

> Not affiliated with Satechi or Roborock. The demo reads their **public** Shopify catalogs
> (`/products.json`, politely: one request per page, 1 s apart, 6 h cache). Orders and payment are simulated.

## Run it (3 commands)

```bash
npm install
cd apps/shop-counter && npm run dev        # MCP server: http://127.0.0.1:8787/mcp  (Roborock: /stores/roborock/mcp)
cd apps/echo-sim && npm run dev            # Echo Show simulator: http://localhost:5180  (?video for a clean frame)
```

Optional: `cd apps/echo-sim && npm run brain` with `ANTHROPIC_API_KEY` set lets Claude Haiku play Alexa
(capped at $0.50 a day). Without a key a small keyword router stands in, so the demo always works.

Try it: pick **Maya** at **Satechi** and say *"I have an iPhone 15 and a Roborock Q7 M5"*. Switch the store to
**Roborock** and say *"What devices do I have?"*: the closet is there, plus one accessory Roborock itself lists
for the Q7 M5, with the quote. Back at Satechi: *"Will this charger work with my phone?"*, no model named.

## What it does

| Shopper says | Shop Counter |
|---|---|
| "Will this work with my phone?" | Uses the remembered iPhone 15. "Works with your iPhone 15, the store confirms it." The screen shows the store's line. |
| "Does this pack fit my robot?" | "No, that won't work with your Saros 10R: the store says "Not compatible with Saros 10R"." plus a part the store does list. |
| "What do I have?" (in another store) | The same closet, and one tip: an in-stock accessory this store lists for one of your devices. Never invented. |
| "Find a charger under $50" | Up to 3 picks with reasons, from the live feed. Unknown is said as unknown. |
| "Order the first one" -> "confirm" | A priced preview first ("Say confirm to buy"), the order only after a yes. Simulated payment. |

Every price, stock flag and compatibility claim is checked against the raw store feed by an eval
(`npm run eval`: 57 shopper requests, 0 fabricated facts).

## Architecture

```
Echo Show simulator (apps/echo-sim)          Alexa+ (real add-on, via account linking)
  MCP client, MCP App host, voice                     |
          |  Streamable HTTP, Authorization: Bearer <signed session>
          v
Shop Counter server (apps/shop-counter)  ->  AWS Lambda Function URL + DynamoDB (deploy/)
  stores: Satechi /mcp, Roborock /stores/roborock/mcp
          |
Shelf to Alexa library (packages/shelf)   Shopify feed -> normalize -> extract -> search -> 9 MCP tools
MCP App view (packages/view)              one HTML file draws every result kind for Echo Show
```

- **MCP 2025-11-25**: `apps/shop-counter/src/app.ts` builds one stateless `McpServer` per request
  (`@modelcontextprotocol/server` 2.3.1); tools in `packages/shelf/src/server.ts`; contract in `docs/CONTRACT.md`.
- **MCP Apps**: `registerAppTool` / `registerAppResource` (`@modelcontextprotocol/ext-apps` 2.0.3) serve
  `ui://shop-counter/view.html`; the simulator hosts it in a sandboxed iframe through `AppBridge`.
- **Agent Skill**: `skills/shop-counter/SKILL.md` tells the Alexa+ model which tool to call when, and what never to make up.
- **Identity**: a demo login (`POST /auth/demo-login`, profiles `maya`, `sam`, `guest`) returns an HMAC-signed
  session; the server takes the shopper only from `Authorization: Bearer`. Forged or expired sessions get 401.
  This is a **demo login**: on Alexa+ the session would come from account linking (OAuth).
- **Memory**: the closet is keyed by shopper and shared by all stores; orders are per store. Files locally,
  DynamoDB on AWS (`STATE_STORE=dynamodb`, `TABLE_NAME`).

## Connect any Shopify store

Add an entry to `apps/shop-counter/src/stores.ts`:

```ts
{ id: 'mystore', name: 'My Store', url: 'https://mystore.com', currency: 'USD', region: 'US', shipping: null, demo_delivery_days: 4 }
```

It is served at `/stores/mystore/mcp`. The library alone (`packages/shelf`, npm name `shelf-to-alexa`) turns any
storefront into the same 9 tools; see `packages/shelf/README.md`. Check the store's terms before you read its feed.

## Deploy to AWS (optional)

`cd apps/shop-counter && npm run package` builds `dist/function.zip` (one ESM bundle, arm64-ready). Upload it with
`deploy/deploy_lambda.sh` to AWS CloudShell and run the script: it creates the DynamoDB table (on-demand), a role
limited to that table, the Lambda (Node 22, arm64, reserved concurrency 5), a public Function URL with CORS,
log retention, and a kill switch alarm that turns the function off above an hourly cap.

## Tests

```bash
npm test                                   # all packages: library, server, view, simulator router
npm run eval                               # shopper eval on a frozen catalog snapshot, no network
cd apps/shop-counter && npm run check      # live end-to-end check against the real Satechi storefront
```

## Build log



## License

MIT, see [LICENSE](LICENSE).
