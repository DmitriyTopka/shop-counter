# Shop Counter: product feedback, tool by tool

One section per tool we actually used, October 12-13, 2026. Versions are the ones in our lockfile. Where a problem cost us real time, the full story is in `docs/submission/friction_log.md` (entry number in brackets).

---

## 1. MCP specification 2025-11-25 (Streamable HTTP)

- **What we used it for:** The whole product. Shop Counter is a self-hosted MCP server with 9 tools, served over Streamable HTTP at `/mcp` (Satechi) and `/stores/roborock/mcp`. Every tool returns two things: one or two spoken sentences in `content[0].text` and a `structuredContent` object for the screen.
- **What works well:** That split between text and structured content fits a voice device with a screen almost perfectly. The voice line and the card come from the same call, so they can't disagree. Version negotiation is simple and honest: our client asks for 2025-11-25 and gets it; ask for 2025-06-18 and the server answers 2025-06-18.
- **What needs work:** The stateless story. Stateless is the natural mode on Lambda, but the spec reads as if sessions are the default, and the side effects (GET returns 405, the server can't see client capabilities on later requests) are left for you to find [3]. Identity is the other gap: outside full OAuth there's no lightweight pattern for "who is the shopper", so we wrote a signed demo session behind `Authorization: Bearer`.
- **Onboarding:** Reading the transport section and building a working `initialize -> tools/list -> tools/call` loop took a single spike, on day one.
- **Would we use it again:** Yes. It is the reason one server can face Alexa+, our simulator and any other MCP client without changes.

## 2. MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `client`, `core` 2.3.1, `node` 2.1.1)

- **What we used it for:** `McpServer` and `registerTool` with zod 4 schemas on the server; `Client` and `StreamableHTTPClientTransport` in the browser simulator and in both eval scripts.
- **What works well:** `createMcpHandler` gives you a web-standard `fetch(Request) -> Response` handler. The same handler runs under `node:http` (through `toNodeHandler`) and inside a Lambda Function URL, with a 62-line adapter (`apps/shop-counter/src/lambda.ts`). The client works unchanged in Node and in the browser.
- **What needs work:** The READMEs lead with the 2026-07-28 spec, which made us doubt whether v2 even speaks 2025-11-25. It does, by default, but we learned that from `.d.ts` comments [2]. `responseMode: 'json'` is silently ignored for 2025-era clients [4].
- **Onboarding:** Good once you know which package does what. The split into four packages is not explained in one place.
- **Would we use it again:** Yes.

## 3. MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **What we used it for:** All the Echo Show screens. `registerAppTool` and `registerAppResource` on the server serve `ui://shop-counter/view.html` (8 of 9 tools open a screen). In the view, the `App` class receives tool results and calls tools back (`app.callServerTool` for "Place order" and "Compare"). In the simulator, `AppBridge` and `PostMessageTransport` host it in a sandboxed iframe. We also send the shopper's card selection back with `ui/update-model-context`, so "compare them" by voice compares exactly the cards that were tapped.
- **What works well:** The round trip tool -> view -> button -> tool worked in the first spike, and the message order is easy to follow in a log. A single HTML file per app is a good constraint: one file draws 9 result kinds for us.
- **What needs work:** Bundle size: 589 KB for a view that only draws cards, because `App` pulls in zod with all its locales and the full client protocol [5]. Peer dependencies tie ext-apps 2.x to SDK v2, which isn't stated up front [2]. For web hosts, the recommended double iframe with a sandbox proxy and CSP enforcement is a lot of work for a hackathon; we did a single `sandbox="allow-scripts"` iframe and wrote that down as a known limit.
- **Onboarding:** The API reference is complete. A minimal "host in a web page" sample would have saved us reading the AppBridge source.
- **Would we use it again:** Yes. It is the most interesting part of this track.

## 4. Agent Skills (`SKILL.md`)

- **What we used it for:** `skills/shop-counter/SKILL.md` (frontmatter `name`, `description`) tells the Alexa+ model which tool to call for which phrase, how to speak on a device with a screen, the two-step order rule, and the facts it must never invent. Our simulator loads it into the model's system prompt.
- **What works well:** Plain Markdown, so the same file is documentation for humans and instructions for the model. A routing table ("will it work with my X" -> `check_compatibility`, leave `device` empty so the closet answers) changed behavior measurably: the live pass rate went from 61% to 72% after skill edits (we also corrected two scenario expectations in that round), with the right tool chosen in 18 of 18 scenarios.
- **What needs work:** We could not test the skill inside real Alexa+ [1], so we don't know how Alexa+ merges it with its own prompt. Rules about form (length) don't hold through a skill [11]. A validator or a reference loader would help.
- **Onboarding:** Fast. The format is small.
- **Would we use it again:** Yes, and we'd keep the habit of putting the routing table first.

## 5. AWS Lambda with a Function URL

- **What we used it for:** The live server: Node.js 22 on arm64, 256 MB, one esbuild bundle in a 594 KB zip, public Function URL with CORS for `authorization`, `mcp-protocol-version` and `mcp-session-id`. Live since October 12, 2026, at `https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/mcp`.
- **What works well:** A Function URL is HTTPS with no API Gateway, which is exactly what a stateless MCP endpoint needs. BUFFERED mode handles the one-message SSE response without any special code. The free tier covers a hackathon demo many times over.
- **What needs work:** Reserved concurrency can't be set at all on a new account, and the error doesn't say why [8]. A public URL needs two permission statements (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` via the URL), which is easy to get half right. Reading a file shipped next to the bundle needs `LAMBDA_TASK_ROOT` or an absolute path [9].
- **Onboarding:** The deploy script was written and run on the same evening; checked from a laptop right after: `initialize` returns 2025-11-25 and `tools/list` returns 9 tools.
- **Would we use it again:** Yes, for every MCP server that doesn't need streaming.

## 6. Amazon DynamoDB

- **What we used it for:** The shopper's device closet and orders, so memory survives across sessions and across Lambda instances. One on-demand table, items `{pk, doc, ver}`. Writes are a `Put` with a condition on `ver` and up to 5 retries. The closet key is per shopper (`shopper:<id>`) and shared by both stores; orders are per store.
- **What works well:** On-demand billing with zero setup. Conditional writes (`attribute_not_exists(pk) OR #v = :v`) give optimistic locking in a 67-line store (`apps/shop-counter/src/dynamo.ts`). Checked on the live endpoint: a device saved in one request is there in the next, separate request.
- **What needs work:** Optimistic locking is common enough that a documented helper in the JS SDK v3 lib (`lib-dynamodb`) would be welcome. We rejected transactions because they cost double the write capacity for this use.
- **Onboarding:** Smooth. Our tests run against a mocked client; we never needed DynamoDB Local.
- **Would we use it again:** Yes.

## 7. AWS CloudShell

- **What we used it for:** The entire deployment. Upload `function.zip` and `deploy_lambda.sh`, run one command. No AWS CLI on the laptop and no access keys created.
- **What works well:** For a team with no AWS tooling installed, this is the safest path we know: nothing secret ever leaves the browser.
- **What needs work:** Getting into the console as root was the hard part, not CloudShell itself [10].
- **Onboarding:** Minutes.
- **Would we use it again:** Yes, for one-off deploys.

## 8. Amazon CloudWatch and Amazon SNS

- **What we used it for:** A cost guard. A CloudWatch alarm on Lambda `Invocations` (over 2,000 in an hour) publishes to an SNS topic, which triggers a tiny "kill switch" Lambda that sets the server's reserved concurrency to 0. Logs are kept 14 days. A $1 AWS Budgets alert sits on top.
- **What works well:** Every piece is in the free tier, and the chain works without reserved concurrency being available.
- **What needs work:** It takes a second Lambda, a topic, a subscription, a permission and an alarm to say "turn this function off above N calls an hour". A built-in invocation cap on the function would replace all of it. Email subscriptions to the topic need a confirmation click that is easy to miss.
- **Onboarding:** Fine with the CLI; we would not have found the pattern from the console alone.
- **Would we use it again:** Yes, until there is a native cap.

## 9. Claude Haiku (`claude-haiku-5-5`) as the Alexa model in our simulator

- **What we used it for:** Playing Alexa+ in the simulator, since the real one isn't available to us [1]. Tools come from our server's `tools/list`; the browser runs every tool call through its own MCP client, so the JSON-RPC log shows each step. Effort `low`, prompt caching on the system prompt and tools, a $0.50 daily cap in code.
- **What works well:** Tool choice. In 18 live conversations (`evals/llm_run.mjs`) it picked the right tool 18 of 18 times, invented 0 facts, and ordered only after an explicit yes. It is cheap and quick: the whole first evaluation was 159 calls for $0.0322, a turn takes 2.0 to 2.6 seconds, and development plus both evals on October 12 cost $0.0436 together.
- **What needs work:** It doesn't stick to a length limit given in the prompt [11], it sometimes answers from a product title instead of calling the tool [12], and answers vary from run to run. Thinking blocks must be sent back unchanged, so a host can't trim the model's history; trim only what you speak.
- **Onboarding:** Fast with the Anthropic TypeScript SDK.
- **Would we use it again:** Yes, as the default model for voice prototypes.

## 10. Shopify storefront `products.json`

- **What we used it for:** Live catalogs of two real stores that are not ours: Satechi (141 products, 298 variants) and Roborock (311 products). `/products.json?limit=250&page=N`, one request per second, a clear User-Agent, a 6-hour cache. The open library `packages/shelf` turns any such feed into the same 9 MCP tools.
- **What works well:** No key, no partner account, the same shape on every Shopify store. Satechi keeps compatibility in tags (`iPhone 15` is on 61 products), which let us answer fit questions with a literal quote from the store, 0 mismatches against the raw feed.
- **What needs work:** Tags double as storefront labels: `magsafe charger` is on plain USB-C cables. `product_type` is unreliable: Roborock labels its F25 and H60 as "Robot Vacuums", and warranty plans and trade-ins sit in the same feed as products. Numbers in HTML descriptions are split by tags (`1<span>5</span> W`). There is no shipping data, so we say "before shipping and tax". Refurbished and new units share one image (40 pairs at Roborock). We classify items by title and parse with rules, and we say "unknown" rather than guess.
- **Onboarding:** Zero. The work is all in cleaning the data, and in checking each store's terms before reading its feed.
- **Would we use it again:** Yes. It's the fastest way to get a real catalog behind an Alexa+ demo.

## 11. Gemini TTS (demo video only, not part of the product)

- **What we used it for:** The four voices in our demo video (narrator, two shoppers, Alexa). Alexa's lines are word for word what the simulator said on the live run.
- **What works well:** Natural voices for English narration, and one voice per role stays consistent within a model (`gemini-3.8-flash-lite-tts`: Charon, Aoede, Puck, Kore). The second render was 25 requests, 25 successful.
- **What needs work:** The flash TTS model returned 429 after 8 requests with 22 seconds between them, and it was unclear whether the limit was per minute or per day. Switching to flash-lite changed the timbre mid-video, so we re-voiced everything on one model. Speech is slower than a real person; we sped it up 1.04 to 1.24x in the edit.
- **Onboarding:** Quick.
- **Would we use it again:** For drafts and demo videos, yes.
