# Shop Counter demo v2: script

Built by `build_video.py` from `capture/timeline_v2.json` (v1 script and video: commit cf5e564). Alexa's lines are word for word what the simulator said on the live run (AWS Lambda MCP server + Claude Haiku, 12.10.2026, `capture/transcript.json`); no new model calls for v2.
Voices: every line from gemini-3.8-flash-lite-tts, one voice per role: narrator Charon, Maya Aoede, Sam Puck, Alexa Kore. Speed-up in the edit (pitch kept): Alexa 1.24, narrator 1.10, shoppers 1.04 (v1: 1.28 / 1.12 / 1.08).
Picture: the Echo Show from the 4K screenshots, the simulator's caption faded out of the shot, a slow push-in from the whole device to the part of the screen with content; every spoken line is a subtitle under the device.

Total: 2:48.0 (1920x1080, H.264 + AAC).


## 0. Hook

- `0:00.0` +3.4s `hook_ask`: **MAYA**: Alexa, will this charger work with my phone?
- `0:03.4` +7.8s `hook_say`: **ALEXA**: Yes, the store confirms the iPhone 15 works with the OntheGo 67W Slim Wall Charger. Want me to check it for your MacBook Air too?
- `0:11.2` +6.2s `hook_title`: **NARRATOR**: She never said which phone. Alexa remembered it, and the yes comes from the store's own product data.

## 1. Problem

- `0:17.4` +8.8s `problem`: **NARRATOR**: We buy chargers, cables and spare parts for things we already own. We guess, and the store's chatbot guesses with us. Then the box goes back.
- `0:26.2` +9.0s `what`: **NARRATOR**: Shop Counter is an Alexa+ add-on that keeps a closet of your devices, and answers fit questions only with what the store itself has published.

## 2. Maya, live (Satechi)

- `0:35.2` +8.1s `m_home`: **NARRATOR**: This is the live server on AWS Lambda, with Claude Haiku playing Alexa. Maya is shopping at Satechi.
- `0:43.3` +3.7s `m01_ask`: **MAYA**: I just got an iPhone 15 and a MacBook Air.
- `0:47.0` +8.2s `m01_say`: **ALEXA**: Got it, I've saved your iPhone 15 and MacBook Air. Satechi lists the USB-C to USB-C Cable for your MacBook Air, at $8.99.
- `0:55.2` +2.2s `m02_ask`: **MAYA**: Find me a charger.
- `0:57.4` +10.0s `m02_say`: **ALEXA**: The best fit is the OntheGo 67W Slim Wall Charger at $59.99, and the store lists it for your iPhone 15 and MacBook Air. Want me to compare it with the other two?
- `1:07.4` +2.6s `m03_ask`: **MAYA**: Will this charger work with my phone?
- `1:10.0` +2.0s `m03_say`: (no voice)
- `1:12.0` +1.5s `m04_ask`: **MAYA**: Order it.
- `1:13.5` +6.2s `m04_say`: **ALEXA**: That's the OntheGo 67W Slim Wall Charger, $59.99 before shipping and tax. Should I place the order?
- `1:19.8` +2.5s `m05_ask`: **MAYA**: Yes, confirm.
- `1:22.3` +8.2s `m05_say`: **ALEXA**: Your order SC-A131E6 is confirmed for $59.99. It's a demo, so no payment was taken.
- `1:30.5` +6.0s `m05_clean`: **NARRATOR**: Two steps. Nothing is ordered until she says yes. The next day, in a brand new session:
- `1:36.5` +2.0s `m07_ask`: **MAYA**: Where's my order?
- `1:38.5` +8.9s `m07_say`: **ALEXA**: Your latest order for the OntheGo 67W Slim Wall Charger is confirmed and expected by October 16. That date is a demo estimate.

## 3. Sam, another store (Roborock)

- `1:47.4` +7.6s `s_satechi`: **NARRATOR**: Sam mentioned his robot vacuum while shopping at Satechi. Now he's at Roborock, a different store. Same closet.
- `1:55.0` +1.8s `s_switch`: (no voice)
- `1:56.8` +2.3s `s03_ask`: **SAM**: What devices do I have?
- `1:59.1` +9.5s `s03_say`: **ALEXA**: You have a Roborock Saros 10R, and you have a cat on file. The store lists a Roborock Main Brush Cover for the Saros 10R at $19.99.
- `2:08.6` +3.7s `s04_ask`: **SAM**: Will the Accessories Pack for Saros 10 fit my robot?
- `2:12.3` +11.1s `s04_say`: **ALEXA**: No, the Accessories Pack for Saros 10 won't work with your Saros 10R, and it's out of stock anyway. The store lists a Main Brush Cover for your Saros 10R at $19.99.
- `2:23.4` +1.8s `s04_clean`: (no voice)

## 4. How it is built

- `2:25.2` +8.0s `tech_log`: **NARRATOR**: Under the hood: a self-hosted MCP server on the November 2025 spec, over Streamable HTTP. MCP Apps draw the screens, an Agent Skill sets the rules, and AWS Lambda with DynamoDB keeps the closet. Fifty-seven of fifty-seven eval cases, zero made-up facts.
- `2:33.2` +10.1s `tech`: (no voice)

## 5. Close

- `2:43.3` +4.8s `final`: **NARRATOR**: Shop Counter. The store clerk who remembers your stuff.

## On-screen titles

- Hook card: It remembered. It didn't guess. It quoted the store.
- Problem card: Will it work with my stuff? / Chargers, cables, spare parts: bought for devices you already own. Store bots guess the fit.
- Product card: Shop Counter / An Alexa+ add-on that remembers your devices and answers fit questions only with the store's own words. / the store clerk who remembers your stuff
- Tags: Live run · AWS Lambda · Claude Haiku as Alexa; The answer from the opening; New session; Earlier, at Satechi; Now at Roborock: same shopper, same closet; The store's own words: "Not compatible with Saros 10R"; MCP activity: initialize · tools/list · tools/call · ui://
- Tech card: MCP (self-hosted server, spec 2025-11-25, Streamable HTTP), MCP Apps, Agent Skill, AWS (Lambda Function URL + DynamoDB closet), Open source (Shelf to Alexa: any Shopify store, one config entry), Honesty (eval 57/57, 0 made-up facts · live Claude Haiku 17/18)
- Small line (Maya intro, final card): Not affiliated with Satechi or Roborock, public catalogs

## Notes

- Turn 3 of Maya is the opening shot; in the flow it is a 2.0 s silent callback.
- Where the simulator caption covered the screen, the lower part of the cards fades out (no re-shoot): the push-in frames the top of the screen.
- Tags are shown in capitals above the subtitle (NEW SESSION, EARLIER, AT SATECHI, ...).
