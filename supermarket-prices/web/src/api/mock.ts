import { MOCK_CHAINS, MOCK_PRODUCTS, MOCK_STORES, mockHistory } from "./mockData";
import type { BasketInput, BasketResponse, BasketStore, ChainFreshness, HistoryPoint, Product, SearchHit } from "./types";

/**
 * "שרת" דמו שרץ בדפדפן: אותם נתיבים ואותן צורות תשובה כמו ה-API האמיתי,
 * כדי שהממשק ירוץ בלי מסד נתונים (VITE_USE_MOCK=true או ?mock=1).
 */
const norm = (s: string) => s.replace(/["'׳״`%]/g, "").toLowerCase().trim();

function currentPrices(productId: number) {
  const latest = new Map<string, HistoryPoint>();
  for (const p of mockHistory(productId)) latest.set(`${p.chainId}|${p.storeKey}`, p);
  return [...latest.values()];
}

function matchScore(q: string, p: Product): number {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const hay = norm(p.name);
  const hit = words.filter((w) => hay.includes(w)).length;
  if (hit === 0) return 0;
  return hit / words.length + (hay.startsWith(words[0]!) ? 0.1 : 0);
}

function search(q: string, limit: number): SearchHit[] {
  return MOCK_PRODUCTS.map((p) => ({ p, score: matchScore(q, p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, "he"))
    .slice(0, limit)
    .map(({ p, score }) => {
      const prices = currentPrices(p.id).filter((x) => MOCK_STORES.find((s) => s.storeKey === x.storeKey)?.isOnline);
      const vals = prices.map((x) => x.price);
      return {
        ...p,
        minPrice: vals.length ? Math.min(...vals) : null,
        maxPrice: vals.length ? Math.max(...vals) : null,
        chains: new Set(prices.map((x) => x.chainId)).size,
        score,
      };
    });
}

function resolve(input: BasketInput): Product | null {
  if (input.gtin) return MOCK_PRODUCTS.find((p) => p.gtin === input.gtin) ?? null;
  if (input.query) return search(input.query, 1)[0] ?? null;
  return null;
}

function basket(body: { items: BasketInput[]; area?: { text?: string; online?: boolean }; limit?: number; requireAll?: boolean }): BasketResponse {
  const resolved = body.items.map((input) => {
    const product = resolve(input);
    return product ? { input, product } : { input, product: null, note: "לא נמצא מוצר תואם" };
  });
  const lines = new Map<number, number>();
  for (const r of resolved) if (r.product) lines.set(r.product.id, (lines.get(r.product.id) ?? 0) + (r.input.qty ?? 1));
  const online = body.area?.online ?? false;
  const text = body.area?.text ? norm(body.area.text) : "";
  const stores: BasketStore[] = [];
  for (const s of MOCK_STORES) {
    if (s.isOnline !== online) continue;
    if (text && !norm([s.city, s.address, s.storeName].join(" ")).includes(text)) continue;
    let total = 0;
    let found = 0;
    const missing: number[] = [];
    for (const [pid, qty] of lines) {
      const pt = currentPrices(pid).find((x) => x.storeKey === s.storeKey);
      if (pt) {
        total += pt.price * qty;
        found++;
      } else missing.push(pid);
    }
    if (found === 0) continue;
    stores.push({ ...s, total: Math.round(total * 100) / 100, found, missingProductIds: missing });
  }
  const requireAll = body.requireAll ?? true;
  const list = stores
    .filter((s) => !requireAll || s.missingProductIds.length === 0)
    .sort((a, b) => a.missingProductIds.length - b.missingProductIds.length || a.total - b.total)
    .slice(0, body.limit ?? 10);
  return { resolved, stores: list, complete: list.length > 0 && list[0]!.missingProductIds.length === 0 };
}

function freshness(): ChainFreshness[] {
  return MOCK_CHAINS.map((c) => ({
    chainId: c.chainId,
    chainName: c.name,
    status: c.ageHours > 36 ? "stale" : "fresh",
    ageHours: c.ageHours,
    stores: c.stores * 40,
    currentPrices: 9000 + c.stores * 3100,
  }));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://mock.local");
  const path = url.pathname.replace(/^\/mock/, "");
  await new Promise((r) => setTimeout(r, 120));
  if (path === "/products/search") {
    const q = url.searchParams.get("q")?.trim();
    if (!q) return json({ error: "q is required" }, 400);
    return json({ results: search(q, Number(url.searchParams.get("limit") ?? 20)) });
  }
  const h = path.match(/^\/products\/([^/]+)\/history$/);
  if (h) {
    const ref = decodeURIComponent(h[1]!);
    const product = /^\d{8,14}$/.test(ref) ? MOCK_PRODUCTS.find((p) => p.gtin === ref) : /^\d+$/.test(ref) ? MOCK_PRODUCTS.find((p) => p.id === Number(ref)) : search(ref, 1)[0];
    return product ? json({ product, points: mockHistory(product.id) }) : json({ error: "product not found" }, 404);
  }
  if (path === "/stores") {
    const online = url.searchParams.get("online");
    return json({ stores: MOCK_STORES.filter((s) => online === null || s.isOnline === (online === "true")) });
  }
  if (path === "/basket/cheapest" && init?.method === "POST") return json(basket(JSON.parse(String(init.body))));
  if (path === "/promos/clubs") {
    return json({ clubs: [
      { chainId: "7290027600007", chainName: "שופרסל", clubId: "3", clubName: "מועדון לקוחות", promoCount: 9 },
      { chainId: "7290055700007", chainName: "קרפור", clubId: "2", clubName: "מועדון אפליקציה", promoCount: 5 },
    ] });
  }
  const pm = path.match(/^\/products\/([^/]+)\/promos$/);
  if (pm) {
    const ref = decodeURIComponent(pm[1]!);
    const product = /^\d{8,14}$/.test(ref) ? MOCK_PRODUCTS.find((p) => p.gtin === ref) : /^\d+$/.test(ref) ? MOCK_PRODUCTS.find((p) => p.id === Number(ref)) : search(ref, 1)[0];
    if (!product) return json({ error: "product not found" }, 404);
    const prices = currentPrices(product.id).filter((x) => MOCK_STORES.find((s) => s.storeKey === x.storeKey)?.isOnline);
    const byChain = new Map<string, number>();
    for (const pr of prices) byChain.set(pr.chainId, Math.min(byChain.get(pr.chainId) ?? Infinity, pr.price));
    const end = new Date(Date.now() + 14 * 86400_000).toISOString();
    const chains = [...byChain.entries()].map(([chainId, basePrice], i) => {
      const name = MOCK_CHAINS.find((c) => c.chainId === chainId)?.name ?? null;
      const clubId = chainId === "7290027600007" ? "3" : "2";
      const clubPrice = Math.round(basePrice * 0.85 * 100) / 100;
      const promoPrice = Math.round(basePrice * 0.92 * 100) / 100;
      return {
        chainId, chainName: name, basePrice, selectedClub: null,
        regular: { price: promoPrice, kind: "promo", conditional: false, condition: null },
        member: { price: clubPrice, kind: "club", conditional: false, condition: null },
        promotions: [
          { chainId, chainName: name, promotionId: `M${i}1`, description: "מבצע לכל הלקוחות", clubId: "0", clubName: null, startsAt: null, endsAt: end, isCoupon: false, itemCode: product.gtin ?? "", isGift: false, minQty: 1, maxQty: null, discountRate: null, discountedPrice: promoPrice, minPurchaseAmount: null, isWeighted: false, active: true, unitPrice: promoPrice, condition: null },
          { chainId, chainName: name, promotionId: `M${i}2`, description: "מחיר מועדון מיוחד", clubId, clubName: "מועדון לקוחות", startsAt: null, endsAt: end, isCoupon: false, itemCode: product.gtin ?? "", isGift: false, minQty: 1, maxQty: null, discountRate: null, discountedPrice: clubPrice, minPurchaseAmount: null, isWeighted: false, active: true, unitPrice: clubPrice, condition: null },
          { chainId, chainName: name, promotionId: `M${i}3`, description: "3 ב-20 ש\u05f4ח", clubId: "0", clubName: null, startsAt: null, endsAt: end, isCoupon: false, itemCode: product.gtin ?? "", isGift: false, minQty: 3, maxQty: null, discountRate: null, discountedPrice: 20, minPurchaseAmount: null, isWeighted: false, active: true, unitPrice: Math.round((20 / 3) * 100) / 100, condition: "בקניית 3 ומעלה" },
        ],
      };
    });
    return json({ product, chains });
  }
  if (path === "/quality/freshness") return json({ chains: freshness() });
  if (path === "/quality/review") {
    return json({ items: [
      { chainId: MOCK_CHAINS[2]!.chainId, itemCode: "5001", productId: 19, rawName: "עגבניות שרי אורגניות 500 גר", matchMethod: "fuzzy", matchScore: 0.62, needsReview: true, productName: "עגבניות שרי 500 גרם" },
      { chainId: MOCK_CHAINS[0]!.chainId, itemCode: "88123", productId: 8, rawName: "פיתה אחלה 10 יח", matchMethod: "fuzzy", matchScore: 0.58, needsReview: true, productName: "פיתות 10 יחידות" },
    ] });
  }
  return json({ error: "not found" }, 404);
};
