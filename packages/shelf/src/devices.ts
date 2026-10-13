/**
 * Device dictionary for Apple, Samsung, Google and Microsoft devices.
 *
 * Two jobs:
 *  1. find device mentions in store text (tags, titles, descriptions, options);
 *  2. decide whether a device the store lists covers the shopper's device.
 *
 * Matching is deliberately conservative: a bare family name like "iPhone" never
 * confirms a specific iPhone, because the connector changed (Lightning -> USB-C)
 * between generations.
 */

export type Brand = 'Apple' | 'Samsung' | 'Google' | 'Microsoft';
export type Port = 'USB-C' | 'Lightning';

export interface DeviceInfo {
  /** Canonical display name, e.g. "iPhone 15 Pro". */
  name: string;
  brand: Brand | null;
  /** Broad family, e.g. "iPhone", "MacBook Air", "Galaxy S". */
  family: string;
  /** Generation series when it matters, e.g. "iPhone 15" for "iPhone 15 Pro Max". */
  series: string | null;
  /** True for bare family names that say nothing about the generation ("iPhone", "Mac"). */
  generic: boolean;
  /** Wired charging port when we know it for sure, else null. */
  port: Port | null;
  /** True when the dictionary recognized it (false = free-text device from the shopper). */
  known: boolean;
  /**
   * What the shopper said beyond the model name: year, chip, size, revision ("2017 Intel", "14 M3").
   * Set by parseDevice only. A store listing without it is not proof for this exact device.
   */
  qualifier?: string;
  /** The full device as the shopper named it ("MacBook Pro 2017 Intel"). Set by parseDevice only. */
  label?: string;
}

export type DeviceKind = 'phone' | 'laptop' | 'tablet' | 'desktop' | 'watch' | 'earbuds' | 'robot' | 'other';

/** The full name to speak and show: the model plus whatever else the shopper said about it. */
export function deviceLabel(d: DeviceInfo): string {
  return d.label ?? d.name;
}

/** What kind of device it is, for "my phone" and for the icon on the My devices screen. */
export function deviceKind(d: DeviceInfo): DeviceKind {
  const n = d.name;
  if (d.known) {
    if (d.family === 'iPhone') return 'phone';
    if (/^(iPad|Pixel Tablet|Galaxy Tab|Surface (Pro|Go))/i.test(n)) return 'tablet';
    if (/^(MacBook|Pixelbook|Surface (Laptop|Book))/i.test(n)) return 'laptop';
    if (/^(iMac|Mac)\b/i.test(n)) return 'desktop';
    if (/Watch/i.test(n)) return 'watch';
    if (/AirPods|Buds/i.test(n)) return 'earbuds';
    if (/^(Galaxy|Pixel)\b/i.test(n)) return 'phone';
    return 'other';
  }
  const t = `${n} ${d.label ?? ''}`;
  if (/\b(robot|vacuum|roborock|saros|qrevo|roomba|dreame|eufy|mop)\b|\b[QS]\d{1,2}\b/i.test(t)) return 'robot';
  if (/\b(phone|smartphone|oneplus|motorola|moto|xiaomi|redmi)\b/i.test(t)) return 'phone';
  if (/\b(laptop|notebook|chromebook|thinkpad|xps|zenbook|spectre)\b/i.test(t)) return 'laptop';
  if (/\b(tablet|kindle)\b/i.test(t)) return 'tablet';
  if (/\b(watch)\b/i.test(t)) return 'watch';
  if (/\b(earbuds|headphones|buds)\b/i.test(t)) return 'earbuds';
  return 'other';
}

export interface DeviceMention {
  device: DeviceInfo;
  /** The exact text that matched. */
  raw: string;
  index: number;
}

const LIGHTNING_IPHONES = new Set(['8', 'X', 'XS', 'XR', '11', '12', '13', '14', 'SE']);

function iphone(gen: string | null, suffix: string | null): DeviceInfo {
  if (!gen) {
    return { name: 'iPhone', brand: 'Apple', family: 'iPhone', series: null, generic: true, port: null, known: true };
  }
  const g = gen === 'Air' ? 'Air' : /^(xs|xr|x|se)$/i.test(gen) ? gen.toUpperCase() : gen.toLowerCase();
  const series = g === 'Air' ? 'iPhone Air' : `iPhone ${g}`;
  const name = suffix ? `${series} ${suffix}` : series;
  const num = parseInt(g, 10);
  const port: Port | null = LIGHTNING_IPHONES.has(g)
    ? 'Lightning'
    : g === 'Air' || (Number.isFinite(num) && num >= 15)
      ? 'USB-C'
      : null;
  return { name, brand: 'Apple', family: 'iPhone', series: suffix ? series : null, generic: false, port, known: true };
}

function normSuffix(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t === 'pro max' || t === 'promax') return 'Pro Max';
  if (t === 'pro') return 'Pro';
  if (t === 'plus' || t === '+') return 'Plus';
  if (t === 'mini') return 'mini';
  if (t === 'ultra') return 'Ultra';
  if (t === 'fe') return 'FE';
  if (t === 'pro xl') return 'Pro XL';
  if (t === 'pro fold') return 'Pro Fold';
  if (t === 'xl') return 'XL';
  return s.trim();
}

const APPLE_GENERIC = new Set(['iPad', 'Mac', 'MacBook']);

function simple(name: string, brand: Brand, family = name, port: Port | null = null): DeviceInfo {
  return { name, brand, family, series: null, generic: APPLE_GENERIC.has(name) || name === 'Galaxy' || name === 'Pixel', port, known: true };
}

interface Rule {
  re: RegExp;
  build: (m: RegExpExecArray) => DeviceInfo[];
}

// `(?![\w-])` after a model number stops "iPhone 15W" or "Pixel 8-bit" from matching a model.
const RULES: Rule[] = [
  {
    re: /\biPhone(?:\s?(\d{1,2}e?|XS|XR|X|SE)(?![\w-])((?:\s?\/\s?\d{1,2}(?![\w-]))*)(?:\s(Pro\s?Max|Pro|Plus|mini)\b)?|\s(Air)\b)?(?![a-z])/gi,
    build: (m) => {
      if (m[4]) return [iphone('Air', null)];
      if (!m[1]) return [iphone(null, null)];
      const gens = [m[1], ...(m[2] ? m[2].split('/').map((s) => s.trim()).filter(Boolean) : [])];
      const suffix = normSuffix(m[3]);
      return gens.map((g) => iphone(g, suffix));
    },
  },
  {
    re: /\biPad(?:\s(Pro|Air|mini))?(?:\s\(?(M\d)\)?(?![\w-]))?(?![a-z])/gi,
    build: (m) => {
      const fam = m[1] ? `iPad ${m[1].toLowerCase() === 'mini' ? 'mini' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()}` : 'iPad';
      const chip = m[2] ? m[2].toUpperCase() : null;
      const name = chip ? `${fam} ${chip}` : fam;
      const port: Port | null = fam !== 'iPad' || chip ? 'USB-C' : null;
      return [{ name, brand: 'Apple', family: fam, series: null, generic: fam === 'iPad' && !chip, port, known: true }];
    },
  },
  {
    re: /\bMacBook(?![a-z])(?:\s(Air|Pro))?(?:\s1[3-6](?:"|”|''|-inch|\sinch)?(?![\w"”'-]))?(?:\s\(?(M\d)(?:\s(Pro|Max|Ultra))?\)?(?![\w-]))?/gi,
    build: (m) => {
      const fam = m[1] ? `MacBook ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}` : 'MacBook';
      const chip = m[2] ? `${m[2].toUpperCase()}${m[3] ? ' ' + normSuffix(m[3]) : ''}` : null;
      const name = chip ? `${fam} ${chip}` : fam;
      return [{ name, brand: 'Apple', family: fam, series: null, generic: fam === 'MacBook', port: chip || fam !== 'MacBook' ? 'USB-C' : null, known: true }];
    },
  },
  { re: /\biMac\sPro\b/gi, build: () => [simple('iMac Pro', 'Apple')] },
  { re: /\biMac\b(?!\sPro)/gi, build: () => [simple('iMac', 'Apple')] },
  { re: /\bMac\s?mini\b/gi, build: () => [simple('Mac mini', 'Apple')] },
  { re: /\bMac\sStudio\b/gi, build: () => [simple('Mac Studio', 'Apple')] },
  { re: /\bMac\sPro\b/gi, build: () => [simple('Mac Pro', 'Apple')] },
  { re: /\bMac\b(?!\s?(?:mini|Studio|Pro)\b)(?![\w-])/g, build: () => [simple('Mac', 'Apple')] },
  { re: /\bApple\sWatch\b/gi, build: () => [simple('Apple Watch', 'Apple')] },
  {
    re: /\bAirPods(?:\s(Pro|Max))?\b/gi,
    build: (m) => [simple(m[1] ? `AirPods ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}` : 'AirPods', 'Apple')],
  },
  {
    re: /\b(?:Samsung\s)?Galaxy\s(S\d{1,2}|Z\s?Fold\s?\d|Z\s?Flip\s?\d|Note\s?\d{1,2}|Tab\sS\d{1,2}|A\d{2}|Buds\s?\d?|Watch\s?\d?)(?![\w-])(\+|\s(?:Ultra|FE|Plus)\b)?/gi,
    build: (m) => {
      const model = m[1].replace(/\s+/g, ' ').replace(/^z\s?/i, 'Z ').replace(/^(Z )(fold|flip)\s?/i, (_a, z: string, f: string) => `${z}${f[0].toUpperCase()}${f.slice(1).toLowerCase()}`);
      const cap = model.charAt(0).toUpperCase() + model.slice(1);
      const suffix = normSuffix(m[2]);
      const series = `Galaxy ${cap}`;
      const isPhone = /^(S|Z|Note|A)/i.test(cap);
      return [{
        name: suffix ? `${series}${suffix === 'Plus' ? '+' : ' ' + suffix}` : series,
        brand: 'Samsung', family: 'Galaxy', series: suffix ? series : null, generic: false,
        port: isPhone || /^Tab/i.test(cap) ? 'USB-C' : null, known: true,
      }];
    },
  },
  {
    re: /\b(?:Google\s)?Pixel\s(\d{1,2}a?|Fold|Tablet)(?![\w-])(?:\s(Pro\sXL|Pro\sFold|Pro|XL)\b)?/gi,
    build: (m) => {
      const series = `Pixel ${m[1][0].toUpperCase()}${m[1].slice(1)}`;
      const suffix = normSuffix(m[2]);
      return [{ name: suffix ? `${series} ${suffix}` : series, brand: 'Google', family: 'Pixel', series: suffix ? series : null, generic: false, port: 'USB-C', known: true }];
    },
  },
  { re: /\bPixel\s?Watch\b/gi, build: () => [simple('Pixel Watch', 'Google')] },
  { re: /\bPixel\s?Buds\b/gi, build: () => [simple('Pixel Buds', 'Google')] },
  { re: /\bPixelbook\b/gi, build: () => [simple('Pixelbook', 'Google', 'Pixelbook', 'USB-C')] },
  {
    re: /\b(?:Microsoft\s)?Surface\s(Pro|Laptop|Go|Book)\b/gi,
    build: (m) => [simple(`Surface ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`, 'Microsoft')],
  },
  // Bare family names last, so a specific model above always wins the same span.
  // "charger for my Pixel" names a Pixel, just not which one: it must not fall back to the closet.
  { re: /\b(?:Google\s)?Pixel\b(?![\w-])/gi, build: () => [simple('Pixel', 'Google')] },
  { re: /\b(?:Samsung\s)?Galaxy\b(?![\w-])/gi, build: () => [simple('Galaxy', 'Samsung')] },
];

/** Every device mention in a piece of text, in order of appearance, without overlaps. */
export function findDevices(text: string): DeviceMention[] {
  const found: DeviceMention[] = [];
  const taken: [number, number][] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      for (const device of rule.build(m)) found.push({ device, raw: m[0], index: start });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Parse what a shopper said ("my iphone 15 pro") into a device. Unknown text stays as-is. */
export function parseDevice(input: string): DeviceInfo {
  const cleaned = input.replace(/\b(my|our|an?|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const [first] = findDevices(cleaned);
  if (!first) return { name: cleaned, brand: null, family: cleaned, series: null, generic: false, port: null, known: false, label: cleaned };
  // Whatever else the shopper said about the model ("2017 Intel", "14 M3", "(3rd gen)") is kept:
  // a listing for the bare model does not prove it for this one. Filler words are not a qualifier.
  const rest = `${cleaned.slice(0, first.index)} ${cleaned.slice(first.index + first.raw.length)}`
    .replace(/[(),]/g, ' ')
    .replace(/\b(new|old|older|latest|current|work|personal|apple|samsung|google|microsoft|phone|laptop|tablet|computer)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qualifier = /\d|\b(intel|silicon|retina|touch\s?bar|gen|generation|refurbished)\b/i.test(rest) ? rest : '';
  const d = first.device;
  // Keep the shopper's own words for the model ("MacBook Pro 14 M3") unless they differ only in case or spacing.
  const flat = (x: string) => x.toLowerCase().replace(/[\s"”'-]+|inch/g, '');
  const said = flat(first.raw) === flat(d.name) ? d.name : first.raw.trim();
  return qualifier ? { ...d, qualifier, label: `${said} ${qualifier}` } : { ...d, label: said };
}

/** Pull every recognizable device out of a free-text need ("charger for my iPhone 15 and MacBook Air"). */
export function devicesInText(text: string): DeviceInfo[] {
  const seen = new Set<string>();
  const out: DeviceInfo[] = [];
  for (const { device } of findDevices(text)) {
    if (!seen.has(device.name)) { seen.add(device.name); out.push(device); }
  }
  return out;
}

export type MatchLevel = 'exact' | 'series' | 'family';

/**
 * How a device the store lists relates to the shopper's device. Only `exact` is proof of fit.
 * - exact:  "iPhone 15" lists "iPhone 15" (spelling variants are normalized by the parser)
 * - series: store lists "iPhone 15", shopper has "iPhone 15 Pro"
 * - family: store lists "MacBook Air", shopper has "MacBook Air M3"; or the same name, but the
 *           shopper named more ("MacBook Pro 2017 Intel" vs a listing for "MacBook Pro")
 * Bare generic names ("iPhone", "iPad", "Mac") never match.
 */
export function deviceMatch(shopper: DeviceInfo, listed: DeviceInfo): MatchLevel | null {
  const eq = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) === 0;
  if (listed.generic || shopper.generic) return null;
  if (eq(listed.name, shopper.name)) return shopper.qualifier ? 'family' : 'exact';
  if (shopper.series && eq(listed.name, shopper.series)) return 'series';
  if (listed.family !== 'iPhone' && listed.family !== 'Galaxy' && listed.family !== 'Pixel' && eq(listed.name, shopper.family)) {
    return 'family';
  }
  return null;
}
