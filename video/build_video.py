"""Assemble the Shop Counter demo (1920x1080, H.264 + AAC), adapted from T_opencv/video/build_video.py.
Inputs: frames/raw/*.png (record.mjs, live Lambda + Claude Haiku), audio/*.wav (tts.py), lines.json,
capture/transcript.json. Output: shop_counter_demo_v2.mp4, frames/v2_check_*.jpg (9 control stills),
capture/timeline_v2.json (start, length, lines per segment, used by script.md). v1 is commit cf5e564.
"""
import json
import pathlib
import subprocess
import wave

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
W, H, FPS, SR = 1920, 1080, 30, 48000
BG = (9, 13, 26)
INK = (245, 247, 250)
MUTED = (150, 160, 178)
ACCENT = (43, 198, 255)
GREEN = (52, 199, 120)
LABEL = {"narrator": None, "maya": ("MAYA", (255, 170, 90)), "sam": ("SAM", (255, 170, 90)), "alexa": ("ALEXA", ACCENT)}
FONT = "/System/Library/Fonts/Helvetica.ttc"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
XFADE = 0.35
# v2 (13.10): bigger Echo Show with a slow push-in, the simulator's Alexa caption faded out of the shot and
# Alexa's words in our own subtitle under the device, one TTS model for every line, gentler speed-up.
AUDIO_DIR = "audio_v2"
OUT_NAME = "shop_counter_demo_v2.mp4"
TEMPO = {"narrator": 1.10, "maya": 1.04, "sam": 1.04, "alexa": 1.24}  # v1: 1.12 / 1.08 / 1.08 / 1.28
CHECKS = {"hook_say": 1, "m01_say": 2, "m02_say": 3, "m04_say": 4, "m05_say": 5, "m07_say": 6, "s03_say": 7, "s04_say": 8, "tech": 9}
DEV = {"maya": (800, 338, 3040, 1629), "sam": (800, 379, 3040, 1670)}  # device in the 4K screenshots (bbox x2)
SCR_X = (836, 3003)
SCR_Y = {"maya": (374, 1595), "sam": (415, 1636)}
DEV_H = 820  # device height on the 1080p canvas; the subtitle band lives under it
DISCLAIMER = "Not affiliated with Satechi or Roborock, public catalogs"

cfg = json.load(open(HERE / "lines.json"))
said = {r["key"]: r["alexa"] for f in json.load(open(HERE / "capture/transcript.json")).values() for r in f["flow"]}
boxes = {k: v["device"] for k, v in json.load(open(HERE / "capture/transcript.json")).items()}
boxes["maya"] = {**boxes["maya"], "x": boxes["sam"]["x"]}  # maya's box was measured with the log panel open


def font(size, bold=False):
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def read_wav(p, tempo=1.0):
    """WAV -> float32 at 48 kHz, sped up with ffmpeg atempo (pitch kept), leading/trailing silence trimmed."""
    if tempo != 1.0:
        tmp = f"/tmp/sc_tempo_{p.stem}.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(p), "-filter:a", f"atempo={tempo}", "-ac", "1", tmp], check=True)
        p = pathlib.Path(tmp)
    with wave.open(str(p)) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        src = w.getframerate()
    t = np.arange(int(len(a) * SR / src)) / SR
    a = np.interp(t, np.arange(len(a)) / src, a).astype(np.float32)
    loud = np.where(np.abs(a) > 0.02)[0]
    if len(loud):
        a = a[max(0, loud[0] - int(0.05 * SR)): loud[-1] + int(0.12 * SR)]
    return a


def text_of(k):
    line = cfg["lines"][k]
    return said[line["from"]] if "from" in line else line["text"]


def wrap(d, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = t
    lines.append(cur)
    return lines


def band(d, k, y0):
    """Subtitle band: speaker pill + big text. Alexa's words are already on the device screen, so only the pill."""
    who = cfg["lines"][k]["voice"]
    lab = LABEL[who]
    x = 90
    if lab:
        f = font(30, True)
        tw = d.textlength(lab[0], font=f)
        d.rounded_rectangle([x, y0 + 14, x + tw + 36, y0 + 60], 23, fill=lab[1])
        d.text((x + 18, y0 + 20), lab[0], font=f, fill=BG)
        x += tw + 60
    f = font(44, who != "narrator")
    for i, line in enumerate(wrap(d, text_of(k), f, W - x - 90)[:3]):
        d.text((x, y0 + 12 + i * 56), line, font=f, fill=INK if who != "narrator" else (220, 226, 236))


def shot(frame, k=None, crop="device", tag=None, foot=None):
    if crop == "device":
        return DShot(frame, k, tag, foot)
    raw = Image.open(HERE / f"frames/raw/{frame}.png").convert("RGB")
    sx = raw.width / W
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    nlines = 0
    if k and cfg["lines"][k]["voice"] != "alexa":
        f = font(44)
        nlines = len(wrap(d, text_of(k), f, W - 400))
    band_h = 150 if nlines <= 2 else 200
    if crop == "device":
        b = boxes[frame.split("_")[0]]
        pad = 14
        s = raw.crop([int((b["x"] - pad) * sx), int((b["y"] - pad) * sx), int((b["x"] + b["width"] + pad) * sx), int((b["y"] + b["height"] + pad) * sx)])
    elif crop:
        s = raw.crop([int(v * sx) for v in crop])
    else:
        s = raw
    avail = H - band_h - 20
    scale = min((W - 40) / s.width, avail / s.height)
    s = s.resize((int(s.width * scale), int(s.height * scale)), Image.LANCZOS)
    im.paste(s, ((W - s.width) // 2, 14 + (avail - s.height) // 2))
    if tag:
        f = font(28, True)
        tw = d.textlength(tag, font=f)
        d.rounded_rectangle([40, 30, 40 + tw + 40, 80], 25, fill=(20, 30, 52), outline=ACCENT, width=2)
        d.text((60, 39), tag, font=f, fill=INK)
    if k:
        band(d, k, H - band_h)
    if foot:
        d.text((W - 40 - d.textlength(foot, font=font(22)), H - 34), foot, font=font(22), fill=MUTED)
    return im


def card(title, sub="", foot="", title_color=INK, lines=None, small=None, k=None):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.ellipse([140, 150, 176, 186], fill=ACCENT)
    d.text((196, 146), "Shop Counter", font=font(36, True), fill=MUTED)
    y = 300 if not lines else 250
    for line in wrap(d, title, font(84, True), 1640):
        d.text((140, y), line, font=font(84, True), fill=title_color)
        y += 104
    y += 20
    for line in wrap(d, sub, font(46), 1640) if sub else []:
        d.text((140, y), line, font=font(46), fill=MUTED)
        y += 64
    for a, b in lines or []:
        d.text((140, y + 10), a, font=font(40, True), fill=ACCENT)
        d.text((640, y + 10), b, font=font(40), fill=INK)
        y += 70
    if foot:
        d.text((140, 800 if k else 930), foot, font=font(34), fill=ACCENT)
    if small:
        d.text((140, 860 if k else 1000), small, font=font(24), fill=MUTED)
    if k:  # narration subtitles on cards too
        bh = 40 + 56 * len(wrap(d, text_of(k), font(44), W - 180)[:3])
        d.line([90, H - bh - 20, W - 90, H - bh - 20], fill=(40, 52, 80), width=2)
        band(d, k, H - bh)
    return im


def caption_top(a, sy):
    """Top of the simulator's Alexa caption: its accent border is the only long vertical cyan run that reaches the
    bottom of the screen, in the left part. None when no caption is on screen."""
    y0 = sy[0] + int((sy[1] - sy[0]) * 0.35)
    sub = a[y0:sy[1] - 20, SCR_X[0]:SCR_X[0] + 900].astype(int)
    m = (sub[:, :, 1] > 80) & (sub[:, :, 2] > 110) & (sub[:, :, 0] < 70) & (sub[:, :, 2] > sub[:, :, 1])
    best = None
    for c in np.where(m.sum(axis=0) >= 100)[0]:
        idx = np.where(m[:, c])[0]
        r = max(np.split(idx, np.where(np.diff(idx) > 3)[0] + 1), key=len)
        if len(r) >= 100 and r[-1] > m.shape[0] - 140 and (best is None or len(r) > best[1]):
            best = (int(r[0]), len(r))
    return None if best is None else y0 + best[0] - 26


class DShot:
    """A device shot that moves: the Echo Show from a 4K screenshot, the simulator caption faded out, and a slow
    push-in from the whole device to the part of the screen that still has content (the screen grows on the canvas)."""
    MAX_W = 1720  # widest the screen may get on the canvas

    def __init__(self, frame, k=None, tag=None, foot=None):
        flow = frame.split("_")[0]
        a = np.asarray(Image.open(HERE / f"frames/raw/{frame}.png").convert("RGB")).astype(np.float32)
        sy = SCR_Y[flow]
        cap = caption_top(a.astype(np.uint8), sy)
        if cap:  # fade the screen into its own background just above the caption, keep the light bar
            for y in range(cap - 60, sy[1] - 24):
                al = min(1.0, max(0.0, (y - (cap - 60)) / 60))
                bg = a[y, SCR_X[0] + 12].copy()
                a[y, SCR_X[0]:SCR_X[1]] = a[y, SCR_X[0]:SCR_X[1]] * (1 - al) + bg * al
        x0, y0, x1, y1 = DEV[flow]
        self.dev = a[y0:y1, x0:x1]
        h, w = self.dev.shape[:2]
        bottom = (cap - 40 if cap else sy[1]) - y0
        self.v0 = np.array([0, 0, w, h], np.float32)  # whole device
        self.v1 = np.array([SCR_X[0] - x0 - 10, sy[0] - y0 - 10, SCR_X[1] - x0 + 10, bottom + 10], np.float32)  # content
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        if tag:
            d.text((90, DEV_H + 22), tag.upper(), font=font(26, True), fill=ACCENT)
        if k:
            band(d, k, DEV_H + (52 if tag else 26))
        if foot:
            d.text((W - 40 - d.textlength(foot, font=font(22)), H - 34), foot, font=font(22), fill=MUTED)
        self.base = np.asarray(im).astype(np.float32)

    def render(self, p):
        e = p * p * (3 - 2 * p)  # ease in-out
        vx0, vy0, vx1, vy1 = self.v0 + (self.v1 - self.v0) * e
        vw, vh = vx1 - vx0, vy1 - vy0
        sc = min(self.MAX_W / vw, (DEV_H - 8) / vh)
        ow, oh = int(vw * sc), int(vh * sc)
        view = cv2.resize(self.dev[int(vy0):int(vy1), int(vx0):int(vx1)], (ow, oh), interpolation=cv2.INTER_AREA)
        fr = self.base.copy()
        x, y = (W - ow) // 2, 8 + (DEV_H - 8 - oh) // 2
        fr[y:y + oh, x:x + ow] = view
        return fr

    def still(self, p=0.5):
        return Image.fromarray(self.render(p).astype(np.uint8))


AUD = {k: read_wav(HERE / f"{AUDIO_DIR}/{k}.wav", TEMPO.get(v["voice"], 1.0)) for k, v in cfg["lines"].items()}
segs = []  # (name, PIL image, [line keys], gap/pad seconds, min seconds)


def add(name, img, keys=(), pad=0.6, min_s=2.0, gap=0.35):
    segs.append((name, img, list(keys), pad, min_s, gap))


# 0-20 s: hook
add("hook_ask", shot("maya_03_a_ask", "h_maya"), ["h_maya"], pad=0.3)
add("hook_say", shot("maya_03_b_say", "h_alexa"), ["h_alexa"], pad=0.3)
add("hook_title", card("It remembered. It didn't guess. It quoted the store.", "", "", title_color=INK, k="h_n"), ["h_n"], pad=0.3)
# 20-40 s: problem, then what it is
add("problem", card("Will it work with my stuff?", "Chargers, cables, spare parts: bought for devices you already own. Store bots guess the fit.", k="p_n1"), ["p_n1"], pad=0.2)
add("what", card("Shop Counter", "An Alexa+ add-on that remembers your devices and answers fit questions only with the store's own words.",
                 "the store clerk who remembers your stuff", k="p_n2"), ["p_n2"], pad=0.3)
# 40-115 s: Maya, live
add("m_home", shot("maya_00_home", "m_n0", tag="Live run · AWS Lambda · Claude Haiku as Alexa", foot=DISCLAIMER), ["m_n0"], pad=0.3)
for n, (s, a) in {"01": ("m_s1", "m_a1"), "02": ("m_s2", "m_a2"), "03": ("m_s3", None), "04": ("m_s4", "m_a4"), "05": ("m_s5", "m_a5")}.items():
    add(f"m{n}_ask", shot(f"maya_{n}_a_ask", s), [s], pad=0.1, min_s=1.4)
    if a:
        add(f"m{n}_say", shot(f"maya_{n}_b_say", a), [a], pad=0.1)
    else:  # turn 3 is the opening shot; here only a short callback, no repeated audio
        add(f"m{n}_say", shot(f"maya_{n}_c_clean", None, tag="The answer from the opening"), [], min_s=2.0)
add("m05_clean", shot("maya_05_c_clean", "m_n1"), ["m_n1"], pad=0.2)
add("m07_ask", shot("maya_07_a_ask", "m_s7", tag="New session"), ["m_s7"], pad=0.15, min_s=1.6)
add("m07_say", shot("maya_07_b_say", "m_a7", tag="New session"), ["m_a7"], pad=0.2)
# 115-140 s: Sam, another store, same closet, and a refusal with the store's words
add("s_satechi", shot("sam_01_c_clean", "s_n0", tag="Earlier, at Satechi"), ["s_n0"], pad=0.1)
add("s_switch", shot("sam_02_store_switched", None, tag="Now at Roborock: same shopper, same closet"), [], min_s=1.8)
add("s03_ask", shot("sam_03_a_ask", "s_s3"), ["s_s3"], pad=0.15, min_s=1.6)
add("s03_say", shot("sam_03_b_say", "s_a3"), ["s_a3"], pad=0.15)
add("s04_ask", shot("sam_04_a_ask", "s_s4"), ["s_s4"], pad=0.15, min_s=1.6)
add("s04_say", shot("sam_04_b_say", "s_a4"), ["s_a4"], pad=0.15)
add("s04_clean", shot("sam_04_c_clean", None, tag="The store's own words: \"Not compatible with Saros 10R\""), [], min_s=1.8)
# 140-160 s: how it's built (the MCP log once)
add("tech_log", shot("maya_08_log", None, crop=None, tag="MCP activity: initialize · tools/list · tools/call · ui://"), [], min_s=3.0)
add("tech", card("How it's built", "", lines=[
    ("MCP", "self-hosted server, spec 2025-11-25, Streamable HTTP"),
    ("MCP Apps", "Echo Show screens from ui://shop-counter/view.html"),
    ("Agent Skill", "SKILL.md: which tool when, what never to invent"),
    ("AWS", "Lambda Function URL + DynamoDB closet"),
    ("Open source", "Shelf to Alexa: any Shopify store, one config entry"),
    ("Honesty", "eval 57/57, 0 made-up facts · live Claude Haiku 17/18"),
], k="t_n"), ["t_n"], pad=0.2)
# 160-170 s: close
add("final", card("Shop Counter", "the store clerk who remembers your stuff", "Alexa+ add-on · MCP server · MCP Apps · Agent Skill",
                  small=DISCLAIMER, k="f_n"), ["f_n"], pad=1.2, min_s=4.0)

# tech_log shares the narration with the "tech" card: split t_n across both
TECH_SPLIT = 0.45

# timing
plan, t = [], 0.0
for name, img, keys, pad, min_s, gap in segs:
    a = [AUD[k] for k in keys]
    secs = sum(len(x) for x in a) / SR + gap * max(0, len(a) - 1) + 0.2 + pad
    plan.append([name, img, keys, max(secs, min_s), gap])
# move part of t_n's time onto the log shot
i = [p[0] for p in plan].index("tech")
move = len(AUD["t_n"]) / SR * TECH_SPLIT
plan[i - 1][3] = max(plan[i - 1][3], move)
plan[i][3] = max(2.5, plan[i][3] - move)

total = sum(p[3] for p in plan)
print("total", round(total, 1), "s")
assert total < 170, f"too long: {total:.1f}s"

(HERE / "frames").mkdir(exist_ok=True)
audio = np.zeros(int((total + 1) * SR), np.float32)
timeline, t = [], 0.0
proc = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                         "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "/tmp/sc_video.mp4"],
                        stdin=subprocess.PIPE)
prev = None
for idx, (name, img, keys, secs, gap) in enumerate(plan):
    n = int(round(secs * FPS))
    moving = isinstance(img, DShot)
    if name in CHECKS:
        (img.still(0.6) if moving else img.convert("RGB")).save(HERE / f"frames/v2_check_{CHECKS[name]}_{name}.jpg", quality=88)
    nx = int(XFADE * FPS) if prev is not None else 0
    for f in range(n):
        cur = img.render(f / max(1, n - 1)) if moving else (cur if f else np.asarray(img).astype(np.float32))
        if f < nx:
            a = (f + 1) / (nx + 1)
            fr = prev * (1 - a) + cur * a
        else:
            fr = cur
        proc.stdin.write(fr.astype(np.uint8).tobytes())
    # audio: lines one after another, the first one shortly after the cut
    at = t + 0.2
    if name == "tech":  # narration started on the log shot
        at = None
    for k in keys:
        if at is None:
            continue
        a = AUD[k]
        s0 = int(at * SR)
        audio[s0:s0 + len(a)] += a[: len(audio) - s0]
        at += len(a) / SR + gap
    if name == "tech_log":  # t_n plays across the log shot and the card
        a = AUD["t_n"]
        s0 = int((t + 0.2) * SR)
        audio[s0:s0 + len(a)] += a
    timeline.append({"segment": name, "start": round(t, 2), "seconds": round(secs, 2),
                     "lines": [{"key": k, "voice": cfg["lines"][k]["voice"], "text": text_of(k)} for k in (keys if name != "tech" else [])]
                     + ([{"key": "t_n", "voice": "narrator", "text": text_of("t_n")}] if name == "tech_log" else [])})
    prev = cur
    t += n / FPS
proc.stdin.close()
proc.wait()
audio = audio[: int(t * SR)]
audio = (np.clip(audio / max(1e-6, np.abs(audio).max()) * 0.9, -1, 1) * 32767).astype(np.int16)
with wave.open("/tmp/sc_audio.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(audio.tobytes())
out = HERE / OUT_NAME
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", "/tmp/sc_video.mp4", "-i", "/tmp/sc_audio.wav", "-c:v", "copy",
                "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(out)], check=True)
json.dump(timeline, open(HERE / "capture/timeline_v2.json", "w"), indent=2, ensure_ascii=False)
print(out, round(t, 1), "s")
