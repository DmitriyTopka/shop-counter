/** Synthetic Shopify products. Shapes follow products.json; names and numbers are invented for tests. */
import type { ShopifyProduct, ShopifyVariant } from '../src/shopify.js';
import type { StoreConfig } from '../src/types.js';

export const STORE: StoreConfig = { id: 'acme', name: 'Acme', url: 'https://acme.example', currency: 'USD', region: 'US', shipping: null };

let nextId = 1000;
export function variant(p: Partial<ShopifyVariant> & { price: string }): ShopifyVariant {
  const id = nextId++;
  return {
    id, title: 'Default Title', option1: 'Default Title', option2: null, option3: null, sku: `SKU-${id}`,
    available: true, compare_at_price: null, featured_image: null, ...p,
  };
}

export function product(p: Partial<ShopifyProduct> & { title: string; variants: ShopifyVariant[] }): ShopifyProduct {
  const id = nextId++;
  return {
    id, handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), body_html: '', vendor: 'Acme', product_type: '',
    tags: [], options: [{ name: 'Title', position: 1, values: ['Default Title'] }], images: [{ src: `https://cdn.example/${id}.png` }], ...p,
  };
}

export const desk140 = product({
  title: 'PowerDesk™ 140W Desktop Charger',
  product_type: 'Charging Stations',
  body_html: '<p>Charge your laptop and phone at once. With <b>four USB-C ports</b>, 140W total output and an LCD that shows per-port wattage.</p>',
  tags: ['iPhone', 'iPhone 15', 'iPhone 16', 'MacBook Air', 'MacBook Pro', 'magsafe charger', 'Charger', 'Device: iPad Pro'],
  options: [{ name: 'Plug', position: 1, values: ['US', 'EU'] }],
  variants: [
    variant({ title: 'US', option1: 'US', price: '99.99', compare_at_price: '119.99' }),
    variant({ title: 'EU', option1: 'EU', price: '99.99', available: false }),
  ],
});

export const wall240 = product({
  title: '240W Desktop Charger',
  product_type: 'Wall Chargers',
  body_html: '<p>Six USB-C ports and 240W total output.</p>',
  tags: ['iPhone 15', 'MacBook Air', 'MacBook Pro', 'Charger'],
  options: [{ name: 'Plug', position: 1, values: ['US', 'UK'] }],
  variants: [
    variant({ title: 'US', option1: 'US', price: '149.99', available: false }),
    variant({ title: 'UK', option1: 'UK', price: '149.99', available: true }),
  ],
});

export const gan100 = product({
  title: '100W USB-C PD Compact GaN Charger',
  product_type: 'Wall Chargers',
  body_html: '<p>Equipped with dual USB-C PD ports and a USB-A port, the charger consolidates three adapters.</p>',
  tags: ['MacBook Pro', 'iPhone 15', 'Charger'],
  variants: [variant({ price: '64.99' })],
});

export const qi2Stand = product({
  title: '2-in-1 Foldable Qi2 Wireless Charging Stand',
  product_type: 'Wireless Chargers',
  // Shopify span glitch: "1 5 W" must not become 5 W or 15 W.
  body_html: '<p>It can simultaneously deliver 1<span>5</span> W of power to your iPhone and 5W of power to your AirPods.</p>',
  tags: ['iPhone 12', 'iPhone 13', 'iPhone 15', 'iPhone 16', 'magsafe charger', 'iphoneipad'],
  options: [{ name: 'Color', position: 1, values: ['Black', 'Sand'] }],
  variants: [
    variant({ title: 'Black', option1: 'Black', price: '79.99', available: false }),
    variant({ title: 'Sand', option1: 'Sand', price: '79.99', available: true }),
  ],
});

export const lightningCable = product({
  title: 'USB-C to Lightning Cable - 10 Inches',
  product_type: 'Cables',
  body_html: '<p>Charge and sync your iPhone.</p>',
  tags: ['iPhone', 'iPhone 11', 'iPhone 12', 'iPhone 13', 'magsafe charger'],
  variants: [variant({ price: '19.99' })],
});

export const ccCable = product({
  title: 'USB-C to USB-C Charging Cable (1m)',
  product_type: 'Cables',
  body_html: '<p>Supports up to 100W charging.</p>',
  tags: ['iPhone 15', 'MacBook Air'],
  variants: [variant({ price: '24.99' })],
});

export const hub = product({
  title: 'USB-C Hub with 100W Pass-Through Charging',
  product_type: 'Multi-Ports ## Hubs',
  body_html: '<p>Designed for MacBook Pro and iPad Pro M4. Includes 4K HDMI and 3 USB-A ports.</p><p>Pairs naturally with Galaxy S24 Ultra.</p>',
  tags: ['Hub', 'USB-C'],
  variants: [variant({ price: '59.99' })],
});

export const soldOut = product({
  title: 'Magnetic Power Bank 10K',
  product_type: 'Wireless Chargers',
  body_html: '<p>10,000mAh battery that delivers 15W fast charging to your iPhone 15.</p>',
  tags: ['iPhone 15', 'Charger'],
  variants: [variant({ price: '89.99', available: false })],
});

export const phoneCase = product({
  title: 'Slim Case',
  product_type: 'Case',
  tags: ['iPhone 15'],
  variants: [variant({ price: '29.99' })],
});

export const chargerDock = product({
  title: 'Aluminum Dock for MagSafe Charger',
  product_type: 'Wireless Chargers',
  body_html: '<p>Designed to fit the MagSafe charger (not included).</p>',
  tags: ['iPhone 15'],
  variants: [variant({ price: '17.99' })],
});

export const ALL = [chargerDock, desk140, wall240, gan100, qi2Stand, lightningCable, ccCable, hub, soldOut, phoneCase];

export const vid = (p: ShopifyProduct, i = 0) => String(p.variants[i].id);
