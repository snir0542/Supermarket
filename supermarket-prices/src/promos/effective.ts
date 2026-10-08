import type { PromotionRow } from "../ingest/repository.js";

export interface EffectiveOffer {
  /** the unit price a buyer actually pays for one unit */
  price: number;
  /** "base" = shelf price, "promo" = open to everyone, "club" = requires the given club */
  kind: "base" | "promo" | "club";
  /** true when the price only holds under conditions (min quantity, min basket, weighted) */
  conditional: boolean;
  /** short Hebrew condition text when conditional, e.g. "בקניית 3 ומעלה" */
  condition: string | null;
  promo: PromotionRow | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Is the promo valid at `now`? Missing bounds are treated as open. */
export function isActive(p: Pick<PromotionRow, "startsAt" | "endsAt">, now: Date): boolean {
  if (p.startsAt && p.startsAt.getTime() > now.getTime()) return false;
  if (p.endsAt && p.endsAt.getTime() < now.getTime()) return false;
  return true;
}

export function conditionText(p: Pick<PromotionRow, "minQty" | "minPurchaseAmount" | "isWeighted">): string | null {
  const parts: string[] = [];
  if (p.minQty !== null && p.minQty > 1) parts.push(`בקניית ${p.minQty} ומעלה`);
  if (p.minPurchaseAmount !== null && p.minPurchaseAmount > 0) parts.push(`בקנייה מעל ₪${p.minPurchaseAmount}`);
  if (p.isWeighted) parts.push(`מוצר שקיל`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Unit price under one promo, honestly:
 * - discountedPrice with minQty<=1 (or none) is the unit price.
 * - discountedPrice with minQty>1 is the price of the whole bundle; the per-unit figure is shown
 *   only as a conditional price, never blended into an unconditional headline.
 * - discountRate is a percent off the base price.
 */
export function promoUnitPrice(basePrice: number, p: Pick<PromotionRow, "minQty" | "discountRate" | "discountedPrice">): number | null {
  if (p.discountedPrice !== null && p.discountedPrice >= 0) {
    const q = p.minQty ?? 1;
    return round2(q > 1 ? p.discountedPrice / q : p.discountedPrice);
  }
  if (p.discountRate !== null && p.discountRate > 0) return round2(basePrice * (1 - p.discountRate / 100));
  return null;
}

/**
 * The best a buyer pays for one unit of a product, given their clubs.
 * Conditional promos only win when no unconditional promo beats them, and are flagged.
 * Gift items, coupons, and promos that don't lower the price are ignored.
 */
export function effectivePrice(basePrice: number, promos: PromotionRow[], clubs: ReadonlySet<string>, now: Date): EffectiveOffer {
  const base: EffectiveOffer = { price: basePrice, kind: "base", conditional: false, condition: null, promo: null };
  let best = base;
  let bestConditional: EffectiveOffer | null = null;
  for (const promo of promos) {
    if (promo.isGift || promo.isCoupon) continue;
    if (!isActive(promo, now)) continue;
    const clubPromo = promo.clubId !== "0";
    if (clubPromo && !clubs.has(promo.clubId)) continue;
    const price = promoUnitPrice(basePrice, promo);
    if (price === null || price >= best.price) continue;
    const condition = conditionText(promo);
    const offer: EffectiveOffer = { price, kind: clubPromo ? "club" : "promo", conditional: condition !== null, condition, promo };
    if (condition === null) best = offer;
    else if (!bestConditional || price < bestConditional.price) bestConditional = offer;
  }
  return best.kind !== "base" ? best : bestConditional && bestConditional.price < best.price ? bestConditional : best;
}
