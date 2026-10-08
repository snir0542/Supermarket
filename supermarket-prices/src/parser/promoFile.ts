import { XMLParser } from "fast-xml-parser";
import type { PromoFile, PromoItem, Promotion } from "../types.js";
import { decodeXmlBuffer } from "./decode.js";
import { parseDate, pick, toNumber } from "./priceFile.js";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["promotion", "item", "promotionitem", "group"].includes(name.toLowerCase()),
});

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Walks the tree and returns every object under a key named like one of `names`. */
function collect(node: unknown, names: string[], out: Node[] = []): Node[] {
  const wanted = names.map((n) => n.toLowerCase());
  if (Array.isArray(node)) for (const n of node) collect(n, names, out);
  else if (isNode(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (wanted.includes(k.toLowerCase())) {
        for (const x of Array.isArray(v) ? v : [v]) if (isNode(x)) out.push(x);
      } else {
        collect(v, names, out);
      }
    }
  }
  return out;
}

export interface ParsedClub {
  id: string;
  name: string | null;
}

/**
 * Club encodings seen live:
 *   "0"                                  (Rami Levy, one <ClubId> per club, inside <Clubs>)
 *   "0 - כלל הלקוחות"                    (Shufersal: "<id> - <names joined by &>")
 *   "(2=מועדון קרפור אשראי|2=מועדון אפליקציה)"  (Carrefour: "(id=name|id=name)")
 */
export function parseClub(raw: string | null): ParsedClub {
  if (!raw) return { id: "0", name: null };
  const v = raw.trim();
  const paren = v.match(/^\((.+)\)$/);
  if (paren) {
    const pairs = [...paren[1]!.matchAll(/(\d+)\s*=\s*([^|]+)/g)];
    if (pairs.length) {
      const id = pairs[0]![1]!;
      const names = pairs.filter((p) => p[1] === id).map((p) => p[2]!.trim());
      return { id, name: names.length ? [...new Set(names)].join(" / ") : null };
    }
  }
  const dashed = v.match(/^(\d+)\s*-\s*(.+)$/);
  if (dashed) {
    // Shufersal joins every member name with " & "; the first name is the club's own name
    const first = dashed[2]!.split("&")[0]!.trim();
    return { id: dashed[1]!, name: first || null };
  }
  if (/^\d+$/.test(v)) return { id: v, name: null };
  return { id: "0", name: v };
}

function num(v: string | null): number | null {
  const n = toNumber(v);
  return n !== null && Number.isFinite(n) ? n : null;
}

/** Date+hour pairs (Rami Levy) or a combined datetime (Carrefour/Shufersal). */
function promoTime(node: Node, combined: string[], date: string[], hour: string[]): Date | null {
  const c = pick(node, ...combined);
  if (c) return parseDate(c);
  const d = pick(node, ...date);
  if (!d) return null;
  const h = pick(node, ...hour) ?? "00:00";
  return parseDate(`${d}T${h.length === 5 ? `${h}:00` : h}`);
}

/**
 * PromoFull in the two shapes seen live:
 *   Rami Levy: conditions on the <Promotion>, items in <PromotionItems><Item>
 *   Carrefour/Shufersal: conditions per item in <Groups><Group><PromotionItems><PromotionItem>
 * Normalized to: promo-level club/dates/description + per-item conditions
 * (promo-level conditions are copied onto every item).
 */
export function parsePromoFile(buf: Buffer | string): PromoFile {
  const xml = typeof buf === "string" ? buf : decodeXmlBuffer(buf);
  const doc = parser.parse(xml) as Node;
  const root = (Object.values(doc).find(isNode) ?? {}) as Node;
  const chainId = pick(root, "ChainId") ?? "";
  const subChainId = pick(root, "SubChainId") ?? "0";
  const storeId = pick(root, "StoreId") ?? "";
  const promotions: Promotion[] = [];
  let skipped = 0;

  for (const p of collect(root, ["Promotion"])) {
    const id = pick(p, "PromotionId") ?? "";
    // club: <Clubs><ClubId>..</ClubId></Clubs> anywhere in the promo (Rami Levy nests it
    // under AdditionalRestrictions), or a direct <ClubID> text (Carrefour/Shufersal)
    const clubRaw: string[] = [];
    for (const c of collect(p, ["Clubs"])) {
      const ids = c["ClubId"] ?? c["ClubID"];
      for (const x of Array.isArray(ids) ? ids : [ids]) if (typeof x === "string" || typeof x === "number") clubRaw.push(String(x));
    }
    if (clubRaw.length === 0) {
      const direct = p["ClubId"] ?? p["ClubID"];
      for (const x of Array.isArray(direct) ? direct : [direct]) if (typeof x === "string" || typeof x === "number") clubRaw.push(String(x));
      if (clubRaw.length === 0) clubRaw.push("0");
    }
    const description = pick(p, "PromotionDescription");
    const startsAt = promoTime(p, ["PromotionStartDateTime"], ["PromotionStartDate"], ["PromotionStartHour"]);
    const endsAt = promoTime(p, ["PromotionEndDateTime"], ["PromotionEndDate"], ["PromotionEndHour"]);

    // promo-level conditions (Rami Levy); empty <Tag/> parses as "" and yields null here
    const promoConds = {
      minQty: num(pick(p, "MinQty")),
      maxQty: num(pick(p, "MaxQty")),
      discountRate: num(pick(p, "DiscountRate")),
      discountedPrice: num(pick(p, "DiscountedPrice")),
      minPurchaseAmount: num(pick(p, "MinPurchaseAmount")),
    };

    // items: direct <PromotionItems><Item> (Rami Levy) or nested groups (Carrefour/Shufersal)
    const itemNodes = collect(p, ["PromotionItem"]);
    const directItems = itemNodes.length ? itemNodes : collect(p, ["Item"]);
    const items: PromoItem[] = [];
    for (const n of directItems) {
      const itemCode = pick(n, "ItemCode");
      if (!itemCode) continue;
      items.push({
        itemCode,
        itemType: num(pick(n, "ItemType")),
        // <IsGiftItem> can sit on the item (Rami Levy) or on the promotion (Carrefour)
        isGift: (pick(n, "IsGiftItem") ?? pick(p, "IsGiftItem")) === "1",
        minQty: num(pick(n, "MinQty")) ?? promoConds.minQty,
        maxQty: num(pick(n, "MaxQty")) ?? promoConds.maxQty,
        discountRate: num(pick(n, "DiscountRate")) ?? promoConds.discountRate,
        discountedPrice: num(pick(n, "DiscountedPrice")) ?? promoConds.discountedPrice,
        minPurchaseAmount: num(pick(n, "MinPurchaseAmount")) ?? promoConds.minPurchaseAmount,
        isWeighted: pick(n, "bIsWeighted", "IsWeighted") === "1",
      });
    }
    if (items.length === 0) {
      skipped++;
      continue;
    }
    for (const raw of clubRaw) {
      const club = parseClub(raw);
      promotions.push({
        promotionId: id,
        description,
        clubId: club.id,
        clubName: club.name,
        startsAt,
        endsAt,
        allowMultipleDiscounts: pick(p, "AllowMultipleDiscounts") === "1",
        isCoupon: pick(p, "AdditionalIsCoupon") === "1",
        items,
      });
    }
  }
  return { chainId, subChainId, storeId, promotions, skipped };
}
