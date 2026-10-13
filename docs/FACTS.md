# Shop Counter: facts and numbers

One source for every number we publish. README, the build log, Devpost text, the YouTube description and the
video cards take their numbers from here. If a number changes, change it here first, then everywhere it is quoted.

Last checked: 2026-10-13 (evening, for video v4).

## Server and endpoint

| Fact | Value | How it was checked |
|---|---|---|
| Repository | https://github.com/DmitriyTopka/shop-counter (MIT) | `curl -o /dev/null -w '%{http_code}'` -> 200, 2026-10-13 |
| Live MCP endpoint (Satechi) | https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/mcp | `curl .../health` -> `{"ok":true,...,"stores":["satechi","roborock"]}`, 2026-10-13 |
| Live MCP endpoint (Roborock) | same host, `/stores/roborock/mcp` | `tools/call` answered, 2026-10-13 |
| Hosted simulator | https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/sim/ (Maya and Sam are private per browser: each visit signs in a fresh guest) | `curl .../sim/` -> 200, 2026-10-13 |
| Model that plays Alexa | Claude Haiku 5.5 through the Anthropic API, called from the same Lambda (`POST /brain/turn`) | `curl .../brain/health` -> `"provider":"claude-api","model":"claude-haiku-5-5"`, 2026-10-13 |
| Account linking | OAuth 2.1 + PKCE S256, consent page "Link Shop Counter to Alexa" | flow run end to end on the live page while recording v4, 2026-10-13 |
| MCP spec | 2025-11-25, Streamable HTTP, stateless | `initialize` answers `protocolVersion: "2025-11-25"` (`npm run check` asserts it) |
| Tools | 9 | `find_products`, `compare_products`, `check_compatibility`, `remember_my_devices`, `my_devices`, `prepare_order`, `place_order`, `order_status`, `talk_to_staff` (`packages/shelf/src/server.ts`) |
| Tools with a screen (MCP Apps) | 8 of 9 | every tool except `talk_to_staff` |
| Lambda bundle | 597 KB (`dist/function.zip`, 596,907 bytes) | `ls -la apps/shop-counter/dist/function.zip`, built 2026-10-13 |

Note: first deployed on 2026-10-12. On 2026-10-13 the live server already answers in contract v1.6 wording
("The store lists it for iPhone 16, not your iPhone 16 Pro specifically"). Check this table after any redeploy.

## Catalogs

Snapshot used by the eval: Satechi fetched 2026-10-13T07:23Z, Roborock fetched 2026-10-12T13:27Z
(`apps/shop-counter/cache/`).

| Store | Products | Variants | Products with `compatible_with` | Distinct devices in `compatible_with` |
|---|---|---|---|---|
| Satechi | 141 | 298 | 134 (95%) | 24 |
| Roborock | 311 | 365 | 0 | 0 |

How the hero feature behaves on these catalogs (library `checkCompat` over every product, 2026-10-13):

- Satechi tags Apple devices: iPhone 15 is listed on 61 products, iPhone 16 on 63, iPhone 17 on 69, iPad Pro on 79,
  MacBook Air and MacBook Pro on 87 each. Only 9 products name a chip model (MacBook Air M2).
- Satechi never lists a Pro iPhone by name, so iPhone 15/16/17 Pro owners get `family_only`, never a yes.
  MacBook Air M3 or M4 owners get `family_only` too (the store lists "MacBook Air").
- Pixel, Galaxy S24 and Galaxy S25: no Satechi product lists them (`not_listed` on 140 of 141; the 141st is a
  Lightning cable, `incompatible` by the connector rule).
- Roborock has no device tags. Fit answers come from the product's own title and text ("for Saros 10R",
  "Not compatible with Saros 10R"): for example Saros 10R is named by 12 products, Q7 M5 by 9, Saros Z70 by 9.

## Evaluation

| Check | Result | Command | Date |
|---|---|---|---|
| Shopper eval (deterministic, offline) | 81/81, 0 fabricated facts, held-out 12/12, 122 tool answers audited (13 `hon-*` cases audit the meaning of the quote) | `npm run eval` | 2026-10-13, rerun for v4 |
| Unit tests | 173 (library 66, view 44, simulator router 29, server 34), no network | `npm test` | 2026-10-13, rerun for v4 |
| Live model eval (Claude Haiku 5.5 as Alexa) | 19/21 conversations pass every check; right tool 20/21; honesty check 20/21; form 20/21; $0.0152 | `node --import tsx evals/llm_run.mjs --budget 0.10` (21 scenarios, current code, local server on the snapshot) | 2026-10-13, rerun for v4 |
| Live end-to-end check against the real Satechi storefront | 29/29 | `cd apps/shop-counter && npm run check` | 2026-10-13 (fix pack run, per `docs/BUILD_LOG.md`; not rerun for this file) |

History, for the build log only: first shopper eval 17/39 with 2 fabricated facts; first live model run 13/18,
then 17/18 after the fixes (2026-10-12, 18 scenarios); 19/21 on the morning of 2026-10-13 and 19/21 again on the
rerun for v4 (the 81-case code). The shopper eval went 68/68 -> 81/81 when the 13 Roborock meaning cases were added.

The two live failures of the v4 rerun: in `c2-pro-series-only` the model's answer was right but 36 words long (form
check); in `c2-two-phones-ask` the model checked both remembered phones instead of asking which one, and said
"Yes" for the iPhone 15 and "the store doesn't list it" for the Galaxy S24. Each part is true, but the scenario
expects a question, and the honesty checker flags a "yes" on a turn whose main verdict is not_listed. The pet note
miss of the morning run did not repeat.

## Demo video

| Version | Length | File |
| --- | --- | --- |
| v5 (current) | 2:56 (176.1 s), 1920x1080 | `video/shop_counter_demo_v5.mp4`, https://youtu.be/uJhJDnPU-Dg |
| v4 | 2:52 (172.4 s), 1920x1080 | `video/shop_counter_demo_v4.mp4` |

Earlier cuts: v1 2:46, v2 2:48, v3 2:47. Only the current version is quoted in README and Devpost.

## Spend and limits

| Item | Value |
|---|---|
| Claude Haiku spend, local brain (evals, local runs) | $0.084 over 405 calls to 2026-10-13 12:20 UTC (`apps/echo-sim/server/usage.jsonl`) |
| Claude Haiku spend, hosted brain on the Lambda | $0.011 on 2026-10-13 (UTC) by 12:40, v4 recording included (`/brain/health` `spent_today`) |
| Claude Haiku daily cap | $0.50 a day and 60 turns an hour per visitor on the Lambda (`apps/shop-counter/src/brain.ts`); $0.50 a day in the local `brain.mjs`; over a cap the keyword router answers |
| Live model eval stop line | $0.90 per run (`--budget`, `evals/llm_run.mjs`) |
| AWS budget alert | $1 |
| Lambda kill switch | email warning above 2,000 invocations in one hour; above 15,000 -> CloudWatch alarm -> SNS -> concurrency set to 0; an hourly check switches it back on (`deploy/deploy_lambda.sh`; the alarms on AWS were not re-read for this file) |
| Lambda reserved concurrency | not available on this new account (account limit 10); the deploy script skips it |
| Logs | kept 14 days |
