/**
 * Compatibility check: "confirmed" only with a literal quote from the store,
 * "incompatible" only from the store's own "not compatible with X" or a hard connector rule,
 * everything else is "not_listed". We never guess.
 */
import { deviceMatch, type DeviceInfo, type MatchLevel } from './devices.js';
import { findLiteral, findNegative, type DeviceEvidence } from './extract.js';
import type { CatalogItem } from './normalize.js';
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
    return { status: 'incompatible', evidence: neg, note: `The store says it is not compatible with the ${device.name}.`, level: null };
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
    if (best.level === 'series' && FIT_SPECIFIC.test(item.title)) {
      return {
        status: 'not_listed',
        evidence,
        note: `The store lists ${best.e.device.name}, not the ${device.name} specifically, and this needs an exact fit.`,
        level: best.level,
      };
    }
    const note =
      best.level === 'exact'
        ? `The store lists ${best.e.device.name} for this product.`
        : best.level === 'series'
          ? `The store lists the ${best.e.device.name} series, which includes the ${device.name}.`
          : `The store lists ${best.e.device.name} for this product, which covers the ${device.name}.`;
    return { status: 'confirmed', evidence, note, level: best.level };
  }

  if (!device.known) {
    const lit = findLiteral(item.source, device.name);
    if (lit) return { status: 'confirmed', evidence: lit, note: `The store mentions ${device.name} for this product.`, level: 'literal' };
  }

  if (device.port === 'USB-C' && deviceSideLightning(item.title)) {
    return {
      status: 'incompatible',
      evidence: { source: 'title', quote: item.title },
      note: `It has a Lightning connector, and the ${device.name} uses USB-C.`,
      level: null,
    };
  }
  if (device.port === 'Lightning' && usbCBothEnds(item.title)) {
    return {
      status: 'incompatible',
      evidence: { source: 'title', quote: item.title },
      note: `It is USB-C on both ends, and the ${device.name} uses a Lightning port.`,
      level: null,
    };
  }

  return {
    status: 'not_listed',
    evidence: null,
    note: `The store doesn't list the ${device.name} for this product, so I can't confirm it works.`,
    level: null,
  };
}
