/**
 * Compatibility check: "confirmed" only when the store names this exact model (with a quote),
 * "family_only" when the store names only its series or family ("iPhone 17" for an iPhone 17 Pro),
 * "incompatible" only from the store's own "not compatible with X" or a hard connector rule,
 * everything else is "not_listed". We never guess.
 */
import { deviceLabel, deviceMatch, type DeviceInfo, type MatchLevel } from './devices.js';
import { findLiteral, findNegative, findSeries, type DeviceEvidence } from './extract.js';
import type { CatalogItem } from './normalize.js';
import { escapeRegExp } from './text.js';
import type { CompatStatus, Evidence } from './types.js';

export interface CompatVerdict {
  status: CompatStatus;
  evidence: Evidence | null;
  note: string;
  level: MatchLevel | 'literal' | null;
}

const SOURCE_RANK: Record<Evidence['source'], number> = { tags: 0, title: 1, options: 2, description: 3 };
const LEVEL_RANK: Record<MatchLevel, number> = { exact: 0, family: 1, series: 2 };

/** Products that need an exact physical fit: a series-level listing is not enough. */
const FIT_SPECIFIC = /\b(case|cover|screen protector|sleeve|skin|holster|folio)\b/i;

/**
 * The product is itself a device (a robot, a stick vacuum), not an accessory or a plan for one. A model named in
 * its title is the product itself or its predecessor ("Saros 10 ... (Upgraded from S8 MaxV Ultra)"), never a fit.
 */
function wholeDevice(item: CatalogItem): boolean {
  if (item.kind.offer !== 'standard') return false;
  if (item.kind.form) return true;
  return item.categories.some((c) => /\b(?:vacuums?|robots?)\b/i.test(c) && !/accessor|part|warrant|trade|point/i.test(c));
}

/** "Roborock Qrevo S" sold as the Qrevo S: the title is the brand plus the model and nothing else. */
function titleIsDevice(item: CatalogItem, device: DeviceInfo): boolean {
  const brand = new RegExp(`^${escapeRegExp(item.vendor)}\\s+`, 'i');
  return item.vendor.length > 0 && item.title.replace(brand, '').trim().toLowerCase() === device.name.trim().toLowerCase();
}

/** Device-side Lightning: "USB-C to Lightning Cable", "Lightning Dock". Not "Lightning to USB-C Adapter". */
function deviceSideLightning(title: string): boolean {
  if (/\bLightning\sto\sUSB/i.test(title)) return false;
  return /\bto\sLightning\b|\bLightning\s(cable|connector|charger|dock|stand|charging)\b|\bwith\sLightning\b|\bfor\sLightning\b/i.test(title);
}

/** Cables that are USB-C on both ends do not plug into a Lightning device. */
function usbCBothEnds(title: string): boolean {
  return /\bUSB-C\sto\sUSB-C\b.*\bcable\b/i.test(title) || /\bUSB-C\sto\sUSB-C\b/i.test(title) && /\bcable\b/i.test(title);
}

export function checkCompat(item: CatalogItem, device: DeviceInfo): CompatVerdict {
  const said = deviceLabel(device);
  if (device.generic) {
    return {
      status: 'not_listed',
      evidence: null,
      note: `The store lists specific models, so I need to know which ${device.name} you have.`,
      level: null,
    };
  }

  // The store's own "not compatible with X" beats everything else.
  const neg = findNegative(item.source, device.name);
  if (neg) {
    const note = neg.others
      ? `The store says it is not compatible with other models in the ${neg.others} series.`
      : `The store says it is not compatible with the ${said}.`;
    return { status: 'incompatible', evidence: { source: neg.source, quote: neg.quote }, note, level: null };
  }

  if (wholeDevice(item) || titleIsDevice(item, device)) {
    return {
      status: 'not_listed',
      evidence: null,
      note: `This is a device itself, not an accessory, so the store doesn't list it for the ${said}.`,
      level: null,
    };
  }

  const matches: { e: DeviceEvidence; level: MatchLevel }[] = [];
  for (const e of item.devices) {
    const level = deviceMatch(device, e.device);
    if (level) matches.push({ e, level });
  }
  matches.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || SOURCE_RANK[a.e.source] - SOURCE_RANK[b.e.source]);
  const best = matches[0];
  if (best) {
    const evidence: Evidence = { source: best.e.source, quote: best.e.quote };
    if (best.level === 'exact') {
      return { status: 'confirmed', evidence, note: `The store lists ${best.e.device.name} for this product.`, level: 'exact' };
    }
    // The store names the series or family, not this model: say exactly that, never "it works".
    const fit = FIT_SPECIFIC.test(item.title) ? ' This one needs an exact fit.' : '';
    return {
      status: 'family_only',
      evidence,
      note: `The store lists ${best.e.device.name}, not your ${said} specifically.${fit}`,
      level: best.level,
    };
  }

  if (!device.known) {
    const lit = findLiteral(item.source, device.name);
    if (lit) return { status: 'confirmed', evidence: lit, note: `The store mentions ${device.name} for this product.`, level: 'literal' };
    const series = findSeries(item.source, device.name);
    if (series) {
      return { status: 'family_only', evidence: series, note: `The store lists ${series.quote}, not your ${said} specifically.`, level: 'family' };
    }
  }

  if (device.port === 'USB-C' && deviceSideLightning(item.title)) {
    return {
      status: 'incompatible',
      evidence: { source: 'title', quote: item.title },
      note: `It has a Lightning connector, and the ${said} uses USB-C.`,
      level: null,
    };
  }
  if (device.port === 'Lightning' && usbCBothEnds(item.title)) {
    return {
      status: 'incompatible',
      evidence: { source: 'title', quote: item.title },
      note: `It is USB-C on both ends, and the ${said} uses a Lightning port.`,
      level: null,
    };
  }

  return {
    status: 'not_listed',
    evidence: null,
    note: `The store doesn't list the ${said} for this product, so I can't confirm it works.`,
    level: null,
  };
}
