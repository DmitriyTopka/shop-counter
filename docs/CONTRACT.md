# Shop Counter: tool contract (v1.5, 2026-10-12)

Single source of truth between the MCP server (`apps/shop-counter`, `packages/shelf`) and the Echo Show simulator (`apps/echo-sim`). Change it here first.

## Transport
- MCP spec 2025-11-25, Streamable HTTP, endpoint `POST /mcp`, stateless (no `Mcp-Session-Id`). `/mcp` serves the default store (Satechi); every store is also at `POST /stores/<id>/mcp` (`satechi`, `roborock`). `GET /health` lists them.
- Shopper identity: `Authorization: Bearer <session>`, an HMAC-signed session from `POST /auth/demo-login {"profile":"maya"|"sam"|"guest"}` -> `{token, user_id, profile, expires_at}` (24 h; `guest` = a fresh private id). The server takes the shopper id ONLY from a valid session. No `Authorization` -> `anonymous` (no memory, no orders). A forged, foreign-secret, expired or malformed session -> HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`, nothing runs. A bare `x-user-id` header is ignored unless the local dev flag `SHOP_COUNTER_DEV_USER_HEADER=1` is set (never on Lambda). In production on Alexa+ the session would come from account linking (OAuth) instead of the demo login.
- Memory scope: the device closet (`remember_my_devices`, `my_devices`) belongs to the shopper and is shared by every store; orders, tickets and confirmations are per store.
- Every tool result = `content[0].text` (one or two short sentences, enforced in code: longer lines are cut between sentences; written to be SPOKEN by Alexa, no URLs, no SKUs) + `structuredContent` (below) + `_meta.ui.resourceUri = "ui://shop-counter/view.html"` for tools marked [UI].
- Facts (price, availability, compatibility) come only from the store feed. Never invented. Unknown -> say unknown.

## Product object
```json
{ "id": "string (variant-stable id)", "handle": "string", "title": "string", "vendor": "string",
  "variant": "Silver | US | null (option value of this variant; null for single-variant products)",
  "price": 49.99, "currency": "USD", "compare_at_price": 59.99, "available": true,
  "image": "https://... | null", "url": "https://store/products/handle?variant=id",
  "highlights": ["100W USB-C PD", "3 ports"], "compatible_with": ["iPhone 15", "MacBook Air M2"],
  "why": ["Fits your iPhone 15 (store lists it)", "Under your $60 budget"] }
```

## Tools
1. `find_products` [UI] input `{ need: string, max_price?: number, category?: string, must_have?: string[], for_devices?: string[] }`. Uses the shopper's device closet when `for_devices` is empty. Returns `{ kind:"products", store, need, for_devices: string[], max_price: number|null, products: Product[<=3], more_available: number, out_of_stock_match: Product|null }`. `max_price` may come from the need text ("under $50"). Empty `products` is a normal answer (the spoken text says why: nothing matched, over budget, out of stock, a wattage nobody has, or a brand/model the store does not sell). Protection plans, trade-in offers and points items are returned only when the need asks for them. When the shopper names a brand/model the store does not sell or a product that is out of stock, the spoken text says so first, then names the closest real option. That holds with `for_devices` too (a named product the store does not list for the device). The named out-of-stock product itself is `out_of_stock_match` (`available: false`): never offered or orderable, but its id works in `check_compatibility`, so "will it fit?" still gets the store's answer.
2. `compare_products` [UI] input `{ ids: string[2..3] }` -> `{ kind:"compare", products: Product[], rows: [{label, values:(string|null)[]}], verdict: string }`.
3. `check_compatibility` [UI] input `{ product_id: string, device?: string }` -> `{ kind:"compat", product, device, status:"confirmed"|"not_listed"|"incompatible", evidence:{ source:"tags"|"title"|"description"|"options", quote:string }|null, note: string, alternatives: Product[], also?: [{device, status, evidence}] }`. `confirmed` only with a literal quote from the store data (a tag counts only when the tag is the device itself, not a label like "magsafe charger"). `incompatible` only from the store's own negation ("Not compatible with Saros 10R", quoted) or a hard connector rule (Lightning vs USB-C), with the title as evidence. Without `device`, all closet devices are checked: the first is the main answer, the rest go to `also`, and `device_source: "closet"` (else `"said"`); the spoken text then names the shopper's device ("Works with your iPhone 15, the store confirms it."). Any answer other than confirmed speaks the first listed alternative; an `incompatible` from the store's own negation quotes it. A free-text device that starts with the store's brand ("Roborock Q7 M5" at Roborock) is matched without the brand.
4. `remember_my_devices` [UI] input `{ devices?: string[], home?: { pets?: string[], notes?: string } , forget?: string[] }` -> `{ kind:"closet", devices: string[], home, store: string, suggestion: { device, product: Product, evidence:{source, quote} } | null }`. `suggestion` is one proactive tip: the cheapest in-stock accessory THIS store lists for a remembered device (newest device first), with the store's quote; never a robot/vacuum, protection plan, trade-in or points item, never something already ordered here; null when nothing is listed or the catalog is unreachable. Only when devices were added.
5. `my_devices` [UI] input `{}` -> same shape as 4 (with `suggestion`).
6. `prepare_order` [UI] input `{ items: [{ id, qty }] }` -> `{ kind:"order_preview", items:[{product, qty, line_total}], subtotal, shipping: number|null, total, currency, confirmation_token, expires_at }`. `shipping` is null when the store policy is unknown (both demo stores): the total is then "before shipping and tax". Unavailable items are refused with a reason. Token = HMAC over user+items+total, 10 min.
7. `place_order` [UI] input `{ confirmation_token }` -> `{ kind:"order", order:{ id, status:"confirmed", created_at, eta, items, subtotal, shipping, total, currency, payment:"simulated (Amazon Wallet style)", store }, already_placed?: true }`. Bad/expired token -> error text, nothing placed. Replaying a used token returns the same order with `already_placed: true` (no second order). Stock and total are re-checked at placement.
8. `order_status` [UI] input `{ order_id?: string }` -> `{ kind:"orders", orders:[order] }` (latest first). Works in a new session for the same signed shopper. `eta` is the store config's demo estimate and is said and shown as such.
9. `talk_to_staff` input `{ reason: string, contact?: string }` -> `{ kind:"handoff", ticket_id, message }`. Notifies the store owner (Telegram if configured, else log).

## Errors
Tool errors return `isError: true` with a spoken-friendly `text` and `structuredContent: { kind:"error", code, message }`. Never throw raw stack traces.

Codes: `not_found`, `out_of_stock`, `invalid_input`, `device_required`, `anonymous` (no session: no closet, no orders), `token_invalid`, `token_expired`, `token_wrong_user`, `price_changed`, `catalog_unavailable`, `internal`.

## Changelog
- v1.5 (2026-10-12, after the live Haiku eval): additive. `products.out_of_stock_match`; the out-of-stock line survives `for_devices`; spoken lines capped at 2 sentences in code; a parts-list title ("Brush Cover for A, B, C, ...") is spoken by its head.
- v1.4 (2026-10-12): `remember_my_devices` and `my_devices` are [UI] tools (closet screen with the suggestion card).
- v1.3 (2026-10-12, round 2): additive. Signed session (`/auth/demo-login`, `Authorization: Bearer`, 401 on bad tokens) replaces the bare `x-user-id`; closet shared by every store; `compat.device_source`; `closet.store`, `closet.suggestion`; spoken compat answers from the closet and refusals with a quote and an alternative; order ETA labelled a demo estimate.
- v1.2 (2026-10-12, quality round 1): behaviour only, no shape change. Store negations -> `incompatible`; tags must be the device to confirm; `Product.image` is the Shopify CDN URL with `width=600`; find_products filters/speech rules above.
- v1.1 (2026-10-12, core implementation): additive only. `Product.variant`; `products.for_devices`, `products.max_price`; `compat.note`, `compat.also`; `order.subtotal`, `order.shipping`, `order.store`, `already_placed`; `shipping` nullable; error code list; `/stores/<id>/mcp` routes.
