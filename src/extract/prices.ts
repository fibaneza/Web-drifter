import type { PriceRecord, Region } from '../core/types.js';
import type { RawPriceCandidate } from './browser-extract.js';

/**
 * Price parsing.
 *
 * The point of parsing rather than string-comparing is that the two sites will
 * almost certainly format prices differently - `$1,299.00` on a legacy CMS,
 * `USD 1 299,00` from a React `Intl.NumberFormat` with a different locale.
 * Those are the *same price*. Comparing the rendered strings would report drift
 * on every product on the site; comparing parsed numbers reports only the ones
 * that actually changed.
 *
 * A formatting difference is still worth knowing about, so it is reported
 * separately and at a lower severity.
 */

/**
 * Symbol to ISO-4217.
 *
 * `$` is genuinely ambiguous - USD, CAD, AUD, NZD, MXN and others all use it -
 * so it resolves to USD by convention. Since BOTH sides are parsed with the
 * same table, an ambiguous symbol still compares correctly; the mapping only
 * matters for what the report displays.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '\u00A3': 'GBP', // pound sign
  '\u20AC': 'EUR', // euro sign
  '\u00A5': 'JPY', // yen sign
  '\u20B9': 'INR', // Indian rupee sign
  '\u20A9': 'KRW', // won sign
  '\u20BD': 'RUB', // ruble sign
  '\u20BA': 'TRY', // Turkish lira sign
  R$: 'BRL',
  CHF: 'CHF',
};

const ISO_CODE = /\b([A-Z]{3})\b/;
const SYMBOL = /[$\u00A3\u20AC\u00A5\u20B9\u20A9\u20BD\u20BA]/;

export interface ParsedPrice {
  amount: number;
  currency: string | null;
  /** The input, unchanged. */
  raw: string;
}

/**
 * Parse a displayed price.
 *
 * Returns null when the text contains no recoverable number, which is common
 * for the text-scan source ("Price on application", "From").
 */
export function parsePrice(raw: string, currencyHint?: string): ParsedPrice | null {
  const text = raw.trim();
  if (text === '') return null;

  const currency = detectCurrency(text, currencyHint);
  const amount = parseAmount(text);
  if (amount === null) return null;

  return { amount, currency, raw: text };
}

function detectCurrency(text: string, hint?: string): string | null {
  if (hint) {
    const normalized = hint.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(normalized)) return normalized;
    const mapped = CURRENCY_SYMBOLS[hint.trim()];
    if (mapped) return mapped;
  }

  // A three-letter code is unambiguous, so it wins over a symbol.
  const code = ISO_CODE.exec(text.toUpperCase());
  if (code?.[1] && code[1] !== 'AND' && code[1] !== 'THE') return code[1];

  const symbol = SYMBOL.exec(text);
  if (symbol?.[0]) return CURRENCY_SYMBOLS[symbol[0]] ?? null;

  return null;
}

/**
 * Extract the numeric value, handling both `1,299.00` and `1.299,00`.
 *
 * The rule when both separators appear is that the LAST one is the decimal
 * point - true for every common locale. When only one appears it is ambiguous,
 * and the digit count decides: exactly three trailing digits is a thousands
 * group (`1,299` / `1.299`), one or two is a decimal fraction (`12,99`).
 * Spaces are always thousands separators.
 */
export function parseAmount(text: string): number | null {
  // Strip currency codes so their letters cannot be mistaken for digits later.
  const withoutCode = text.replace(/\b[A-Z]{3}\b/gi, ' ');
  const match = /-?\d[\d.,\u00A0\u202F ]*/.exec(withoutCode);
  if (!match) return null;

  let numeric = match[0].replace(/[\u00A0\u202F ]/g, '');
  const negative = numeric.startsWith('-');
  if (negative) numeric = numeric.slice(1);

  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');

  let decimalSeparator: '.' | ',' | null = null;

  if (lastComma !== -1 && lastDot !== -1) {
    decimalSeparator = lastComma > lastDot ? ',' : '.';
  } else if (lastComma !== -1 || lastDot !== -1) {
    const separator = lastComma !== -1 ? ',' : '.';
    const index = lastComma !== -1 ? lastComma : lastDot;
    const occurrences = numeric.split(separator).length - 1;
    const trailingDigits = numeric.length - index - 1;
    // Repeated separators are always thousands (1.234.567).
    // Exactly three trailing digits is a thousands group, not 3dp of currency.
    decimalSeparator =
      occurrences === 1 && trailingDigits > 0 && trailingDigits <= 2 ? separator : null;
  }

  let normalized: string;
  if (decimalSeparator === null) {
    normalized = numeric.replace(/[.,]/g, '');
  } else {
    const other = decimalSeparator === ',' ? '.' : ',';
    normalized = numeric.split(other).join('');
    const decimalIndex = normalized.lastIndexOf(decimalSeparator);
    normalized = `${normalized.slice(0, decimalIndex).replace(/[.,]/g, '')}.${normalized.slice(
      decimalIndex + 1,
    )}`;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Turn raw in-page candidates into parsed price records, dropping unparseable ones. */
export function buildPriceRecords(candidates: readonly RawPriceCandidate[]): PriceRecord[] {
  const records: PriceRecord[] = [];
  for (const candidate of candidates) {
    const parsed = parsePrice(candidate.raw, candidate.currency);
    if (!parsed) continue;
    records.push({
      amount: parsed.amount,
      currency: parsed.currency,
      raw: candidate.raw,
      source: candidate.source,
      region: candidate.region as Region,
      context: candidate.context,
    });
  }
  return dedupePrices(records);
}

/**
 * Collapse the same price found by several sources.
 *
 * A product price typically appears in JSON-LD *and* in the rendered text; both
 * are the same fact. The most reliable source wins so the record carries an
 * explicit currency where one exists.
 */
function dedupePrices(records: readonly PriceRecord[]): PriceRecord[] {
  const priority: Record<PriceRecord['source'], number> = {
    jsonld: 0,
    microdata: 1,
    selector: 2,
    text: 3,
  };
  const best = new Map<string, PriceRecord>();

  for (const record of records) {
    const key = `${record.amount}|${record.currency ?? ''}|${record.context}`;
    const existing = best.get(key);
    if (!existing || priority[record.source] < priority[existing.source]) {
      best.set(key, record);
    }
  }
  return [...best.values()];
}
