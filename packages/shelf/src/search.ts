/**
 * Search: BM25 over weighted fields (title, category, tags, description), then hard filters
 * (budget, stock, category, must-have) and a ranking that explains itself (`why`).
 *
 * Shopper devices are not search words: "charger for my iPhone 15" searches "charger"
 * and then prefers products the store lists for iPhone 15.
 */
import { deviceLabel, deviceMatch, findDevices, type DeviceInfo } from './devices.js';
import type { Catalog, CatalogItem, CatalogVariant } from './normalize.js';
import { joinAnd, money, round2 } from './text.js';

const STOP = new Set(
  ('a an the for my me i im i\'m to and or with of in on at that this these those need want wanna looking look ' +
    'something some thing things good great best nice please can could would you your find show get buy got have has ' +
    'under below less than around about dollar dollars usd budget cheap cheaper is are be it its one ones new ' +
    'which what any also just like will should do does some kind sort type').split(/\s+/),
);

// No device names here on purpose: "laptop" must not turn into every MacBook-tagged product.
const SYNONYMS: Record<string, string[]> = {
  earbud: ['airpod'],
  headphone: ['headset'],
  mice: ['mouse'],
  cord: ['cable'],
  hub: ['multiport', 'adapt'],
  dock: ['dock', 'station'],
  vacuum: ['vacuum', 'robot'],
  plug: ['outlet'],
  // No "charger" -> "charging": that would turn every charging cable into a charger.
  // Pets mean hair: anti-tangle brushes are the honest answer in vacuum stores.
  cat: ['pet', 'hair', 'tangle'],
  dog: ['pet', 'hair', 'tangle'],
  pet: ['hair', 'tangle'],
};

/** Other brands shoppers ask a single-brand store about. Only used to say "I don't see X here" honestly. */
const COMPETITORS = new Set(
  ('anker belkin ugreen mophie baseus zagg otterbox spigen esr aukey nomad twelvesouth logitech razer ' +
    'dyson roomba irobot ecovacs deebot shark eufy dreame narwal bissell tineco samsung lg').split(/\s+/),
);
/** Device words the typo fixer may correct to (they are removed from the text index on purpose). */
const DEVICE_WORDS = ['iphone', 'ipad', 'macbook', 'airpods', 'imac', 'galaxy', 'pixel', 'surface'];
/** Connector words that change what a product is: a "Lightning cable" request is not met by a USB-C cable. */
const HARD_WORDS = new Set(['lightning', 'thunderbolt']);
/** Model codes: "s8", "q7", "f25", "h60", "qi2", "ex1". */
const MODEL_CODE = /^[a-z]{1,3}\d{1,3}[a-z]{0,2}$/;
const NON_ROBOT_NEED = /\b(stick|cordless|hand-?held|wet[\s-]*(?:and|&)?[\s-]*dry)\b/i;

/** Optimal string alignment distance, capped: returns max+1 as soon as it is exceeded. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/**
 * Fix typos against the store's own vocabulary ("chargr for my macbok" -> "charger for my macbook").
 * Only words the catalog does not know at all are touched, and only to a close, known word.
 */
export function correctTypos(need: string, index: SearchIndex): { text: string; fixes: [string, string][] } {
  const fixes: [string, string][] = [];
  const text = need.replace(/[A-Za-z]{4,}/g, (w) => {
    const lw = w.toLowerCase();
    if (STOP.has(lw) || COMPETITORS.has(lw) || DEVICE_WORDS.includes(lw) || SYNONYMS[stem(lw)] || index.df.has(stem(lw))) return w;
    const max = lw.length >= 7 ? 2 : 1;
    let best: string | null = null;
    let bestD = max + 1;
    let bestDf = -1;
    const consider = (t: string, df: number) => {
      if (t.length < 3 || !/^[a-z]+$/.test(t)) return;
      const d = editDistance(lw, t, max);
      if (d < bestD || (d === bestD && df > bestDf)) { best = t; bestD = d; bestDf = df; }
    };
    for (const [t, df] of index.df) consider(t, df);
    for (const t of DEVICE_WORDS) consider(t, Number.MAX_SAFE_INTEGER);
    if (best === null || bestD > max) return w;
    fixes.push([w, best]);
    return best;
  });
  return { text, fixes };
}

/**
 * Light English stemmer for product words. Plurals fold ("chargers" -> "charger"), "-ing" folds
 * ("charging" -> "charg"), but "-er" is kept so a "charger" search does not pull in "charging cables".
 */
export function stem(w: string): string {
  let t = w;
  if (t.length > 3 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  return t;
}

export function tokenize(text: string, keepStop = false): string[] {
  const t = text
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\busb[\s-]?type[\s-]?c\b|\btype[\s-]?c\b|\busb[\s-]c\b/g, ' usbc ')
    .replace(/\busb[\s-]a\b/g, ' usba ')
    .replace(/\bwi[\s-]?fi\b/g, ' wifi ')
    .replace(/\b(\d{1,2})-in-1\b/g, ' $1in1 ')
    .replace(/'s\b/g, '');
  return t
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (keepStop || !STOP.has(w)))
    .map(stem);
}

interface FieldDoc {
  tf: Map<string, number>;
  len: number;
}

interface IndexedDoc {
  item: CatalogItem;
  fields: Record<FieldName, FieldDoc>;
  strong: Set<string>;
}

type FieldName = 'title' | 'category' | 'tags' | 'body';
const FIELDS: FieldName[] = ['title', 'category', 'tags', 'body'];
const WEIGHTS: Record<FieldName, number> = { title: 3, category: 2, tags: 1.5, body: 1 };
/** Per-field length normalization (BM25F): long descriptions are damped, titles barely. */
const B: Record<FieldName, number> = { title: 0.3, category: 0.3, tags: 0.5, body: 0.75 };

function fieldDoc(text: string): FieldDoc {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, len: tokens.length };
}

export interface SearchIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: Record<FieldName, number>;
}

export function buildIndex(catalog: Catalog): SearchIndex {
  const docs: IndexedDoc[] = catalog.items.map((item) => {
    const fields: Record<FieldName, FieldDoc> = {
      title: fieldDoc(item.title),
      category: fieldDoc(item.categories.join(' ')),
      tags: fieldDoc(item.source.tags.join(' ')),
      body: fieldDoc(item.source.description),
    };
    // Tags are scored but do not qualify a product on their own: stores use them as merchandising
    // labels (Satechi puts "magsafe charger" on plain USB-C cables).
    const strong = new Set<string>([...fields.title.tf.keys(), ...fields.category.tf.keys()]);
    return { item, fields, strong };
  });
  const df = new Map<string, number>();
  const totals: Record<FieldName, number> = { title: 0, category: 0, tags: 0, body: 0 };
  for (const d of docs) {
    const terms = new Set<string>();
    for (const f of FIELDS) {
      for (const t of d.fields[f].tf.keys()) terms.add(t);
      totals[f] += d.fields[f].len;
    }
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const avgLen = Object.fromEntries(FIELDS.map((f) => [f, Math.max(1, totals[f] / n)])) as Record<FieldName, number>;
  return { docs, df, avgLen };
}

/** BM25F: weighted, per-field-normalized term frequency, one saturation per term. */
function bm25f(index: SearchIndex, doc: IndexedDoc, terms: Map<string, number>): number {
  const k1 = 1.2;
  const n = index.docs.length;
  let score = 0;
  for (const [term, qWeight] of terms) {
    let tf = 0;
    for (const f of FIELDS) {
      const raw = doc.fields[f].tf.get(term) ?? 0;
      if (raw) tf += (WEIGHTS[f] * raw) / (1 - B[f] + (B[f] * doc.fields[f].len) / index.avgLen[f]);
    }
    if (tf === 0) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += qWeight * idf * ((tf * (k1 + 1)) / (tf + k1));
  }
  return score;
}

const hasTerm = (doc: IndexedDoc, t: string) => FIELDS.some((f) => doc.fields[f].tf.has(t));

export interface SearchQuery {
  need: string;
  maxPrice?: number;
  category?: string;
  mustHave?: string[];
  devices?: DeviceInfo[];
  /** Default true. */
  inStockOnly?: boolean;
  limit?: number;
}

export interface DeviceCoverage {
  /** Devices the store lists by their exact model. Only these may be called "listed for your X". */
  covered: string[];
  /** Devices the store lists only by series or family: "iPhone 17" for an iPhone 17 Pro. Not proof of fit. */
  family: { device: string; listed: string }[];
  /** Devices the store does not list at all. */
  missing: string[];
}

export interface SearchHit {
  item: CatalogItem;
  variant: CatalogVariant;
  score: number;
  coverage: DeviceCoverage;
  why: string[];
  /** Share of the shopper's words in the product name (1 = the shopper named this product). */
  inTitle: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Matching, in-stock products beyond `limit`. */
  more: number;
  /** Products that matched everything except stock. */
  outOfStock: number;
  /** Products that matched except the budget (cheapest of them, for a helpful answer). */
  overBudget: { count: number; cheapest: number | null };
  /** Words the search actually used (after removing devices and filler). */
  terms: string[];
  /** Brands or model codes the shopper said that this catalog does not have at all, as said ("Anker", "S9"). */
  missing: string[];
  /** Minimum wattage read from the need ("300W charger"), if any. */
  wattsWanted: number | null;
  /** The best-matching product that is out of stock, when it matches the request at least as well as the hits. */
  outOfStockMatch: { title: string; inTitle: number; item: CatalogItem } | null;
}

/** Which of the shopper's devices does the store list for this item? */
export function coverageFor(item: CatalogItem, devices: DeviceInfo[]): DeviceCoverage {
  const covered: string[] = [];
  const family: DeviceCoverage['family'] = [];
  const missing: string[] = [];
  for (const d of devices) {
    const levels = item.devices.map((e) => ({ e, level: deviceMatch(d, e.device) }));
    if (levels.some((x) => x.level === 'exact')) covered.push(deviceLabel(d));
    else {
      const near = levels.find((x) => x.level !== null);
      if (near) family.push({ device: deviceLabel(d), listed: near.e.device.name });
      else missing.push(deviceLabel(d));
    }
  }
  return { covered, family, missing };
}

/** "Store lists iPhone 17, not your iPhone 17 Pro specifically" for the first series-only device, else ''. */
export function familyLine(c: DeviceCoverage): string {
  const f = c.family[0];
  return f ? `Store lists ${f.listed}, not your ${f.device} specifically` : '';
}

function mustHaveOk(item: CatalogItem, term: string): boolean {
  const t = term.trim();
  const watts = /^(\d{1,3})\s?w(atts?)?$/i.exec(t);
  if (watts) return (item.features.watts ?? 0) >= Number(watts[1]) && !item.features.passThrough;
  const ports = /^(\d{1,2})\s?(usb-?c\s)?ports?$/i.exec(t);
  if (ports) {
    const n = Number(ports[1]);
    const f = item.features;
    return (ports[2] ? f.usbCPorts ?? 0 : Math.max(f.totalPorts ?? 0, (f.usbCPorts ?? 0) + (f.usbAPorts ?? 0), f.inOne ?? 0)) >= n;
  }
  const dev = findDevices(t);
  if (dev.length && !dev[0].device.generic) {
    const c = coverageFor(item, dev.map((m) => m.device));
    return c.missing.length === 0 && c.family.length === 0;
  }
  // Feature words: title, description and extracted features only. Tags are merchandising labels.
  const hay = new Set(tokenize(`${item.title} ${item.source.description} ${item.highlights.join(' ')} ${item.features.connectors.join(' ')} ${item.features.wireless.join(' ')}`));
  return tokenize(t).every((w) => hay.has(w));
}

function categoryOk(item: CatalogItem, category: string): boolean {
  const want = tokenize(category);
  if (want.length === 0) return true;
  const have = new Set(tokenize(`${item.categories.join(' ')} ${item.source.tags.join(' ')} ${item.title}`));
  return want.every((w) => have.has(w));
}

function pickVariant(item: CatalogItem, inStockOnly: boolean): CatalogVariant | null {
  if (!inStockOnly || item.primary.available) return item.primary;
  // A region-pinned primary (e.g. the US plug) is never swapped for another region.
  const regionPinned = item.variants.length > 1 && item.primary.label !== null && /^(US|EU|UK|AU|CA)$/i.test(item.primary.label);
  if (regionPinned) return null;
  return item.variants.find((v) => v.available) ?? null;
}

export function buildWhy(item: CatalogItem, variant: CatalogVariant, coverage: DeviceCoverage, q: SearchQuery, currency: string, needTerms: string[] = []): string[] {
  const why: string[] = [];
  if (coverage.covered.length) {
    const tail = coverage.missing.length ? `, but not for your ${joinAnd(coverage.missing)}` : '';
    why.push(`Store lists it for your ${joinAnd(coverage.covered)}${tail}`);
  }
  if (coverage.family.length) why.push(familyLine(coverage));
  if (q.maxPrice !== undefined) why.push(`${money(variant.price, currency)}, within your ${money(q.maxPrice, currency)} budget`);
  if (variant.compare_at_price !== null) {
    why.push(`On sale: ${money(round2(variant.compare_at_price - variant.price), currency)} off the regular ${money(variant.compare_at_price, currency)}`);
  }
  // The highlight that speaks to the need ("Anti-tangle brush" for a cat owner), else the first one.
  const relevant = item.highlights.find((h) => tokenize(h).some((t) => needTerms.includes(t))) ?? item.highlights[0];
  if (relevant) why.push(relevant);
  return why.slice(0, 3);
}

export function search(catalog: Catalog, index: SearchIndex, q: SearchQuery): SearchOutcome {
  const devices = q.devices ?? [];
  const inStockOnly = q.inStockOnly ?? true;
  const limit = q.limit ?? 3;

  // Remove device names from the need so "iPhone 15" does not drag in every iPhone-tagged item.
  let needText = q.need;
  // "300W charger" is a spec, not a word to match: it becomes a must-have.
  const wattM = /\b(\d{1,3})\s?w(?:atts?)?\b/i.exec(needText);
  const wattsWanted = wattM && Number(wattM[1]) >= 5 ? Number(wattM[1]) : null;
  const mustHave = [...(q.mustHave ?? [])];
  if (wattsWanted !== null) {
    needText = needText.replace(wattM![0], ' ');
    mustHave.push(`${wattsWanted}W`);
  }
  for (const m of findDevices(needText).sort((a, b) => b.index - a.index)) {
    needText = needText.slice(0, m.index) + ' ' + needText.slice(m.index + m.raw.length);
  }
  needText = needText.replace(/\$\s?\d+(\.\d+)?|\b\d+(\.\d+)?\s?(dollars|bucks|usd)\b/gi, ' ');
  // Words this catalog has never seen: competitor brands and model codes are reported, not searched.
  const missing: string[] = [];
  const said = (t: string) => new RegExp(`\\b${t}\\w*`, 'i').exec(q.need)?.[0] ?? t;
  // The store's own brand says nothing about the product ("Roborock S8" = "S8").
  const brand = new Set(tokenize(`${catalog.store.name} ${[...new Set(catalog.items.map((i) => i.vendor))].join(' ')}`));
  const allTerms = [...new Set(tokenize(needText))];
  const baseTerms = allTerms.filter((t) => !brand.has(t) || allTerms.every((x) => brand.has(x))).filter((t) => {
    if (index.df.has(t)) return true;
    if (COMPETITORS.has(t) || MODEL_CODE.test(t)) { missing.push(said(t)); return false; }
    return true;
  });
  const empty = (): SearchOutcome => ({ hits: [], more: 0, outOfStock: 0, overBudget: { count: 0, cheapest: null }, terms: baseTerms, missing, wattsWanted, outOfStockMatch: null });
  if (missing.length && baseTerms.length === 0) return empty();
  // Model codes and connector words must be in the product name, when any product has them all there.
  const keyTerms = baseTerms.filter((t) => MODEL_CODE.test(t) || HARD_WORDS.has(t));
  const titleTokens = (d: IndexedDoc) => d.fields.title.tf;
  const keyFilter = keyTerms.length > 0 && index.docs.some((d) => keyTerms.every((t) => titleTokens(d).has(t)));
  if (keyFilter) {
    // A model that only appears in accessory names ("Brush Cover for ... S9 MaxV Ultra") is not for sale here.
    const headOf = (d: IndexedDoc) => { const at = d.item.title.search(/\sfor\s/i); return new Set(tokenize(at > 0 ? d.item.title.slice(0, at) : d.item.title)); };
    const withKeys = index.docs.filter((d) => keyTerms.every((t) => titleTokens(d).has(t)));
    const sold = withKeys.some((d) => { const h = headOf(d); return baseTerms.some((t) => h.has(t)); });
    if (!sold) {
      for (const t of keyTerms) if (MODEL_CODE.test(t)) missing.push(said(t));
      if (missing.length) return empty();
    }
  }
  // Form and offer: read from the product's own name (see classifyItem), never from the store's collection.
  const wantsRobot = baseTerms.includes('robot');
  const wantsNonRobot = NON_ROBOT_NEED.test(needText);
  const offersWanted = new Set<string>(['standard']);
  if (/\b(warrant|protection|coverage|care\s+plan)/i.test(needText)) offersWanted.add('protection_plan');
  if (/\btrade[\s-]?in\b/i.test(needText)) offersWanted.add('trade_in');
  if (/\bpoints?\b/i.test(needText)) offersWanted.add('points');
  const terms = new Map<string, number>();
  for (const t of baseTerms) {
    terms.set(t, 1);
    // Synonyms help, but never outweigh the shopper's own words.
    for (const s of SYNONYMS[t] ?? []) if (!terms.has(stem(s))) terms.set(stem(s), 0.3);
  }

  // A word of the need counts as matched when it, or one of its synonyms, is in the product.
  const variants = new Map(baseTerms.map((t) => [t, [t, ...(SYNONYMS[t] ?? []).map(stem)]]));
  const required = baseTerms.length <= 2 ? 1 : Math.ceil(baseTerms.length / 2);

  const scored: { doc: IndexedDoc; score: number; inTitle: number; coverage: DeviceCoverage; headHit: boolean; tailOnly: boolean }[] = [];
  for (const doc of index.docs) {
    const kind = doc.item.kind;
    if (!offersWanted.has(kind.offer)) continue;
    if (wantsRobot && kind.form && kind.form !== 'robot vacuum') continue;
    if (wantsNonRobot && !wantsRobot && kind.form === 'robot vacuum') continue;
    if (keyFilter && !keyTerms.every((t) => titleTokens(doc).has(t))) continue;
    if (terms.size) {
      // Require a hit in a strong field (title/category): a word only in tags or description is not enough.
      if (![...terms.keys()].some((t) => doc.strong.has(t))) continue;
      // Require at least half of the need's words, so one filler word ("home") cannot qualify a product.
      const matched = baseTerms.filter((t) => variants.get(t)!.some((v) => hasTerm(doc, v)));
      if (matched.length < required) continue;
    }
    let score = terms.size ? bm25f(index, doc, terms) : 0;
    // Share of the shopper's own words that are in the title: "robot" + "vacuum" in the title beats
    // a stick vacuum that the store filed under "Robot Vacuums".
    // Only the head of "X for Y" says what the product is.
    const forAt = doc.item.title.search(/\sfor\s/i);
    const head = new Set(tokenize(forAt > 0 ? doc.item.title.slice(0, forAt) : doc.item.title));
    // A synonym in the title earns partial credit only ("Zero-Tangle" is not "cat").
    const titleCredit = (t: string) => (head.has(t) ? 1 : variants.get(t)!.some((v) => head.has(v)) ? 0.3 : 0);
    const inTitle = baseTerms.length ? baseTerms.reduce((a, t) => a + titleCredit(t), 0) / baseTerms.length : 0;
    const coverage = coverageFor(doc.item, devices);
    // "Dock for MagSafe Charger" is an accessory for a charger, not a charger: if the need's
    // words only appear after " for " in the title, halve the text score.
    const headHit = baseTerms.some((t) => variants.get(t)!.some((v) => head.has(v)));
    let tailOnly = false;
    if (terms.size && forAt > 0) {
      const tail = new Set(tokenize(doc.item.title.slice(forAt)));
      tailOnly = !headHit && baseTerms.some((t) => variants.get(t)!.some((v) => tail.has(v)));
      if (tailOnly) score *= 0.5;
    }
    if (!terms.size && devices.length && coverage.covered.length === 0 && coverage.family.length === 0) continue;
    if (q.category && !categoryOk(doc.item, q.category)) continue;
    if (mustHave.length && !mustHave.every((m) => mustHaveOk(doc.item, m))) continue;
    scored.push({ doc, score, inTitle, coverage, headHit, tailOnly });
  }

  // "Wet dry vacuum" must not return a brush made for one: when real matches exist, accessories that
  // only mention the need after " for " drop out. ("Brush for Q7" still matches "brush".)
  let pool = scored.some((s) => s.headHit) ? scored.filter((s) => !s.tailOnly) : scored;
  // The named product may be out of stock AND not listed for the shopper's devices ("USB-C to Lightning
  // cable" for an iPhone 16): look for it before the device filter, or the "out of stock" line is lost.
  let oosMatch: { title: string; inTitle: number; item: CatalogItem } | null = null;
  for (const s of pool) {
    if (pickVariant(s.doc.item, inStockOnly)) continue;
    if (!oosMatch || s.inTitle > oosMatch.inTitle) oosMatch = { title: s.doc.item.title, inTitle: s.inTitle, item: s.doc.item };
  }
  // If anything is listed for the shopper's devices, recommend only listed products.
  // Nothing listed for the exact model: the series-only listings come first, and are labeled as such.
  if (devices.length && pool.some((s) => s.coverage.covered.length)) pool = pool.filter((s) => s.coverage.covered.length);
  else if (devices.length && pool.some((s) => s.coverage.family.length)) pool = pool.filter((s) => s.coverage.family.length);

  const maxScore = Math.max(1e-9, ...pool.map((s) => s.score));
  const hits: SearchHit[] = [];
  let outOfStock = 0;
  let overBudgetCount = 0;
  let overBudgetCheapest: number | null = null;
  for (const s of pool) {
    const variant = pickVariant(s.doc.item, inStockOnly);
    if (!variant) {
      outOfStock++;
      continue;
    }
    if (q.maxPrice !== undefined && variant.price > q.maxPrice) {
      overBudgetCount++;
      overBudgetCheapest = overBudgetCheapest === null ? variant.price : Math.min(overBudgetCheapest, variant.price);
      continue;
    }
    const devFrac = devices.length ? (s.coverage.covered.length + 0.5 * s.coverage.family.length) / devices.length : 0;
    // Covering more of the shopper's devices outranks a better text match (the text part stays
    // below 0.3, under one device step for up to 3 devices); a real markdown only breaks ties.
    const text = terms.size ? 0.17 * s.inTitle + 0.13 * (s.score / maxScore) : 0;
    const rank = devFrac + text + (variant.compare_at_price !== null ? 0.01 : 0);
    hits.push({ item: s.doc.item, variant, score: round2(rank * 1000) / 1000, coverage: s.coverage, why: [], inTitle: s.inTitle });
  }
  hits.sort((a, b) => b.score - a.score || a.variant.price - b.variant.price || a.item.title.localeCompare(b.item.title));
  const top = hits.slice(0, limit);
  for (const h of top) h.why = buildWhy(h.item, h.variant, h.coverage, q, catalog.store.currency, [...terms.keys()]);
  return {
    hits: top,
    more: Math.max(0, hits.length - top.length),
    outOfStock,
    overBudget: { count: overBudgetCount, cheapest: overBudgetCheapest },
    terms: baseTerms,
    missing,
    wattsWanted,
    // Only worth saying when the out-of-stock product fits the request better than anything offered.
    outOfStockMatch: oosMatch && oosMatch.inTitle > 0 && (top.length === 0 || oosMatch.inTitle > top[0].inTitle) ? oosMatch : null,
  };
}

/** "under $50", "below 120 dollars", "less than $30" in free text -> 50 / 120 / 30. */
export function budgetFromText(text: string): number | undefined {
  const m = /\b(?:under|below|less than|no more than|up to|max(?:imum)?|within)\s\$?\s?(\d{1,5}(?:\.\d{1,2})?)\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}
