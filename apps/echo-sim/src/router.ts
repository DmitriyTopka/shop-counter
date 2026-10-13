// No-LLM fallback router: keyword rules -> one MCP tool call. Used when the brain proxy has no API key,
// hit its daily limit, or the API is down, so the demo always works. Deliberately simple and predictable.

export interface ScreenProduct { id: string; title: string; price: number; available?: boolean }
export interface ScreenState {
  /** products currently on screen (from products / compare / compat results) */
  products: ScreenProduct[];
  /** last order_preview token, if one is waiting for "confirm" */
  token?: string;
  /** the need behind the products on screen, so "anything cheaper?" keeps it */
  need?: string;
  /** ids of cards the shopper marked in the carousel (ui/update-model-context from the view) */
  selected?: string[];
}

/** Questions the catalog cannot answer. The honest move is a person, not a guess. */
const STAFF_TOPICS = /\b(promo(tion)?s?( code)?|coupons?|discount codes?|any discounts?|a discount|warrant(y|ies)|guarantee|return(s| it| policy| this| that)?\b|refunds?|exchange|shipping|ship (it )?to|delivery (cost|fee|price|time)|how much is delivery|price match|repair|broken|damaged|cancel (my|the|this|that) order|cancel order|(can|could) you deliver|deliver(ed)? (it |them |this |that )?(by|before|tomorrow|today|on|this))/;

export type Route = { tool: string; args: Record<string, unknown> } | { say: string };

const ORD: [RegExp, (n: number, ps: ScreenProduct[]) => number][] = [
  [/\b(first|1st|number one|#1|top)\b/, () => 0],
  [/\b(second|2nd|number two|#2|middle)\b/, () => 1],
  [/\b(third|3rd|number three|#3)\b/, () => 2],
  [/\blast\b/, (n) => n - 1],
  [/\bcheapest\b/, (_n, ps) => ps.reduce((b, p, i) => (p.price < ps[b].price ? i : b), 0)],
  [/\b(most expensive|priciest)\b/, (_n, ps) => ps.reduce((b, p, i) => (p.price > ps[b].price ? i : b), 0)],
];

export function pickIndex(u: string, ps: ScreenProduct[]): number | null {
  if (!ps.length) return null;
  for (const [re, f] of ORD) if (re.test(u)) return Math.min(Math.max(f(ps.length, ps), 0), ps.length - 1);
  // a word from a product title ("the Q10", "the car charger")
  const words = u.split(/[^a-z0-9+]+/).filter((w) => w.length > 2 && !STOP.has(w));
  let best = -1;
  let score = 0;
  ps.forEach((p, i) => {
    const t = p.title.toLowerCase();
    const s = words.filter((w) => t.includes(w)).length;
    if (s > score) { score = s; best = i; }
  });
  return best >= 0 ? best : null;
}
const STOP = new Set(['the', 'one', 'that', 'this', 'with', 'and', 'for', 'buy', 'order', 'add', 'cart', 'get', 'want', 'please', 'will', 'work', 'does', 'compatible', 'my', 'your', 'alexa', 'can', 'you', 'charger', 'vacuum', 'robot']);

export function parseBudget(u: string): number | undefined {
  const m = u.match(/(?:under|below|less than|up to|max(?:imum)?|within|no more than|budget(?: of| is)?)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/) ?? u.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

const PETS = /\b(cats?|dogs?|kittens?|puppies|puppy|pets?)\b/;

export function route(utterance: string, s: ScreenState): Route {
  const u = utterance.toLowerCase().replace(/^\s*(alexa|hey alexa)[,!.]?\s*/, '').trim();
  if (!u) return { say: 'Sorry, I did not catch that.' };

  // 1. confirm a pending order
  if (/\b(confirm|place (the |my )?order|yes|yep|go ahead|do it|sounds good)\b/.test(u) && s.token && !/\bno\b|\bdon'?t\b|\bcancel\b/.test(u)) {
    return { tool: 'place_order', args: { confirmation_token: s.token } };
  }
  // "cancel my order" about a PLACED order: there is no cancel tool, so a person takes it (never "done").
  if (/\bcancel\b.*\border\b/.test(u) && !s.token) return { tool: 'talk_to_staff', args: { reason: `Cancel request: ${utterance.trim()}` } };
  if (/^(no|cancel|never ?mind|stop|maybe later|not now|hmm)\b/.test(u)) return { say: 'Okay, I will not order anything.' };

  // 1b. questions the store feed does not answer: discounts, warranty, returns, shipping
  if (STAFF_TOPICS.test(u)) return { tool: 'talk_to_staff', args: { reason: utterance.trim() } };

  // 2. order status (also the first step of "order the same as last time")
  if (/where('?s| is) my (order|package|stuff)|order status|track (my )?(order|package)|my orders?\b|when (will|does) (it|my \w+) (arrive|come|get here)|\b(last time|same as before|reorder|order (it |that |the same \w+ )?again)\b/.test(u)) {
    const again = /\b(again|reorder|last time|same as before)\b/.test(u);
    if (again && s.products.length && /\b(order|buy|get)\b/.test(u) && !/\blast time\b/.test(u)) {
      return { tool: 'prepare_order', args: { items: [{ id: s.products[pickIndex(u, s.products) ?? 0].id, qty: 1 }] } };
    }
    return { tool: 'order_status', args: {} };
  }

  // 3. human handoff
  if (/\b(talk|speak|chat) (to|with) (a |an |the )?(person|human|someone|staff|agent|manager|store)|real person|customer service/.test(u)) {
    return { tool: 'talk_to_staff', args: { reason: utterance.trim() } };
  }

  // 4. devices
  if (/what (devices|stuff) do i (have|own)|what do (i|you know i) (have|own)|my devices|what do you remember/.test(u)) {
    return { tool: 'my_devices', args: {} };
  }
  const own = u.match(/\bi (?:have|own|got|just got|bought|use) (?:a |an |the |two |2 )?(.+)$/);
  if (own && !/\b(budget|question|problem|order)\b/.test(own[1]) && !/\b(find|need|looking|want|recommend)\b/.test(u)) {
    const parts = own[1].split(/,|\band\b|\balso\b/).map((x) => x.replace(/^(a|an|the)\s+/, '').replace(/[.!?]$/, '').trim()).filter(Boolean);
    const pets = parts.filter((p) => PETS.test(p)).map((p) => p.match(PETS)![1].replace(/s$/, ''));
    const devices = parts.filter((p) => !PETS.test(p)).map(titleCase);
    return { tool: 'remember_my_devices', args: { ...(devices.length ? { devices } : {}), ...(pets.length ? { home: { pets } } : {}) } };
  }

  // 5. compare what is on screen: the cards the shopper marked, else the first three
  if (/\b(compare|comparison|difference|differ|versus|vs\.?|side by side|which (one )?(is|should))\b/.test(u)) {
    const marked = (s.selected ?? []).filter((id) => s.products.some((p) => p.id === id));
    if (marked.length >= 2) return { tool: 'compare_products', args: { ids: marked.slice(0, 3) } };
    if (s.products.length >= 2) return { tool: 'compare_products', args: { ids: s.products.slice(0, 3).map((p) => p.id) } };
    return { say: 'Ask me to find a few options first, then I can compare them.' };
  }

  // 6. compatibility
  const compat = u.match(/(?:work|works|compatible|fit|fits|go)\s+(?:with|for|on)\s+(?:my |a |an |the )?([a-z0-9][a-z0-9 +-]{1,40})/);
  if (compat && /\b(will|does|is|can|would|compatible)\b/.test(u)) {
    const i = pickIndex(u, s.products) ?? (s.products.length ? 0 : null);
    if (i === null) return { say: 'Which product should I check? Ask me to find one first.' };
    return { tool: 'check_compatibility', args: { product_id: s.products[i].id, device: titleCase(compat[1].replace(/\?$/, '').trim()) } };
  }

  // 7. buy something on screen
  if (/\b(buy|order|add|purchase|get me|i'?ll take|take)\b/.test(u) && s.products.length && !/\b(find|search|looking|recommend|show me)\b/.test(u)) {
    const i = pickIndex(u, s.products) ?? (s.products.length === 1 ? 0 : null);
    if (i === null) return { say: 'Which one? You can say the first, second or third one.' };
    const qty = Number(u.match(/\b(\d)\s*(?:of|x|pieces|units)\b/)?.[1] ?? 1);
    return { tool: 'prepare_order', args: { items: [{ id: s.products[i].id, qty }] } };
  }

  // 7b. "anything cheaper?": same need, budget just under the cheapest card on screen
  if (/\b(cheaper|less expensive|lower price|more affordable)\b/.test(u) && s.products.length && s.need) {
    const min = Math.min(...s.products.map((p) => p.price));
    return { tool: 'find_products', args: { need: s.need, max_price: Math.round((min - 0.01) * 100) / 100 } };
  }

  // 8. anything else is a shopping need
  const max_price = parseBudget(u);
  const need = u.replace(/^(can you |could you |please |i('m| am) looking for |i need |i want |find( me)?|show me|search for|recommend|get me)\s*/g, '').replace(/[?.!]+$/, '').trim();
  return { tool: 'find_products', args: { need: need || u, ...(max_price ? { max_price } : {}) } };
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => (/^(iphone|ipad|imac|airpods|macbook)/.test(w) ? w.replace(/^i(phone|pad|mac)/, (_m, r) => `i${r[0].toUpperCase()}${r.slice(1)}`).replace(/^airpods/, 'AirPods').replace(/^macbook/, 'MacBook') : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
