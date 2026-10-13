# Shop Counter demo v4: script

Built by `build_video.py` from `capture/timeline_v4.json` (v1: cf5e564, v2: a0e19f1, v3: 1dd09ca). Recorded on 13.10.2026 by `record.mjs` on the hosted simulator (https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/sim/): the live MCP server on AWS Lambda, Claude Haiku 5.5 as Alexa through the Anthropic API called from the same Lambda, the closet in DynamoDB. Every browser context was a fresh private shopper.
Alexa's lines are word for word the simulator's spoken line on that run (`capture/transcript_v4.json`, field `alexa`), checked by script against the timeline. The simulator speaks at most two sentences of the model's reply; the full reply is in `model_text`. After the tap on Place order the simulator speaks the `place_order` tool's own line (no model turn), as it does for any button.
Voices: gemini-3.8-flash-lite-tts, one voice per role: narrator Charon, Maya Aoede, Sam Puck, Alexa Kore. Shopper lines with unchanged text reuse the v2/v3 takes. Speed-up in the edit (pitch kept): Alexa 1.18, narrator 1.08, shoppers 1.04.
Sound: a quiet pad synthesized in `build_video.py` (four sine chords, no samples), ducked under speech; -16.1 LUFS integrated, true peak -4.1 dBFS, no gap quieter than -45 dB longer than 0.8 s (ffmpeg ebur128 and silencedetect on the final file).

Total: 2:52.4 (1920x1080, H.264 + AAC).


## 0. Hook: the honest no

- `0:00.2` `hook_ask`: **SAM**: Will the Accessories Pack for Saros 10 fit my robot?
- `0:03.7` `hook_say`: **ALEXA**: No, the Accessories Pack for Saros 10 is out of stock, and the store says it's not compatible with your Saros 10R. The Main Brush Cover is listed for your Saros 10R at $19.99.

## 1. The formula and why a simulator

- `0:15.6` `formula`: **NARRATOR**: Will it work with what I already own? Shop Counter is an Alexa+ add-on. Alexa understands what you mean, and the store answers for the facts.
- `0:24.0` `m_home`: **NARRATOR**: The Alexa+ MCP toolkit isn't open to hackathon builders, so this Echo Show is our own real MCP client, live on AWS. Maya shops at Satechi.

## 2. Maya at Satechi, live: voice, then a tap

- `0:34.6` `m01_ask`: **MAYA**: I just got an iPhone 15 and a MacBook Air.
- `0:37.9` `m01_say`: **ALEXA**: Got it, I've saved your iPhone 15 and MacBook Air. Satechi lists the USB-C to USB-C Cable for your MacBook Air, at $8.99.
- `0:46.9` `m02_ask`: **MAYA**: Find me a charger.
- `0:48.8` `m02_say`: **ALEXA**: The best fit is the OntheGo 67W Slim Wall Charger at $59.99, and the store lists it for both your iPhone 15 and MacBook Air. Want me to compare the top two?
- `0:59.7` `m03_ask`: **MAYA**: Will this charger work with my phone?
- `1:02.0` `m03_say`: **ALEXA**: Yes, the store lists the iPhone 15 for the OntheGo 67W Slim Wall Charger. Want me to add it to your order?
- `1:09.0` `m04_ask`: **MAYA**: Order it.
- `1:10.4` `m04_say`: **ALEXA**: That's the OntheGo 67W Slim Wall Charger, $59.99 before shipping and tax. Should I place the order?
- `1:17.8` `m05_tap`: **NARRATOR**: Voice first, not voice only. She taps Place order on the screen.
- `1:23.6` `m05_say`: **ALEXA**: Done: order SC-5DD504 is confirmed for $59.99. It's a demo, so no payment was taken.
- `1:31.5` `m07_ask`: **NARRATOR**: Later, in a brand new session:
- `1:33.7` `m07_ask`: **MAYA**: Where's my order?
- `1:35.4` `m07_say`: **ALEXA**: Your latest order, SC-5DD504 for the OntheGo 67W Slim Wall Charger, is confirmed and expected by October 17. That date is a demo estimate.

## 3. Account linking

- `1:46.0` `link`: **NARRATOR**: Account linking is real OAuth 2.1 with PKCE, the way Alexa+ links accounts.

## 4. Sam: Satechi, then Roborock, same closet

- `1:51.9` `s01_ask`: **NARRATOR**: Remember Sam from the start? Earlier, at Satechi, he told Alexa about his robot.
- `1:57.5` `s01_ask`: **SAM**: I have a Roborock Saros 10R and an iPhone 16.
- `2:01.7` `s01_say`: **ALEXA**: Got it, I've saved your Roborock Saros 10R and iPhone 16. Satechi lists the USB-C to USB-C Cable for your iPhone 16, at $8.99.
- `2:11.9` `s02_ask`: **NARRATOR**: Now he's at Roborock, a different store.
- `2:14.1` `s02_ask`: **SAM**: Will the Accessories Pack for Saros 10 fit my robot?
- `2:17.5` `s02_back`: **NARRATOR**: He only said “my robot”. Alexa knew it was his Saros 10R, and the no is the store's own words.

## 5. Under the hood

- `2:25.0` `tech_log`: **NARRATOR**: Under the hood, every step is real JSON-RPC. Alexa passes “my robot” as it was said, and our MCP server on AWS Lambda finds the Saros 10R in the closet, kept in DynamoDB.
- `2:37.5` `tech`: **NARRATOR**: MCP Apps draw the screens, and an Agent Skill sets the rules. Eighty-one of eighty-one eval cases pass, with zero made-up facts.

## 6. Close

- `2:45.6` `final`: **NARRATOR**: Try it yourself, the link is on screen. Shop Counter: the store clerk who remembers your stuff.

## On-screen text

- Formula card: Alexa understands what you mean. The store answers for the facts. / Shop Counter, an Alexa+ add-on for shopping by voice
- Tags: Live on AWS Lambda · Claude Haiku 5.5 plays Alexa; Voice first, not voice only; New session; Account linking · OAuth 2.1 + PKCE, live; Earlier, at Satechi; Now at Roborock · a different store, the same closet; MCP activity · this run's JSON-RPC: tools/call check_compatibility
- Tech card: MCP (self-hosted server, spec 2025-11-25, Streamable HTTP, 9 tools), MCP Apps, Agent Skill, AWS (Lambda Function URL, DynamoDB closet, brain called from the Lambda), Account linking (OAuth 2.1, PKCE S256, consent page, rotating refresh tokens), Eval (81 of 81 shopper cases, 0 made-up facts), Live model (Claude Haiku 5.5 as Alexa: 19 of 21 conversations pass every check)
- Final card: Try it: https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/sim/ · Open source (MIT): https://github.com/DmitriyTopka/shop-counter · Not affiliated with Satechi or Roborock, public catalogs
- A white finger dot and ring mark the two taps (Place order, Allow).

## Notes

- The hook and the Roborock callback are the same live turn (`sam_02`), shown twice; the callback carries narration, not Alexa's audio again.
- Sam's turn at Roborock was rerun in a fresh browser until the model's reply started with "No," (8 runs of the Sam flow, 2 started with "No,"; the other 6 said the same facts but opened with "The Accessories Pack..."; the video uses the last run). The text was never edited. Maya's "Yes," came on the first run.
- Two edits at capture time, both listed in `record.mjs`: the live consent page still says "robot vacuum, a cat" for Sam, so that one line shows the wording now in `apps/shop-counter/src/oauth.ts` ("demo shopper, Roborock Saros 10R"); and the live view draws a phone icon on "Your Saros 10R · remembered", so the icon path is the robot icon that `packages/view/src/render.ts` now draws. Both fixes were deployed on October 13 right after the capture (function.zip ebfa0a43), so the live server now shows exactly what the video shows.
- The simulator's own Alexa caption is hidden for the clean frames only; the subtitles under the device carry the line.

