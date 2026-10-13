"""Voices for the demo (v4: Alexa lines from capture/transcript_v4.json) with Gemini TTS (free tier, 3 requests/min), adapted from T_opencv/video/tts.py.
Alexa lines are taken word for word from capture/transcript_v4.json (what the simulator said on the live run).
Key read from ~/.gemini_key, never printed. Existing WAVs are kept, so a rerun only fills gaps."""
import base64, json, pathlib, time, urllib.request, wave
HERE = pathlib.Path(__file__).parent
key = pathlib.Path.home().joinpath(".gemini_key").read_text().strip()
cfg = json.load(open(HERE / "lines.json"))
said = {r["key"]: r["alexa"] for f in json.load(open(HERE / "capture/transcript_v4.json")).values() if "flow" in f for r in f["flow"]}
out = HERE / "audio_v4"; out.mkdir(exist_ok=True)  # v4; shopper lines with unchanged text are copied from audio_v2 (same model, same voice)
log = open(out / "tts_requests.log", "a")
MODELS = ("gemini-3.8-flash-lite-tts",)
PAUSE = 30
for k, line in cfg["lines"].items():
    f = out / f"{k}.wav"
    if f.exists():
        continue
    text = said[line["from"]] if "from" in line else line["text"]
    if "from" in line:  # same capture already voiced (the hook reuses Maya's turn 3)
        twin = next((o for o, l in cfg["lines"].items() if o != k and l.get("from") == line["from"] and (out / f"{o}.wav").exists()), None)
        if twin:
            f.write_bytes((out / f"{twin}.wav").read_bytes()); print(k, "copied from", twin); continue
    voice = cfg["voices"][line["voice"]]
    for model in MODELS:
        body = json.dumps({"contents": [{"parts": [{"text": text}]}],
                           "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {
                               "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}).encode()
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                     data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
        log.write(f"{time.strftime('%H:%M:%S')} {k} {model}\n"); log.flush()
        try:
            d = json.load(urllib.request.urlopen(req, timeout=120))
            pcm = base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
            with wave.open(str(f), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
            print(k, voice, model, round(len(pcm) / 48000, 1), "s", flush=True)
            break
        except Exception as e:
            print(k, model, "ERR", type(e).__name__, str(e)[:120], flush=True)
            time.sleep(PAUSE)
    time.sleep(PAUSE)
