/**
 * Deterministic feature extraction from Shopify fields (title, body_html, tags, options).
 *
 * Rules, not a model: every highlight and every compatibility claim can be traced
 * back to a literal piece of store text. When the text is ambiguous we emit nothing.
 *
 * Known traps (covered by tests):
 *  - Shopify body HTML splits words across spans ("1 5 W" for "15 W"): body wattage
 *    is only read in "delivers / up to / NNW total" phrasings, and never from glued digits.
 *  - Tags are partly merchandising labels ("magsafe charger" sits on USB-C cables),
 *    so tags feed device compatibility only, never feature highlights.
 *  - "Pixel" as in "4K pixels" is not a Google Pixel; "iPhone 15W" is not an iPhone 15.
 */
import { findDevices, type DeviceInfo } from './devices.js';
import { escapeRegExp, sentences, wordToNumber } from './text.js';
import type { EvidenceSource } from './types.js';

export interface Features {
  watts: number | null;
  /** True when the wattage is pass-through for a hub rather than charger output. */
  passThrough: boolean;
  usbCPorts: number | null;
  usbAPorts: number | null;
  totalPorts: number | null;
  inOne: number | null;
  connectors: string[];
  wireless: string[];
  gan: boolean;
  batteryMah: number | null;
  suctionPa: number | null;
  displays: string[];
  traits: string[];
}

export interface SourceText {
  title: string;
  description: string;
  tags: string[];
  options: string[];
}

export interface DeviceEvidence {
  device: DeviceInfo;
  source: EvidenceSource;
  /** Literal substring of the store data. */
  quote: string;
}

const NUM_WORD = '(\\d{1,2}|single|one|dual|two|twin|three|triple|four|quad|five|six|seven|eight)';

function count(re: RegExp, text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = wordToNumber(m[1]);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

function parseNumber(s: string): number {
  return Number(s.replace(/,/g, ''));
}

export function extractFeatures(src: SourceText): Features {
  const { title, description } = src;
  const both = `${title}\n${description}`;

  // Wattage: title first (most reliable), then explicit body phrasings.
  let watts: number | null = null;
  for (const m of title.matchAll(/(?<![\d.])(\d{1,3})\s?W\b/g)) watts = Math.max(watts ?? 0, Number(m[1]));
  if (watts === null) {
    const bodyRe = /\b(?:delivers?|delivering|provides?|up to|outputs?|total of)\s(?:up to\s)?(\d{1,3})\s?W\b|\b(\d{2,3})\s?W\s(?:total|max|maximum|output|power delivery|PD)\b/gi;
    for (const m of description.matchAll(bodyRe)) {
      const n = Number(m[1] ?? m[2]);
      if (n >= 5) watts = Math.max(watts ?? 0, n);
    }
  }
  const passThrough = watts !== null && /pass[- ]?through/i.test(title);

  const usbCPorts = count(new RegExp(`\\b${NUM_WORD}\\s(?:USB-C|USB\\sType-C|Type-C)(?:\\s(?:PD|Power Delivery))?\\sports?\\b`, 'gi'), both);
  const usbAPorts = count(new RegExp(`\\b${NUM_WORD}\\s(?:USB-A|USB\\s3\\.0|USB)\\sports?\\b`, 'gi'), both);
  const totalPorts = count(/\b(\d{1,2})[-\s]Ports?\b/gi, title) ?? count(new RegExp(`\\b${NUM_WORD}[-\\s]ports?\\b`, 'gi'), description);
  const inOneM = /\b(\d{1,2})-in-1\b/i.exec(title);
  const inOne = inOneM ? Number(inOneM[1]) : null;

  const connectors: string[] = [];
  const tb = /\bThunderbolt\s?(\d)\b/i.exec(both);
  if (tb) connectors.push(`Thunderbolt ${tb[1]}`);
  if (/\bUSB4\b/i.test(both)) connectors.push('USB4');
  if (/\b(USB-C|USB\sType-C|Type-C|USB C)\b/i.test(both)) connectors.push('USB-C');
  if (/\bLightning\b/.test(title)) connectors.push('Lightning');
  if (/\bHDMI\b/.test(both)) connectors.push('HDMI');

  const wireless: string[] = [];
  if (/\bQi2\b/i.test(both)) wireless.push('Qi2');
  else if (/\bQi\b(?:[- ](?:enabled|certified|wireless|compatible))?/.test(both)) wireless.push('Qi');
  if (wireless.length === 0 && /\bwireless charg/i.test(title)) wireless.push('Wireless charging');

  const gan = /\bGaN\b/.test(both);

  const mah = /\b(\d{1,3},\d{3}|\d{4,5})\s?mAh\b/i.exec(both);
  const batteryMah = mah ? parseNumber(mah[1]) : null;

  const pa = /\b(\d{1,3},\d{3}|\d{4,5})\s?Pa\b/.exec(both);
  const suctionPa = pa ? parseNumber(pa[1]) : null;

  const displays: string[] = [];
  const res = /\b(8K|4K)\b/.exec(both);
  if (res && connectors.includes('HDMI')) displays.push(`${res[1]} HDMI`);
  if (/\btriple display\b/i.test(title)) displays.push('Triple display');
  else if (/\bdual display\b/i.test(title)) displays.push('Dual display');

  const traits: string[] = [];
  if (/\banti-?tangle\b/i.test(both)) traits.push('Anti-tangle brush');
  if (/\bauto[- ]?empty\b/i.test(both)) traits.push('Auto-empty dock');
  if (/\bmop\b/i.test(title)) traits.push('Vacuum and mop');
  if (/\bfoldable\b/i.test(title)) traits.push('Foldable');
  if (/\bLCD\b|\bdisplay shows\b/i.test(description) && /charger/i.test(title)) traits.push('Live wattage display');
  if (/certified refurbished/i.test(title)) traits.push('Certified refurbished');

  return { watts, passThrough, usbCPorts, usbAPorts, totalPorts, inOne, connectors, wireless, gan, batteryMah, suctionPa, displays, traits };
}

/** Up to `max` short, speakable highlights, most useful first. */
export function highlightsFrom(f: Features, max = 4): string[] {
  const h: string[] = [];
  if (f.watts !== null) {
    if (f.passThrough) h.push(`${f.watts}W pass-through charging`);
    else if (f.wireless.includes('Qi2')) h.push(`Up to ${f.watts}W Qi2 wireless`);
    else h.push(`Up to ${f.watts}W`);
  } else if (f.wireless.length) {
    h.push(f.wireless[0] === 'Wireless charging' ? 'Wireless charging' : `${f.wireless[0]} wireless charging`);
  }
  if (f.suctionPa !== null) h.push(`${f.suctionPa.toLocaleString('en-US')} Pa suction`);
  if (f.usbCPorts !== null && f.usbAPorts !== null) h.push(`${f.usbCPorts} USB-C + ${f.usbAPorts} USB-A ports`);
  else if (f.usbCPorts !== null) h.push(`${f.usbCPorts} USB-C port${f.usbCPorts === 1 ? '' : 's'}`);
  else if (f.totalPorts !== null) h.push(`${f.totalPorts} ports`);
  else if (f.inOne !== null) h.push(`${f.inOne}-in-1`);
  const tb = f.connectors.find((c) => c.startsWith('Thunderbolt') || c === 'USB4');
  if (tb) h.push(tb);
  if (f.displays[0]) h.push(f.displays[0]);
  if (f.gan) h.push('GaN');
  if (f.batteryMah !== null) h.push(`${f.batteryMah.toLocaleString('en-US')} mAh battery`);
  for (const t of f.traits) h.push(t);
  return [...new Set(h)].slice(0, max);
}

const COMPAT_CONTEXT = /\b(compatible|works with|work with|designed for|made for|fits?|for your|supports?|charges? (?:your|an?|the)|power(?:s)? (?:your|an?|the)|for (?:iPhone|iPad|MacBook|Mac|Apple Watch|AirPods|Galaxy|Pixel|Surface))\b/i;

/** Trim a sentence to at most `max` chars around `needle`, keeping it a literal substring. */
function window(sentence: string, needle: string, max = 160): string {
  if (sentence.length <= max) return sentence;
  const at = Math.max(0, sentence.indexOf(needle));
  const start = Math.max(0, Math.min(at - Math.floor((max - needle.length) / 2), sentence.length - max));
  return sentence.slice(start, start + max).trim();
}

/**
 * Devices the store itself lists, with a literal quote for each.
 * Tags are taken whole (Satechi-style "iPhone 15", "Device: iPad Pro"). Titles count as listing.
 * Descriptions count only inside a compatibility phrase ("designed for iPhone 12/13"),
 * so marketing lines like "pairs naturally with MacBook Pro" are not treated as a promise.
 */
export function extractDeviceEvidence(src: SourceText): DeviceEvidence[] {
  const out: DeviceEvidence[] = [];
  const add = (device: DeviceInfo, source: EvidenceSource, quote: string) => {
    if (!out.some((e) => e.device.name === device.name && e.source === source)) out.push({ device, source, quote });
  };
  for (const tag of src.tags) {
    const value = tag.replace(/^device:\s*/i, '').trim();
    const mentions = findDevices(value);
    // Only tags that are *just* a device name (plus colour words like "MacBook Air Gold").
    if (mentions.length === 1 && mentions[0].index === 0 && /^[\s\w]*$/.test(value.slice(mentions[0].raw.length))) {
      add(mentions[0].device, 'tags', tag);
    }
  }
  // A device named inside "Not compatible with ..." is the opposite of a listing.
  for (const m of findDevices(src.title)) if (!negatedAt(src.title, m.index)) add(m.device, 'title', src.title);
  for (const opt of src.options) for (const m of findDevices(opt)) if (!negatedAt(opt, m.index)) add(m.device, 'options', opt);
  for (const s of sentences(src.description)) {
    if (!COMPAT_CONTEXT.test(s)) continue;
    for (const m of findDevices(s)) if (!negatedAt(s, m.index)) add(m.device, 'description', window(s, m.raw));
  }
  return out;
}

/** "Not compatible with X", "doesn't fit X", "incompatible with X": the store says no for whatever follows. */
const NEGATION = /(?:\bnot\s+(?:compatible|designed|made|suitable|intended)\s+(?:with|for)|\b(?:does\s+not|doesn't|do\s+not|don't|will\s+not|won't)\s+(?:fit|work|support)(?:\s+(?:with|on|for))?|\bincompatible\s+with|\bnot\s+for\s+use\s+with)\b[^.;:!?]*$/i;

/** Is the text at `index` inside a negated compatibility phrase of the same clause? */
export function negatedAt(text: string, index: number): boolean {
  return NEGATION.test(text.slice(Math.max(0, index - 80), index));
}

/**
 * The store explicitly says the product does NOT work with `needle` ("(Not compatible with Saros 10R)").
 * Returns the literal clause as evidence, or null.
 */
export function findNegative(src: SourceText, needle: string): { source: EvidenceSource; quote: string } | null {
  if (needle.trim().length < 2) return null;
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(needle.trim())}(?![\\w-])`, 'gi');
  const scan = (text: string): boolean => {
    for (const m of text.matchAll(re)) if (negatedAt(text, m.index ?? 0)) return true;
    return false;
  };
  if (scan(src.title)) return { source: 'title', quote: src.title };
  const opt = src.options.find(scan);
  if (opt) return { source: 'options', quote: opt };
  for (const s of sentences(src.description)) {
    if (scan(s)) {
      const at = s.search(re);
      return { source: 'description', quote: window(s, s.slice(at, at + needle.length)) };
    }
  }
  return null;
}

/** Literal, case-insensitive search for a free-text device in store data (for devices outside the dictionary). */
export function findLiteral(src: SourceText, needle: string): { source: EvidenceSource; quote: string } | null {
  if (needle.trim().length < 3) return null;
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(needle.trim())}(?![\\w-])`, 'i');
  // A tag counts only when it IS the device ("Saros 10R"): "magsafe charger" is a shelf label, not a promise.
  const whole = needle.trim().toLowerCase();
  const tag = src.tags.find((t) => t.replace(/^device:\s*/i, '').trim().toLowerCase() === whole);
  if (tag) return { source: 'tags', quote: tag };
  const hit = (text: string) => { const m = re.exec(text); return m && !negatedAt(text, m.index) ? m : null; };
  if (hit(src.title)) return { source: 'title', quote: src.title };
  const opt = src.options.find((o) => hit(o));
  if (opt) return { source: 'options', quote: opt };
  for (const s of sentences(src.description)) {
    const m = hit(s);
    if (m && COMPAT_CONTEXT.test(s)) return { source: 'description', quote: window(s, m[0]) };
  }
  return null;
}

/* ---------- what kind of thing is this? (from the product's own words, not the store's collection) ---------- */

/** Things a store sells next to products that are not the product itself. */
export type Offer = 'standard' | 'protection_plan' | 'trade_in' | 'points';

export interface ItemKind {
  /** Physical form when it matters for matching: "robot vacuum", "stick vacuum", "wet-dry vacuum", "handheld vacuum". */
  form: string | null;
  offer: Offer;
}

const NON_ROBOT_FORMS: [RegExp, string][] = [
  [/\bwet[\s-]*(?:and|&)?[\s-]*dry\b/i, 'wet-dry vacuum'],
  [/\bstick\s+vacuum\b|\bcordless\s+(?:stick\s+)?vacuum\b/i, 'stick vacuum'],
  [/\bhand-?held\s+vacuum\b/i, 'handheld vacuum'],
];

/**
 * Stores file products in collections for merchandising (Roborock lists its F25 wet-dry and H60 stick
 * vacuums under "Robot Vacuums"), so the form is read from the title. Only the head of "X for Y" says
 * what the product is: "Cleaning Solution for Robot Vacuums" is not a robot.
 */
export function classifyItem(src: SourceText, categories: string[]): ItemKind {
  const cats = categories.join(' ');
  const forAt = src.title.search(/\sfor\s/i);
  const head = forAt > 0 ? src.title.slice(0, forAt) : src.title;
  let offer: Offer = 'standard';
  if (/\bwarrant(?:y|ies)\b|\bprotection\b/i.test(cats) || /\b(?:extended warranty|protection plan|accident protection)\b/i.test(src.title)) offer = 'protection_plan';
  else if (/\btrade[\s-]?in\b/i.test(`${src.title} ${cats}`)) offer = 'trade_in';
  else if (/\bpoints?\s+program\b/i.test(src.title) || /^\s*points?\s*$/i.test(cats)) offer = 'points';
  let form: string | null = null;
  for (const [re, f] of NON_ROBOT_FORMS) if (re.test(head)) { form = f; break; }
  if (!form && /\brobot\b/i.test(head) && /\bvacuum|\bmop\b|\bcleaner\b/i.test(`${head} ${cats}`)) form = 'robot vacuum';
  return { form, offer };
}
