import { ONLINE_CHAIN_IDS } from "../downloader/registry.js";
import type Database from "better-sqlite3";
import type { StoreRecord } from "../types.js";
import { normalizeHebrew } from "../normalize/hebrew.js";
import { TrigramIndex } from "../normalize/trigramIndex.js";
import type {
  BasketLine, BasketStoreResult, ChainItemRow, FreshnessRow, HistoryPoint, IngestRunInfo, PriceWrite,
  ProductRow, PromotionRow, PromotionWrite, PromoWriteResult, ClubRow, Repository, SearchHit, SimilarProduct, StoreArea, StoreListRow, WriteResult,
} from "../ingest/repository.js";

type Row = Record<string, any>;

const productFrom = (r: Row): ProductRow => ({ id: r.id, gtin: r.gtin, name: r.name, nameNorm: r.name_norm, sizeKey: r.size_key });
const searchText = (s: { name: string | null; address: string | null; city: string | null }) =>
  normalizeHebrew([s.city, s.address, s.name].filter(Boolean).join(" "));
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Repository על SQLite (better-sqlite3) להרצה מקומית בלי Postgres.
 * אותו חוזה כמו PgRepository. ההבדל היחיד: pg_trgm לא קיים, ולכן הדמיון בין שמות
 * מחושב בתהליך (TrigramIndex, אותה הגדרת דמיון) ונבנה מחדש מטבלת products בכל פתיחה.
 */
export class SqliteRepository implements Repository {
  private index = new TrigramIndex();

  constructor(private db: Database.Database, schemaSql: string, private onlineOnly = false) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(schemaSql);
    for (const r of db.prepare("SELECT id, name_norm FROM products").iterate() as Iterable<Row>) this.index.add(r.id, r.name_norm);
  }


  private scope(alias = "s"): string {
    return this.onlineOnly ? `${alias}.is_online = 1 AND ${alias}.chain_id IN (${ONLINE_CHAIN_IDS.map((id) => `'${id}'`).join(",")})` : "1=1";
  }

  async upsertChain(chainId: string, name: string | null) {
    this.db
      .prepare(`INSERT INTO chains (chain_id, name) VALUES (?, ?)
                ON CONFLICT (chain_id) DO UPDATE SET name = COALESCE(excluded.name, chains.name), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(chainId, name);
  }

  async upsertStores(stores: StoreRecord[]) {
    const run = this.db.transaction((list: StoreRecord[]) => {
      for (const s of list) {
        this.db.prepare(`INSERT OR IGNORE INTO chains (chain_id) VALUES (?)`).run(s.chainId);
        this.db
          .prepare(`INSERT INTO stores (chain_id, sub_chain_id, store_id, name, address, city, zip, search_text, is_online)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT (chain_id, sub_chain_id, store_id) DO UPDATE SET name = excluded.name, address = excluded.address,
                      city = excluded.city, zip = excluded.zip, search_text = excluded.search_text, is_online = excluded.is_online`)
          .run(s.chainId, s.subChainId, s.storeId, s.name, s.address, s.city, s.zip, searchText(s), s.isOnline ? 1 : 0);
      }
    });
    run(stores);
  }

  async ensureStore(chainId: string, sub: string, storeId: string): Promise<string> {
    this.db.prepare(`INSERT OR IGNORE INTO chains (chain_id) VALUES (?)`).run(chainId);
    this.db.prepare(`INSERT OR IGNORE INTO stores (chain_id, sub_chain_id, store_id) VALUES (?,?,?)`).run(chainId, sub, storeId);
    const r = this.db.prepare(`SELECT id FROM stores WHERE chain_id=? AND sub_chain_id=? AND store_id=?`).get(chainId, sub, storeId) as Row;
    return String(r.id);
  }

  async getChainItem(chainId: string, itemCode: string): Promise<ChainItemRow | null> {
    const x = this.db.prepare(`SELECT * FROM chain_items WHERE chain_id=? AND item_code=?`).get(chainId, itemCode) as Row | undefined;
    return x ? { chainId: x.chain_id, itemCode: x.item_code, productId: x.product_id, rawName: x.raw_name, matchMethod: x.match_method, matchScore: x.match_score, needsReview: x.needs_review === 1 } : null;
  }

  async findProductByGtin(gtin: string) {
    const r = this.db.prepare(`SELECT * FROM products WHERE gtin=?`).get(gtin) as Row | undefined;
    return r ? productFrom(r) : null;
  }

  async findSimilarProducts(nameNorm: string, min: number, limit: number): Promise<SimilarProduct[]> {
    const hits = this.index.query(nameNorm, Math.max(min, 0.3), limit);
    return hits.map((h) => ({ ...productFrom(this.db.prepare(`SELECT * FROM products WHERE id=?`).get(h.id) as Row), similarity: h.similarity }));
  }

  async createProduct(p: { gtin: string | null; name: string; nameNorm: string; sizeKey: string | null }) {
    const existing = p.gtin ? ((this.db.prepare(`SELECT * FROM products WHERE gtin=?`).get(p.gtin) as Row | undefined) ?? null) : null;
    if (existing) return productFrom(existing);
    const info = this.db.prepare(`INSERT INTO products (gtin, name, name_norm, size_key) VALUES (?,?,?,?)`).run(p.gtin, p.name, p.nameNorm, p.sizeKey);
    const id = Number(info.lastInsertRowid);
    this.index.add(id, p.nameNorm);
    return { id, gtin: p.gtin, name: p.name, nameNorm: p.nameNorm, sizeKey: p.sizeKey };
  }

  async upsertChainItem(row: ChainItemRow & { manufacturer: string | null }) {
    this.db
      .prepare(`INSERT INTO chain_items (chain_id, item_code, product_id, raw_name, manufacturer, match_method, match_score, needs_review)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT (chain_id, item_code) DO UPDATE SET product_id = excluded.product_id, raw_name = excluded.raw_name,
                  manufacturer = excluded.manufacturer, match_method = excluded.match_method, match_score = excluded.match_score,
                  needs_review = excluded.needs_review, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(row.chainId, row.itemCode, row.productId, row.rawName, row.manufacturer, row.matchMethod, row.matchScore, row.needsReview ? 1 : 0);
  }

  async recordPrices(chainId: string, storeKey: string, prices: PriceWrite[], observedAt: Date): Promise<WriteResult> {
    const res: WriteResult = { inserted: 0, changed: 0, unchanged: 0 };
    const sel = this.db.prepare(`SELECT price FROM current_prices WHERE store_pk=? AND item_code=?`);
    const hist = this.db.prepare(`INSERT INTO price_history (store_pk, chain_id, item_code, price, valid_from) VALUES (?,?,?,?,?)`);
    const up = this.db.prepare(`INSERT INTO current_prices (store_pk, chain_id, item_code, price, unit_price, price_updated_at, observed_at)
                                VALUES (?,?,?,?,?,?,?)
                                ON CONFLICT (store_pk, item_code) DO UPDATE SET price = excluded.price, unit_price = excluded.unit_price,
                                  price_updated_at = excluded.price_updated_at, observed_at = excluded.observed_at`);
    const store = Number(storeKey);
    this.db.transaction(() => {
      for (const p of prices) {
        const cur = sel.get(store, p.itemCode) as Row | undefined;
        const prev = cur ? Number(cur.price) : null;
        if (prev === null) res.inserted++;
        else if (prev !== p.price) res.changed++;
        else res.unchanged++;
        if (prev === null || prev !== p.price) hist.run(store, chainId, p.itemCode, p.price, observedAt.toISOString());
        up.run(store, chainId, p.itemCode, p.price, p.unitPrice, iso(p.priceUpdatedAt), observedAt.toISOString());
      }
    })();
    return res;
  }

  async hasIngestedFile(fileName: string) {
    return this.db.prepare(`SELECT 1 FROM ingest_runs WHERE file_name=? AND status <> 'failed' LIMIT 1`).get(fileName) !== undefined;
  }

  async recordIngestRun(r: IngestRunInfo) {
    this.db
      .prepare(`INSERT INTO ingest_runs (chain_id, store_id, file_name, file_time, items_total, items_invalid, gtin_matched,
                  fuzzy_matched, new_products, needs_review, price_changes, status, issues) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.chainId, r.storeId, r.fileName, iso(r.fileTime), r.itemsTotal, r.itemsInvalid, r.gtinMatched, r.fuzzyMatched, r.newProducts, r.needsReview, r.priceChanges, r.status, JSON.stringify(r.issues));
  }

  async previousRun(chainId: string, storeId: string): Promise<IngestRunInfo | null> {
    const x = this.db
      .prepare(`SELECT * FROM ingest_runs WHERE chain_id=? AND store_id=? AND status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(chainId, storeId) as Row | undefined;
    if (!x) return null;
    return {
      chainId: x.chain_id, storeId: x.store_id, fileName: x.file_name, fileTime: date(x.file_time), itemsTotal: x.items_total,
      itemsInvalid: x.items_invalid, gtinMatched: x.gtin_matched, fuzzyMatched: x.fuzzy_matched, newProducts: x.new_products,
      needsReview: x.needs_review, priceChanges: x.price_changes, status: x.status, issues: JSON.parse(x.issues) as string[],
    };
  }

  async getProduct(id: number) {
    const r = this.db.prepare(`SELECT * FROM products WHERE id=?`).get(id) as Row | undefined;
    return r ? productFrom(r) : null;
  }

  async getProductByGtin(gtin: string) {
    return this.findProductByGtin(gtin.replace(/\D/g, "").padStart(13, "0"));
  }

  /**
   * שונה מ-Postgres: מועמדים לפי TrigramIndex בתהליך (סף 0.3 כמו pg_trgm) + התאמת תת-מחרוזת.
   * התוצאות דומות, אבל סדר תוצאות בשוויון ציון עשוי להיות שונה.
   */
  async searchProducts(query: string, limit: number): Promise<SearchHit[]> {
    const q = normalizeHebrew(query);
    if (!q) return [];
    const scores = new Map<number, number>();
    for (const h of this.index.query(q, 0.3, 500)) scores.set(h.id, h.similarity);
    const like = this.db.prepare(`SELECT id FROM products WHERE instr(name_norm, ?) > 0 LIMIT 500`).all(q) as Row[];
    for (const r of like) scores.set(r.id, Math.max(scores.get(r.id) ?? 0, 0.9));
    const agg = this.db.prepare(
      `SELECT min(cp.price) AS min_price, max(cp.price) AS max_price, count(DISTINCT cp.chain_id) AS chains
       FROM chain_items ci JOIN current_prices cp ON cp.chain_id = ci.chain_id AND cp.item_code = ci.item_code
       JOIN stores s ON s.id = cp.store_pk
       WHERE ci.product_id = ? AND ${this.scope()}`,
    );
    const getP = this.db.prepare(`SELECT * FROM products WHERE id=?`);
    const hits: SearchHit[] = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const a = agg.get(id) as Row;
        return {
          ...productFrom(getP.get(id) as Row), score,
          minPrice: a.min_price === null ? null : Number(a.min_price),
          maxPrice: a.max_price === null ? null : Number(a.max_price),
          chains: Number(a.chains),
        };
      });
    return hits.filter((h) => !this.onlineOnly || h.chains > 0).sort((a, b) => b.score - a.score || b.chains - a.chains || a.id - b.id).slice(0, limit);
  }

  async priceHistory(productId: number, opts: { chainId?: string; storeKey?: string; since?: Date }): Promise<HistoryPoint[]> {
    const rows = this.db
      .prepare(
        `SELECT h.chain_id, h.store_pk, h.price, h.valid_from
         FROM price_history h JOIN chain_items ci ON ci.chain_id = h.chain_id AND ci.item_code = h.item_code
         JOIN stores s ON s.id = h.store_pk
         WHERE ci.product_id = ? AND ${this.scope()}
           AND (? IS NULL OR h.chain_id = ?)
           AND (? IS NULL OR h.store_pk = ?)
           AND (? IS NULL OR h.valid_from >= ?)
         ORDER BY h.valid_from, h.id`,
      )
      .all(productId, opts.chainId ?? null, opts.chainId ?? null, opts.storeKey ? Number(opts.storeKey) : null, opts.storeKey ? Number(opts.storeKey) : null, iso(opts.since ?? null), iso(opts.since ?? null)) as Row[];
    return rows.map((x) => ({ chainId: x.chain_id, storeKey: String(x.store_pk), price: Number(x.price), validFrom: new Date(x.valid_from) }));
  }

  async basket(lines: BasketLine[], area: StoreArea, limit: number, requireAll: boolean): Promise<BasketStoreResult[]> {
    if (lines.length === 0) return [];
    const ids = lines.map((l) => l.productId);
    const where: string[] = [`ci.product_id IN (${ids.map(() => "?").join(",")})`, "s.is_online = ?", this.scope()];
    const args: Array<string | number> = [...ids, this.onlineOnly || area.online ? 1 : 0];
    if (area.text) {
      where.push("instr(s.search_text, ?) > 0");
      args.push(normalizeHebrew(area.text));
    }
    if (area.chainIds?.length) {
      where.push(`s.chain_id IN (${area.chainIds.map(() => "?").join(",")})`);
      args.push(...area.chainIds);
    }
    if (area.storeKeys?.length) {
      where.push(`s.id IN (${area.storeKeys.map(() => "?").join(",")})`);
      args.push(...area.storeKeys.map(Number));
    }
    // cheapest price per store and product (a product can have several chain codes)
    const rows = this.db
      .prepare(
        `SELECT s.id, s.chain_id, c.name AS chain_name, s.name, s.address, s.city, s.is_online, ci.product_id, min(cp.price) AS price
         FROM current_prices cp
         JOIN chain_items ci ON ci.chain_id = cp.chain_id AND ci.item_code = cp.item_code
         JOIN stores s ON s.id = cp.store_pk LEFT JOIN chains c ON c.chain_id = s.chain_id
         WHERE ${where.join(" AND ")}
         GROUP BY s.id, ci.product_id`,
      )
      .all(...args) as Row[];
    const qty = new Map(lines.map((l) => [l.productId, l.qty]));
    const byStore = new Map<number, { row: Row; total: number; have: Set<number> }>();
    for (const r of rows) {
      const e = byStore.get(r.id) ?? { row: r, total: 0, have: new Set<number>() };
      e.total += Number(r.price) * (qty.get(r.product_id) ?? 1);
      e.have.add(r.product_id);
      byStore.set(r.id, e);
    }
    const out: BasketStoreResult[] = [];
    for (const { row: x, total, have } of byStore.values()) {
      const missing = ids.filter((id) => !have.has(id));
      if (requireAll && missing.length) continue;
      out.push({
        chainId: x.chain_id, chainName: x.chain_name, storeKey: String(x.id), storeName: x.name, address: x.address, city: x.city,
        isOnline: x.is_online === 1, total: round2(total), found: have.size, missingProductIds: missing,
      });
    }
    return out.sort((a, b) => b.found - a.found || a.total - b.total).slice(0, limit);
  }

  async listStores(opts: { text?: string; chainIds?: string[]; online?: boolean; limit: number }): Promise<StoreListRow[]> {
    const where: string[] = [this.scope()];
    const args: Array<string | number> = [];
    if (opts.text) {
      where.push("instr(s.search_text, ?) > 0");
      args.push(normalizeHebrew(opts.text));
    }
    if (opts.chainIds?.length) {
      where.push(`s.chain_id IN (${opts.chainIds.map(() => "?").join(",")})`);
      args.push(...opts.chainIds);
    }
    if (opts.online !== undefined) {
      where.push("s.is_online = ?");
      args.push(opts.online ? 1 : 0);
    }
    const rows = this.db
      .prepare(`SELECT s.id, s.chain_id, c.name AS chain_name, s.name, s.address, s.city, s.is_online
                FROM stores s LEFT JOIN chains c ON c.chain_id = s.chain_id WHERE ${where.join(" AND ")}
                ORDER BY s.chain_id, s.name LIMIT ?`)
      .all(...args, opts.limit) as Row[];
    return rows.map((x) => ({ chainId: x.chain_id, chainName: x.chain_name, storeKey: String(x.id), storeName: x.name, address: x.address, city: x.city, isOnline: x.is_online === 1 }));
  }

  async freshness(): Promise<FreshnessRow[]> {
    const rows = this.db
      .prepare(
        `SELECT c.chain_id, c.name,
                (SELECT count(DISTINCT store_pk) FROM current_prices cp JOIN stores s ON s.id = cp.store_pk WHERE cp.chain_id = c.chain_id AND ${this.scope()}) AS stores,
                (SELECT count(*) FROM current_prices cp JOIN stores s ON s.id = cp.store_pk WHERE cp.chain_id = c.chain_id AND ${this.scope()}) AS current_prices,
                (SELECT max(file_time) FROM ingest_runs ir WHERE ir.chain_id = c.chain_id AND ir.status <> 'failed' AND EXISTS (SELECT 1 FROM stores s WHERE s.chain_id = ir.chain_id AND s.sub_chain_id || '-' || s.store_id = ir.store_id AND ${this.scope()})) AS last_file_time,
                (SELECT max(created_at) FROM ingest_runs ir WHERE ir.chain_id = c.chain_id AND EXISTS (SELECT 1 FROM stores s WHERE s.chain_id = ir.chain_id AND s.sub_chain_id || '-' || s.store_id = ir.store_id AND ${this.scope()})) AS last_ingest_at
         FROM chains c WHERE ${this.onlineOnly ? `c.chain_id IN (${ONLINE_CHAIN_IDS.map((id) => `'${id}'`).join(',')})` : '1=1'} ORDER BY c.chain_id`,
      )
      .all() as Row[];
    return rows.map((x) => ({
      chainId: x.chain_id, chainName: x.name, stores: Number(x.stores), currentPrices: Number(x.current_prices),
      lastFileTime: date(x.last_file_time), lastIngestAt: date(x.last_ingest_at),
    }));
  }

  async reviewQueue(limit: number) {
    const rows = this.db
      .prepare(`SELECT ci.*, p.name AS product_name FROM chain_items ci JOIN products p ON p.id = ci.product_id
                WHERE ci.needs_review = 1 AND EXISTS (SELECT 1 FROM current_prices cp JOIN stores s ON s.id = cp.store_pk WHERE cp.chain_id = ci.chain_id AND cp.item_code = ci.item_code AND ${this.scope()}) ORDER BY ci.updated_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((x) => ({
      chainId: x.chain_id, itemCode: x.item_code, productId: x.product_id, rawName: x.raw_name, matchMethod: x.match_method,
      matchScore: x.match_score, needsReview: x.needs_review === 1, productName: x.product_name,
    }));
  }

  async replaceStorePromotions(chainId: string, storeKey: string, fileName: string, observedAt: Date, promotions: PromotionWrite[]): Promise<PromoWriteResult> {
    const store = Number(storeKey);
    const res: PromoWriteResult = { promotions: 0, clubPromotions: 0, items: 0 };
    const insPromo = this.db.prepare(`INSERT INTO promotions (store_pk, chain_id, promotion_id, description, club_id, club_name, starts_at, ends_at, allow_multiple, is_coupon, file_name, observed_at)
                                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insItem = this.db.prepare(`INSERT OR IGNORE INTO promotion_items (promotion_pk, item_code, item_type, is_gift, min_qty, max_qty, discount_rate, discounted_price, min_purchase_amount, is_weighted)
                                     VALUES (?,?,?,?,?,?,?,?,?,?)`);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM promotions WHERE store_pk=?`).run(store);
      for (const p of promotions) {
        const info = insPromo.run(store, chainId, p.promotionId, p.description, p.clubId, p.clubName, iso(p.startsAt), iso(p.endsAt), p.allowMultipleDiscounts ? 1 : 0, p.isCoupon ? 1 : 0, fileName, observedAt.toISOString());
        const pk = Number(info.lastInsertRowid);
        res.promotions++;
        if (p.clubId !== "0") res.clubPromotions++;
        for (const it of p.items) {
          const r = insItem.run(pk, it.itemCode, it.itemType, it.isGift ? 1 : 0, it.minQty, it.maxQty, it.discountRate, it.discountedPrice, it.minPurchaseAmount, it.isWeighted ? 1 : 0);
          if (r.changes > 0) res.items++;
        }
      }
    })();
    return res;
  }

  async productPromotions(productId: number, opts: { chainId?: string }): Promise<PromotionRow[]> {
    const rows = this.db
      .prepare(
        `SELECT p.chain_id, c.name AS chain_name, p.store_pk, p.promotion_id, p.description, p.club_id, p.club_name, p.starts_at, p.ends_at,
                p.allow_multiple, p.is_coupon, i.item_code, i.is_gift, i.min_qty, i.max_qty, i.discount_rate, i.discounted_price, i.min_purchase_amount, i.is_weighted
         FROM promotion_items i
         JOIN promotions p ON p.id = i.promotion_pk
         JOIN chain_items ci ON ci.chain_id = p.chain_id AND ci.item_code = i.item_code
         JOIN stores s ON s.id = p.store_pk LEFT JOIN chains c ON c.chain_id = p.chain_id
         WHERE ci.product_id = ? AND ${this.scope()}
           AND (? IS NULL OR p.chain_id = ?)
         ORDER BY p.chain_id, p.club_id, p.promotion_id`,
      )
      .all(productId, opts.chainId ?? null, opts.chainId ?? null) as Row[];
    return rows.map((x) => ({
      chainId: x.chain_id, chainName: x.chain_name, storeKey: String(x.store_pk), promotionId: x.promotion_id, description: x.description,
      clubId: x.club_id, clubName: x.club_name, startsAt: date(x.starts_at), endsAt: date(x.ends_at),
      allowMultipleDiscounts: x.allow_multiple === 1, isCoupon: x.is_coupon === 1, itemCode: x.item_code, isGift: x.is_gift === 1,
      minQty: x.min_qty, maxQty: x.max_qty, discountRate: x.discount_rate, discountedPrice: x.discounted_price,
      minPurchaseAmount: x.min_purchase_amount, isWeighted: x.is_weighted === 1,
    }));
  }

  async currentChainPrices(productId: number): Promise<Array<{ chainId: string; chainName: string | null; price: number }>> {
    const rows = this.db
      .prepare(
        `SELECT s.chain_id, c.name AS chain_name, min(cp.price) AS price
         FROM current_prices cp
         JOIN chain_items ci ON ci.chain_id = cp.chain_id AND ci.item_code = cp.item_code
         JOIN stores s ON s.id = cp.store_pk LEFT JOIN chains c ON c.chain_id = s.chain_id
         WHERE ci.product_id = ? AND ${this.scope()}
         GROUP BY s.chain_id ORDER BY price`,
      )
      .all(productId) as Row[];
    return rows.map((x) => ({ chainId: x.chain_id, chainName: x.chain_name, price: Number(x.price) }));
  }

  async listClubs(): Promise<ClubRow[]> {
    const rows = this.db
      .prepare(
        `SELECT p.chain_id, c.name AS chain_name, p.club_id, p.club_name, count(DISTINCT p.id) AS promo_count
         FROM promotions p JOIN stores s ON s.id = p.store_pk LEFT JOIN chains c ON c.chain_id = p.chain_id
         WHERE p.club_id <> '0' AND ${this.scope()}
         GROUP BY p.chain_id, p.club_id ORDER BY p.chain_id, promo_count DESC`,
      )
      .all() as Row[];
    return rows.map((x) => ({ chainId: x.chain_id, chainName: x.chain_name, clubId: x.club_id, clubName: x.club_name, promoCount: Number(x.promo_count) }));
  }
}
