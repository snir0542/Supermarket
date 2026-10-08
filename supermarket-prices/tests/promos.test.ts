import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { parseClub, parsePromoFile } from "../src/parser/promoFile.js";
import { conditionText, effectivePrice, promoUnitPrice } from "../src/promos/effective.js";
import { openStorage } from "../src/db/storage.js";
import { loadConfig } from "../src/config.js";
import { ingestSource } from "../src/ingest/ingest.js";
import { PriceService } from "../src/service.js";
import { createApp } from "../src/api/app.js";
import { MemoryRepository } from "../src/ingest/memoryRepository.js";
import { MockSource, gtin13, priceXml, storesXml } from "./helpers.js";
import type { PromotionRow } from "../src/ingest/repository.js";

const CHAIN = "7290058140886";

const ramiStyle = `<Root><ChainId>${CHAIN}</ChainId><SubChainId>1</SubChainId><StoreId>039</StoreId><Promotions>
<Promotion><PromotionId>100</PromotionId><PromotionDescription>גבינה ב-9.90</PromotionDescription>
<PromotionStartDate>2026-10-01</PromotionStartDate><PromotionStartHour>00:00:00</PromotionStartHour>
<PromotionEndDate>2026-10-31</PromotionEndDate><PromotionEndHour>23:59:00</PromotionEndHour>
<MinQty>1</MinQty><DiscountedPrice>9.90</DiscountedPrice>
<AdditionalRestrictions><Clubs><ClubId>0</ClubId></Clubs><AdditionalIsCoupon>0</AdditionalIsCoupon></AdditionalRestrictions>
<PromotionItems><Item><ItemCode>${gtin13("729000000001")}</ItemCode><IsGiftItem>0</IsGiftItem><ItemType>1</ItemType></Item></PromotionItems></Promotion>
<Promotion><PromotionId>101</PromotionId><PromotionDescription>מועדון: 3 ב-20</PromotionDescription>
<PromotionStartDate>2026-10-01</PromotionStartDate><PromotionStartHour>00:00:00</PromotionStartHour>
<PromotionEndDate>2026-10-31</PromotionEndDate><PromotionEndHour>23:59:00</PromotionEndHour>
<MinQty>3</MinQty><DiscountedPrice>20.00</DiscountedPrice>
<AdditionalRestrictions><Clubs><ClubId>2</ClubId></Clubs></AdditionalRestrictions>
<PromotionItems><Item><ItemCode>${gtin13("729000000001")}</ItemCode><IsGiftItem>0</IsGiftItem><ItemType>1</ItemType></Item></PromotionItems></Promotion>
</Promotions></Root>`;

const groupsStyle = `<Root><ChainID>7290027600007</ChainID><SubChainID>002</SubChainID><StoreID>413</StoreID><Promotions>
<Promotion><PromotionID>200</PromotionID><PromotionDescription>מחיר מועדון</PromotionDescription>
<PromotionStartDateTime>2026-10-01T00:00:00.000</PromotionStartDateTime><PromotionEndDateTime>2026-10-31T23:59:00.000</PromotionEndDateTime>
<ClubID>3 - מועדון לקוחות &amp; מועדון לקוחות אשראי</ClubID><AllowMultipleDiscounts>0</AllowMultipleDiscounts>
<Groups><Group><GroupID>1</GroupID><PromotionItems><PromotionItem>
<ItemCode>${gtin13("729000000002")}</ItemCode><ItemType>1</ItemType><MinQty>1</MinQty><DiscountRate>25</DiscountRate><bIsWeighted>0</bIsWeighted>
</PromotionItem></PromotionItems></Group></Groups></Promotion>
</Promotions></Root>`;

describe("parseClub", () => {
  it("parses every live encoding", () => {
    expect(parseClub("0")).toEqual({ id: "0", name: null });
    expect(parseClub(null)).toEqual({ id: "0", name: null });
    expect(parseClub("0 - כלל הלקוחות")).toEqual({ id: "0", name: "כלל הלקוחות" });
    expect(parseClub("3 - מועדון לקוחות & מועדון לקוחות אשראי")).toEqual({ id: "3", name: "מועדון לקוחות" });
    expect(parseClub("(2=מועדון קרפור אשראי|2=מועדון אפליקציה)")).toEqual({ id: "2", name: "מועדון קרפור אשראי / מועדון אפליקציה" });
    expect(parseClub("2")).toEqual({ id: "2", name: null });
  });
});

describe("parsePromoFile", () => {
  it("parses the Rami Levy shape: promo-level conditions, Clubs/ClubId, date+hour", () => {
    const f = parsePromoFile(Buffer.from(gzipSync(Buffer.from("﻿" + ramiStyle, "utf8"))));
    expect(f.chainId).toBe(CHAIN);
    expect(f.promotions).toHaveLength(2);
    const open = f.promotions[0]!;
    expect(open.clubId).toBe("0");
    expect(open.items[0]).toMatchObject({ itemCode: gtin13("729000000001"), minQty: 1, discountedPrice: 9.9, isGift: false });
    const club = f.promotions[1]!;
    expect(club.clubId).toBe("2");
    expect(club.items[0]).toMatchObject({ minQty: 3, discountedPrice: 20 });
    expect(club.startsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(club.endsAt?.toISOString()).toBe("2026-10-31T23:59:00.000Z");
  });

  it("parses the groups shape: per-item conditions, ClubID with names, combined datetimes", () => {
    const f = parsePromoFile(groupsStyle);
    expect(f.storeId).toBe("413");
    expect(f.promotions).toHaveLength(1);
    const p = f.promotions[0]!;
    expect(p.clubId).toBe("3");
    expect(p.clubName).toBe("מועדון לקוחות");
    expect(p.items[0]).toMatchObject({ discountRate: 25, minQty: 1 });
    expect(p.endsAt?.toISOString()).toBe("2026-10-31T23:59:00.000Z");
  });

  it("skips promotions without items", () => {
    const f = parsePromoFile(`<Root><ChainId>${CHAIN}</ChainId><Promotions><Promotion><PromotionId>1</PromotionId></Promotion></Promotions></Root>`);
    expect(f.promotions).toHaveLength(0);
    expect(f.skipped).toBe(1);
  });
});

function promoRow(over: Partial<PromotionRow>): PromotionRow {
  return {
    chainId: CHAIN, chainName: null, storeKey: "1", promotionId: "1", description: null, clubId: "0", clubName: null,
    startsAt: null, endsAt: null, allowMultipleDiscounts: false, isCoupon: false, itemCode: "x", isGift: false,
    minQty: null, maxQty: null, discountRate: null, discountedPrice: null, minPurchaseAmount: null, isWeighted: false,
    ...over,
  };
}
const NOW = new Date("2026-10-08T09:00:00Z");

describe("effectivePrice", () => {
  it("returns the base price when nothing applies", () => {
    expect(effectivePrice(10, [], new Set(), NOW)).toMatchObject({ price: 10, kind: "base" });
    expect(effectivePrice(10, [promoRow({ discountedPrice: 8, endsAt: new Date("2026-10-01") })], new Set(), NOW)).toMatchObject({ price: 10, kind: "base" });
  });
  it("applies an open promo to everyone", () => {
    const r = effectivePrice(10, [promoRow({ discountedPrice: 8 })], new Set(), NOW);
    expect(r).toMatchObject({ price: 8, kind: "promo", conditional: false });
  });
  it("applies a club promo only to members", () => {
    const promos = [promoRow({ clubId: "2", discountedPrice: 7 })];
    expect(effectivePrice(10, promos, new Set(), NOW)).toMatchObject({ price: 10, kind: "base" });
    expect(effectivePrice(10, promos, new Set(["2"]), NOW)).toMatchObject({ price: 7, kind: "club" });
  });
  it("discountRate is a percent off the base", () => {
    expect(promoUnitPrice(10, { minQty: 1, discountRate: 25, discountedPrice: null })).toBe(7.5);
  });
  it("minQty>1 is conditional and never blends into an unconditional headline", () => {
    const promos = [promoRow({ minQty: 3, discountedPrice: 20 })];
    const r = effectivePrice(10, promos, new Set(), NOW);
    expect(r).toMatchObject({ price: 6.67, conditional: true, condition: "בקניית 3 ומעלה" });
    // an unconditional promo at a higher unit price still wins over the conditional one
    const r2 = effectivePrice(10, [...promos, promoRow({ promotionId: "2", discountedPrice: 9 })], new Set(), NOW);
    expect(r2).toMatchObject({ price: 9, conditional: false, kind: "promo" });
  });
  it("ignores gift items and coupons", () => {
    const promos = [promoRow({ discountedPrice: 1, isGift: true }), promoRow({ discountedPrice: 2, isCoupon: true })];
    expect(effectivePrice(10, promos, new Set(), NOW)).toMatchObject({ price: 10, kind: "base" });
  });
  it("conditionText covers min basket and weighted", () => {
    expect(conditionText({ minQty: null, minPurchaseAmount: 100, isWeighted: false })).toBe("בקנייה מעל ₪100");
    expect(conditionText({ minQty: 2, minPurchaseAmount: null, isWeighted: true })).toBe("בקניית 2 ומעלה · מוצר שקיל");
  });
});

async function sqliteWithData() {
  const storage = await openStorage({ ...loadConfig({}), sqlitePath: ":memory:" });
  await storage.migrate();
  const source = new MockSource("rami-levy", "רמי לוי");
  const at = new Date("2026-10-08T05:00:00Z");
  const milk = gtin13("729000000001");
  source.add("Stores7290058140886-000-20261008.xml", "stores", CHAIN, null, null, at, storesXml(CHAIN, [{ sub: "1", id: "039", name: "רמי לוי אונליין", city: "אונליין", address: "משלוחים", type: 2 }]));
  source.add("PriceFull7290058140886-001-039-20261008.gz", "pricefull", CHAIN, "001", "039", at, priceXml(CHAIN, "1", "039", [{ code: milk, name: "חלב תנובה 3%", price: 10 }]));
  source.add("PromoFull7290058140886-001-039-20261008.gz", "promofull", CHAIN, "001", "039", at, ramiStyle);
  await ingestSource(storage.repo, source, { config: loadConfig({}), kinds: ["pricefull", "promofull"], onlineOnly: true });
  return { storage, milk };
}

describe("promo ingest + queries (sqlite)", () => {
  it("stores the promo snapshot and answers club vs non-club prices", async () => {
    const { storage, milk } = await sqliteWithData();
    try {
      const service = new PriceService(storage.repo);
      const product = await service.resolveProduct({ gtin: milk });
      expect(product).not.toBeNull();
      const out = await service.productPromos({ id: product!.id }, { [CHAIN]: "2" }, NOW);
      expect(out).not.toBeNull();
      const chain = out!.chains.find((c) => c.chainId === CHAIN)!;
      expect(chain.basePrice).toBe(10);
      expect(chain.regular).toMatchObject({ price: 9.9, kind: "promo", conditional: false });
      // מבצע המועדון מותנה (3 ב-20), ולכן מחיר הכותרת נשאר המבצע הפתוח; המבצע המותנה מופיע ברשימה עם התנאי
      expect(chain.member).toMatchObject({ price: 9.9, kind: "promo", conditional: false });
      const clubPromo = chain.promotions.find((pr) => pr.clubId === "2")!;
      expect(clubPromo).toMatchObject({ condition: "בקניית 3 ומעלה", unitPrice: 6.67 });
      expect(chain.promotions).toHaveLength(2);
      const clubs = await storage.repo.listClubs();
      expect(clubs).toEqual([expect.objectContaining({ chainId: CHAIN, clubId: "2", promoCount: 1 })]);
    } finally {
      await storage.close();
    }
  });

  it("re-ingesting a new promo file replaces the store snapshot", async () => {
    const { storage } = await sqliteWithData();
    try {
      const source2 = new MockSource("rami-levy", "רמי לוי");
      const at = new Date("2026-10-09T05:00:00Z");
      source2.add("Stores7290058140886-000-20261009.xml", "stores", CHAIN, null, null, at, storesXml(CHAIN, [{ sub: "1", id: "039", name: "רמי לוי אונליין", city: "אונליין", address: "משלוחים", type: 2 }]));
      source2.add("PromoFull7290058140886-001-039-20261009.gz", "promofull", CHAIN, "001", "039", at, `<Root><ChainId>${CHAIN}</ChainId><SubChainId>1</SubChainId><StoreId>039</StoreId><Promotions></Promotions></Root>`);
      await ingestSource(storage.repo, source2, { config: loadConfig({}), kinds: ["promofull"], onlineOnly: true });
      expect(await storage.repo.listClubs()).toEqual([]);
    } finally {
      await storage.close();
    }
  });
});

describe("promo API", () => {
  it("serves /promos/clubs and /products/:ref/promos with club selection", async () => {
    const repo = new MemoryRepository();
    await repo.upsertChain(CHAIN, "רמי לוי");
    const storeKey = await repo.ensureStore(CHAIN, "1", "039");
    const product = await repo.createProduct({ gtin: gtin13("729000000001"), name: "חלב", nameNorm: "חלב", sizeKey: null });
    await repo.upsertChainItem({ chainId: CHAIN, itemCode: "1001", productId: product.id, rawName: "חלב", matchMethod: "new", matchScore: null, needsReview: false, manufacturer: null });
    await repo.recordPrices(CHAIN, storeKey, [{ itemCode: "1001", price: 10, unitPrice: null, priceUpdatedAt: null }], new Date());
    await repo.replaceStorePromotions(CHAIN, storeKey, "PromoFull.gz", new Date(), [
      { promotionId: "1", description: "מבצע לכולם", clubId: "0", clubName: null, startsAt: null, endsAt: null, allowMultipleDiscounts: false, isCoupon: false,
        items: [{ itemCode: "1001", itemType: 1, isGift: false, minQty: 1, maxQty: null, discountRate: null, discountedPrice: 9, minPurchaseAmount: null, isWeighted: false }] },
      { promotionId: "2", description: "מחיר מועדון", clubId: "2", clubName: "מועדון אשראי", startsAt: null, endsAt: null, allowMultipleDiscounts: false, isCoupon: false,
        items: [{ itemCode: "1001", itemType: 1, isGift: false, minQty: 1, maxQty: null, discountRate: null, discountedPrice: 7, minPurchaseAmount: null, isWeighted: false }] },
    ]);
    const app = createApp(new PriceService(repo), loadConfig({}));
    const clubs = await (await app.request("/promos/clubs")).json();
    expect(clubs.clubs).toEqual([expect.objectContaining({ chainId: CHAIN, clubId: "2", clubName: "מועדון אשראי", promoCount: 1 })]);
    const plain = await (await app.request(`/products/${product.id}/promos`)).json();
    expect(plain.chains[0].member.price).toBe(9); // בלי מועדון: רק מבצעים פתוחים
    const withClub = await (await app.request(`/products/${product.id}/promos?clubs=${CHAIN}:2`)).json();
    expect(withClub.chains[0].member).toMatchObject({ price: 7, kind: "club" });
    expect(withClub.chains[0].regular).toMatchObject({ price: 9, kind: "promo" });
    const missing = await app.request("/products/99999/promos");
    expect(missing.status).toBe(404);
  });
});
