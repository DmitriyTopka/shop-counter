import { describe, expect, it } from 'vitest';
import { deviceMatch, devicesInText, findDevices, parseDevice } from '../src/devices.js';
import { extractDeviceEvidence, extractFeatures, findLiteral, highlightsFrom } from '../src/extract.js';
import { htmlToText } from '../src/text.js';

const names = (t: string) => findDevices(t).map((m) => m.device.name);
const src = (title: string, html = '', tags: string[] = [], options: string[] = []) => ({ title, description: htmlToText(html), tags, options });

describe('device dictionary', () => {
  it('reads iPhone models with suffixes and slash lists', () => {
    expect(names('Works with iPhone 15 Pro Max and iPhone 12/13')).toEqual(['iPhone 15 Pro Max', 'iPhone 12', 'iPhone 13']);
    expect(names('iphone 17')).toEqual(['iPhone 17']);
    expect(names('iPhone XS, iPhone SE and iPhone Air')).toEqual(['iPhone XS', 'iPhone SE', 'iPhone Air']);
  });

  it('does not invent models from wattage or glued words', () => {
    expect(names('iPhone 15W charging')).toEqual(['iPhone']);
    expect(names('iphoneipad iphoneessentials')).toEqual([]);
    expect(names('4K at 60Hz, 3840 pixels wide, Pixel-perfect')).toEqual([]);
  });

  it('reads Macs, iPads, Samsung, Google and Microsoft', () => {
    expect(names('MacBook Air M2, MacBook Pro 16" M3 Max, Mac Mini, iMac Pro, iPad Pro M4')).toEqual([
      'MacBook Air M2', 'MacBook Pro M3 Max', 'Mac mini', 'iMac Pro', 'iPad Pro M4',
    ]);
    expect(names('Samsung Galaxy S24 Ultra, Galaxy Z Fold5, Galaxy S23+')).toEqual(['Galaxy S24 Ultra', 'Galaxy Z Fold5', 'Galaxy S23+']);
    expect(names('Google Pixel 8 Pro and Pixel 8a, Surface Pro')).toEqual(['Pixel 8 Pro', 'Pixel 8a', 'Surface Pro']);
  });

  it('knows ports only where it is sure', () => {
    expect(parseDevice('my iPhone 14').port).toBe('Lightning');
    expect(parseDevice('my iPhone 15 Pro').port).toBe('USB-C');
    expect(parseDevice('iPhone').port).toBeNull();
    expect(parseDevice('Kindle Paperwhite')).toMatchObject({ known: false, name: 'Kindle Paperwhite' });
  });

  it('matches exact, series and family, never a bare generic name', () => {
    const p15 = parseDevice('iPhone 15 Pro');
    expect(deviceMatch(p15, parseDevice('iPhone 15'))).toBe('series');
    expect(deviceMatch(p15, parseDevice('iPhone 15 Pro'))).toBe('exact');
    expect(deviceMatch(p15, parseDevice('iPhone'))).toBeNull();
    expect(deviceMatch(parseDevice('iPhone 15'), parseDevice('iPhone 15 Pro'))).toBeNull();
    expect(deviceMatch(parseDevice('MacBook Air M3'), parseDevice('MacBook Air'))).toBe('family');
    expect(deviceMatch(parseDevice('MacBook Air'), parseDevice('MacBook Air M2'))).toBeNull();
    expect(deviceMatch(parseDevice('Mac'), parseDevice('Mac'))).toBeNull();
  });

  it('pulls devices out of a shopper sentence', () => {
    expect(devicesInText('charger for my iPhone 15 and MacBook Air').map((d) => d.name)).toEqual(['iPhone 15', 'MacBook Air']);
  });
});

describe('feature extraction', () => {
  it('takes wattage from the title first', () => {
    expect(extractFeatures(src('ChargeView 140W Desktop Charger', '<p>Up to 100W per port</p>')).watts).toBe(140);
    expect(extractFeatures(src('3-in-1 Stand with Qi2 25W')).watts).toBe(25);
  });

  it('ignores the "1 5 W" span glitch and reads body wattage only in explicit phrasing', () => {
    const f = extractFeatures(src('2-in-1 Qi2 Stand', '<p>deliver 1<span>5</span> W of power to your iPhone</p>'));
    expect(f.watts).toBeNull();
    expect(extractFeatures(src('Power Bank', '<p>delivers 15W fast charging</p>')).watts).toBe(15);
    expect(extractFeatures(src('Hub', '<p>Charge with 60W total output.</p>')).watts).toBe(60);
    expect(extractFeatures(src('Hub', '<p>Model 2024W edition</p>')).watts).toBeNull();
  });

  it('counts ports in words and digits, and marks pass-through', () => {
    const a = extractFeatures(src('Desk Charger', '<p>With six USB-C ports and 240W total output</p>'));
    expect(a.usbCPorts).toBe(6);
    const b = extractFeatures(src('100W GaN Charger', '<p>dual USB-C PD ports and a USB-A port</p>'));
    expect([b.usbCPorts, b.watts, b.gan]).toEqual([2, 100, true]);
    expect(extractFeatures(src('145W USB-C 4-Port GaN Travel Charger')).totalPorts).toBe(4);
    const hub = extractFeatures(src('USB-C Hub with 100W Pass-Through Charging'));
    expect(hub.passThrough).toBe(true);
    expect(highlightsFrom(hub)[0]).toBe('100W pass-through charging');
  });

  it('reads wireless standards from text, not from merchandising tags', () => {
    const f = extractFeatures(src('USB-C to USB-C Cable', '', ['magsafe charger']));
    expect(f.wireless).toEqual([]);
    expect(extractFeatures(src('Trio Pad', '<p>powers a Qi-enabled smartphone</p>')).wireless).toEqual(['Qi']);
    expect(extractFeatures(src('Qi2 Car Charger')).wireless).toEqual(['Qi2']);
  });

  it('reads vacuum facts', () => {
    const f = extractFeatures(src('Q7 Robot Vacuum and Mop (8,000 Pa)', '<p>Dual anti-tangle system prevents hair clogs. Auto-empty dock.</p>'));
    expect(f.suctionPa).toBe(8000);
    expect(highlightsFrom(f)).toEqual(['8,000 Pa suction', 'Anti-tangle brush', 'Auto-empty dock', 'Vacuum and mop']);
  });
});

describe('device evidence', () => {
  it('takes whole device tags, keeps the literal tag as the quote, drops label tags', () => {
    const ev = extractDeviceEvidence(src('Desk Charger', '', ['iPhone 15', 'Device: iPad Pro', 'MacBook Air Gold', 'iphone essentials collection', 'magsafe charger']));
    expect(ev.map((e) => [e.device.name, e.quote])).toEqual([
      ['iPhone 15', 'iPhone 15'],
      ['iPad Pro', 'Device: iPad Pro'],
      ['MacBook Air', 'MacBook Air Gold'],
      ['iPhone', 'iphone essentials collection'],
    ]);
  });

  it('uses descriptions only inside a compatibility phrase, with a literal quote', () => {
    const s = src('Hub', '<p>Designed for MacBook Pro and iPad Pro M4.</p><p>Pairs naturally with Galaxy S24 Ultra.</p>');
    const ev = extractDeviceEvidence(s);
    expect(ev.map((e) => e.device.name)).toEqual(['MacBook Pro', 'iPad Pro M4']);
    for (const e of ev) expect(s.description).toContain(e.quote);
  });

  it('finds unknown devices literally and only in compatibility context in descriptions', () => {
    const s = src('Stand', '<p>Fits your Kindle Paperwhite.</p>', ['Steam Deck']);
    expect(findLiteral(s, 'Steam Deck')).toEqual({ source: 'tags', quote: 'Steam Deck' });
    expect(findLiteral(s, 'kindle paperwhite')?.source).toBe('description');
    expect(findLiteral(s, 'Kobo')).toBeNull();
  });
});
