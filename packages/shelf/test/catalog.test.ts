import { describe, expect, it } from 'vitest';
import { staticCatalog } from '../src/catalog.js';
import { checkCompat } from '../src/compat.js';
import { parseDevice } from '../src/devices.js';
import { toProduct } from '../src/normalize.js';
import { budgetFromText, search, tokenize } from '../src/search.js';
import { ALL, ccCable, desk140, gan100, hub, lightningCable, phoneCase, product, qi2Stand, soldOut, STORE, variant, vid, wall240 } from './fixtures.js';

const { catalog, index } = await staticCatalog(STORE, ALL).load();
const item = (p: { id: number }) => catalog.items.find((i) => i.productId === String(p.id))!;
const titles = (need: string, extra: Parameters<typeof search>[2] extends infer Q ? Partial<Q> : never = {}) =>
  search(catalog, index, { need, ...extra }).hits.map((h) => h.item.title);

describe('normalization', () => {
  it('prefers the region variant and keeps a real markdown only', () => {
    const p = toProduct(item(desk140), STORE);
    expect(p).toMatchObject({ id: vid(desk140, 0), variant: 'US', price: 99.99, compare_at_price: 119.99, available: true, currency: 'USD' });
    expect(p.url).toBe(`https://acme.example/products/powerdesk-140w-desktop-charger?variant=${vid(desk140, 0)}`);
    expect(p.highlights).toEqual(['Up to 140W', '4 USB-C ports', 'Live wattage display']);
    expect(p.compatible_with).toEqual(['iPad Pro', 'iPhone 15', 'iPhone 16', 'MacBook Air', 'MacBook Pro']);
  });

  it('keeps the US variant even when only another region is in stock', () => {
    expect(toProduct(item(wall240), STORE)).toMatchObject({ variant: 'US', available: false });
  });

  it('picks the first in-stock colour when there is no region', () => {
    expect(toProduct(item(qi2Stand), STORE)).toMatchObject({ variant: 'Sand', available: true });
  });

  it('indexes every variant id', () => {
    expect(catalog.byVariant.get(vid(desk140, 1))?.variant).toMatchObject({ label: 'EU', available: false });
  });
});

describe('search', () => {
  it('tokenizes connector spellings and plurals the same way', () => {
    expect(tokenize('USB Type-C chargers')).toEqual(tokenize('usb-c charger'));
  });

  it('finds chargers for both devices, in stock, within budget, with reasons', () => {
    const out = search(catalog, index, { need: 'charger for my iPhone 15 and MacBook Air', maxPrice: 120, devices: [parseDevice('iPhone 15'), parseDevice('MacBook Air')] });
    expect(out.hits[0].item.title).toBe('PowerDesk™ 140W Desktop Charger');
    expect(out.hits[0].why).toEqual(['Store lists it for your iPhone 15 and MacBook Air', '$99.99, within your $120 budget', 'On sale: $20 off the regular $119.99']);
    const all = out.hits.map((h) => h.item.title);
    expect(all).not.toContain('240W Desktop Charger'); // US plug sold out
    expect(all).not.toContain('Magnetic Power Bank 10K'); // sold out
    for (const h of out.hits) expect(h.variant.price).toBeLessThanOrEqual(120);
  });

  it('only recommends products listed for the shopper devices when any exist', () => {
    const out = search(catalog, index, { need: 'charger', devices: [parseDevice('MacBook Air')] });
    expect(out.hits.every((h) => h.coverage.covered.includes('MacBook Air'))).toBe(true);
  });

  it('reports out-of-stock and over-budget instead of an empty shrug', () => {
    expect(search(catalog, index, { need: 'power bank' })).toMatchObject({ hits: [], outOfStock: 1 });
    expect(search(catalog, index, { need: 'hub', maxPrice: 20 })).toMatchObject({ hits: [], overBudget: { count: 1, cheapest: 59.99 } });
  });

  it('applies must-have, category and requires a strong-field hit', () => {
    expect(titles('charger', { mustHave: ['100W'] }).sort()).toEqual(['100W USB-C PD Compact GaN Charger', 'PowerDesk™ 140W Desktop Charger']);
    expect(titles('charger', { mustHave: ['GaN'] })).toEqual(['100W USB-C PD Compact GaN Charger']);
    expect(titles('charger', { category: 'Wireless Chargers' })).toEqual(['2-in-1 Foldable Qi2 Wireless Charging Stand', 'Aluminum Dock for MagSafe Charger']);
    // An accessory *for* a charger is not a charger: with real chargers around, it drops out.
    const order = titles('charger', { limit: 10 } as never);
    expect(order).toContain('2-in-1 Foldable Qi2 Wireless Charging Stand');
    expect(order).not.toContain('Aluminum Dock for MagSafe Charger');
    // A merchandising tag ("magsafe charger" on a cable) does not make a cable a charger.
    expect(titles('charger')).not.toContain('USB-C to Lightning Cable - 10 Inches');
    // "laptop" appears only in a description: not enough to recommend.
    expect(titles('laptop sleeve')).toEqual([]);
  });

  it('reads a budget from free text', () => {
    expect(budgetFromText('a hub under $50 please')).toBe(50);
    expect(budgetFromText('less than 30 dollars')).toBe(30);
    expect(budgetFromText('a 100W charger')).toBeUndefined();
  });
});

describe('compatibility', () => {
  const dev = parseDevice;
  it('confirms from a tag with the literal tag as quote', () => {
    expect(checkCompat(item(desk140), dev('iPhone 15'))).toMatchObject({ status: 'confirmed', evidence: { source: 'tags', quote: 'iPhone 15' }, level: 'exact' });
    // A series or family listing is reported as exactly that, never as "it works" (council 2, 2026-10-13).
    expect(checkCompat(item(desk140), dev('iPhone 15 Pro Max'))).toMatchObject({
      status: 'family_only', level: 'series', note: 'The store lists iPhone 15, not your iPhone 15 Pro Max specifically.',
    });
    expect(checkCompat(item(desk140), dev('MacBook Air M3'))).toMatchObject({ status: 'family_only', level: 'family', evidence: { quote: 'MacBook Air' } });
    expect(checkCompat(item(desk140), dev('MacBook Pro 2017 Intel'))).toMatchObject({
      status: 'family_only', note: 'The store lists MacBook Pro, not your MacBook Pro 2017 Intel specifically.',
    });
    expect(checkCompat(item(desk140), dev('MacBook Pro 14 M3')).status).toBe('family_only');
    expect(checkCompat(item(desk140), dev('iphone 15')).status).toBe('confirmed');
  });

  it('confirms from a description only inside a compatibility phrase', () => {
    expect(checkCompat(item(hub), dev('iPad Pro M4'))).toMatchObject({ status: 'confirmed', evidence: { source: 'description' } });
    expect(checkCompat(item(hub), dev('Galaxy S24 Ultra')).status).toBe('not_listed');
  });

  it('rules out Lightning for USB-C iPhones and USB-C cables for Lightning iPhones', () => {
    expect(checkCompat(item(lightningCable), dev('iPhone 15'))).toMatchObject({ status: 'incompatible', evidence: { source: 'title' } });
    expect(checkCompat(item(lightningCable), dev('iPhone 13')).status).toBe('confirmed');
    expect(checkCompat(item(ccCable), dev('iPhone 13')).status).toBe('incompatible');
  });

  it('never confirms from a bare "iPhone" tag or for a generic shopper device', () => {
    expect(checkCompat(item(lightningCable), dev('iPhone 14')).status).toBe('not_listed');
    expect(checkCompat(item(desk140), dev('iPhone')).status).toBe('not_listed');
  });

  it('does not stretch a series listing to a case that needs an exact fit', () => {
    expect(checkCompat(item(phoneCase), dev('iPhone 15 Pro'))).toMatchObject({ status: 'family_only', note: expect.stringMatching(/needs an exact fit/) });
    expect(checkCompat(item(phoneCase), dev('iPhone 15')).status).toBe('confirmed');
  });

  it('handles devices outside the dictionary by literal match only', () => {
    expect(checkCompat(item(gan100), dev('Steam Deck')).status).toBe('not_listed');
  });

  it('keeps the fixture honest: sold-out item stays sold out', () => {
    expect(toProduct(item(soldOut), STORE).available).toBe(false);
  });
});

describe('search quality on a vacuum store', () => {
  const store = { ...STORE, id: 'vac', name: 'VacCo' };
  const stick = product({ title: 'H9 Cordless Stick Vacuum Cleaner', product_type: 'Robot Vacuums', variants: [variant({ price: '199.99' })] });
  const robot = product({
    title: 'Q5 Robot Vacuum and Mop with 8,000 Pa Suction',
    product_type: 'Robot Vacuums',
    body_html: '<p>Our robot vacuum maps your rooms and cleans on a schedule. '.repeat(8) + 'Dual anti-tangle system prevents hair clogs.</p>',
    variants: [variant({ price: '249.99' })],
  });
  const outlet = product({ title: 'Smart Outlet', product_type: 'Smart Home', variants: [variant({ price: '19.99', available: false })] });
  const loaded = staticCatalog(store, [stick, robot, outlet]);

  it('keeps a stick vacuum the store filed under "Robot Vacuums" out of a robot search, and back in a stick search', async () => {
    const { catalog: c, index: i } = await loaded.load();
    const out = search(c, i, { need: 'robot vacuum for a home with a cat', maxPrice: 300 });
    expect(out.hits.map((h) => h.item.title)).toEqual(['Q5 Robot Vacuum and Mop with 8,000 Pa Suction']);
    expect(search(c, i, { need: 'cordless stick vacuum' }).hits.map((h) => h.item.title)).toEqual(['H9 Cordless Stick Vacuum Cleaner']);
    expect(out.hits[0].why).toContain('Anti-tangle brush');
  });

  it('does not let one filler word ("home") qualify an unrelated product', async () => {
    const { catalog: c, index: i } = await loaded.load();
    const out = search(c, i, { need: 'a quiet blender for my home kitchen' });
    expect(out).toMatchObject({ hits: [], outOfStock: 0 });
  });
});
