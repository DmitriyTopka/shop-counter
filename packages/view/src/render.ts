// Pure DOM renderer for every structuredContent kind. No framework, no innerHTML with data:
// all store text goes through textContent, so a product title can never inject markup.
// Design follows the Alexa MCP add-on guide: one headline, one or two fields, one main action,
// text readable across the room (type scale 1.6).
import type { LineItem, Order, Product, Structured, ToolResultLike, ViewHost } from './types';

type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string> = {
  check: 'M5 12.5l4.2 4.2L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 8v5m0 3.5v.5M10.3 3.9L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  cart: 'M3 4h2l2.4 11.2a2 2 0 002 1.6h7.9a2 2 0 002-1.5L21 8H6.2M10 20.5h.01M17 20.5h.01',
  compare: 'M8 4v16M16 4v16M4 8h4M16 16h4',
  truck: 'M3 6h11v9H3zM14 10h4l3 3v2h-7M7.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  device: 'M8 3h8a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2zM11 18h2',
  home: 'M4 11l8-7 8 7v8a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z',
  person: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  quote: 'M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
};

export function icon(name: keyof typeof ICONS | string, cls = 'ic'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? ICONS.spark);
  svg.append(p);
  return svg;
}

export function money(v: number | null | undefined, currency = 'USD'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

/**
 * Some stores reuse one photo for the new and the refurbished unit of the same model (Roborock does
 * for 40 pairs). The photo is the store's; the badge makes the two cards tell apart at a glance.
 */
const REFURB = /\brefurbished\b/i;

function thumb(p: Product, cls = 'img'): HTMLElement {
  const box = h('div', { class: cls });
  if (cls === 'img' && REFURB.test(p.title)) box.append(h('span', { class: 'tag-refurb' }, 'Refurbished'));
  const fallback = () => {
    box.textContent = '';
    box.classList.add('noimg');
    box.append(h('span', {}, (p.vendor || p.title || '?').slice(0, 1).toUpperCase()));
  };
  if (p.image) {
    const img = h('img', { src: p.image, alt: '', loading: 'lazy', decoding: 'async' }) as HTMLImageElement;
    img.addEventListener('error', fallback, { once: true });
    box.append(img);
  } else fallback();
  return box;
}

function stock(p: Product): HTMLElement {
  return h('span', { class: `stock ${p.available ? 'in' : 'out'}` }, h('i', {}), p.available ? 'In stock' : 'Out of stock');
}

function header(eyebrow: string | undefined, title: string, extra?: Child): HTMLElement {
  return h('header', { class: 'hd' }, eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null, h('h1', {}, title), extra ?? null);
}

function button(label: string, opts: { kind?: 'primary' | 'ghost' | 'quiet'; icon?: string; pressed?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h(
    'button',
    { type: 'button', class: `btn ${opts.kind ?? 'primary'}`, 'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed), disabled: opts.disabled },
    opts.icon ? icon(opts.icon) : null,
    h('span', {}, label),
  ) as HTMLButtonElement;
  return b;
}

/** Runs a tool from a button: busy state, status line, then shows the new result on screen. */
async function run(host: ViewHost, btn: HTMLButtonElement, busyLabel: string, name: string, args: Record<string, unknown>, status: HTMLElement) {
  const label = btn.querySelector('span');
  const before = label?.textContent ?? '';
  btn.disabled = true;
  btn.classList.add('busy');
  if (label) label.textContent = busyLabel;
  status.textContent = '';
  try {
    const r = await host.callTool(name, args);
    host.show(r);
  } catch (e) {
    status.textContent = 'Something went wrong. Please try again, or just ask Alexa.';
    btn.disabled = false;
    btn.classList.remove('busy');
    if (label) label.textContent = before;
    // keep the error visible in the host log too
    console.warn('[view] tool call failed', name, e);
  }
}

function statusLine(): HTMLElement {
  return h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
}

function addToCartArgs(p: Product) {
  return { items: [{ id: p.id, qty: 1 }] };
}

// ---------- kinds ----------

function renderProducts(sc: Extract<Structured, { kind: 'products' }>, host: ViewHost, spokenText?: string): HTMLElement {
  const status = statusLine();
  const picked = new Set<string>();
  const tray = h('div', { class: 'tray', hidden: true });
  const trayBtn = button('Compare', { icon: 'compare' });
  tray.append(trayBtn);
  const refreshTray = () => {
    tray.hidden = picked.size < 2;
    const s = trayBtn.querySelector('span');
    if (s) s.textContent = `Compare ${picked.size}`;
  };
  trayBtn.addEventListener('click', () => run(host, trayBtn, 'Comparing…', 'compare_products', { ids: [...picked] }, status));

  const cards = sc.products.slice(0, 3).map((p, i) => {
    const cmp = button('Compare', { kind: 'ghost', icon: 'compare', pressed: false });
    cmp.addEventListener('click', () => {
      if (picked.has(p.id)) picked.delete(p.id);
      else {
        if (picked.size >= 3) return;
        picked.add(p.id);
      }
      cmp.setAttribute('aria-pressed', String(picked.has(p.id)));
      card.classList.toggle('picked', picked.has(p.id));
      refreshTray();
      host.select?.(sc.products.filter((x) => picked.has(x.id)));
    });
    const add = button(p.available ? 'Add to cart' : 'Unavailable', { icon: 'cart', disabled: !p.available });
    add.addEventListener('click', () => run(host, add, 'Adding…', 'prepare_order', addToCartArgs(p), status));
    const save = p.compare_at_price && p.compare_at_price > p.price ? p.compare_at_price - p.price : 0;
    const card = h(
      'article',
      { class: 'card', 'data-id': p.id, style: `--i:${i}` },
      h('span', { class: 'rank' }, String(i + 1)),
      thumb(p),
      h('h2', { class: 'name' }, p.title),
      p.variant ? h('p', { class: 'variant' }, p.variant) : null,
      h(
        'div',
        { class: 'price' },
        h('strong', {}, money(p.price, p.currency)),
        save ? h('s', {}, money(p.compare_at_price, p.currency)) : null,
        save ? h('em', { class: 'save' }, `Save ${money(save, p.currency).replace(/\.00$/, '')}`) : null,
      ),
      stock(p),
      p.why?.length ? h('ul', { class: 'why' }, ...p.why.slice(0, 2).map((w) => h('li', {}, icon('check'), h('span', {}, w)))) : null,
      h('div', { class: 'actions' }, cmp, add),
    );
    return card;
  });

  const eyebrow = [
    sc.store,
    sc.for_devices?.length ? `for your ${sc.for_devices.join(' + ')}` : sc.need ? `“${sc.need}”` : '',
    sc.max_price ? `under ${money(sc.max_price).replace(/\.00$/, '')}` : '',
  ].filter(Boolean).join(' · ');
  const n = cards.length;
  const title = n === 0 ? 'Nothing matched' : n === 1 ? 'My pick for you' : `My top ${n} picks`;
  return h(
    'section',
    { class: 'kind-products' },
    header(eyebrow, title),
    n ? h('div', { class: 'cards', style: `--n:${n}` }, ...cards) : h('p', { class: 'empty' }, spokenText || 'Try a different budget or ask for something else.'),
    h('footer', { class: 'ft' }, sc.more_available ? h('span', { class: 'muted' }, `+${sc.more_available} more in the store · add a budget or a must-have to narrow it`) : h('span', {}), tray),
    status,
  );
}

function renderCompare(sc: Extract<Structured, { kind: 'compare' }>, host: ViewHost): HTMLElement {
  const status = statusLine();
  const cols = sc.products.slice(0, 3);
  const table = h('table', { class: 'cmp', style: `--n:${cols.length}` });
  const headRow = h('tr', {}, h('th', { scope: 'col' }, h('span', { class: 'sr' }, 'Feature')));
  for (const p of cols) {
    const add = button('Choose', { kind: 'ghost', icon: 'cart', disabled: !p.available });
    add.addEventListener('click', () => run(host, add, 'Adding…', 'prepare_order', addToCartArgs(p), status));
    headRow.append(h('th', { scope: 'col' }, h('div', { class: 'col-head' }, thumb(p, 'img xs'), h('div', { class: 'name' }, p.title)), add));
  }
  table.append(h('thead', {}, headRow));
  const body = h('tbody');
  for (const row of sc.rows) {
    const vals = row.values.slice(0, cols.length);
    const distinct = new Set(vals.filter((v) => v !== null)).size > 1;
    const tr = h('tr', { class: distinct ? 'diff' : 'same' }, h('th', { scope: 'row' }, row.label));
    vals.forEach((v) => tr.append(h('td', {}, v ?? h('span', { class: 'muted' }, 'Not listed'))));
    body.append(tr);
  }
  table.append(body);
  return h(
    'section',
    { class: 'kind-compare' },
    header('Side by side', `Comparing ${cols.length} models`),
    h('div', { class: 'cmp-wrap' }, table),
    sc.verdict ? h('div', { class: 'verdict' }, icon('spark', 'ic big'), h('p', {}, sc.verdict)) : null,
    status,
  );
}

const SOURCE_LABEL: Record<string, string> = {
  tags: 'store compatibility tags',
  title: 'product title',
  description: 'product description',
  options: 'product options',
};

function renderCompat(sc: Extract<Structured, { kind: 'compat' }>, host: ViewHost): HTMLElement {
  const status = statusLine();
  const dev = sc.device || 'your device';
  const mine = sc.device_source === 'closet';
  const v = {
    confirmed: { cls: 'ok', ic: 'check', title: `Works with ${mine ? 'your ' : ''}${dev}`, sub: 'Confirmed by the store' },
    not_listed: { cls: 'warn', ic: 'alert', title: `Not confirmed for ${dev}`, sub: 'The store does not list it, so I will not guess' },
    incompatible: { cls: 'bad', ic: 'x', title: `Not for ${dev}`, sub: 'The store data rules it out' },
  }[sc.status] ?? { cls: 'warn', ic: 'alert', title: 'Unknown', sub: '' };

  const p = sc.product;
  const add = button('Add to cart', { icon: 'cart', disabled: !p.available });
  add.addEventListener('click', () => run(host, add, 'Adding…', 'prepare_order', addToCartArgs(p), status));

  const alts = (sc.alternatives ?? []).slice(0, 3);
  return h(
    'section',
    { class: `kind-compat ${v.cls}` },
    h(
      'div',
      { class: 'verdict-badge' },
      h('div', { class: 'seal' }, icon(v.ic, 'ic big')),
      h('div', {}, mine ? h('p', { class: 'eyebrow remembered' }, icon('device'), `Your ${dev} · remembered`) : null, h('h1', {}, v.title), h('p', { class: 'muted' }, v.sub)),
    ),
    h(
      'div',
      { class: 'compat-body' },
      sc.note ? h('p', { class: 'note' }, sc.note) : null,
      h('div', { class: 'prod-row' }, thumb(p, 'img sm'), h('div', {}, h('div', { class: 'name' }, p.title), h('div', { class: 'price' }, h('strong', {}, money(p.price, p.currency))), stock(p))),
      sc.evidence
        ? h(
            'figure',
            { class: 'evidence' },
            icon('quote', 'ic q'),
            h('blockquote', {}, sc.evidence.quote),
            h('figcaption', {}, `From the ${SOURCE_LABEL[sc.evidence.source] ?? sc.evidence.source}`),
          )
        : h('p', { class: 'evidence none' }, 'No line in the store data mentions this device.'),
      sc.also?.length
        ? h('ul', { class: 'also' }, ...sc.also.slice(0, 4).map((a) => h('li', { class: `st-${a.status}` }, icon(a.status === 'confirmed' ? 'check' : a.status === 'incompatible' ? 'x' : 'alert'), h('span', {}, a.device), h('em', {}, a.status === 'confirmed' ? 'confirmed' : a.status === 'incompatible' ? 'will not work' : 'not listed'))))
        : null,
      sc.status === 'confirmed' ? h('div', { class: 'actions solo' }, add) : null,
    ),
    alts.length
      ? h(
          'div',
          { class: 'alts' },
          h('h2', {}, sc.status === 'confirmed' ? 'Also works' : `These are confirmed for ${dev}`),
          h(
            'div',
            { class: 'alt-list' },
            ...alts.map((a) => {
              const b = button('Add', { kind: 'ghost', icon: 'cart', disabled: !a.available });
              b.addEventListener('click', () => run(host, b, 'Adding…', 'prepare_order', addToCartArgs(a), status));
              return h('div', { class: 'alt' }, thumb(a, 'img xs'), h('div', { class: 'alt-txt' }, h('div', { class: 'name' }, a.title), h('strong', {}, money(a.price, a.currency))), b);
            }),
          ),
        )
      : null,
    status,
  );
}

function lineItems(items: LineItem[] | undefined, currency?: string): HTMLElement {
  return h(
    'ul',
    { class: 'lines' },
    ...(items ?? []).map((li) =>
      h(
        'li',
        {},
        thumb(li.product, 'img xs'),
        h('div', { class: 'line-txt' }, h('div', { class: 'name' }, li.product.title), h('span', { class: 'muted' }, [li.product.variant, `Qty ${li.qty}`].filter(Boolean).join(' · '))),
        h('strong', {}, money(li.line_total, li.product.currency ?? currency)),
      ),
    ),
  );
}

function shippingLabel(v: number | null | undefined, cur: string): string {
  if (v === null || v === undefined) return 'Set by the store';
  return v === 0 ? 'Free' : money(v, cur);
}

function minutesLeft(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 60000);
}

function renderOrderPreview(sc: Extract<Structured, { kind: 'order_preview' }>, host: ViewHost): HTMLElement {
  const status = statusLine();
  const cur = sc.currency ?? 'USD';
  const confirm = button(`Place order · ${money(sc.total, cur)}`, { icon: 'check' });
  confirm.classList.add('wide');
  confirm.addEventListener('click', () => run(host, confirm, 'Placing order…', 'place_order', { confirmation_token: sc.confirmation_token }, status));
  const left = minutesLeft(sc.expires_at);
  return h(
    'section',
    { class: 'kind-order_preview' },
    header('Not ordered yet · review your order', 'Say “confirm” to buy'),
    h(
      'div',
      { class: 'split' },
      lineItems(sc.items, cur),
      h(
        'aside',
        { class: 'summary' },
        h('dl', {}, h('dt', {}, 'Subtotal'), h('dd', {}, money(sc.subtotal, cur)), h('dt', {}, 'Shipping'), h('dd', {}, shippingLabel(sc.shipping, cur))),
        h('div', { class: 'total' }, h('span', {}, sc.shipping === null || sc.shipping === undefined ? 'Total before shipping & tax' : 'Total'), h('strong', {}, money(sc.total, cur))),
        h('p', { class: 'pay muted' }, 'Payment is simulated (Amazon Wallet style). Nothing is charged.'),
        confirm,
        h('p', { class: 'hint muted' }, left !== null && left > 0 ? `Nothing is ordered until you say “confirm” or tap. This quote holds for ${left} min.` : 'Nothing is ordered until you say “confirm” or tap.'),
      ),
    ),
    status,
  );
}

const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', processing: 'Processing', shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };

function orderCard(o: Order, big = false): HTMLElement {
  const st = (o.status || '').toLowerCase();
  return h(
    'article',
    { class: `order ${big ? 'big' : ''}` },
    h('div', { class: 'order-top' }, h('span', { class: `pill st-${st}` }, STATUS_LABEL[st] ?? o.status), h('span', { class: 'muted mono' }, `#${o.id}`)),
    // Orders are simulated: the date is the store config's demo estimate, and the card says so.
    o.eta ? h('div', { class: 'eta' }, icon('truck'), h('div', {}, h('span', { class: 'muted' }, st === 'delivered' ? 'Delivered' : 'Arrives · store estimate (demo)'), h('strong', {}, o.eta))) : null,
    lineItems(o.items, o.currency),
    h('div', { class: 'total' }, h('span', {}, o.shipping === null ? 'Total before shipping & tax' : 'Total'), h('strong', {}, money(o.total, o.currency ?? 'USD'))),
  );
}

function renderOrder(sc: Extract<Structured, { kind: 'order' }>): HTMLElement {
  return h(
    'section',
    { class: 'kind-order' },
    h('div', { class: 'verdict-badge ok' }, h('div', { class: 'seal pop' }, icon('check', 'ic big')), h('div', {}, h('h1', {}, sc.already_placed ? 'Already placed' : 'Order placed'), h('p', { class: 'muted' }, [sc.order.store, sc.order.payment ? `payment ${sc.order.payment}` : ''].filter(Boolean).join(' · ')))),
    orderCard(sc.order, true),
  );
}

function renderOrders(sc: Extract<Structured, { kind: 'orders' }>): HTMLElement {
  const list = sc.orders ?? [];
  return h(
    'section',
    { class: 'kind-orders' },
    header('Your orders', list.length ? (list.length === 1 ? 'Your latest order' : `${list.length} recent orders`) : 'No orders yet'),
    list.length ? h('div', { class: 'orders' }, ...list.slice(0, 3).map((o, i) => orderCard(o, i === 0))) : h('p', { class: 'empty' }, 'When you order something, you can ask me where it is from any Echo.'),
  );
}

function renderCloset(sc: Extract<Structured, { kind: 'closet' }>, host: ViewHost): HTMLElement {
  const pets = sc.home?.pets ?? [];
  const status = statusLine();
  const tip = sc.suggestion;
  let tipEl: HTMLElement | null = null;
  if (tip) {
    const add = button('Add to cart', { kind: 'ghost', icon: 'cart', disabled: !tip.product.available });
    add.addEventListener('click', () => run(host, add, 'Adding…', 'prepare_order', addToCartArgs(tip.product), status));
    tipEl = h(
      'aside',
      { class: 'tip' },
      h('p', { class: 'eyebrow' }, icon('spark'), `${sc.store ?? 'The store'} lists this for your ${tip.device}`),
      h(
        'div',
        { class: 'prod-row' },
        thumb(tip.product, 'img sm'),
        h('div', { class: 'tip-txt' }, h('div', { class: 'name' }, tip.product.title), h('div', { class: 'price' }, h('strong', {}, money(tip.product.price, tip.product.currency)))),
        add,
      ),
      h('figure', { class: 'evidence' }, icon('quote', 'ic q'), h('blockquote', {}, tip.evidence.quote), h('figcaption', {}, `From the ${SOURCE_LABEL[tip.evidence.source] ?? tip.evidence.source}`)),
    );
  }
  return h(
    'section',
    { class: 'kind-closet' },
    header(sc.store ? `Remembered for you · shared with every store, now ${sc.store}` : 'Remembered for you · shared with every store', 'My devices'),
    sc.devices.length
      ? h('ul', { class: 'devices' }, ...sc.devices.map((d) => h('li', {}, h('span', { class: 'dev-ic' }, icon('device')), h('span', {}, d))))
      : h('p', { class: 'empty' }, 'Tell me what devices you have, and I will check compatibility for you.'),
    pets.length || sc.home?.notes
      ? h('div', { class: 'home' }, icon('home'), h('p', {}, [pets.length ? `Pets: ${pets.join(', ')}` : '', sc.home?.notes ?? ''].filter(Boolean).join(' · ')))
      : null,
    tipEl,
    status,
  );
}

function renderHandoff(sc: Extract<Structured, { kind: 'handoff' }>): HTMLElement {
  return h(
    'section',
    { class: 'kind-handoff' },
    h('div', { class: 'verdict-badge ok' }, h('div', { class: 'seal' }, icon('person', 'ic big')), h('div', {}, h('h1', {}, 'A person will help'), h('p', { class: 'muted mono' }, `Ticket ${sc.ticket_id}`))),
    h('p', { class: 'lead' }, sc.message),
  );
}

function renderError(sc: { message?: string; code?: string }, fallbackText?: string): HTMLElement {
  return h(
    'section',
    { class: 'kind-error' },
    h('div', { class: 'verdict-badge warn' }, h('div', { class: 'seal' }, icon('alert', 'ic big')), h('div', {}, h('h1', {}, 'That did not work'), sc.code ? h('p', { class: 'muted mono' }, sc.code) : null)),
    h('p', { class: 'lead' }, sc.message || fallbackText || 'Please try again.'),
  );
}

export function renderWaiting(text = 'Waiting for Alexa…'): HTMLElement {
  return h('section', { class: 'kind-wait' }, h('div', { class: 'orb' }), h('p', { class: 'muted' }, text));
}

/** Entry point: tool result -> element. Unknown kinds fall back to the spoken text. */
export function renderResult(result: ToolResultLike, host: ViewHost): HTMLElement {
  const sc = (result.structuredContent ?? null) as Structured | null;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!sc || typeof sc !== 'object' || !('kind' in sc)) {
    if (result.isError) return renderError({}, text);
    return h('section', { class: 'kind-text' }, h('p', { class: 'lead' }, text ?? ''));
  }
  switch (sc.kind) {
    case 'products':
      return renderProducts(sc, host, text);
    case 'compare':
      return renderCompare(sc, host);
    case 'compat':
      return renderCompat(sc, host);
    case 'order_preview':
      return renderOrderPreview(sc, host);
    case 'order':
      return renderOrder(sc);
    case 'orders':
      return renderOrders(sc);
    case 'closet':
      return renderCloset(sc, host);
    case 'handoff':
      return renderHandoff(sc);
    case 'error':
      return renderError(sc, text);
    default:
      return h('section', { class: 'kind-text' }, h('p', { class: 'lead' }, text ?? ''));
  }
}
