# Shop Counter: friction log

Everything below happened while building Shop Counter between October 12 and 13, 2026. Each entry points to the file in the repository where we hit it or worked around it, and to the day in `docs/BUILD_LOG.md` where the story is told in order.

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
- **Evidence:** `apps/echo-sim/` (the simulator), `docs/BUILD_LOG.md` (October 12: the core).

### 2. `@modelcontextprotocol/ext-apps` 2.0.3 does not work with `@modelcontextprotocol/sdk` 1.x

- **Tool:** MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3), MCP TypeScript SDK
- **Task attempted:** Add an MCP App screen to a server built on the SDK most tutorials use, `@modelcontextprotocol/sdk@1.32.1`.
- **Steps:** `npm i @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps`, called `registerAppTool` on an `McpServer` from the 1.x package.
- **Expected:** The latest ext-apps works with the latest SDK.
- **Actual:** ext-apps 2.0.3 declares peer dependencies on the split v2 packages (`@modelcontextprotocol/core|client|server ^2.0.0`), not on `@modelcontextprotocol/sdk`. For 1.x you need ext-apps 1.7.x. On top of that, the v2 server and client READMEs say they implement the 2026-07-28 spec, while the hackathon requires 2025-11-25. We had to read `client/dist/index.d.mts` to learn that the v2 client defaults to `versionNegotiation: 'legacy'` and sends a plain `initialize` with 2025-11-25.
- **Severity:** Medium. It took a separate spike to sort out, plus the worry of picking the "wrong" SDK for judging.
- **Workaround:** Went with SDK v2 (`server|client|core` 2.3.1, `node` 2.1.1) and ext-apps 2.0.3, then proved the negotiated version on the wire: `initialize` returns `protocolVersion: "2025-11-25"` (our `npm run check` asserts it on every run).
- **Suggestion:** A compatibility table at the top of the ext-apps README (ext-apps 2.x needs SDK v2, ext-apps 1.7 for SDK 1.x), and one sentence in the v2 READMEs: "talks 2025-11-25 by default, opts into 2026-07-28 only when asked".
- **Evidence:** `package.json` files (pinned versions), `apps/shop-counter/check.mjs` (asserts `protocolVersion` 2025-11-25), `docs/BUILD_LOG.md` (the spike).

### 3. Stateless Streamable HTTP: GET /mcp returns 405 and the server cannot see client capabilities

- **Tool:** MCP TypeScript SDK v2, `createMcpHandler(factory, { legacy: 'stateless' })`
- **Task attempted:** Run the server statelessly so it fits AWS Lambda (any request can land on any instance).
- **Steps:** Built one fresh `McpServer` per POST, connected a browser client.
- **Expected:** A quiet console, and the server knowing whether the client can show UI.
- **Actual:** (a) After `initialize`, the client opens an SSE stream with GET, the stateless handler answers 405, and the browser logs a red network error on every connect. It is spec-compliant, but it looks like a bug to anyone opening DevTools, including judges. (b) `tools/list` arrives at a server that never saw `initialize`, so `getClientCapabilities()` is empty and `getUiCapability()` cannot be used to hide screen tools from screenless clients.
- **Severity:** Low for (a), Medium for (b).
- **Workaround:** (a) Documented as expected. (b) We register all 8 screen tools for every client and put a speakable sentence in `content[0].text`, so a voice-only host can ignore `_meta.ui` and still answer.
- **Suggestion:** Have the client skip the GET stream when the server returned no `Mcp-Session-Id`, or log it at debug level. For stateless mode, document the capability gap and recommend the "always register, always include text" pattern.
- **Evidence:** `apps/shop-counter/src/app.ts` (stateless handler), `packages/shelf/src/server.ts`, `docs/BUILD_LOG.md` (the spike).

### 4. `responseMode: 'json'` still returns `text/event-stream` for 2025-11-25 clients

- **Tool:** MCP TypeScript SDK v2, `createMcpHandler`
- **Task attempted:** Return plain JSON from Lambda in BUFFERED mode, so `curl` output and Lambda logs are readable.
- **Steps:** `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' })`, then a raw `fetch` POST of `initialize`.
- **Expected:** `content-type: application/json`.
- **Actual:** `HTTP 200 content-type=text/event-stream`, body `event: message / data: {...}`. The option only applies to the 2026-07-28 era. Nothing in the option's name or JSDoc says so.
- **Severity:** Low. The SDK client parses it fine, and BUFFERED Lambda returns the whole stream body.
- **Workaround:** Kept SSE. Our own checks parse the `data:` line.
- **Suggestion:** Either honor `responseMode` for legacy requests (use `enableJsonResponse` underneath) or rename it / warn when it is ignored.
- **Evidence:** `apps/shop-counter/check.mjs` (parses the `data:` line), `docs/BUILD_LOG.md` (the spike, "Lambda shape").

### 5. An MCP App view that only draws cards weighed 589 KB

- **Tool:** MCP Apps (`App` class from `@modelcontextprotocol/ext-apps`), zod 4
- **Task attempted:** Ship one self-contained `view.html` for the Echo Show screens.
- **Steps:** Bundled a small carousel with esbuild into a single HTML file.
- **Expected:** Tens of kilobytes for a view with no framework.
- **Actual:** 589.0 KB. The `App` class pulls in zod (including 40+ locale bundles for error messages the view never shows) and the full client `Protocol`. On a real Echo Show this is a cold download before the first card appears.
- **Severity:** Medium.
- **Workaround:** Minified, and an esbuild plugin that resolves zod's `locales/index.js` to English only: 589 KB -> 356 KB (gzip about 97 KB) for the full product view. zod (188 KB) and `Protocol` (97 KB) are still the bulk.
- **Suggestion:** A lightweight `App` entry point for views (postMessage plus JSON-RPC framing, no runtime schema validation), or make validation pluggable so zod is tree-shaken out.
- **Evidence:** `packages/view/scripts/build.mjs` (`zod-english-only` plugin), `docs/BUILD_LOG.md` (the spike, "View size").

### 6. Clicks never reach an MCP App iframe placed inside a CSS-scaled device frame

- **Tool:** MCP Apps host side (`AppBridge`, `PostMessageTransport`) in a web simulator
- **Task attempted:** Draw the MCP App inside an Echo Show mockup that is laid out at 1280 px and scaled to fit the window.
- **Steps:** Put the sandboxed iframe inside the scaled screen element (`transform: scale(...)`), tapped "Place order" in the view, with both Playwright and a real mouse.
- **Expected:** The button fires `app.callServerTool`.
- **Actual:** Mouse clicks did not reach the button. A DOM `click()` did. `zoom` instead of `transform` behaved the same.
- **Severity:** Medium. It looks like a broken view, and the cause is in the host layout, far from the code you suspect.
- **Workaround:** The iframe lives in an unscaled layer above the device frame; the view scales itself from 1280 px.
- **Suggestion:** A note in the MCP Apps host guide: do not nest the app iframe under transformed ancestors; size it and let the view scale.
- **Evidence:** `apps/echo-sim/src/apphost.ts`, `docs/BUILD_LOG.md` (October 12: the core).

### 7. The rules disagree on whether the MCP server must stay live during judging

- **Tool:** Hackathon rules and FAQ (Alexa+ track)
- **Task attempted:** Decide whether hosting is needed.
- **Steps:** Read the FAQ ("a locally runnable public repo plus demo video is enough") and the discussion threads.
- **Expected:** One answer.
- **Actual:** The FAQ and one thread say hosting is optional; a later answer from a judge in another thread says the server "needs to be live and accessible till the end of the judging period".
- **Severity:** Medium. It moved AWS deployment, a cost guard and a kill switch into the critical path.
- **Workaround:** Deployed to AWS Lambda anyway, with a $1 budget alert and an hourly invocation cap, and we keep it live until results (early December). The repo also runs locally with 3 commands.
- **Suggestion:** Update the FAQ with the final answer and pin it.
- **Evidence:** `apps/shop-counter/deploy/deploy_lambda.sh` (budget alert and kill switch), `docs/BUILD_LOG.md` (October 12, evening: Deploy).

### 8. Reserved concurrency fails on a new AWS account

- **Tool:** AWS Lambda
- **Task attempted:** Cap the function at 5 concurrent executions as a cost guard.
- **Steps:** `aws lambda put-function-concurrency --reserved-concurrent-executions 5` from CloudShell during deploy.
- **Expected:** Success, it is the documented way to cap a function.
- **Actual:** Rejected. A new account has an account-wide concurrency limit of 10, and Lambda requires 10 to stay unreserved, so nothing can be reserved at all. The error does not suggest what to do next.
- **Severity:** Medium. Our deploy script used `set -e` and stopped halfway.
- **Workaround:** The reservation is now optional. The kill switch still works, because setting reserved concurrency to 0 never lowers the unreserved pool.
- **Suggestion:** Mention the new-account limit in the error text and in the "Reserved concurrency" docs, with the Service Quotas link.
- **Evidence:** `apps/shop-counter/deploy/deploy_lambda.sh` (optional reservation), `docs/BUILD_LOG.md` (October 12, evening: Deploy).

### 9. On Lambda, a path that works in the monorepo points one level above the code

- **Tool:** AWS Lambda (Node.js 22, ESM bundle in a zip)
- **Task attempted:** Serve `view.html` (the MCP App) from the same zip as `lambda.mjs`.
- **Steps:** The server finds the view relative to `import.meta.url`, one directory up (`apps/shop-counter/dist/.. -> apps/shop-counter`). In the zip both files sit flat in `/var/task`.
- **Expected:** The same relative lookup to work.
- **Actual:** On Lambda, "one up" is `/var`, so the lookup misses and the server would quietly serve its built-in placeholder view. No error, just a blank card.
- **Severity:** Low.
- **Workaround:** The deploy script sets `SHOP_COUNTER_VIEW_HTML=/var/task/view.html`, and the env path wins over the guesses.
- **Suggestion:** In the Lambda Node.js docs, one example of reading a file shipped in the zip with `LAMBDA_TASK_ROOT`.
- **Evidence:** `apps/shop-counter/deploy/deploy_lambda.sh` (ENV line), `apps/shop-counter/src/app.ts` (`VIEW_CANDIDATES`).

### 10. AWS root sign-in fails at MFA when an AWS Builder ID session is open

- **Tool:** AWS Management Console sign-in, AWS Builder ID
- **Task attempted:** Sign in as root to open CloudShell for the deploy.
- **Steps:** In a browser already signed in to AWS Builder ID (needed for the hackathon), chose root user sign-in, entered the email and password.
- **Expected:** Normal root sign-in.
- **Actual:** Builder ID kept taking over the sign-in flow, and the root sign-in died at the MFA step with "Unexpected error".
- **Severity:** Medium. A non-developer on our team lost real time here and could not tell what was wrong.
- **Workaround:** "Add session" -> root user email, in the same tab the deploy ran in.
- **Suggestion:** Detect the open Builder ID session and say so ("You are signed in with Builder ID. Continue as root in a new session?") instead of a generic error.
- **Evidence:** `docs/BUILD_LOG.md` (October 12, evening: Deploy).

### 11. The model ignores a length rule written in the prompt

- **Tool:** Claude Haiku (`claude-haiku-5-5`) as the Alexa model in our simulator, with our Agent Skill in the system prompt
- **Task attempted:** Keep every spoken reply to at most two short sentences, as Alexa would.
- **Steps:** Wrote the rule in `skills/shop-counter/SKILL.md`, ran 18 live conversations (`evals/llm_run.mjs`).
- **Expected:** The rule holds.
- **Actual:** It held in 13 of 18 scenarios. The model added "Want me to...?" after the tool's two sentences in 7 of 28 turns. We could not trim the model's own history either: Haiku's thinking blocks are tied to the exact history and must be sent back unchanged.
- **Severity:** Medium.
- **Workaround:** Length is enforced in code: the server cuts tool lines to two sentences (`clampSpeech`), the host trims what it speaks and leaves the history alone. Live run went from 13/18 to 17/18 passing scenarios, 0 made-up facts.
- **Suggestion:** For voice hosts, document a recommended place to enforce output length (host side, not prompt), and how to post-process speech without touching thinking-signed history.
- **Evidence:** `evals/llm_run.mjs`, `evals/llm_scenarios.json`, `clampSpeech` in `packages/shelf/src/service.ts`, `docs/BUILD_LOG.md` (October 12, evening: the live model).

### 12. The model answered a fit question from the product title and skipped the tool

- **Tool:** Claude Haiku tool use, our `check_compatibility` MCP tool
- **Task attempted:** "Will the Accessories Pack for Saros 10 fit my robot?", expected to go through `check_compatibility` so the screen shows the store's quote.
- **Steps:** Live conversation as shopper Sam, Saros 10R in his device closet.
- **Expected:** A `check_compatibility` call.
- **Actual:** The product title already contained "(Not compatible with Saros 10R)", and the model answered from it directly. The fact was right, the path was not: no quote card on screen. Separately, the item was out of stock, and `find_products` did not return its id at all, so the tool could not have been called.
- **Severity:** Medium. Our scenario checker only looked at the spoken phrase and passed it.
- **Workaround:** A named out-of-stock product now comes back with its id and `available: false` (contract v1.5), and the skill tells the model to check fit through the tool. On the recorded demo run the refusal did go through `check_compatibility`. Our scenario file now asserts the `check_compatibility` call and the `incompatible` status for this turn, not only the phrase (not yet re-run live).
- **Suggestion:** None for the model. For anyone writing evals for MCP add-ons: assert on tool calls, not only on the final sentence.
- **Evidence:** `out_of_stock_match` in `docs/CONTRACT.md` (v1.5), `video/capture/transcript.json`, `docs/BUILD_LOG.md` (October 12, evening: the live model).

### 13. Amazon Bedrock answers "not available for this account" for every model on a new account

- **Tool:** Amazon Bedrock (console, Claude in Amazon Bedrock, Amazon Nova)
- **Task attempted:** Move the model that plays Alexa from our own Anthropic API key to Bedrock, called from the shop-counter Lambda with its IAM role, so the hosted simulator keeps working for judges after our API credit runs out and the project uses Bedrock for the AWS Builder prize.
- **Steps:** Wrote the integration first (`@anthropic-ai/bedrock-sdk` with `AnthropicBedrockMantle` for Claude, Converse for Nova Lite as a fallback), then on October 13 tried the models by hand in the Bedrock console: Claude Haiku 4.5 and GPT-5.6 Luna.
- **Expected:** Model access on request, or at least an error that says what to request.
- **Actual:** Every model answered "not available for this account". Claude Haiku 5.5, the model we evaluate as Alexa, is not listed in the Bedrock model catalog at all. The model list in the new console showed "Serverless (0)" with no reason given. Two hackathon forum threads (45416, 45384) report the same block on new accounts; organizers said they could not escalate it and pointed to AWS Support.
- **Severity:** High. It removed Bedrock from the live product. The brain now calls Claude Haiku 5.5 through the Anthropic API from the same Lambda, and our AWS story for the AWS Builder prize is Lambda, DynamoDB, CloudWatch and SNS only.
- **Workaround:** `BRAIN_PROVIDER=claude-api` with the key in the Lambda environment. The Bedrock paths stay in the code behind the flag and are covered by unit tests (the real SDK signs a request against a mocked network), but they never made a live call.
- **Suggestion:** Say on the model access page why an account is blocked and what unblocks it (account age, billing history, a quota request). For hackathons that list Bedrock as a target service, give participants a pre-approved path.
- **Evidence:** `apps/shop-counter/src/brain.ts` (providers and the note dated 2026-10-13), `apps/shop-counter/deploy/deploy_lambda.sh`, `apps/shop-counter/test/brain.test.ts`, `docs/BUILD_LOG.md` (October 13, evening: Alexa moves to the Lambda).

### 14. Claude on Bedrock lives on a second service with its own IAM namespace

- **Tool:** Amazon Bedrock (`bedrock-mantle` and `bedrock-runtime`), AWS IAM
- **Task attempted:** Give the Lambda role the narrowest permission that lets it call one Claude model.
- **Steps:** Started from the usual `bedrock:InvokeModel` on a foundation-model ARN, then read the Claude in Amazon Bedrock docs and the SDK source.
- **Expected:** One Bedrock service, one action to allow.
- **Actual:** Claude through the Messages API goes to a separate endpoint (`bedrock-mantle.<region>.api.aws/anthropic/v1/messages`). It is authorized as `bedrock-mantle:CreateInference` on a project ARN (`arn:aws:bedrock-mantle:<region>:<account>:project/default`), narrowed by the `bedrock-mantle:Model` condition key, not by `bedrock:InvokeModel`. Nova still goes through `bedrock-runtime` and `bedrock:InvokeModel`. The console shows the two surfaces side by side, so it was not obvious which one a given model belongs to. A wrong policy fails only at call time with a 403.
- **Severity:** Medium. Two policy statements for two services, and a second deploy flag (`BRAIN_IAM_STRICT=0`) in case the model condition does not match.
- **Workaround:** `deploy_lambda.sh` writes both statements: `bedrock-mantle:CreateInference` with the model condition for Claude, `bedrock:InvokeModel` for Nova. A unit test checks that the SDK signs for the `bedrock-mantle` service in us-east-1.
- **Suggestion:** One IAM page that maps each Bedrock model family to its endpoint, action and condition keys, and a console label on each model saying which API serves it.
- **Evidence:** `apps/shop-counter/deploy/deploy_lambda.sh` (the `MANTLE` and `NOVA` statements), `apps/shop-counter/test/brain.test.ts` (SigV4 for `bedrock-mantle`).

### 15. The rules do not say whether an unlisted video counts

- **Tool:** Hackathon rules and overview (video requirement)
- **Task attempted:** Upload the demo video and keep it private to the team until the submission was final.
- **Steps:** Uploaded the drafts to YouTube as unlisted, then read the Rules, the Overview, the FAQ, the Updates and the Discussions for the word "unlisted".
- **Expected:** A clear line on unlisted vs public, as many Devpost hackathons have.
- **Actual:** The Rules say the video must be "made publicly visible" and the Overview says "public and in English". "Unlisted" appears nowhere in the Rules, FAQ, Updates or Discussions. Other Devpost hackathons accept unlisted, some do not.
- **Severity:** Low. It is a one-click change, but getting it wrong could disqualify a submission.
- **Workaround:** Drafts stay unlisted; the video goes public before the deadline.
- **Suggestion:** One sentence in the Rules: "Unlisted YouTube videos are (or are not) accepted."
- **Evidence:** `docs/BUILD_LOG.md` (October 13, evening: video v4).

### 16. We could not see how Alexa+ links accounts with an MCP server

- **Tool:** Alexa+ account linking, MCP Authorization (spec 2025-11-25)
- **Task attempted:** Replace our demo login with real account linking, so the shopper's closet and orders belong to a linked account.
- **Steps:** Built a minimal OAuth 2.1 authorization server in the same Lambda by the MCP Authorization spec: resource and server metadata (RFC 9728, RFC 8414), Client ID Metadata Documents, dynamic registration, PKCE S256, resource indicators (RFC 8707), rotating refresh tokens.
- **Expected:** A way to check which of these Alexa+ actually uses for an MCP add-on.
- **Actual:** The MCP spec is built around public clients (PKCE, client metadata documents, dynamic registration), while classic Alexa account linking is configured in the developer console with a client id and a client secret. With the Alexa+ toolkit closed [1], we could not see which model Alexa+ follows for MCP add-ons, so our server accepts public clients only and does not take a `client_secret`.
- **Severity:** Medium. Account linking is the one piece of a shopping add-on we can only half test: the full flow runs in our simulator, but against our own client, not Alexa's.
- **Workaround:** The simulator has a "Link account" button that runs the real browser flow against our server; the server tests in `oauth.test.ts` cover the flow and its failure cases. Confidential clients are listed as a known gap.
- **Suggestion:** One page in the Alexa+ MCP docs: which OAuth client type Alexa+ uses for MCP add-ons (CIMD, dynamic registration, or a console client secret) and which redirect URIs to allow.
- **Evidence:** `apps/shop-counter/src/oauth.ts`, `apps/shop-counter/test/oauth.test.ts`, `docs/CONTRACT.md` (v1.7), `docs/BUILD_LOG.md` (October 13: account linking).
