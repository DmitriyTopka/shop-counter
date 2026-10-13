import type { StoreConfig } from 'shelf-to-alexa';

/**
 * Stores served by Shop Counter. The first one is served at /mcp, every store at /stores/<id>/mcp.
 * Data comes from each storefront's public products.json; currency is configured because the feed
 * does not carry it (verified USD via /cart.js during catalog research, 2026-10-12).
 * Shipping is null: we do not know the stores' shipping policies, so we never quote shipping.
 */
export const STORES: StoreConfig[] = [
  {
    id: 'satechi',
    name: 'Satechi',
    url: 'https://satechi.net',
    currency: 'USD',
    region: 'US',
    shipping: null,
    demo_delivery_days: 4,
  },
  {
    id: 'roborock',
    name: 'Roborock',
    url: 'https://us.roborock.com',
    currency: 'USD',
    region: 'US',
    shipping: null,
    demo_delivery_days: 5,
  },
];
