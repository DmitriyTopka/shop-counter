// Voice in (Web Speech API, Chrome) and voice out (speechSynthesis). Both degrade quietly:
// no recognition -> the mic button hides, typing still works; muted -> captions only.
/* eslint-disable @typescript-eslint/no-explicit-any */

let voice: SpeechSynthesisVoice | null = null;
const PREFERRED = ['Samantha', 'Google US English', 'Microsoft Aria Online (Natural) - English (United States)', 'Microsoft Jenny', 'Ava', 'Allison', 'Karen'];

function pickVoice() {
  const all = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en'));
  voice = PREFERRED.map((n) => all.find((v) => v.name.startsWith(n))).find(Boolean) ?? all.find((v) => v.lang === 'en-US') ?? all[0] ?? null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export let muted = new URLSearchParams(location.search).has('mute');
export function setMuted(v: boolean) { muted = v; if (v && 'speechSynthesis' in window) speechSynthesis.cancel(); }

export function speak(text: string, onStart: () => void, onEnd: () => void) {
  if (muted || !('speechSynthesis' in window) || !text) {
    onStart();
    // keep the "speaking" bar visible for roughly reading time
    setTimeout(onEnd, Math.min(6000, 600 + text.length * 45));
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = 'en-US';
  u.rate = 1.03;
  u.onstart = onStart;
  u.onend = onEnd;
  u.onerror = onEnd;
  speechSynthesis.speak(u);
}

export function stopSpeaking() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }

const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
export const canListen = !!SR;

/** Starts one recognition round. Returns a stop() function. */
export function listen(handlers: { interim: (t: string) => void; final: (t: string) => void; end: () => void; error: (e: string) => void }) {
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let done = false;
  rec.onresult = (e: any) => {
    let text = '';
    let isFinal = false;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
      if (e.results[i].isFinal) isFinal = true;
    }
    if (isFinal && !done) { done = true; handlers.final(text.trim()); } else handlers.interim(text);
  };
  rec.onerror = (e: any) => handlers.error(e.error ?? 'error');
  rec.onend = () => handlers.end();
  rec.start();
  return () => { try { rec.stop(); } catch { /* already stopped */ } };
}
