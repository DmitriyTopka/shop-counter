# Build log

How Shop Counter was built, day by day, inside the submission period (October 12 to 13, 2026, Kyiv time).
The public repository is published as a single snapshot, so this file is the history. Numbers are from the
runs on that day; where a later run changed them, both are given.

Most of the code was written by an AI coding agent from short written briefs. Every step had a brief, a plan
with a budget of files, and a report checked by a person before the next step started. Twice the whole project
was put in front of an independent five-perspective review (a skeptic, an architect, a visionary, an outsider
and a pragmatist reading the code and running the checks) and the findings were fixed before moving on.

## Before writing product code: a spike (October 12)

A throwaway prototype answered three questions before any product code existed.

- **Which SDK.** `@modelcontextprotocol/ext-apps` 2.0.3 needs the split v2 SDK packages, not
  `@modelcontextprotocol/sdk` 1.x, and the v2 READMEs describe a newer spec than the hackathon's. We read the
  client typings, then checked the wire: the v2 client sends a plain `initialize` and the server answers
  `protocolVersion: "2025-11-25"`. Chosen: `@modelcontextprotocol/server|client|core` 2.3.1, `node` 2.1.1,
  ext-apps 2.0.3, zod 4.
- **Sessions or stateless.** Stateless (`createMcpHandler(factory, { legacy: 'stateless' })`, a fresh
  `McpServer` per POST), so any Lambda instance can answer any request. Two side effects found here:
  the client's GET for an SSE stream gets a spec-compliant 405, and a stateless server never sees the client's
  capabilities, so every screen tool also returns a speakable sentence.
- **Lambda shape.** Function URL in BUFFERED mode with one esbuild bundle and no `node_modules`.
  `responseMode: 'json'` does not apply to 2025-11-25 requests: answers stay `text/event-stream`.
- **View size.** A view that only draws cards bundled to 589 KB (zod with all its locales, plus the client
  protocol). An esbuild plugin that keeps only the English locale brought the full view to about 356 KB.

## October 12: the core

- **Library and server.** `packages/shelf` (npm name `shelf-to-alexa`): Shopify `/products.json` adapter
  (one page a second, honest User-Agent, 6-hour disk cache), normalization (one product per variant, US plug
  first), rule-based extraction of watts, ports, wireless standards and devices, BM25F search, and the 9 MCP
  tools. `apps/shop-counter` serves Satechi at `/mcp` and Roborock at `/stores/roborock/mcp`. A live check
  against the real Satechi storefront asserts the protocol version, the tool list and every price, stock flag
  and quote in the answers (28 checks that day).
- **Echo Show simulator and MCP App view.** The Alexa+ toolkit is not available to participants, so
  `apps/echo-sim` is a browser Echo Show 8 and 15 that is a real MCP client over Streamable HTTP and hosts the
  MCP App in a sandboxed iframe through `AppBridge`. Claude Haiku plays Alexa through a small proxy with a daily
  spending cap; without a key, a keyword router takes over. `packages/view` is one HTML file that draws every
  result kind. Clicks did not reach an iframe nested under a CSS-scaled device frame; the iframe now sits in an
  unscaled layer.

## October 12: measuring honesty

- **Shopper eval.** `evals/run.mjs` replays real shopper requests through a real MCP client on a frozen catalog
  snapshot and audits every price, stock flag and quote against the raw feed. Baseline: 17 of 39 requests
  behaved as expected, and 2 answers contained made-up facts: a USB-C cable called "MagSafe" because of a
  merchandising tag, and a "yes" built from the store's own "Not compatible with Saros 10R".
- **Quality round 1.** The store's negation now means "incompatible", a tag proves fit only when the tag is the
  device itself, product type (robot, stick vacuum, warranty plan, trade-in) is read from the product name before
  ranking, and search scores fields separately. Result: 51 of 51, 0 made-up facts; 12 more requests written
  afterwards as a held-out set passed 9 of 12 on the first run.
- **Agent Skill.** `skills/shop-counter/SKILL.md`: which tool for which phrase, how to speak on a screen device,
  what never to invent. It is loaded into the simulator's model.

## October 12: first review and round 2

- **First review.** Verdict: the core was solid, but the strongest idea, a closet of the shopper's devices, was
  invisible to judges, the framing read as "a store chatbot inside Alexa", and nothing was hosted.
- **Round 2.** The closet now belongs to the shopper and is shared by every store; "will this work with my
  phone?" is answered from it. Identity moved from a bare header to a signed demo session
  (`POST /auth/demo-login`, `Authorization: Bearer`, 401 on a forged or expired token). A DynamoDB state store
  with versioned writes, a CloudShell deploy script, a "My devices" screen and a two-step order preview
  ("Say confirm to buy"). Eval: 57 of 57, 0 made-up facts.

## October 12, evening: the live model, then AWS

- **Live model eval.** `evals/llm_run.mjs` runs 18 multi-turn conversations with Claude Haiku against the real
  server. The model chose the right tool 18 of 18 times and invented nothing, but a prompt rule kept replies to
  two sentences in only 13 of 18. It also once answered a fit question from a product title that said
  "(Not compatible with Saros 10R)" without calling the tool, because that product was out of stock and its id
  was never returned.
- **Fixes.** Speech length is enforced in code (tool lines are cut to two sentences on the server, the host trims
  what it speaks). A named out-of-stock product now comes back with its id and `available: false`, so its fit
  can still be checked. Live run: 17 of 18. Total API spend for development and both live evals: $0.04.
- **Deploy.** AWS Lambda (Node.js 22, arm64, 256 MB) with a Function URL, a DynamoDB on-demand table, logs kept
  14 days, a $1 budget alert, and a kill switch (more than 2,000 invocations in an hour sets concurrency to 0).
  A new account cannot reserve concurrency at all, so the reservation became optional. The root sign-in failed
  at MFA while an AWS Builder ID session was open in the same browser; "Add session" got around it. Verified
  from outside: `initialize` answers 2025-11-25, 9 tools, the closet survives separate requests, a forged token
  gets 401.

## October 13, morning: the demo video

- **v1.** Recorded live against the Lambda server with Claude Haiku as Alexa; Alexa's lines in the video are
  word for word from that run. Narrator and shopper voices are TTS. 2:46.
- **v2.** A bigger Echo Show with a slow push-in, shots without the simulator's caption, one TTS model for all
  voices and a gentler tempo. 2:48.
- **Submission drafts.** The friction log and product feedback in `docs/submission/`.

## October 13: second review and fix pack

- **Second review.** The project passed every stage-one check, but the skeptic broke "zero made-up facts" in
  three requests: a closet with an iPhone 17 Pro got "works with your iPhone 17 Pro" because the store tags only
  "iPhone 17"; a MacBook Pro of any year matched a bare "MacBook Pro" tag; "my phone" picked one of two phones
  silently; and a device named in the request lost to the closet. The video also showed a phone icon next to a
  robot vacuum and read a pet note aloud.
- **Fix pack (contract v1.6).** "Confirmed" now needs the exact model. A series or family listing is a new status,
  `family_only`, spoken as "The store lists iPhone 17, not your iPhone 17 Pro specifically". The closet keeps the
  device as the shopper named it ("MacBook Pro 2017 Intel"), and parsing is used only for matching. "My phone"
  with two phones on file returns `device_ambiguous` with the options, so the shopper is asked. A device named
  in the request beats the closet, and a bare "Pixel" or "Galaxy" asks for the model. Device icons follow the
  device kind. Answers say "the store lists it" instead of "confirmed by the store", and "my devices" no longer
  reads pets aloud. Eleven new eval requests cover these cases: 68 of 68, 0 made-up facts; 143 unit tests;
  29 of 29 live checks against Satechi.

## October 13, afternoon: live model rerun and video v3

- **Live model eval, 21 scenarios.** Three new scenarios cover the fix pack. 19 of 21 pass every check, right tool
  19 of 21, 0 invented facts in 21 of 21, $0.0154 for the run. One miss is the model's (it read a pet note aloud),
  the other is our checker (the model asked "which phone?" correctly and a generic rule flagged it).
- **v3.** Opens on the honest "no" for Sam's Saros 10R, recorded live with Claude Haiku as Alexa. 2:47.
- **One file for numbers.** `docs/FACTS.md` now holds every number we publish, with the command behind it.

## October 13, evening: Alexa moves to the Lambda, simulator on the Lambda

- **Update after deploy.** Our AWS account answers "not available for this account" for every Bedrock model (checked in
  the console on Claude Haiku 4.5 and GPT-5.6 Luna; Claude Haiku 5.5 is not listed on Bedrock at all). Other new
  hackathon accounts reported the same. The live brain therefore calls Claude Haiku 5.5 through the Anthropic API
  from the Lambda; the Bedrock code below stays behind a flag. First live turn: HTTP 200, $0.0004.

- **No install, no keys.** Judges look after our API credit runs out, so the model that plays Alexa moved to Amazon
  Bedrock: Claude Haiku 5.5 through Claude in Amazon Bedrock, called from the shop-counter Lambda with its IAM role.
  The wire format stayed the Anthropic Messages format, so the simulator did not change. Amazon Nova Lite through the
  Converse API sits behind a flag in case Anthropic model access is not granted.
- **One link.** The simulator build is served by the same Lambda at `/sim/`, next to `/mcp` and `/brain/turn`.
- **Spend has a ceiling in code**: $0.50 a day and 60 model turns an hour per visitor, counted with atomic adds in the
  DynamoDB table we already had. Over it the simulator falls back to its keyword router.
- **Checks.** 15 new unit tests (limits, format translation, the real Bedrock SDK signing a request against a mocked
  network, static files). 158 unit tests in all, eval 68 of 68. The live Bedrock call is checked by the deploy script
  itself, after deploy.

## October 13: account linking

- **Why.** The demo login was the one place where we said "on Alexa+ this would be OAuth". Alexa+ links accounts
  with OAuth, and the MCP Authorization spec 2025-11-25 says how an MCP server should take part, so we built it.
- **What.** A minimal OAuth 2.1 authorization server inside the same Lambda: resource and server metadata
  (RFC 9728, RFC 8414), Client ID Metadata Documents and dynamic registration, PKCE S256 only, resource
  indicators (RFC 8707), a consent page, a 1-hour access token that is the existing signed session plus an
  audience, and refresh tokens that rotate. Codes and tokens are HMAC-signed, so no session table; one-time use
  goes through the same state store as order confirmations (a conditional write in DynamoDB). Dynamic
  registration needs no storage either: the client id is the signed registration.
- **The simulator** got a "Link account" button that runs the real flow in the browser. Two things broke on the
  first try: `Referrer-Policy: no-referrer` made Chrome send `Origin: null` on the consent form, which the local
  server refuses, and a `form-action 'self'` CSP blocked the redirect back to the app. Both are fixed and the
  flow was checked by hand in Chrome.
- **Tests.** 9 new server tests: the full flow, a wrong PKCE verifier, a foreign `redirect_uri`, a replayed and
  an expired code, a token for another store, refresh rotation, metadata documents. 152 unit tests in all;
  the eval stays at 68 of 68 with the demo login.

## October 13, evening: video v4

- **Recorded on the hosted page.** Every turn in v4 ran on the public simulator at `/sim/`: the live MCP server on
  AWS Lambda, Claude Haiku 5.5 as Alexa through the Anthropic API called from the same Lambda, the closet in
  DynamoDB. Each browser was a fresh private shopper, so no old test data shows up on screen.
- **What changed in the story.** The hook is still Sam's honest "no", now with the $19.99 part that fits said out
  loud. One card follows with the formula: Alexa understands what you mean, the store answers for the facts. Then
  one line on why a simulator: the Alexa+ MCP toolkit is not open to hackathon builders. Sam's memory happens on
  screen: he names his Saros 10R at Satechi, moves to Roborock, says only "my robot", and the JSON-RPC log shows
  `"device": "my robot"` going to the server. Maya taps Place order instead of saying it, and the account
  linking consent page is shown. The final card has the live link and the repository. 2:52.
- **Sound.** A quiet pad made in code under the voices. Every Gemini TTS clip turned out to end with a short
  full-scale noise burst after the speech; earlier cuts kept it. The builder now cuts it, and the mix sits at
  -16.1 LUFS with the true peak at -4.1 dBFS.
- **Small fixes found on the way.** The verdict line "Your Saros 10R · remembered" drew a phone icon; it now uses
  the device's own icon (new view test). Sam's descriptions on the consent page and in the simulator config no
  longer mention a cat. Not deployed yet: the v4 shots get these two from the committed code at capture time, and
  `video/script.md` says where.
- **Numbers rerun.** Shopper eval 81 of 81, 0 made-up facts; 173 unit tests; live model 19 of 21 conversations,
  right tool 20 of 21, $0.015 for the run.

## Where to verify

```bash
npm test                                   # library, server, view, simulator router
npm run eval                               # 81 shopper requests on a frozen snapshot, honesty audit, no network
cd apps/shop-counter && npm run check      # live end-to-end check against the real Satechi storefront
```

`docs/CONTRACT.md` keeps a changelog of every contract version from v1.1 to v1.7.
