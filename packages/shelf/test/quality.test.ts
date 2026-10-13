/** Quality round 1: traps found by the shopper eval (evals/shopper_cases.json), pinned as unit tests. */
import { describe, expect, it } from 'vitest';
import { staticCatalog } from '../src/catalog.js';
import { checkCompat } from '../src/compat.js';
import { parseDevice } from '../src/devices.js';
import { classifyItem } from '../src/extract.js';
import { sizedImage } from '../src/normalize.js';
import { correctTypos, search } from '../src/search.js';
import { MemoryStateStore } from '../src/state.js';
import { ShelfService } from '../src/service.js';
import { product, STORE, variant } from './fixtures.js';

const VAC = { ...STORE, id: 'vac', name: 'VacCo' };
const robot = product({ title: 'VacCo Q7 Robot Vacuum and Mop', product_type: 'Robot Vacuums', variants: [variant({ price: '259.99' })] });
const wetDry = product({ title: 'VacCo F25 Wet & Dry Vacuum with Robotic Arm', product_type: 'Robot Vacuums', variants: [variant({ price: '169.99' })] });
const plan = product({ title: 'Q7 Robot 1 Year', product_type: 'Warranty', variants: [variant({ price: '34.00' })] });
const tradeIn = product({ title: 'VacCo Q7 Robot Vacuum-trade in', product_type: 'Trade-in Vacuum', variants: [variant({ price: '199.00' })] });
const fluid = product({ title: 'Cleaning Solution for Robot Vacuums', product_type: 'Accessories', variants: [variant({ price: '14.99' })] });
const brush = product({ title: 'Main Brush for Q7, S9 MaxV Ultra', product_type: 'Accessories', variants: [variant({ price: '19.99' })] });
const pack = product({ title: 'Accessories Pack for Saros 10 (Not compatible with Saros 10R )', product_type: 'Accessories', variants: [variant({ price: '99.00' })] });
const vac = await staticCatalog(VAC, [robot, wetDry, plan, tradeIn, fluid, brush, pack]).load();
const find = (need: string, maxPrice?: number) => search(vac.catalog, vac.index, { need: correctTypos(need, vac.index).text, maxPrice });

describe('what a product is comes from its name, not the store collection', () => {
  it('classifies form and offer', () => {
    const k = (p: typeof robot) => classifyItem({ title: p.title, description: '', tags: [], options: [] }, [p.product_type]);
    expect(k(robot)).toEqual({ form: 'robot vacuum', offer: 'standard' });
    expect(k(wetDry).form).toBe('wet-dry vacuum'); // "Robotic Arm" does not make it a robot
    expect(k(plan).offer).toBe('protection_plan');
    expect(k(tradeIn).offer).toBe('trade_in');
    expect(k(fluid).form).toBeNull(); // "... for Robot Vacuums" is an accessory
  });

  it('a robot search skips wet-dry vacuums, warranty plans, trade-ins and accessories for robots', () => {
    expect(find('robot vacuum').hits.map((h) => h.item.title)).toEqual(['VacCo Q7 Robot Vacuum and Mop']);
    const cheap = find('robot vacuum', 50);
    expect(cheap.hits).toEqual([]);
    expect(cheap.overBudget.cheapest).toBe(259.99);
  });

  it('protection plans and trade-ins appear only when asked for', () => {
    expect(find('extended warranty for Q7').hits[0].item.title).toBe('Q7 Robot 1 Year');
    expect(find('Q7 robot trade in').hits.map((h) => h.item.title)).toContain('VacCo Q7 Robot Vacuum-trade in');
  });
});

describe('names the shopper says that the store does not sell', () => {
  it('a model that only appears in accessory names is reported missing, not offered as a brush', () => {
    const out = find('S9 MaxV Ultra');
    expect(out.hits).toEqual([]);
    expect(out.missing).toEqual(['S9']);
  });

  it('competitor brands are reported, the rest of the need still searches', () => {
    const out = find('Dyson robot vacuum');
    expect(out.missing).toEqual(['Dyson']);
    expect(out.hits[0].item.title).toBe('VacCo Q7 Robot Vacuum and Mop');
  });

  it('typos are fixed against the catalog vocabulary only', () => {
    expect(correctTypos('robot vacum', vac.index).text).toBe('robot vacuum');
    expect(correctTypos('chargr for my macbok', vac.index).text).toContain('macbook');
    expect(correctTypos('Dyson', vac.index).text).toBe('Dyson'); // brands are never "corrected" into our words
  });

  it('speaks the gap first, then the closest real option', async () => {
    const svc = new ShelfService({ catalog: staticCatalog(VAC, [robot, wetDry, plan, brush]), state: new MemoryStateStore(), secret: 's', log: () => {} });
    const r = await svc.findProducts('u', { need: 'Dyson robot vacuum' });
    expect(r.text).toBe("I don't see Dyson for sale at VacCo. The closest match is the VacCo Q7 Robot Vacuum and Mop at $259.99.");
    const s9 = await svc.findProducts('u', { need: 'Roborock S9 MaxV Ultra' });
    expect(s9.text).toMatch(/^I don't see S9 for sale at VacCo\./);
  });
});

describe('compatibility: the store saying "no" is a no', () => {
  const item = vac.catalog.items.find((i) => i.title.startsWith('Accessories Pack'))!;
  it('"Not compatible with Saros 10R" -> incompatible with that quote', () => {
    const v = checkCompat(item, parseDevice('Saros 10R'));
    expect(v.status).toBe('incompatible');
    expect(v.evidence?.quote).toContain('Not compatible with Saros 10R');
  });
  it('a merchandising tag is not a listing', async () => {
    const cable = product({ title: 'USB-C to USB-C Cable', tags: ['magsafe charger', 'MagSafe Duo'], variants: [variant({ price: '8.99' })] });
    const c = await staticCatalog(STORE, [cable]).load();
    expect(checkCompat(c.catalog.items[0], parseDevice('MagSafe')).status).toBe('not_listed');
    expect(checkCompat(c.catalog.items[0], parseDevice('MagSafe Duo')).status).toBe('confirmed'); // the tag IS the device
  });
});

describe('card images', () => {
  it('asks the Shopify CDN for 600 px, leaves other hosts alone', () => {
    expect(sizedImage('https://cdn.shopify.com/s/files/1/1/files/a.png?v=17')).toBe('https://cdn.shopify.com/s/files/1/1/files/a.png?v=17&width=600');
    expect(sizedImage('https://shop.example/cdn/shop/files/a.png')).toBe('https://shop.example/cdn/shop/files/a.png?width=600');
    expect(sizedImage('https://img.example/a.png')).toBe('https://img.example/a.png');
    expect(sizedImage(null)).toBeNull();
  });
});

/*
 * Honesty round 2 (2026-10-13): Roborock has no compatibility tags, so robots outside the device
 * dictionary are matched against store text. Found on the live server: "for Qrevo only" read as a no,
 * "for Qrevo Curv" read as a yes for a plain Qrevo, "Upgraded from S8 MaxV Ultra" read as a yes.
 * Titles below are copied from the Roborock feed (cache 2026-10-12).
 */
const ROBO = { ...STORE, id: 'roborock', name: 'Roborock' };
const p = (title: string, product_type = 'Accessories', body_html = '') => product({ title, product_type, body_html, vendor: 'Roborock', variants: [variant({ price: '19.99' })] });
const items = [
  p('Roborock Washable Filter*2 pcs for Roborock Qrevo only (Incompatible with other models in the Qrevo series)'),
  p('Roborock Mop Cloth*4pcs for Qrevo Curv Series and Qrevo Edge Series (Not compatible with CurvX)'),
  p('Roborock Saros 10 Robot Vacuum with Dual Anti-tangle System (Upgraded from S8 MaxV Ultra)', 'Robot Vacuums'),
  p('Roborock Side Brushes Replacement for Qrevo Curv 2 Flow'),
  p('Roborock Washable Filter (x2) for Roborock S7/S8/S8+/S8 Pro Ultra/S7 Max Ultra'),
  p('Roborock Dust Bag*6pcs for S8 MaxV Ultra, S8 Max Ultra, Qrevo Series, Qrevo Curv Series, Qrevo Edge Series, Saros Series and QV Series'),
  p('Main Brush for Q7 M5 (replaces the Q5 brush)', 'Accessories', '<p>Designed for the Q7 Max, quieter than the Q5 Max.</p>'),
  p('Qrevo Curv 1 Year', 'Warranty'),
  p('QRevo 1 Year', 'Warranty'),
  p('Roborock Qrevo S', ''),
  p('Q7 Max+ Robot 1 Year', 'Warranty'),
  p('Roborock QV 35A Robot Vacuum with Multifunctional Dock (Upgraded from Qrevo S)', 'Robot Vacuums'),
];
const cat = await staticCatalog(ROBO, items).load();
const at = (start: string) => cat.catalog.items.find((i) => i.title.startsWith(start) || i.title === start)!;
const st = (start: string, device: string) => checkCompat(at(start), parseDevice(device)).status;

describe('compatibility by name for models outside the dictionary: meaning, not substring', () => {
  it('"for Qrevo only" is a yes for the Qrevo; "other models in the Qrevo series" is a no for those, not for the Qrevo', () => {
    const v = checkCompat(at('Roborock Washable Filter*2 pcs for Roborock Qrevo only'), parseDevice('Qrevo'));
    expect(v.status).toBe('confirmed');
    expect(v.evidence?.quote).toContain('Qrevo only');
    expect(st('Roborock Washable Filter*2 pcs for Roborock Qrevo only', 'Qrevo S')).toBe('incompatible');
    expect(st('Roborock Washable Filter*2 pcs for Roborock Qrevo only', 'Qrevo Curv')).toBe('incompatible');
  });

  it('a longer model is not the shorter one: "Qrevo Curv" is not a Qrevo, "Qrevo Curv 2 Flow" is not a Qrevo Curv, "S8 Pro Ultra" is not an S8 Max Ultra', () => {
    expect(st('Roborock Mop Cloth*4pcs for Qrevo Curv Series', 'Qrevo')).toBe('not_listed');
    expect(st('Roborock Side Brushes Replacement for Qrevo Curv 2 Flow', 'Qrevo Curv')).toBe('not_listed');
    expect(st('Roborock Side Brushes Replacement for Qrevo Curv 2 Flow', 'Qrevo Curv 2 Flow')).toBe('confirmed');
    expect(st('Roborock Washable Filter (x2)', 'S8')).toBe('confirmed');
    expect(st('Roborock Washable Filter (x2)', 'S8+')).toBe('confirmed');
    expect(st('Roborock Washable Filter (x2)', 'S8 Pro Ultra')).toBe('confirmed');
    expect(st('Roborock Washable Filter (x2)', 'S8 Max Ultra')).toBe('not_listed');
    expect(st('Qrevo Curv 1 Year', 'Qrevo')).toBe('not_listed');
    expect(st('QRevo 1 Year', 'Qrevo')).toBe('confirmed'); // "1 Year" is the plan term, not a model
  });

  it('"X Series" or "X+" is a family answer for another model in it, never a yes', () => {
    const v = checkCompat(at('Roborock Dust Bag'), parseDevice('Saros 10'));
    expect(v.status).toBe('family_only');
    expect(v.evidence?.quote).toContain('Saros Series');
    expect(st('Roborock Dust Bag', 'Qrevo S')).toBe('family_only');
    expect(st('Roborock Dust Bag', 'Qrevo Curv 2 Flow')).toBe('family_only');
    expect(st('Roborock Dust Bag', 'S8 MaxV Ultra')).toBe('confirmed');
    // A series named after the exact model includes that model.
    expect(st('Roborock Dust Bag', 'Qrevo')).toBe('confirmed');
    expect(st('Roborock Mop Cloth*4pcs for Qrevo Curv Series', 'Qrevo Curv')).toBe('confirmed');
    // "Q7 Max+" is the Q7 Max with a dock: the store names the edition, not the shopper's model.
    const plus = checkCompat(at('Q7 Max+ Robot 1 Year'), parseDevice('Q7 Max'));
    expect(plus.status).toBe('family_only');
    expect(plus.evidence?.quote).toBe('Q7 Max+');
  });

  it('"upgraded from", "replaces", "than" name another model, not a fit', () => {
    expect(st('Main Brush for Q7 M5', 'Q5')).toBe('not_listed');
    expect(st('Main Brush for Q7 M5', 'Q5 Max')).toBe('not_listed');
    expect(st('Main Brush for Q7 M5', 'Q7 M5')).toBe('confirmed');
    expect(st('Main Brush for Q7 M5', 'Q7 Max')).toBe('confirmed');
  });

  it('a robot is not an accessory: its title never lists another robot, nor itself', () => {
    const v = checkCompat(at('Roborock Saros 10 Robot Vacuum'), parseDevice('S8 MaxV Ultra'));
    expect(v.status).toBe('not_listed');
    expect(v.note).toMatch(/itself/);
    expect(st('Roborock Saros 10 Robot Vacuum', 'Saros 10')).toBe('not_listed');
    expect(st('Roborock QV 35A', 'Qrevo S')).toBe('not_listed');
    expect(st('Roborock Qrevo S', 'Qrevo S')).toBe('not_listed');
  });
});
