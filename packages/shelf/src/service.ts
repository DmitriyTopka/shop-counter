/**
 * The shop assistant itself, independent of MCP: every method takes the shopper id and
 * plain input, and returns spoken text + structured content. The MCP layer (server.ts)
 * is a thin adapter, so the same brain can serve Telegram or tests.
 */
import { randomBytes } from 'node:crypto';
import type { CatalogSource, LoadedCatalog } from './catalog.js';
import { checkCompat } from './compat.js';
import { devicesInText, parseDevice, type DeviceInfo } from './devices.js';
import { toProduct, type CatalogItem, type CatalogVariant } from './normalize.js';
import { budgetFromText, correctTypos, coverageFor, search, tokenize } from './search.js';
import type { ShopperState, StateStore } from './state.js';
import { joinAnd, money, round2, speakable } from './text.js';
import { newNonce, signOrderToken, TOKEN_TTL_MS, verifyOrderToken } from './token.js';
import type {
  ClosetResult, ClosetSuggestion, CompareResult, CompareRow, CompatResult, ErrorCode, ErrorResult, HandoffResult, HandoffTicket,
  Order, OrderLine, OrderPreviewResult, OrderResult, OrdersResult, Product, ProductsResult, StructuredResult,
} from './types.js';

export interface ToolOutcome<T extends StructuredResult = StructuredResult> {
  /** One or two short sentences for Alexa to speak. No URLs, no SKUs. */
  text: string;
  structured: T;
  isError: boolean;
}

export type Notifier = (event: { store: string; user: string; ticket: HandoffTicket }) => Promise<void> | void;

export interface ShelfServiceConfig {
  catalog: CatalogSource;
  state: StateStore;
  /** HMAC secret for order confirmations. */
  secret: string | Buffer;
  notify?: Notifier;
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const ANONYMOUS = 'anonymous';
/** "my phone", "the laptop": a kind of device, not a model. The closet says which one the shopper has. */
const DEVICE_KIND_ONLY = /^(?:(?:my|the|a|an|this)\s+)?(?:phone|smartphone|cell ?phone|mobile|laptop|computer|notebook|tablet|robot|vacuum|robot vacuum|device|gadget|stuff|it)$/i;
const MAX_DEVICES = 20;
const MAX_LINES = 10;
const MAX_QTY = 10;

/**
 * Every spoken line is at most two sentences, enforced here and not only by prompts: any host
 * (the simulator, a real Alexa+) reads `content[0].text` aloud as it is. Cuts between sentences only,
 * never inside one ("$59.99" has no space after its dot, so it is not a sentence end).
 */
export function clampSpeech(text: string, max = 2): string {
  const parts = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c$])/);
  return parts.length <= max ? text.trim() : parts.slice(0, max).join(' ');
}

export function fail(code: ErrorCode, text: string): ToolOutcome<ErrorResult> {
  const t = clampSpeech(text);
  return { text: t, structured: { kind: 'error', code, message: t }, isError: true };
}

function ok<T extends StructuredResult>(text: string, structured: T): ToolOutcome<T> {
  return { text: clampSpeech(text), structured, isError: false };
}

/** Short title for speech: no trademark glyphs, no "(Upgraded from ...)", nothing after a dash. */
export function spokenTitle(title: string): string {
  let t = speakable(title).replace(/【([^】]*)】/g, '$1 ').replace(/\s*\([^)]*\)\s*/g, ' ');
  t = t.split(/\s[-\u2013|]\s/)[0];
  // "Main Brush Cover for Qrevo Curv, Qrevo Edge, Saros 10R, ..." is a parts list, not a name: say the head.
  const forAt = t.search(/\sfor\s/i);
  if (forAt > 0 && (t.slice(forAt).match(/,/g) ?? []).length >= 2) t = t.slice(0, forAt);
  return t.replace(/\s+/g, ' ').trim();
}

function spokenDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function similarity(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / Math.max(1, new Set([...x, ...y]).size);
}

function cleanList(xs: unknown, maxLen = 60): string[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 0 && x.length <= maxLen);
}

export class ShelfService {
  constructor(private readonly cfg: ShelfServiceConfig) {}

  get store() {
    return this.cfg.catalog.store;
  }

  private now(): Date {
    return this.cfg.now?.() ?? new Date();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    (this.cfg.log ?? ((m, e) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: m, ...e }))))(msg, extra);
  }

  private async loadCatalog(): Promise<LoadedCatalog | ToolOutcome<ErrorResult>> {
    try {
      return await this.cfg.catalog.load();
    } catch (err) {
      this.log('catalog_unavailable', { error: (err as Error).message });
      return fail('catalog_unavailable', `I can't reach the ${this.store.name} catalog right now. Please try again in a minute.`);
    }
  }

  private product(item: CatalogItem, variant?: CatalogVariant, why: string[] = []): Product {
    return toProduct(item, this.store, variant, why);
  }

  /**
   * The closet belongs to the shopper and is shared by every store, so a free-text device may carry
   * the brand of the store that sells it ("Roborock Q7 M5"). Stores list their own models without
   * their brand ("Main Brush Cover for Q7 M5"), so the brand is dropped when this store is that brand.
   */
  private localDevice(d: DeviceInfo): DeviceInfo {
    if (d.known) return d;
    const brand = `${this.store.name.toLowerCase()} `;
    const n = d.name.trim();
    return n.toLowerCase().startsWith(brand) && n.length > brand.length + 1 ? parseDevice(n.slice(brand.length)) : d;
  }

  private async closetDevices(userId: string): Promise<DeviceInfo[]> {
    if (userId === ANONYMOUS) return [];
    const s = await this.cfg.state.get(userId);
    return s.closet.devices.map((d) => this.localDevice(parseDevice(d)));
  }

  /* ---------------- find_products ---------------- */

  async findProducts(
    userId: string,
    input: { need?: string; max_price?: number; category?: string; must_have?: string[]; for_devices?: string[] },
  ): Promise<ToolOutcome> {
    const need = typeof input.need === 'string' ? input.need.trim().slice(0, 300) : '';
    if (!need) return fail('invalid_input', 'What are you shopping for? For example, a charger for your iPhone.');
    const maxPrice = typeof input.max_price === 'number' && input.max_price > 0 ? input.max_price : budgetFromText(need);
    const loaded = await this.loadCatalog();
    if ('isError' in loaded) return loaded;

    // Typos are fixed against the store's own words before anything else ("macbok" -> "macbook").
    const fixed = correctTypos(need, loaded.index).text;
    const named = [...cleanList(input.for_devices).map(parseDevice), ...devicesInText(fixed)];
    const devices = named.length ? named : await this.closetDevices(userId);
    const uniq = devices.filter((d, i) => devices.findIndex((x) => x.name === d.name) === i);

    const out = search(loaded.catalog, loaded.index, {
      need: fixed,
      maxPrice,
      category: typeof input.category === 'string' ? input.category : undefined,
      mustHave: cleanList(input.must_have),
      devices: uniq,
    });
    const products = out.hits.map((h) => this.product(h.item, h.variant, h.why));
    const structured: ProductsResult = {
      kind: 'products',
      store: this.store.name,
      need,
      for_devices: uniq.map((d) => d.name),
      max_price: maxPrice ?? null,
      products,
      more_available: out.more,
      // The named product the shopper asked for, when it is out of stock: not offered, but its id lets
      // check_compatibility answer "will it fit?" (and the store's own "not compatible with" refusal).
      out_of_stock_match: out.outOfStockMatch ? this.product(out.outOfStockMatch.item, out.outOfStockMatch.item.primary) : null,
    };

    const cur = this.store.currency;
    const notHere = out.missing.length ? `I don't see ${joinAnd(out.missing)} for sale at ${this.store.name}.` : '';
    if (products.length === 0) {
      let text = `I couldn't find a match for that at ${this.store.name}. Could you say it another way?`;
      if (notHere) {
        text = `${notHere} Want me to look for something similar from ${this.store.name}?`;
      } else if (out.overBudget.count && out.overBudget.cheapest !== null && maxPrice !== undefined) {
        text = `Nothing matches under ${money(maxPrice, cur)}. The closest one starts at ${money(out.overBudget.cheapest, cur)}.`;
      } else if (out.outOfStockMatch) {
        text = `The ${spokenTitle(out.outOfStockMatch.title)} is out of stock right now, so I can't offer it.`;
      } else if (out.outOfStock) {
        text = `I found ${out.outOfStock} matching product${out.outOfStock === 1 ? '' : 's'}, but none are in stock right now.`;
      } else if (out.wattsWanted !== null) {
        text = `Nothing at ${this.store.name} matches that with ${out.wattsWanted}W or more.`;
      }
      return ok(text, structured);
    }

    const top = out.hits[0];
    // The shopper named something we cannot offer: say so first, then the closest real option.
    if (notHere || out.outOfStockMatch) {
      const lead = notHere || `The ${spokenTitle(out.outOfStockMatch!.title)} is out of stock right now.`;
      return ok(`${lead} The closest match is the ${spokenTitle(top.item.title)} at ${money(top.variant.price, cur)}.`, structured);
    }
    const fit = top.coverage.covered.length ? `, and the store lists it for your ${joinAnd(top.coverage.covered)}` : '';
    const count = products.length === 1 ? 'one option' : `${products.length} options`;
    const text = `I found ${count}. The best fit is the ${spokenTitle(top.item.title)} at ${money(top.variant.price, this.store.currency)}${fit}.`;
    return ok(text, structured);
  }

  /* ---------------- compare_products ---------------- */

  async compareProducts(userId: string, input: { ids?: string[] }): Promise<ToolOutcome> {
    const ids = [...new Set(cleanList(input.ids, 40))];
    if (ids.length < 2 || ids.length > 3) return fail('invalid_input', 'I can compare two or three products at a time.');
    const loaded = await this.loadCatalog();
    if ('isError' in loaded) return loaded;
    const found = ids.map((id) => loaded.catalog.byVariant.get(id));
    const missing = found.findIndex((f) => !f);
    if (missing >= 0) return fail('not_found', "I couldn't find one of those products. Let's search again.");
    const entries = found as { item: CatalogItem; variant: CatalogVariant }[];
    const devices = await this.closetDevices(userId);
    const cur = this.store.currency;
    const cov = entries.map((e) => coverageFor(e.item, devices));

    const rows: CompareRow[] = [
      { label: 'Price', values: entries.map((e) => money(e.variant.price, cur) + (e.variant.compare_at_price ? ` (was ${money(e.variant.compare_at_price, cur)})` : '')) },
      { label: 'In stock', values: entries.map((e) => (e.variant.available ? 'Yes' : 'No')) },
      { label: 'Power', values: entries.map((e) => (e.item.features.watts !== null ? `${e.item.features.watts}W${e.item.features.passThrough ? ' pass-through' : ''}` : null)) },
      {
        label: 'Ports',
        values: entries.map((e) => {
          const f = e.item.features;
          if (f.usbCPorts !== null && f.usbAPorts !== null) return `${f.usbCPorts} USB-C, ${f.usbAPorts} USB-A`;
          if (f.usbCPorts !== null) return `${f.usbCPorts} USB-C`;
          if (f.totalPorts !== null) return `${f.totalPorts}`;
          return f.inOne !== null ? `${f.inOne}-in-1` : null;
        }),
      },
      { label: 'Wireless', values: entries.map((e) => (e.item.features.wireless.length ? e.item.features.wireless.join(', ') : null)) },
      { label: 'Connectivity', values: entries.map((e) => e.item.features.connectors.filter((c) => c !== 'USB-C').join(', ') || null) },
      { label: 'Suction', values: entries.map((e) => (e.item.features.suctionPa !== null ? `${e.item.features.suctionPa.toLocaleString('en-US')} Pa` : null)) },
      { label: 'Traits', values: entries.map((e) => e.item.features.traits.join(', ') || null) },
    ];
    if (devices.length) {
      rows.push({ label: 'Listed for your devices', values: cov.map((c) => (c.covered.length ? c.covered.join(', ') : 'None listed')) });
    } else {
      rows.push({ label: 'Store lists', values: entries.map((e) => (e.item.compatibleWith.length ? e.item.compatibleWith.slice(0, 4).join(', ') + (e.item.compatibleWith.length > 4 ? ` +${e.item.compatibleWith.length - 4} more` : '') : null)) });
    }
    const usedRows = rows.filter((r) => r.values.some((v) => v !== null));

    // Deterministic verdict: in stock, then device coverage, then price.
    const order = entries
      .map((e, i) => ({ e, i, c: cov[i].covered.length }))
      .sort((a, b) => Number(b.e.variant.available) - Number(a.e.variant.available) || b.c - a.c || a.e.variant.price - b.e.variant.price);
    const best = order[0];
    const other = order[1];
    const reasons: string[] = [];
    if (best.e.variant.available && !other.e.variant.available) reasons.push("it's in stock");
    if (best.c > other.c) reasons.push(`the store lists it for ${best.c === devices.length ? 'all your devices' : `more of your devices`}`);
    const diff = round2(other.e.variant.price - best.e.variant.price);
    if (diff > 0) reasons.push(`it's ${money(diff, cur)} cheaper`);
    const bw = best.e.item.features.watts;
    const ow = other.e.item.features.watts;
    if (bw !== null && ow !== null && bw > ow && !best.e.item.features.passThrough) reasons.push(`it has more power, ${bw}W versus ${ow}W`);
    // The other side of the trade-off, so the shopper hears what they give up.
    let tradeoff = '';
    if (ow !== null && bw !== null && ow > bw && !other.e.item.features.passThrough) {
      tradeoff = ` The ${spokenTitle(other.e.item.title)} has more power, ${ow}W versus ${bw}W.`;
    } else if (other.c > best.c) {
      tradeoff = ` The ${spokenTitle(other.e.item.title)} is listed for more of your devices.`;
    }
    let verdict: string;
    if (reasons.length) {
      verdict = `The ${spokenTitle(best.e.item.title)} looks like the better pick: ${joinAnd(reasons.slice(0, 2))}.${tradeoff}`;
    } else {
      verdict = `They're close. The ${spokenTitle(best.e.item.title)} is ${money(best.e.variant.price, cur)} and the ${spokenTitle(other.e.item.title)} is ${money(other.e.variant.price, cur)}.`;
    }

    const structured: CompareResult = {
      kind: 'compare',
      products: entries.map((e, i) => this.product(e.item, e.variant, cov[i].covered.length ? [`Store lists it for your ${joinAnd(cov[i].covered)}`] : [])),
      rows: usedRows,
      verdict,
    };
    return ok(verdict, structured);
  }

  /* ---------------- check_compatibility ---------------- */

  async checkCompatibility(userId: string, input: { product_id?: string; device?: string }): Promise<ToolOutcome> {
    const id = typeof input.product_id === 'string' ? input.product_id.trim() : '';
    if (!id) return fail('invalid_input', 'Which product should I check?');
    const loaded = await this.loadCatalog();
    if ('isError' in loaded) return loaded;
    const hit = loaded.catalog.byVariant.get(id);
    if (!hit) return fail('not_found', "I couldn't find that product. Let's search for it first.");

    const raw = typeof input.device === 'string' ? input.device.trim().slice(0, 80) : '';
    const said = raw && !DEVICE_KIND_ONLY.test(raw) ? [this.localDevice(parseDevice(raw))] : [];
    const fromCloset = said.length === 0;
    const devices = fromCloset ? await this.closetDevices(userId) : said;
    if (!devices.length) return fail('device_required', 'Which device should I check it with?');

    const verdicts = devices.map((d) => ({ d, v: checkCompat(hit.item, d) }));
    const main = verdicts[0];
    const alternatives: Product[] = [];
    if (main.v.status !== 'confirmed') {
      const cats = new Set(hit.item.categories.map((c) => c.toLowerCase()));
      const alts = loaded.catalog.items
        .filter((it) => it !== hit.item && it.primary.available && it.categories.some((c) => cats.has(c.toLowerCase())))
        .filter((it) => checkCompat(it, main.d).status === 'confirmed')
        // Most similar first (shared title words), then closest in price.
        .map((it) => ({ it, sim: similarity(it.title, hit.item.title) }))
        .sort((a, b) => b.sim - a.sim || Math.abs(a.it.primary.price - hit.variant.price) - Math.abs(b.it.primary.price - hit.variant.price))
        .map((x) => x.it)
        .slice(0, 3);
      for (const it of alts) alternatives.push(this.product(it, it.primary, [`Store lists it for your ${main.d.name}`]));
    }

    const structured: CompatResult = {
      kind: 'compat',
      product: this.product(hit.item, hit.variant),
      device: main.d.name,
      status: main.v.status,
      evidence: main.v.evidence,
      note: main.v.note,
      alternatives,
      ...(verdicts.length > 1 ? { also: verdicts.slice(1).map(({ d, v }) => ({ device: d.name, status: v.status, evidence: v.evidence })) } : {}),
      device_source: fromCloset ? 'closet' : 'said',
    };

    const name = spokenTitle(hit.item.title);
    const d = main.d.name;
    const broad = main.v.level === 'series' || main.v.level === 'family';
    let text: string;
    if (main.v.status === 'confirmed' && fromCloset) {
      // The shopper never named the model: the closet did. Say whose device it is and who vouches for it.
      text = broad
        ? `Works with your ${d}: the store lists ${main.v.evidence?.quote ?? d} for it.`
        : `Works with your ${d}, the store confirms it.`;
    } else if (main.v.status === 'confirmed') {
      text = broad
        ? `Yes, the store lists ${main.v.evidence?.quote ?? d} for the ${name}, which covers your ${d}.`
        : `Yes, the store lists the ${d} for the ${name}.`;
    } else if (main.v.status === 'incompatible') {
      // Quote the store's own "not compatible with ..." when that is the reason; a connector rule is explained instead.
      const clause = main.v.evidence?.quote.match(/\bnot\s+(?:compatible|designed|suitable|for\s+use)\s+(?:with|for)\s+[^.;:!?()\]]+/i)?.[0].trim();
      text = clause
        ? `No, that won't work with your ${d}: the store says "${clause}".`
        : `No, that won't work: ${main.v.note.charAt(0).toLowerCase()}${main.v.note.slice(1, -1)}.`;
    } else if (main.d.generic) {
      text = `I can't confirm that yet. Which ${d} model do you have?`;
    } else {
      text = `I can't confirm that: the store doesn't list the ${d} for the ${name}.`;
    }
    const others = verdicts.slice(1);
    if (main.v.status !== 'confirmed' && alternatives[0] && !main.d.generic) {
      // A "no" always comes with a real way forward from the same store.
      text += ` The ${spokenTitle(alternatives[0].title)} is listed for it, at ${money(alternatives[0].price, this.store.currency)}.`;
    } else if (others.length) {
      const yes = others.filter((o) => o.v.status === 'confirmed').map((o) => o.d.name);
      if (yes.length) text += ` It's also listed for your ${joinAnd(yes)}.`;
    }
    return ok(text, structured);
  }

  /* ---------------- closet ---------------- */

  async rememberDevices(
    userId: string,
    input: { devices?: string[]; home?: { pets?: string[]; notes?: string }; forget?: string[] },
  ): Promise<ToolOutcome> {
    if (userId === ANONYMOUS) return fail('anonymous', "I can only remember your devices when you're signed in.");
    // "a Roborock Q7 M5" -> "Roborock Q7 M5": articles are speech, not part of the model name.
    const add = cleanList(input.devices).map((d) => d.replace(/^(?:a|an|the|my)\s+/i, '')).filter((d) => d && !DEVICE_KIND_ONLY.test(d))
      .map((d) => { const p = parseDevice(d); return p.known ? p.name : p.name.slice(0, 60); });
    const forget = cleanList(input.forget).map((d) => parseDevice(d).name.toLowerCase());
    const pets = cleanList(input.home?.pets, 40);
    const notes = typeof input.home?.notes === 'string' ? input.home.notes.trim().slice(0, 300) : undefined;
    const s = await this.cfg.state.update(userId, (st) => {
      let devices = st.closet.devices.filter((d) => !forget.includes(d.toLowerCase()));
      for (const d of add) if (!devices.some((x) => x.toLowerCase() === d.toLowerCase())) devices.push(d);
      devices = devices.slice(-MAX_DEVICES);
      const home = { ...st.closet.home };
      if (pets.length) home.pets = [...new Set([...(home.pets ?? []), ...pets.map((p) => p.toLowerCase())])].slice(0, 10);
      if (notes !== undefined) home.notes = notes || undefined;
      return { ...st, closet: { devices, home } };
    });
    const parts: string[] = [];
    if (add.length) parts.push(`I'll remember your ${joinAnd(add)}`);
    if (forget.length) parts.push(`I forgot ${joinAnd(cleanList(input.forget))}`);
    if (pets.length) parts.push(`and that you have ${joinAnd(pets.map((p) => `a ${p}`))}`);
    const suggestion = add.length ? await this.suggestion(s) : null;
    const text = parts.length ? `Got it, ${parts.join(', ').replace(', and', ' and')}.${this.suggestionSpeech(suggestion)}` : this.closetSpeech(s, suggestion);
    return ok(text, this.closetResult(s, suggestion));
  }

  async myDevices(userId: string): Promise<ToolOutcome> {
    if (userId === ANONYMOUS) return fail('anonymous', "I can only remember your devices when you're signed in.");
    const s = await this.cfg.state.get(userId);
    const suggestion = await this.suggestion(s);
    return ok(this.closetSpeech(s, suggestion), this.closetResult(s, suggestion));
  }

  private closetResult(s: ShopperState, suggestion: ClosetSuggestion | null = null): ClosetResult {
    return { kind: 'closet', devices: s.closet.devices, home: s.closet.home, store: this.store.name, suggestion };
  }

  private closetSpeech(s: ShopperState, suggestion: ClosetSuggestion | null = null): string {
    if (!s.closet.devices.length) return "I don't know your devices yet. Tell me what you use, like an iPhone 15 or a MacBook Air.";
    // Two sentences at most: the suggestion takes the place of the pets line (both stay on screen).
    const pets = !suggestion && s.closet.home.pets?.length ? ` At home: ${joinAnd(s.closet.home.pets.map((p) => `a ${p}`))}.` : '';
    return `You have ${joinAnd(s.closet.devices)}.${pets}${this.suggestionSpeech(suggestion)}`;
  }

  private suggestionSpeech(x: ClosetSuggestion | null): string {
    return x ? ` ${this.store.name} lists the ${spokenTitle(x.product.title)} for your ${x.device}, at ${money(x.product.price, this.store.currency)}.` : '';
  }

  /**
   * One proactive tip: the cheapest in-stock accessory this store itself lists for a remembered device
   * (newest device first), with the store's quote. Never a robot/vacuum, a plan, a trade-in or points,
   * never something the shopper already ordered here. No catalog or no listing -> no tip.
   */
  private async suggestion(s: ShopperState): Promise<ClosetSuggestion | null> {
    if (!s.closet.devices.length) return null;
    let loaded: LoadedCatalog;
    try {
      loaded = await this.cfg.catalog.load();
    } catch {
      return null;
    }
    const owned = new Set(s.orders.flatMap((o) => o.items.map((l) => l.product.id)));
    const devices = [...s.closet.devices].reverse().map((d) => this.localDevice(parseDevice(d))).filter((d) => !d.generic);
    for (const d of devices) {
      let best: { item: CatalogItem; evidence: NonNullable<ReturnType<typeof checkCompat>['evidence']> } | null = null;
      for (const item of loaded.catalog.items) {
        const v = item.primary;
        if (!v.available || item.kind.offer !== 'standard' || item.kind.form || owned.has(v.id)) continue;
        const c = checkCompat(item, d);
        if (c.status !== 'confirmed' || !c.evidence || c.level === 'family') continue;
        if (!best || v.price < best.item.primary.price) best = { item, evidence: c.evidence };
      }
      if (best) {
        return { device: d.name, product: this.product(best.item, best.item.primary, [`Store lists it for your ${d.name}`]), evidence: best.evidence };
      }
    }
    return null;
  }

  /* ---------------- orders ---------------- */

  /** Shipping is only charged when the store config states a policy; otherwise it is unknown (null). */
  private totals(items: OrderLine[]): { subtotal: number; shipping: number | null; total: number } {
    const subtotal = round2(items.reduce((a, l) => a + l.line_total, 0));
    const ship = this.store.shipping;
    const shipping = ship ? (ship.free_over !== undefined && subtotal >= ship.free_over ? 0 : ship.flat) : null;
    return { subtotal, shipping, total: round2(subtotal + (shipping ?? 0)) };
  }

  async prepareOrder(userId: string, input: { items?: { id?: string; qty?: number }[] }): Promise<ToolOutcome> {
    if (userId === ANONYMOUS) return fail('anonymous', 'Please sign in before ordering, so I can keep track of it for you.');
    const raw = Array.isArray(input.items) ? input.items : [];
    const lines = new Map<string, number>();
    for (const it of raw) {
      const id = typeof it?.id === 'string' ? it.id.trim() : '';
      const qty = it?.qty === undefined ? 1 : it.qty;
      if (!id || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
        return fail('invalid_input', `Each item needs a product and a quantity from 1 to ${MAX_QTY}.`);
      }
      lines.set(id, (lines.get(id) ?? 0) + qty);
    }
    if (lines.size === 0 || lines.size > MAX_LINES) return fail('invalid_input', 'What would you like to order?');
    const loaded = await this.loadCatalog();
    if ('isError' in loaded) return loaded;

    const items: OrderLine[] = [];
    for (const [id, qty] of lines) {
      const hit = loaded.catalog.byVariant.get(id);
      if (!hit) return fail('not_found', "I couldn't find one of those products, so I didn't prepare the order.");
      if (!hit.variant.available) {
        return fail('out_of_stock', `Sorry, the ${spokenTitle(hit.item.title)} is out of stock right now, so I can't order it.`);
      }
      if (qty > MAX_QTY) return fail('invalid_input', `I can order up to ${MAX_QTY} of each item.`);
      items.push({ product: this.product(hit.item, hit.variant), qty, line_total: round2(hit.variant.price * qty) });
    }
    const { subtotal, shipping, total } = this.totals(items);
    const expires = this.now().getTime() + TOKEN_TTL_MS;
    const token = signOrderToken(
      { v: 1, u: userId, s: this.store.id, i: [...lines.entries()], t: Math.round(total * 100), e: expires, n: newNonce() },
      this.cfg.secret,
    );
    const structured: OrderPreviewResult = {
      kind: 'order_preview',
      items,
      subtotal,
      shipping,
      total,
      currency: this.store.currency,
      confirmation_token: token,
      expires_at: new Date(expires).toISOString(),
    };
    const what = items.length === 1 ? `${items[0].qty > 1 ? `${items[0].qty} of the ` : 'the '}${spokenTitle(items[0].product.title)}` : `${items.length} items`;
    const extra = shipping === null ? ' before shipping and tax' : ' before tax';
    return ok(`That's ${what}, ${money(total, this.store.currency)}${extra}. Should I place the order?`, structured);
  }

  async placeOrder(userId: string, input: { confirmation_token?: string }): Promise<ToolOutcome> {
    if (userId === ANONYMOUS) return fail('anonymous', 'Please sign in before ordering, so I can keep track of it for you.');
    const now = this.now();
    const check = verifyOrderToken(typeof input.confirmation_token === 'string' ? input.confirmation_token : '', this.cfg.secret, now.getTime());
    if (!check.ok) {
      return check.code === 'token_expired'
        ? fail('token_expired', 'That confirmation expired, so nothing was ordered. I can prepare the order again.')
        : fail('token_invalid', "That confirmation isn't valid, so nothing was ordered. Let's prepare the order again.");
    }
    const p = check.payload;
    if (p.s !== this.store.id) return fail('token_invalid', "That confirmation isn't valid, so nothing was ordered. Let's prepare the order again.");
    if (p.u !== userId) return fail('token_wrong_user', "That confirmation belongs to a different shopper, so nothing was ordered.");

    const loaded = await this.loadCatalog();
    if ('isError' in loaded) return loaded;

    // Set inside the serialized state update, so the replay check and the write are atomic per shopper.
    const result: { outcome: ToolOutcome | null; placed: string | null } = { outcome: null, placed: null };
    await this.cfg.state.update(userId, (st) => {
      const used = st.used_tokens[p.n];
      if (used) {
        const existing = st.orders.find((o) => o.id === used.order_id);
        if (existing) {
          result.outcome = ok(`That order is already placed, as order ${existing.id}.`, { kind: 'order', order: existing, already_placed: true } satisfies OrderResult);
          return st;
        }
      }
      const items: OrderLine[] = [];
      for (const [id, qty] of p.i) {
        const hit = loaded.catalog.byVariant.get(id);
        if (!hit) { result.outcome = fail('not_found', 'One of the products is no longer in the store, so nothing was ordered.'); return st; }
        if (!hit.variant.available) {
          result.outcome = fail('out_of_stock', `The ${spokenTitle(hit.item.title)} just went out of stock, so nothing was ordered.`);
          return st;
        }
        items.push({ product: this.product(hit.item, hit.variant), qty, line_total: round2(hit.variant.price * qty) });
      }
      const { subtotal, shipping, total } = this.totals(items);
      if (Math.round(total * 100) !== p.t) {
        result.outcome = fail('price_changed', `The price changed to ${money(total, this.store.currency)} since I quoted it, so nothing was ordered. Want me to prepare it again?`);
        return st;
      }
      const days = this.store.demo_delivery_days ?? 4;
      const order: Order = {
        id: `SC-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`,
        status: 'confirmed',
        created_at: now.toISOString(),
        eta: new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10),
        items,
        subtotal,
        shipping,
        total,
        currency: this.store.currency,
        payment: 'simulated (Amazon Wallet style)',
        store: this.store.name,
      };
      const usedTokens = Object.fromEntries(Object.entries(st.used_tokens).filter(([, v]) => v.expires > now.getTime() - 3_600_000));
      usedTokens[p.n] = { order_id: order.id, expires: p.e };
      result.outcome = ok(
        `Done: order ${order.id} is confirmed for ${money(total, this.store.currency)}. It's a demo, so no payment was taken.`,
        { kind: 'order', order } satisfies OrderResult,
      );
      result.placed = order.id;
      return { ...st, orders: [order, ...st.orders].slice(0, 50), used_tokens: usedTokens };
    });
    if (result.placed) this.log('order_placed', { user: userId, order: result.placed });
    return result.outcome ?? fail('internal', 'Sorry, something went wrong on my side. Nothing was ordered.');
  }

  async orderStatus(userId: string, input: { order_id?: string }): Promise<ToolOutcome> {
    if (userId === ANONYMOUS) return fail('anonymous', 'Please sign in so I can look up your orders.');
    const s = await this.cfg.state.get(userId);
    const wanted = typeof input.order_id === 'string' ? input.order_id.trim().toUpperCase() : '';
    const orders = wanted ? s.orders.filter((o) => o.id.toUpperCase() === wanted) : s.orders.slice(0, 5);
    if (wanted && !orders.length) return fail('not_found', `I can't find order ${wanted} on your account.`);
    const structured: OrdersResult = { kind: 'orders', orders };
    if (!orders.length) return ok(`You don't have any orders with ${this.store.name} yet.`, structured);
    const o = orders[0];
    const what = o.items.length === 1 ? `the ${spokenTitle(o.items[0].product.title)}` : `${o.items.length} items`;
    const lead = wanted ? `Order ${o.id}` : `Your latest order, ${o.id},`;
    // Orders are simulated, so the delivery date is the store config's demo estimate: say so.
    return ok(`${lead} for ${what} is ${o.status}, expected by ${spokenDate(o.eta)}. That date is a demo estimate.`, structured);
  }

  /* ---------------- talk_to_staff ---------------- */

  async talkToStaff(userId: string, input: { reason?: string; contact?: string }): Promise<ToolOutcome> {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) return fail('invalid_input', 'What should I tell the team?');
    const contact = typeof input.contact === 'string' && input.contact.trim() ? input.contact.trim().slice(0, 120) : null;
    const ticket: HandoffTicket = {
      ticket_id: `T-${randomBytes(3).toString('hex').toUpperCase()}`,
      created_at: this.now().toISOString(),
      reason,
      contact,
    };
    if (userId !== ANONYMOUS) await this.cfg.state.update(userId, (st) => ({ ...st, tickets: [ticket, ...st.tickets].slice(0, 50) }));
    try {
      await this.cfg.notify?.({ store: this.store.name, user: userId, ticket });
    } catch (err) {
      this.log('notify_failed', { ticket: ticket.ticket_id, error: (err as Error).message });
    }
    const message = `I've passed this to the ${this.store.name} team. Your ticket is ${ticket.ticket_id}.`;
    return ok(message, { kind: 'handoff', ticket_id: ticket.ticket_id, message } satisfies HandoffResult);
  }
}
