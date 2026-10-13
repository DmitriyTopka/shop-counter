/** End-to-end through a real MCP client over an in-memory transport, on synthetic data. */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { staticCatalog } from '../src/catalog.js';
import { createShelfServer, DEFAULT_VIEW_URI } from '../src/server.js';
import { ShelfService } from '../src/service.js';
import { MemoryStateStore } from '../src/state.js';
import { signOrderToken } from '../src/token.js';
import type { StructuredResult } from '../src/types.js';
import { ALL, desk140, lightningCable, qi2Stand, soldOut, STORE, vid } from './fixtures.js';

const SECRET = 'unit-secret';
const tickets: string[] = [];
const state = new MemoryStateStore();
const service = new ShelfService({
  catalog: staticCatalog(STORE, ALL),
  state,
  secret: SECRET,
  notify: ({ ticket }) => { tickets.push(ticket.ticket_id); },
  log: () => {},
});

async function session(userId?: string) {
  const server = createShelfServer({ service, log: () => {} }, { userId });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0].text;
    return { text, sc: r.structuredContent as unknown as StructuredResult & Record<string, any>, isError: r.isError === true };
  };
  return { client, call };
}

const SPOKEN_OK = (t: string) => !/https?:|\bSKU-|\.com\b/.test(t) && t.split(/(?<=[.?!])\s/).length <= 2;

describe('MCP server', () => {
  it('lists every contract tool, with the UI resource on the screen tools', async () => {
    const { client } = await session('u1');
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'check_compatibility', 'compare_products', 'find_products', 'my_devices', 'order_status', 'place_order',
      'prepare_order', 'remember_my_devices', 'talk_to_staff',
    ]);
    for (const n of ['find_products', 'compare_products', 'check_compatibility', 'remember_my_devices', 'my_devices', 'prepare_order', 'place_order', 'order_status']) {
      expect((byName[n]._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).toBe(DEFAULT_VIEW_URI);
    }
    expect(byName.talk_to_staff._meta?.ui).toBeUndefined();
    const res = await client.readResource({ uri: DEFAULT_VIEW_URI });
    expect(res.contents[0].mimeType).toBe('text/html;profile=mcp-app');
  });

  it('runs the shopper journey: closet -> find -> compare -> compat -> order -> status in a new session', async () => {
    const s1 = await session('alice');
    const closet = await s1.call('remember_my_devices', { devices: ['my iPhone 15', 'MacBook Air M2'], home: { pets: ['cat'] } });
    expect(closet.sc).toMatchObject({ kind: 'closet', devices: ['iPhone 15', 'MacBook Air M2'], home: { pets: ['cat'] } });

    const found = await s1.call('find_products', { need: 'a charger', max_price: 120 });
    expect(found.sc.kind).toBe('products');
    expect(found.sc.for_devices).toEqual(['iPhone 15', 'MacBook Air M2']);
    expect(found.sc.products[0].id).toBe(vid(desk140, 0));
    // The tag says "MacBook Air", not "MacBook Air M2": only the iPhone 15 is listed by its exact model.
    expect(found.text).toBe('I found 3 options. The best fit is the PowerDesk 140W Desktop Charger at $99.99, and the store lists it for your iPhone 15.');

    const ids = found.sc.products.slice(0, 2).map((p: { id: string }) => p.id);
    const cmp = await s1.call('compare_products', { ids });
    expect(cmp.sc.kind).toBe('compare');
    expect(cmp.sc.rows.map((r: { label: string }) => r.label)).toContain('Listed for your devices');
    expect(SPOKEN_OK(cmp.text)).toBe(true);

    const compat = await s1.call('check_compatibility', { product_id: vid(desk140, 0) });
    expect(compat.sc).toMatchObject({ kind: 'compat', device: 'iPhone 15', status: 'confirmed', evidence: { source: 'tags', quote: 'iPhone 15' } });
    expect(compat.sc.also).toEqual([{ device: 'MacBook Air M2', status: 'family_only', evidence: { source: 'tags', quote: 'MacBook Air' } }]);

    const prev = await s1.call('prepare_order', { items: [{ id: vid(desk140, 0), qty: 2 }] });
    expect(prev.sc).toMatchObject({ kind: 'order_preview', subtotal: 199.98, shipping: null, total: 199.98 });
    expect(prev.text).toBe("That's 2 of the PowerDesk 140W Desktop Charger, $199.98 before shipping and tax. Should I place the order?");

    const placed = await s1.call('place_order', { confirmation_token: prev.sc.confirmation_token });
    expect(placed.sc.kind).toBe('order');
    const orderId = placed.sc.order.id;

    const again = await s1.call('place_order', { confirmation_token: prev.sc.confirmation_token });
    expect(again.sc).toMatchObject({ kind: 'order', already_placed: true, order: { id: orderId } });

    const s2 = await session('alice'); // new connection, same shopper
    const st = await s2.call('order_status');
    expect(st.sc.orders.map((o: { id: string }) => o.id)).toEqual([orderId]);
    expect((await s2.call('my_devices')).sc.devices).toEqual(['iPhone 15', 'MacBook Air M2']);
    expect((await (await session('bob')).call('order_status')).sc.orders).toEqual([]);
  });

  it('refuses bad orders without placing anything', async () => {
    const s = await session('carol');
    expect((await s.call('prepare_order', { items: [{ id: vid(soldOut), qty: 1 }] })).sc).toMatchObject({ kind: 'error', code: 'out_of_stock' });
    expect((await s.call('prepare_order', { items: [{ id: '999', qty: 1 }] })).sc).toMatchObject({ code: 'not_found' });
    expect((await s.call('prepare_order', { items: [{ id: vid(qi2Stand, 1), qty: 0 }] })).sc).toMatchObject({ code: 'invalid_input' });
    const expired = signOrderToken({ v: 1, u: 'carol', s: 'acme', i: [[vid(qi2Stand, 1), 1]], t: 7999, e: Date.now() - 1000, n: 'x' }, SECRET);
    expect((await s.call('place_order', { confirmation_token: expired })).sc).toMatchObject({ code: 'token_expired' });
    expect((await s.call('place_order', { confirmation_token: 'garbage.token' })).sc).toMatchObject({ code: 'token_invalid' });
    const other = signOrderToken({ v: 1, u: 'dave', s: 'acme', i: [[vid(qi2Stand, 1), 1]], t: 7999, e: Date.now() + 60_000, n: 'y' }, SECRET);
    expect((await s.call('place_order', { confirmation_token: other })).sc).toMatchObject({ code: 'token_wrong_user' });
    const cheap = signOrderToken({ v: 1, u: 'carol', s: 'acme', i: [[vid(qi2Stand, 1), 1]], t: 100, e: Date.now() + 60_000, n: 'z' }, SECRET);
    expect((await s.call('place_order', { confirmation_token: cheap })).sc).toMatchObject({ code: 'price_changed' });
    expect((await s.call('order_status')).sc.orders).toEqual([]);
  });

  it('answers every error in the contract shape with isError', async () => {
    const anon = await session(undefined);
    for (const [name, args] of [
      ['my_devices', {}], ['prepare_order', { items: [{ id: vid(desk140), qty: 1 }] }], ['order_status', {}],
    ] as const) {
      const r = await anon.call(name, args);
      expect(r).toMatchObject({ isError: true, sc: { kind: 'error', code: 'anonymous' } });
      expect(SPOKEN_OK(r.text)).toBe(true);
    }
    const s = await session('erin');
    expect((await s.call('compare_products', { ids: [vid(desk140)] })).sc).toMatchObject({ code: 'invalid_input' });
    expect((await s.call('check_compatibility', { product_id: vid(desk140) })).sc).toMatchObject({ code: 'device_required' });
    expect((await s.call('check_compatibility', { product_id: 'nope', device: 'iPhone 15' })).sc).toMatchObject({ code: 'not_found' });
    expect((await s.call('order_status', { order_id: 'SC-NOPE' })).sc).toMatchObject({ code: 'not_found' });
  });

  it('suggests listed alternatives when compatibility is not confirmed', async () => {
    const s = await session('frank');
    const r = await s.call('check_compatibility', { product_id: vid(qi2Stand, 1), device: 'MacBook Air' });
    expect(r.sc.status).toBe('not_listed');
    expect(r.text).toMatch(/^I can't confirm that: the store doesn't list the MacBook Air for the 2-in-1 Foldable Qi2 Wireless Charging Stand\./);
  });

  it('answers from the closet without a named model, and tips one listed accessory', async () => {
    const s = await session('hana');
    const saved = await s.call('remember_my_devices', { devices: ['iPhone 15'] });
    // Cheapest in-stock item the store lists for the iPhone 15 (exact tag), with the store's own quote.
    expect(saved.sc.suggestion).toMatchObject({ device: 'iPhone 15', evidence: { source: 'tags', quote: 'iPhone 15' } });
    expect(saved.sc.suggestion.product.available).toBe(true);
    expect(saved.text).toMatch(/^Got it, I'll remember your iPhone 15\. Acme lists the .+ for your iPhone 15, at \$\d+\.\d\d\.$/);
    expect(SPOKEN_OK(saved.text)).toBe(true);
    expect((await s.call('remember_my_devices', { devices: ['a phone'] })).sc.devices).toEqual(['iPhone 15']); // a kind, not a model
    // "my phone" is not a model: the closet answers
    expect((await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'my phone' })).sc).toMatchObject({ device: 'iPhone 15', device_source: 'closet' });
    const yes = await s.call('check_compatibility', { product_id: vid(desk140, 0) });
    expect(yes.sc).toMatchObject({ status: 'confirmed', device: 'iPhone 15', device_source: 'closet', evidence: { quote: 'iPhone 15' } });
    expect(yes.text).toBe('The store lists your iPhone 15 for the PowerDesk 140W Desktop Charger.');
    const no = await s.call('check_compatibility', { product_id: vid(lightningCable) });
    expect(no.sc.status).toBe('incompatible');
    expect(no.sc.alternatives.length).toBeGreaterThan(0);
    expect(no.text).toMatch(/^No, that won't work: .+\. The .+ is listed for it, at \$/);
    expect(SPOKEN_OK(no.text)).toBe(true);
  });

  it('says "the store lists iPhone 15, not your iPhone 15 Pro" instead of "it works"', async () => {
    const s = await session('ivan');
    await s.call('remember_my_devices', { devices: ['iPhone 15 Pro'] });
    const r = await s.call('check_compatibility', { product_id: vid(desk140, 0) });
    expect(r.sc).toMatchObject({ status: 'family_only', device: 'iPhone 15 Pro', device_source: 'closet', evidence: { quote: 'iPhone 15' } });
    expect(r.text).toBe('The store lists iPhone 15, not your iPhone 15 Pro specifically.');
    const found = await s.call('find_products', { need: 'a charger' });
    expect(found.text).not.toMatch(/lists it for your iPhone 15 Pro/);
    expect(found.text).toMatch(/not your iPhone 15 Pro specifically/);
  });

  it('keeps the closet device as said and checks it exactly', async () => {
    const s = await session('judy');
    const saved = await s.call('remember_my_devices', { devices: ['MacBook Pro 2017 Intel', 'iphone 15'] });
    expect(saved.sc.devices).toEqual(['MacBook Pro 2017 Intel', 'iPhone 15']);
    expect(saved.sc.items).toEqual([{ name: 'MacBook Pro 2017 Intel', kind: 'laptop' }, { name: 'iPhone 15', kind: 'phone' }]);
    const r = await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'my laptop' });
    expect(r.sc).toMatchObject({ status: 'family_only', device: 'MacBook Pro 2017 Intel' });
    expect(r.text).toBe('The store lists MacBook Pro, not your MacBook Pro 2017 Intel specifically.');
    // Forgetting works with the model's own spelling too.
    expect((await s.call('remember_my_devices', { forget: ['iPhone 15'] })).sc.devices).toEqual(['MacBook Pro 2017 Intel']);
  });

  it('asks which phone when "my phone" fits two remembered phones', async () => {
    const s = await session('kate');
    await s.call('remember_my_devices', { devices: ['iPhone 15', 'Galaxy S24', 'MacBook Air M2'] });
    const r = await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'my phone' });
    expect(r.isError).toBe(true);
    expect(r.sc).toMatchObject({ kind: 'error', code: 'device_ambiguous', options: ['iPhone 15', 'Galaxy S24'] });
    expect(r.text).toBe('Which phone should I check: your iPhone 15 or Galaxy S24?');
    // "my laptop" has one match: no question.
    expect((await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'my laptop' })).sc).toMatchObject({ device: 'MacBook Air M2', device_source: 'closet' });
    // No robot on file: ask for it, do not answer about the phone.
    expect((await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'my robot' })).sc).toMatchObject({ code: 'device_required' });
  });

  it('a device named in the request beats the closet', async () => {
    const s = await session('liam');
    await s.call('remember_my_devices', { devices: ['iPhone 15'] });
    const found = await s.call('find_products', { need: 'a charger for my Pixel' });
    expect(found.sc.for_devices).toEqual(['Pixel']);
    expect(found.text).not.toMatch(/iPhone/);
    expect(found.text).toMatch(/Which Pixel model do you have/);
    const c = await s.call('check_compatibility', { product_id: vid(desk140, 0), device: 'Galaxy S24' });
    expect(c.sc).toMatchObject({ device: 'Galaxy S24', device_source: 'said', status: 'not_listed' });
  });

  it('does not read pets out loud on my_devices', async () => {
    const s = await session('mia');
    await s.call('remember_my_devices', { devices: ['Kindle Paperwhite'], home: { pets: ['cat'] } });
    const r = await s.call('my_devices');
    expect(r.sc.home).toMatchObject({ pets: ['cat'] });
    expect(r.text).toBe('You have Kindle Paperwhite.');
  });

  it('hands off to staff and notifies', async () => {
    const s = await session('gina');
    const r = await s.call('talk_to_staff', { reason: 'Warranty question about my order' });
    expect(r.sc.kind).toBe('handoff');
    expect(tickets).toContain(r.sc.ticket_id);
    expect(r.text).toMatch(/^I've passed this to the Acme team\. Your ticket is T-[0-9A-F]{6}\.$/);
  });
});
