import { describe, expect, it } from 'vitest';
import { route, parseBudget } from '../src/router';

const vac = [
  { id: 'q7', title: 'Roborock Q7 L5 Robot Vacuum and Mop', price: 199.99 },
  { id: 'm5', title: 'Roborock Q7 M5+ (Certified Refurbished)', price: 259.99 },
  { id: 'q10', title: 'Roborock Q10 S5+ with Auto-Empty Dock', price: 279.99 },
];
const empty = { products: [] };
const onScreen = { products: vac };

describe('fallback router', () => {
  it.each([
    ['Alexa, find a robot vacuum under $300, I have a cat', empty, 'find_products', { max_price: 300 }],
    ['find a wireless charger for my iPhone 15', empty, 'find_products', {}],
    ['compare them', onScreen, 'compare_products', { ids: ['q7', 'm5', 'q10'] }],
    ['order the third one', onScreen, 'prepare_order', { items: [{ id: 'q10', qty: 1 }] }],
    ['buy the cheapest', onScreen, 'prepare_order', { items: [{ id: 'q7', qty: 1 }] }],
    ['add the Q10 to my cart', onScreen, 'prepare_order', { items: [{ id: 'q10', qty: 1 }] }],
    ['confirm', { products: vac, token: 'T' }, 'place_order', { confirmation_token: 'T' }],
    ['yes, place the order', { products: [], token: 'T' }, 'place_order', { confirmation_token: 'T' }],
    ["where's my order?", empty, 'order_status', {}],
    ['will the second one work with my iPhone 15?', onScreen, 'check_compatibility', { product_id: 'm5', device: 'iPhone 15' }],
    ['I have an iPhone 15 and a cat', empty, 'remember_my_devices', { devices: ['iPhone 15'], home: { pets: ['cat'] } }],
    ['what devices do I have', empty, 'my_devices', {}],
    ['can I talk to a person', empty, 'talk_to_staff', {}],
  ])('%s', (u, s, tool, args) => {
    const r = route(u, s as any) as any;
    expect(r.tool).toBe(tool);
    expect(r.args).toMatchObject(args);
  });
  it('does not place an order without a pending token', () => {
    expect((route('confirm', onScreen) as any).tool).not.toBe('place_order');
  });
  it('"no" never orders', () => {
    expect(route('no, cancel', { products: vac, token: 'T' })).toEqual({ say: 'Okay, I will not order anything.' });
  });
  it.each([
    ['compare them', { products: vac, selected: ['q7', 'q10'] }, 'compare_products', { ids: ['q7', 'q10'] }],
    ['is there anything cheaper?', { products: vac, need: 'robot vacuum' }, 'find_products', { need: 'robot vacuum', max_price: 199.98 }],
    ['do you have a promo code?', empty, 'talk_to_staff', {}],
    ["what's the warranty on it", onScreen, 'talk_to_staff', {}],
    ['how much is shipping to Texas', empty, 'talk_to_staff', {}],
    ['can I return it if my cat hates it', onScreen, 'talk_to_staff', {}],
    ['cancel my order', empty, 'talk_to_staff', {}],
    ['can you deliver it by Friday?', onScreen, 'talk_to_staff', {}],
    ['when will my vacuum arrive?', empty, 'order_status', {}],
    ['order the same as last time', empty, 'order_status', {}],
    ['order it again', onScreen, 'prepare_order', { items: [{ id: 'q7', qty: 1 }] }],
  ])('quality round: %s', (u, s, tool, args) => {
    const r = route(u, s as any) as any;
    expect(r.tool).toBe(tool);
    expect(r.args).toMatchObject(args);
  });
  it('"cancel my order" never places or claims a cancellation, "maybe later" never orders', () => {
    expect((route('cancel my order', { products: vac, token: 'T' }) as any).tool).toBeUndefined();
    expect(route('hmm, maybe later', { products: vac, token: 'T' })).toEqual({ say: 'Okay, I will not order anything.' });
  });
  it('compare with nothing on screen asks for a search first', () => {
    expect((route('compare them', empty) as any).say).toMatch(/find/);
  });
  it('budget parsing', () => {
    expect(parseBudget('under $1,200')).toBe(1200);
    expect(parseBudget('something for 60 dollars')).toBeUndefined();
    expect(parseBudget('about $60')).toBe(60);
  });
});
