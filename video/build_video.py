"""Assemble the Shop Counter demo v4 (1920x1080, H.264 + AAC).
Inputs: frames/raw/*.png and capture/transcript_v4.json (record.mjs on the hosted simulator: live Lambda MCP server,
Claude Haiku 5.5 brain called from the Lambda), audio_v4/*.wav (tts.py), lines.json.
Output: shop_counter_demo_v4.mp4, frames/v4_check_*.jpg (control stills), capture/timeline_v4.json (used by script.md).
Earlier cuts: v1 cf5e564, v2 a0e19f1, v3 1dd09ca (git history of this file).
v4: one short card after the hook, a tap on the screen, account linking, Sam's memory shown across two stores,
a readable push-in on the JSON-RPC log, links on the final card, a quiet synthesized pad under the voices,
loudness set to -16 LUFS in two passes, with a compressor and a limiter on 4x oversampled audio so the true peak stays under -1 dBTP after AAC.
"""
import json
import pathlib
import re
import subprocess
import tempfile
import wave

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
TMP = pathlib.Path(tempfile.mkdtemp(prefix="sc_v4_"))
W, H, FPS, SR = 1920, 1080, 30, 48000
BG = (9, 13, 26)
INK = (245, 247, 250)
MUTED = (150, 160, 178)
ACCENT = (43, 198, 255)
LABEL = {"narrator": None, "maya": ("MAYA", (255, 170, 90)), "sam": ("SAM", (120, 220, 160)), "alexa": ("ALEXA", ACCENT)}
FONT = "/System/Library/Fonts/Helvetica.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
XFADE = 0.35
AUDIO_DIR = "audio_v4"
OUT_NAME = "shop_counter_demo_v4.mp4"
TEMPO = {"narrator": 1.08, "maya": 1.04, "sam": 1.04, "alexa": 1.18}  # same as v3
DEV_H = 820  # height of the picture area on the 1080p canvas; the subtitle band lives under it
SIM_URL = "https://x2uph6avweit5yuv5crwm474240pwtzb.lambda-url.us-east-1.on.aws/sim/"
REPO = "https://github.com/DmitriyTopka/shop-counter"
DISCLAIMER = "Not affiliated with Satechi or Roborock, public catalogs"

cfg = json.load(open(HERE / "lines.json"))
cap = json.load(open(HERE / "capture/transcript_v4.json"))
said = {r["key"]: r["alexa"] for f in cap.values() if "flow" in f for r in f["flow"]}
META = {k: v for f in cap.values() for k, v in f.get("frames", {}).items()}


def font(size, bold=False):
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def drop_tail_burst(a):
    """Gemini TTS sometimes ends a clip with a short full-scale noise burst after the speech (m_s1: 0.13 s at 0 dBFS
    after 0.25 s of silence). Cut it at the silence before it."""
    q = np.abs(a) > 0.01
    idx = np.where(q)[0]
    if not len(idx):
        return a
    tail = int(0.6 * SR)
    for j in range(len(idx) - 1, 0, -1):
        if idx[j] - idx[j - 1] > int(0.15 * SR):  # a gap of silence
            if len(a) - idx[j] < tail and np.abs(a[idx[j]:]).max() > 0.9:
                return a[:idx[j - 1] + int(0.1 * SR)]
            break
    return a


def read_wav(p, tempo=1.0):
    """WAV -> float32 at 48 kHz, sped up with ffmpeg atempo (pitch kept), leading/trailing silence trimmed."""
    if tempo != 1.0:
        tmp = TMP / f"tempo_{p.stem}.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(p), "-filter:a", f"atempo={tempo}", "-ac", "1", str(tmp)], check=True)
        p = tmp
    with wave.open(str(p)) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        src = w.getframerate()
    t = np.arange(int(len(a) * SR / src)) / SR
    a = np.interp(t, np.arange(len(a)) / src, a).astype(np.float32)
    a = drop_tail_burst(a)
    loud = np.where(np.abs(a) > 0.02)[0]
    if len(loud):
        a = a[max(0, loud[0] - int(0.05 * SR)): loud[-1] + int(0.12 * SR)].copy()
    f = int(0.01 * SR)  # 10 ms fades: a hard cut at the trim point is a click, and AAC turns clicks into peaks
    a[:f] *= np.linspace(0, 1, f)
    a[-f:] *= np.linspace(1, 0, f)
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


def band(d, k, y0, size=42):
    """Subtitle band: speaker pill + the line."""
    who = cfg["lines"][k]["voice"]
    lab = LABEL[who]
    x = 90
    if lab:
        f = font(30, True)
        tw = d.textlength(lab[0], font=f)
        d.rounded_rectangle([x, y0 + 12, x + tw + 36, y0 + 58], 23, fill=lab[1])
        d.text((x + 18, y0 + 18), lab[0], font=f, fill=BG)
        x += tw + 60
    f = font(size, who != "narrator")
    for i, line in enumerate(wrap(d, text_of(k), f, W - x - 90)[:3]):
        d.text((x, y0 + 10 + i * int(size * 1.27)), line, font=f, fill=INK if who != "narrator" else (220, 226, 236))


def base_canvas(keys=(), tag=None, foot=None):
    """Background with the tag and the subtitles of the segment's lines (the last line that is spoken wins)."""
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    if tag:
        d.text((90, DEV_H + 18), tag.upper(), font=font(26, True), fill=ACCENT)
    if keys:
        band(d, keys[-1], DEV_H + (46 if tag else 22))
    if foot:
        d.text((W - 40 - d.textlength(foot, font=font(22)), H - 34), foot, font=font(22), fill=MUTED)
    return np.asarray(im).astype(np.float32)


class Shot:
    """A picture from a 4K screenshot that moves: a push-in from view v0 to view v1 (boxes in screenshot pixels),
    optionally with a tap: a finger dot that presses and a ring that spreads at `tap` (screenshot pixels)."""

    def __init__(self, frame, v0, v1, p=(0.0, 1.0), keys=(), tag=None, foot=None, tap=None, area_w=1840, hold=1.0):
        self.img = np.asarray(Image.open(HERE / f"frames/raw/{frame}.png").convert("RGB")).astype(np.float32)
        hh, ww = self.img.shape[:2]
        lim = np.array([ww, hh, ww, hh], np.float32)
        self.v0, self.v1 = (np.clip(np.array(v, np.float32), 0, lim) for v in (v0, v1))
        self.p = p
        self.hold = hold  # the push-in ends at this share of the segment, then holds
        self.tap = tap
        self.area_w = area_w
        self.keys = list(keys)
        self.tag, self.foot = tag, foot
        self.base = base_canvas(keys, tag, foot)

    def render(self, q, subs=None):
        p = self.p[0] + (self.p[1] - self.p[0]) * min(1.0, q / self.hold)
        e = p * p * (3 - 2 * p)
        vx0, vy0, vx1, vy1 = self.v0 + (self.v1 - self.v0) * e
        vw, vh = vx1 - vx0, vy1 - vy0
        sc = min(self.area_w / vw, (DEV_H - 16) / vh)
        ow, oh = int(vw * sc), int(vh * sc)
        view = cv2.resize(self.img[int(vy0):int(vy1), int(vx0):int(vx1)], (ow, oh), interpolation=cv2.INTER_AREA)
        fr = (subs if subs is not None else self.base).copy()
        x, y = (W - ow) // 2, 8 + (DEV_H - 8 - oh) // 2
        fr[y:y + oh, x:x + ow] = view
        if self.tap is not None and q > 0.35:
            tx, ty = (self.tap[0] - vx0) * sc + x, (self.tap[1] - vy0) * sc + y
            k = min(1.0, (q - 0.35) / 0.4)
            ov = fr.copy()
            r_dot = int(30 - 8 * min(1.0, k * 2))
            cv2.circle(ov, (int(tx), int(ty)), r_dot, (255, 255, 255), -1, cv2.LINE_AA)
            fr = fr * 0.55 + ov * 0.45
            if k > 0.3:
                rr = int(30 + 90 * (k - 0.3) / 0.7)
                ring = fr.copy()
                cv2.circle(ring, (int(tx), int(ty)), rr, (255, 255, 255), 5, cv2.LINE_AA)
                a = 0.8 * (1 - (k - 0.3) / 0.7)
                fr = fr * (1 - a) + ring * a
        return fr

    def still(self, q=0.6):
        return Image.fromarray(self.render(q).astype(np.uint8))


def px(b):  # CSS box -> screenshot box (screenshots are deviceScaleFactor 2)
    return [b["x"] * 2, b["y"] * 2, (b["x"] + b["width"]) * 2, (b["y"] + b["height"]) * 2]


def device_shot(frame, keys=(), tag=None, foot=None, p=(0.0, 1.0), zoom_to="screen"):
    """Echo Show from the whole device (p=0) to its screen (p=1)."""
    m = META[frame]
    dev = px(m["device"])
    dev = [dev[0] - 20, dev[1] - 20, dev[2] + 20, dev[3] + 20]
    scr = px(m["screen"])
    tap = None
    if "tap" in m:
        t = px(m["tap"])
        tap = ((t[0] + t[2]) / 2, (t[1] + t[3]) / 2)
    return Shot(frame, dev, scr, p=p, keys=keys, tag=tag, foot=foot, tap=tap)


class Card:
    def __init__(self, im, keys=()):
        self.im = np.asarray(im).astype(np.float32)
        self.keys = list(keys)

    def render(self, q, subs=None):
        return self.im

    def still(self, q=0.6):
        return Image.fromarray(self.im.astype(np.uint8))


def card(title, sub="", lines=None, link_lines=None, small=None, k=None, title_size=80):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.ellipse([140, 120, 176, 156], fill=ACCENT)
    d.text((196, 116), "Shop Counter", font=font(36, True), fill=MUTED)
    y = 220
    for line in wrap(d, title, font(title_size, True), 1640):
        d.text((140, y), line, font=font(title_size, True), fill=INK)
        y += int(title_size * 1.22)
    y += 14
    for line in wrap(d, sub, font(44), 1640) if sub else []:
        d.text((140, y), line, font=font(44), fill=MUTED)
        y += 60
    for a, b in lines or []:
        d.text((140, y + 8), a, font=font(34, True), fill=ACCENT)
        d.text((560, y + 8), b, font=font(34), fill=INK)
        y += 56
    for a, b in link_lines or []:
        y += 18
        d.text((140, y), a, font=font(34, True), fill=ACCENT)
        d.text((140, y + 46), b, font=ImageFont.truetype(MONO, 34), fill=INK)
        y += 104
    if small:
        d.text((140, y + 24), small, font=font(24), fill=MUTED)
    if k:
        bh = 40 + 53 * len(wrap(d, text_of(k), font(42), W - 180)[:3])
        d.line([90, H - bh - 20, W - 90, H - bh - 20], fill=(40, 52, 80), width=2)
        band(d, k, H - bh)
    return Card(im, [k] if k else [])


AUD = {k: read_wav(HERE / f"{AUDIO_DIR}/{k}.wav", TEMPO.get(v["voice"], 1.0)) for k, v in cfg["lines"].items()}
segs = []


def add(name, pic, keys=(), pad=0.4, min_s=2.0, gap=0.3, cut=False):
    """cut=True: hard cut into this segment (same device, next turn), else a short crossfade."""
    segs.append(dict(name=name, pic=pic, keys=list(keys), pad=pad, min_s=min_s, gap=gap, cut=cut))


ASK, SAY = (0.0, 0.25), (0.25, 1.0)  # ask frames stay wide on the device, answers push in to the screen

# 0:00 hook: Sam's honest "no" at Roborock (recorded live, used again later as the callback)
add("hook_ask", device_shot("sam_02_a_ask", ["h_sam"], p=ASK), ["h_sam"], pad=0.25)
add("hook_say", device_shot("sam_02_c_clean", ["h_alexa"], p=SAY), ["h_alexa"], pad=0.35, cut=True)
# the formula, one card
add("formula", card("Alexa understands what you mean. The store answers for the facts.", "Shop Counter, an Alexa+ add-on for shopping by voice",
                    k="c_n", title_size=76), ["c_n"], pad=0.3)
# why a simulator, over the live device
add("m_home", device_shot("maya_00_home", ["m_n0"], tag="Live on AWS Lambda · Claude Haiku 5.5 plays Alexa", foot=DISCLAIMER, p=(0.0, 0.4)), ["m_n0"], pad=0.3)
for n, (s, a) in {"01": ("m_s1", "m_a1"), "02": ("m_s2", "m_a2"), "03": ("m_s3", "m_a3"), "04": ("m_s4", "m_a4")}.items():
    add(f"m{n}_ask", device_shot(f"maya_{n}_a_ask", [s], p=ASK), [s], pad=0.1, min_s=1.4, cut=n != "01")
    add(f"m{n}_say", device_shot(f"maya_{n}_c_clean", [a], p=SAY), [a], pad=0.15, cut=True)
add("m05_tap", device_shot("maya_05_a_tap", ["m_n_tap"], tag="Voice first, not voice only", p=(0.6, 0.75)), ["m_n_tap"], pad=0.2, cut=True)
add("m05_say", device_shot("maya_05_c_clean", ["m_a5"], tag="Voice first, not voice only", p=(0.75, 1.0)), ["m_a5"], pad=0.15, cut=True)
add("m07_ask", device_shot("maya_07_a_ask", ["m_n1", "m_s7"], tag="New session", p=ASK), ["m_n1", "m_s7"], pad=0.1, min_s=1.4)
add("m07_say", device_shot("maya_07_c_clean", ["m_a7"], tag="New session", p=SAY), ["m_a7"], pad=0.2, cut=True)
# account linking: the consent page of the real OAuth flow, a tap on Allow
lk = META["link_01_consent"]
lc = px(lk["card"])
lt = px(lk["tap"])
add("link", Shot("link_01_consent", [lc[0] - 700, lc[1] - 120, lc[2] + 700, lc[3] + 120], [lc[0] - 260, lc[1] - 30, lc[2] + 260, lc[3] + 30],
                 keys=["l_n"], tag="Account linking · OAuth 2.1 + PKCE, live", tap=((lt[0] + lt[2]) / 2, (lt[1] + lt[3]) / 2)), ["l_n"], pad=0.3, min_s=4.0)
# Sam: Satechi first, then Roborock, same closet
add("s01_ask", device_shot("sam_01_a_ask", ["s_n0", "s_s1"], tag="Earlier, at Satechi", p=ASK), ["s_n0", "s_s1"], pad=0.1)
add("s01_say", device_shot("sam_01_c_clean", ["s_a1"], tag="Earlier, at Satechi", p=SAY), ["s_a1"], pad=0.15, cut=True)
add("s02_ask", device_shot("sam_02_a_ask", ["s_n1", "s_s2"], tag="Now at Roborock · a different store, the same closet", p=ASK), ["s_n1", "s_s2"], pad=0.1)
add("s02_back", device_shot("sam_02_c_clean", ["s_n2"], tag="Now at Roborock · a different store, the same closet", p=SAY), ["s_n2"], pad=0.2, cut=True)
# under the hood: push in on this run's JSON-RPC (tools/call check_compatibility and its result)
lg = META["sam_03_log"]["log"]
c, r = px(lg["call"]), px(lg["result"] or lg["call"])
pn = px(lg["panel"])  # start on the whole activity panel (the page's try-phrases stay out of the shot)
add("tech_log", Shot("sam_03_log", [pn[0] - 40, pn[1], pn[2], pn[3]], [c[0] - 24, c[1] - 20, c[2] + 24, min(r[3], c[1] + 700)], p=(0.0, 1.0), hold=0.5,
                     keys=["t_n1"], tag="MCP activity · this run's JSON-RPC: tools/call check_compatibility"), ["t_n1"], pad=0.2)
add("tech", card("How it's built", "", lines=[
    ("MCP", "self-hosted server, spec 2025-11-25, Streamable HTTP, 9 tools"),
    ("MCP Apps", "Echo Show screens from ui://shop-counter/view.html"),
    ("Agent Skill", "SKILL.md: which tool when, what never to invent"),
    ("AWS", "Lambda Function URL, DynamoDB closet, brain called from the Lambda"),
    ("Account linking", "OAuth 2.1, PKCE S256, consent page, rotating refresh tokens"),
    ("Eval", "81 of 81 shopper cases, 0 made-up facts"),
    ("Live model", "Claude Haiku 5.5 as Alexa: 19 of 21 conversations pass every check"),
], k="t_n2", title_size=72), ["t_n2"], pad=0.3)
add("final", card("Shop Counter", "the store clerk who remembers your stuff", link_lines=[("Try it:", SIM_URL), ("Open source (MIT)", REPO)],
                  small=DISCLAIMER, k="f_n"), ["f_n"], pad=1.6, min_s=6.0)

# timing
plan = []
for s in segs:
    a = [AUD[k] for k in s["keys"]]
    secs = sum(len(x) for x in a) / SR + s["gap"] * max(0, len(a) - 1) + 0.2 + s["pad"]
    plan.append({**s, "secs": max(secs, s["min_s"])})
total = sum(p["secs"] for p in plan)
print("total", round(total, 1), "s")
assert total < 178, f"too long: {total:.1f}s"

# per-line subtitle switch: a segment with two lines shows the first line's subtitle until the second starts
(HERE / "frames").mkdir(exist_ok=True)
voice = np.zeros(int((total + 2) * SR), np.float32)
timeline, t = [], 0.0
proc = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                         "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", str(TMP / "video.mp4")],
                        stdin=subprocess.PIPE)
prev = None
checks = 0
for s in plan:
    pic, keys = s["pic"], s["keys"]
    n = int(round(s["secs"] * FPS))
    starts, at = [], t + 0.2
    for k in keys:
        starts.append(at)
        a = AUD[k]
        s0 = int(at * SR)
        voice[s0:s0 + len(a)] += a
        at += len(a) / SR + s["gap"]
    subs = None
    if isinstance(pic, Shot) and len(keys) > 1:
        subs = [base_canvas([k], pic.tag, pic.foot) for k in keys]
    nx = 0 if (prev is None or s["cut"]) else int(XFADE * FPS)
    for f in range(n):
        q = f / max(1, n - 1)
        now = t + f / FPS
        sb = None
        if subs:
            i = max([j for j, st in enumerate(starts) if st - 0.05 <= now] or [0])
            sb = subs[i]
        cur = pic.render(q, sb)
        fr = prev * (1 - (f + 1) / (nx + 1)) + cur * ((f + 1) / (nx + 1)) if f < nx else cur
        proc.stdin.write(fr.astype(np.uint8).tobytes())
    prev = cur
    checks += 1
    pic.still(0.7).save(HERE / f"frames/v4_check_{checks:02d}_{s['name']}.jpg", quality=86)
    timeline.append({"segment": s["name"], "start": round(t, 2), "seconds": round(n / FPS, 2),
                     "lines": [{"key": k, "voice": cfg["lines"][k]["voice"], "text": text_of(k), "at": round(st, 2)} for k, st in zip(keys, starts)]})
    t += n / FPS
proc.stdin.close()
proc.wait()
voice = voice[: int(t * SR)]
voice = voice / max(1e-6, np.abs(voice).max()) * 0.9


def pad_music(n):
    """A quiet pad made here with numpy: four soft chords (C maj7, A min7, F maj7, G6), 8 s each, sine partials,
    slow attack and release, a gentle tremolo. No samples, no third-party audio."""
    tt = np.arange(n) / SR
    chords = [[48, 55, 64, 71], [45, 52, 60, 67], [41, 48, 57, 64], [43, 50, 59, 64]]
    out = np.zeros(n, np.float32)
    seg = 8.0
    for i in range(int(n / SR / seg) + 2):
        t0 = i * seg - 1.5
        a0, a1 = max(0, int(t0 * SR)), min(n, int((t0 + seg + 3.0) * SR))
        if a0 >= a1:
            continue
        lt = tt[a0:a1] - t0
        env = np.clip(lt / 2.5, 0, 1) * np.clip((seg + 3.0 - lt) / 2.5, 0, 1)
        sig = np.zeros(a1 - a0, np.float32)
        for m in chords[i % 4]:
            f0 = 440 * 2 ** ((m - 69) / 12)
            for det in (-0.6, 0.6):
                sig += np.sin(2 * np.pi * (f0 + det) * lt) * 0.5 + np.sin(2 * np.pi * 2 * (f0 + det) * lt) * 0.08
        out[a0:a1] += sig * env
    out *= 1 + 0.08 * np.sin(2 * np.pi * 0.17 * tt)
    out /= max(1e-6, np.abs(out).max())
    fade = np.clip(tt / 1.5, 0, 1) * np.clip((tt[-1] - tt) / 2.5, 0, 1)
    return (out * fade).astype(np.float32)


music = pad_music(len(voice))
# duck the pad a little under speech (envelope of the voice, 150 ms smoothing)
env = np.abs(voice)
k = int(0.15 * SR)
env = np.convolve(env, np.ones(k) / k, mode="same")
duck = 1.0 - 0.45 * np.clip(env / 0.05, 0, 1)
mix = voice + music * 0.075 * duck
pre = TMP / "mix.wav"
with wave.open(str(pre), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())

# loudness: a gentle compressor, gain, then a limiter on 4x oversampled audio. Two passes: the first measures the
# integrated loudness with the gain at 9 dB, the second sets the gain for -16 LUFS. Without the compressor the AAC
# encode overshot the limiter by 2-4 dB on TTS transients (loudnorm alone left +1.5 dBTP in the first v4 build).
def chain(gain):
    return (f"acompressor=threshold=0.1:ratio=3:attack=5:release=120,volume={gain:.2f}dB,aresample=192000,"
            "alimiter=limit=0.6:attack=1:release=80:level=disabled,aresample=48000")


probe = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(pre), "-af", chain(9.0) + ",ebur128", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
i_meas = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", probe)[-1])
af = chain(9.0 + (-16.0 - i_meas))
out = HERE / OUT_NAME
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(TMP / "video.mp4"), "-i", str(pre), "-af", af, "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(out)], check=True)
json.dump(timeline, open(HERE / "capture/timeline_v4.json", "w"), indent=2, ensure_ascii=False)
print(out, round(t, 1), "s")
