# Echo Show simulator (Alexa+ stand-in)

A browser Echo Show 8 / 15 that is a real MCP client (Streamable HTTP, protocol 2025-11-25) and a real MCP Apps host. The closed Alexa+ toolkit is not available to hackathon entrants, so this plays the Alexa+ layer; the Shop Counter server behind it is the real product.

```bash
cd apps/shop-counter && npm run dev   # MCP server on :8787 (Satechi at /mcp, Roborock at /stores/roborock/mcp)
cd apps/echo-sim && npm run brain     # optional: Claude Haiku "Alexa" on :8788 (needs ANTHROPIC_API_KEY)
cd apps/echo-sim && npm run dev       # http://localhost:5180  (?user=maya | sam, &store=satechi | roborock, &device=show15, &log, &video, &mute)
```

Without the brain (no key, daily cap reached, or API down) the simulator uses `src/router.ts`, a keyword router with no LLM, so the demo always works.

## Shopper, store, session

- **Shopper and store are picked separately** (top bar). The device closet belongs to the shopper and is shared by every store: tell Satechi about your iPhone 15 and Roborock Q7 M5, switch the store to Roborock, ask "What devices do I have?". Orders stay per store.
- **Signed session.** On connect the simulator calls the server's demo login (`POST /auth/demo-login {"profile":"maya"}`, proxied by Vite like `/mcp`) and sends `Authorization: Bearer <session>` on every MCP request. The server takes the shopper only from that token. On a real Alexa+ add-on this would be account linking.
- **URL flags:** `?log` opens the MCP activity panel (folded by default, key L toggles it); `?video` gives a clean frame for recording (no log, no "who plays Alexa" badge); `?store=roborock` starts at Roborock.

## The brain loads the Shop Counter Agent Skill

`server/brain.mjs` builds its system prompt from a short Alexa persona plus the Agent Skill at [`skills/shop-counter/SKILL.md`](../../skills/shop-counter/SKILL.md) (the same file an Alexa+ or any MCP host would load next to our server). The YAML frontmatter (`name`, `description`) is read for the skill name; the body goes into the prompt inside `<skill name="shop-counter">`. The skill teaches:

- which tool for which request (including "anything cheaper?", "order the same again", and what goes to `talk_to_staff`: coupons, warranty, returns, shipping cost, delivery promises, cancellations);
- how to speak on a device with a screen: one short line, the screen carries the details, never read out all three prices;
- facts it must never invent: compatibility only with `status: "confirmed"`, MagSafe vs Qi2, stock, "before shipping and tax";
- two-step ordering: `prepare_order`, then `place_order` only after a clear yes;
- the device closet: remember once, shared by every store, used automatically; "my phone" means "look in the closet", never ask for a model the closet already has.

Check it loaded: `npm run brain` prints `[brain] skill: shop-counter (...)`, and `GET /brain/health` returns `"skill":"shop-counter"`. Another file: `SKILL_PATH=/path/to/SKILL.md npm run brain`. The system prompt is sent with `cache_control`, so the larger prompt (about 6.3K characters) is paid in full once and then read from cache at 0.1x.

## Marked cards reach the conversation

When the shopper marks cards in the carousel, the view sends the MCP Apps request `ui/update-model-context` (`App.updateModelContext`) with the marked titles and `structuredContent.selected_ids`. The host (`src/apphost.ts`) declares `updateModelContext` in its capabilities and:

- keeps the ids in `screen.selected`, so the offline router's "compare them" compares the marked cards;
- sends the latest context to the brain as a `[screen] ...` text block in front of the next user message (as the spec says: deferred until the next message, last update wins).

## Tests

```bash
npm test              # router tests (no network)
npm run shoot         # screenshots via headless Chrome (needs playwright-core, see scripts/shoot.mjs)
```

The shopper eval for the whole stack lives in [`evals/`](../../evals): `npm run eval` from the repo root.
