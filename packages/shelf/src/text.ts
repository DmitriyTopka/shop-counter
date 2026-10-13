/** Small, dependency-free text helpers shared by extraction, search and speech. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', trade: '™', reg: '®', copy: '©',
  ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', deg: '°',
  times: 'x', bull: '•', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Store HTML -> plain text. Block ends become sentence breaks so sentences stay separable. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[   ]/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Split plain text into sentences (also on line breaks from block HTML). */
export function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Title fit for speech: no trademark glyphs, no doubled spaces. */
export function speakable(title: string): string {
  return title.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
}

export function money(n: number, currency = 'USD'): string {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  // Whole amounts read better aloud: "$120", not "$120.00".
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return sym ? `${sym}${s}` : `${s} ${currency}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "a", "a and b", "a, b and c" */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const NUMBER_WORDS: Record<string, number> = {
  single: 1, one: 1, dual: 2, two: 2, twin: 2, three: 3, triple: 3, four: 4, quad: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10,
};

export function wordToNumber(w: string): number | null {
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w.toLowerCase()] ?? null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
