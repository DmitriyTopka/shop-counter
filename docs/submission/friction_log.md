# Shop Counter: friction log

Everything below happened while building Shop Counter between October 12 and 13, 2026. Each entry points to the commit or file where we hit it or worked around it. Our build notes in `harness/`, `tasks/` and `spike/SPIKE_NOTES.md` are written in Russian; the code and commit messages are in English.

Severity scale: **High** = blocked a requirement or forced a redesign. **Medium** = cost hours or a non-obvious workaround. **Low** = annoying, fixed in minutes once understood.

---

### 1. The Alexa+ MCP Toolkit, CLI and Web Simulator are not available to participants

- **Tool:** Alexa+ MCP Toolkit, `@alexa-ai/cli`, Alexa+ Web Simulator
- **Task attempted:** Connect our MCP server to Alexa+ and test how Alexa speaks our tool results and renders our MCP App on an Echo Show.
- **Steps:** Read the hackathon Resources page and FAQ, looked for a test console or a sample add-on, searched the AmazonAppDev GitHub org.
- **Expected:** Some way to point a real (or simulated) Alexa+ at a self-hosted MCP server, even a limited one.
- **Actual:** The FAQ says the toolkit, CLI and simulator are not given to participants. There is no official Alexa+ MCP sample either. We never saw how the real Alexa+ trims, paraphrases or displays a tool result.
- **Severity:** High. It decided the architecture: we had to build our own Echo Show simulator as a real MCP client and MCP Apps host before we could test anything end to end.
- **Workaround:** `apps/echo-sim`: a browser Echo Show 8/15 that speaks MCP over Streamable HTTP, hosts the MCP App in a sandboxed iframe through `AppBridge`, and uses Claude Haiku as the "Alexa" model. Every guess about Alexa+ behavior (two spoken sentences, screen first) is written into our Agent Skill instead of verified.
- **Suggestion:** Publish a public, rate-limited "MCP add-on inspector": paste an HTTPS MCP URL, get Alexa+'s spoken answer and a screenshot of the rendered MCP App for one utterance. Even a recorded reference transcript for a sample server would help.
- **Evidence:** commit `4c2b95f` (simulator), `harness/PROJECT.md` Known issues.

### 2. `@modelcontextprotocol/ext-apps` 2.0.3 does not work with `@modelcontextprotocol/sdk` 1.x

- **Tool:** MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3), MCP TypeScript SDK
- **Task attempted:** Add an MCP App screen to a server built on the SDK most tutorials use, `@modelcontextprotocol/sdk@1.32.1`.
- **Steps:** `npm i @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps`, called `registerAppTool` on an `McpServer` from the 1.x package.
- **Expected:** The latest ext-apps works with the latest SDK.
- **Actual:** ext-apps 2.0.3 declares peer dependencies on the split v2 packages (`@modelcontextprotocol/core|client|server ^2.0.0`), not on `@modelcontextprotocol/sdk`. For 1.x you need ext-apps 1.7.x. On top of that, the v2 server and client READMEs say they implement the 2026-07-28 spec, while the hackathon requires 2025-11-25. We had to read `client/dist/index.d.mts` to learn that the v2 client defaults to `versionNegotiation: 'legacy'` and sends a plain `initialize` with 2025-11-25.
- **Severity:** Medium. It took a separate spike to sort out, plus the worry of picking the "wrong" SDK for judging.
- **Workaround:** Went with SDK v2 (`server|client|core` 2.3.1, `node` 2.1.1) and ext-apps 2.0.3, then proved the negotiated version on the wire: `initialize` returns `protocolVersion: "2025-11-25"` (our `npm run check` asserts it on every run).
- **Suggestion:** A compatibility table at the top of the ext-apps README (ext-apps 2.x needs SDK v2, ext-apps 1.7 for SDK 1.x), and one sentence in the v2 READMEs: "talks 2025-11-25 by default, opts into 2026-07-28 only when asked".
- **Evidence:** `spike/SPIKE_NOTES.md` (version table and `npm test` log), commit `88f35ad`.

### 3. Stateless Streamable HTTP: GET /mcp returns 405 and the server cannot see client capabilities

- **Tool:** MCP TypeScript SDK v2, `createMcpHandler(factory, { legacy: 'stateless' })`
- **Task attempted:** Run the server statelessly so it fits AWS Lambda (any request can land on any instance).
- **Steps:** Built one fresh `McpServer` per POST, connected a browser client.
- **Expected:** A quiet console, and the server knowing whether the client can show UI.
- **Actual:** (a) After `initialize`, the client opens an SSE stream with GET, the stateless handler answers 405, and the browser logs a red network error on every connect. It is spec-compliant, but it looks like a bug to anyone opening DevTools, including judges. (b) `tools/list` arrives at a server that never saw `initialize`, so `getClientCapabilities()` is empty and `getUiCapability()` cannot be used to hide screen tools from screenless clients.
- **Severity:** Low for (a), Medium for (b).
- **Workaround:** (a) Documented as expected. (b) We register all 8 screen tools for every client and put a speakable sentence in `content[0].text`, so a voice-only host can ignore `_meta.ui` and still answer.
- **Suggestion:** Have the client skip the GET stream when the server returned no `Mcp-Session-Id`, or log it at debug level. For stateless mode, document the capability gap and recommend the "always register, always include text" pattern.
- **Evidence:** `spike/SPIKE_NOTES.md` (section on stateless), `packages/shelf/src/server.ts`.

### 4. `responseMode: 'json'` still returns `text/event-stream` for 2025-11-25 clients

- **Tool:** MCP TypeScript SDK v2, `createMcpHandler`
- **Task attempted:** Return plain JSON from Lambda in BUFFERED mode, so `curl` output and Lambda logs are readable.
- **Steps:** `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' })`, then a raw `fetch` POST of `initialize`.
- **Expected:** `content-type: application/json`.
- **Actual:** `HTTP 200 content-type=text/event-stream`, body `event: message / data: {...}`. The option only applies to the 2026-07-28 era. Nothing in the option's name or JSDoc says so.
- **Severity:** Low. The SDK client parses it fine, and BUFFERED Lambda returns the whole stream body.
- **Workaround:** Kept SSE. Our own checks parse the `data:` line.
- **Suggestion:** Either honor `responseMode` for legacy requests (use `enableJsonResponse` underneath) or rename it / warn when it is ignored.
- **Evidence:** `spike/SPIKE_NOTES.md`, section "AWS Lambda", point 3 and the raw HTTP log.

### 5. An MCP App view that only draws cards weighed 589 KB

- **Tool:** MCP Apps (`App` class from `@modelcontextprotocol/ext-apps`), zod 4
- **Task attempted:** Ship one self-contained `view.html` for the Echo Show screens.
- **Steps:** Bundled a small carousel with esbuild into a single HTML file.
- **Expected:** Tens of kilobytes for a view with no framework.
- **Actual:** 589.0 KB. The `App` class pulls in zod (including 40+ locale bundles for error messages the view never shows) and the full client `Protocol`. On a real Echo Show this is a cold download before the first card appears.
- **Severity:** Medium.
- **Workaround:** Minified, and an esbuild plugin that resolves zod's `locales/index.js` to English only: 589 KB -> 356 KB (gzip about 97 KB) for the full product view. zod (188 KB) and `Protocol` (97 KB) are still the bulk.
- **Suggestion:** A lightweight `App` entry point for views (postMessage plus JSON-RPC framing, no runtime schema validation), or make validation pluggable so zod is tree-shaken out.
- **Evidence:** `packages/view/scripts/` (`zod-english-only` plugin), commit `4c2b95f`, `tasks/2026-10-12-mvp-shop-counter/REPORT.md`.

### 6. Clicks never reach an MCP App iframe placed inside a CSS-scaled device frame

- **Tool:** MCP Apps host side (`AppBridge`, `PostMessageTransport`) in a web simulator
- **Task attempted:** Draw the MCP App inside an Echo Show mockup that is laid out at 1280 px and scaled to fit the window.
- **Steps:** Put the sandboxed iframe inside the scaled screen element (`transform: scale(...)`), tapped "Place order" in the view, with both Playwright and a real mouse.
- **Expected:** The button fires `app.callServerTool`.
- **Actual:** Mouse clicks did not reach the button. A DOM `click()` did. `zoom` instead of `transform` behaved the same.
- **Severity:** Medium. It looks like a broken view, and the cause is in the host layout, far from the code you suspect.
- **Workaround:** The iframe lives in an unscaled layer above the device frame; the view scales itself from 1280 px.
- **Suggestion:** A note in the MCP Apps host guide: do not nest the app iframe under transformed ancestors; size it and let the view scale.
- **Evidence:** `tasks/2026-10-12-mvp-shop-counter/REPORT.md` (Surprises), `apps/echo-sim/src/apphost.ts`.

### 7. The rules disagree on whether the MCP server must stay live during judging

- **Tool:** Hackathon rules and FAQ (Alexa+ track)
- **Task attempted:** Decide whether hosting is needed.
- **Steps:** Read the FAQ ("a locally runnable public repo plus demo video is enough") and the discussion threads.
- **Expected:** One answer.
- **Actual:** The FAQ and one thread say hosting is optional; a later answer from a judge in another thread says the server "needs to be live and accessible till the end of the judging period".
- **Severity:** Medium. It moved AWS deployment, a cost guard and a kill switch into the critical path.
- **Workaround:** Deployed to AWS Lambda anyway, with a $1 budget alert and an hourly invocation cap, and we keep it live until results (early December). The repo also runs locally with 3 commands.
- **Suggestion:** Update the FAQ with the final answer and pin it.
- **Evidence:** `harness/PROJECT.md` Known issues and "live server" section, commit `02a7709`.

### 8. Reserved concurrency fails on a new AWS account

- **Tool:** AWS Lambda
- **Task attempted:** Cap the function at 5 concurrent executions as a cost guard.
- **Steps:** `aws lambda put-function-concurrency --reserved-concurrent-executions 5` from CloudShell during deploy.
- **Expected:** Success, it is the documented way to cap a function.
- **Actual:** Rejected. A new account has an account-wide concurrency limit of 10, and Lambda requires 10 to stay unreserved, so nothing can be reserved at all. The error does not suggest what to do next.
- **Severity:** Medium. Our deploy script used `set -e` and stopped halfway.
- **Workaround:** The reservation is now optional. The kill switch still works, because setting reserved concurrency to 0 never lowers the unreserved pool.
- **Suggestion:** Mention the new-account limit in the error text and in the "Reserved concurrency" docs, with the Service Quotas link.
- **Evidence:** commit `02a7709` (`apps/shop-counter/deploy/deploy_lambda.sh`), `harness/LESSONS.md`.

### 9. On Lambda, a path that works in the monorepo points one level above the code

- **Tool:** AWS Lambda (Node.js 22, ESM bundle in a zip)
- **Task attempted:** Serve `view.html` (the MCP App) from the same zip as `lambda.mjs`.
- **Steps:** The server finds the view relative to `import.meta.url`, one directory up (`apps/shop-counter/dist/.. -> apps/shop-counter`). In the zip both files sit flat in `/var/task`.
- **Expected:** The same relative lookup to work.
- **Actual:** On Lambda, "one up" is `/var`, so the lookup misses and the server would quietly serve its built-in placeholder view. No error, just a blank card.
- **Severity:** Low.
- **Workaround:** The deploy script sets `SHOP_COUNTER_VIEW_HTML=/var/task/view.html`, and the env path wins over the guesses.
- **Suggestion:** In the Lambda Node.js docs, one example of reading a file shipped in the zip with `LAMBDA_TASK_ROOT`.
- **Evidence:** `apps/shop-counter/deploy/deploy_lambda.sh` (ENV line), `apps/shop-counter/src/app.ts` (`VIEW_CANDIDATES`), commit `02dcbc3`.

### 10. AWS root sign-in fails at MFA when an AWS Builder ID session is open

- **Tool:** AWS Management Console sign-in, AWS Builder ID
- **Task attempted:** Sign in as root to open CloudShell for the deploy.
- **Steps:** In a browser already signed in to AWS Builder ID (needed for the hackathon), chose root user sign-in, entered the email and password.
- **Expected:** Normal root sign-in.
- **Actual:** Builder ID kept taking over the sign-in flow, and the root sign-in died at the MFA step with "Unexpected error".
- **Severity:** Medium. A non-developer on our team lost real time here and could not tell what was wrong.
- **Workaround:** "Add session" -> root user email, in the same tab the deploy ran in.
- **Suggestion:** Detect the open Builder ID session and say so ("You are signed in with Builder ID. Continue as root in a new session?") instead of a generic error.
- **Evidence:** `harness/LESSONS.md` (2026-10-12, AWS sign-in).

### 11. The model ignores a length rule written in the prompt

- **Tool:** Claude Haiku (`claude-haiku-5-5`) as the Alexa model in our simulator, with our Agent Skill in the system prompt
- **Task attempted:** Keep every spoken reply to at most two short sentences, as Alexa would.
- **Steps:** Wrote the rule in `skills/shop-counter/SKILL.md`, ran 18 live conversations (`evals/llm_run.mjs`).
- **Expected:** The rule holds.
- **Actual:** It held in 13 of 18 scenarios. The model added "Want me to...?" after the tool's two sentences in 7 of 28 turns. We could not trim the model's own history either: Haiku's thinking blocks are tied to the exact history and must be sent back unchanged.
- **Severity:** Medium.
- **Workaround:** Length is enforced in code: the server cuts tool lines to two sentences (`clampSpeech`), the host trims what it speaks and leaves the history alone. Live run went from 13/18 to 17/18 passing scenarios, 0 made-up facts.
- **Suggestion:** For voice hosts, document a recommended place to enforce output length (host side, not prompt), and how to post-process speech without touching thinking-signed history.
- **Evidence:** commits `8440531`, `96e6014`, `tasks/2026-10-12-live-haiku-eval/REPORT.md`.

### 12. The model answered a fit question from the product title and skipped the tool

- **Tool:** Claude Haiku tool use, our `check_compatibility` MCP tool
- **Task attempted:** "Will the Accessories Pack for Saros 10 fit my robot?", expected to go through `check_compatibility` so the screen shows the store's quote.
- **Steps:** Live conversation as shopper Sam, Saros 10R in his device closet.
- **Expected:** A `check_compatibility` call.
- **Actual:** The product title already contained "(Not compatible with Saros 10R)", and the model answered from it directly. The fact was right, the path was not: no quote card on screen. Separately, the item was out of stock, and `find_products` did not return its id at all, so the tool could not have been called.
- **Severity:** Medium. Our scenario checker only looked at the spoken phrase and passed it.
- **Workaround:** A named out-of-stock product now comes back with its id and `available: false` (contract v1.5), and the skill tells the model to check fit through the tool. On the recorded demo run the refusal did go through `check_compatibility`. Our scenario file still accepts the phrase alone for this turn; making it assert the call is an open item.
- **Suggestion:** None for the model. For anyone writing evals for MCP add-ons: assert on tool calls, not only on the final sentence.
- **Evidence:** commit `96e6014`, `harness/LESSONS.md`, `video/capture/transcript.json`.
