import type { Config } from "../config.js";
import { matchItem } from "../normalize/matcher.js";
import { checkFile } from "../quality/checks.js";
import { parsePriceFile, parseStoresFile } from "../parser/priceFile.js";
import { parsePromoFile } from "../parser/promoFile.js";
import type { ChainSource, FileKind, PriceFile, PromoFile, RemoteFile, StoreRecord } from "../types.js";
import type { IngestRunInfo, PriceWrite, Repository } from "./repository.js";

export interface IngestOptions {
  config: Pick<Config, "fuzzyAutoThreshold" | "fuzzyReviewThreshold" | "maxPriceIls" | "maxFileAgeHours">;
  now?: () => Date;
}

/** Stores one parsed price file: match products, write current prices + history, run quality checks. */
export async function ingestPriceFile(
  repo: Repository,
  file: PriceFile,
  meta: { fileName: string; fileTime: Date | null; expectedChainId: string | null; chainName?: string | null },
  opts: IngestOptions,
): Promise<IngestRunInfo> {
  const now = opts.now?.() ?? new Date();
  const chainId = file.chainId || meta.expectedChainId || "unknown";
  if (meta.expectedChainId && file.chainId && meta.expectedChainId !== file.chainId) {
    // wrong chain inside the file: do not write anything, just record the failure
    const bad: IngestRunInfo = {
      chainId, storeId: `${file.subChainId}-${file.storeId}`, fileName: meta.fileName, fileTime: meta.fileTime,
      itemsTotal: 0, itemsInvalid: file.items.length + file.skipped, gtinMatched: 0, fuzzyMatched: 0, newProducts: 0,
      needsReview: 0, priceChanges: 0, status: "failed",
      issues: [`CHAIN_MISMATCH: ChainId בקובץ (${file.chainId}) שונה מהצפוי (${meta.expectedChainId})`],
    };
    await repo.recordIngestRun(bad);
    return bad;
  }
  await repo.upsertChain(chainId, meta.chainName ?? null);
  const storeKey = await repo.ensureStore(chainId, file.subChainId, file.storeId);
  const prev = await repo.previousRun(chainId, `${file.subChainId}-${file.storeId}`);

  const seen = new Set<string>();
  let duplicates = 0;
  let invalid = file.skipped;
  let gtinMatched = 0;
  let fuzzyMatched = 0;
  let newProducts = 0;
  let needsReview = 0;
  const prices: PriceWrite[] = [];

  for (const item of file.items) {
    if (seen.has(item.itemCode)) {
      duplicates++;
      continue;
    }
    seen.add(item.itemCode);
    if (!(item.price > 0) || item.price > opts.config.maxPriceIls) {
      invalid++;
      continue;
    }
    const m = await matchItem(repo, chainId, item, { auto: opts.config.fuzzyAutoThreshold, review: opts.config.fuzzyReviewThreshold });
    if (m.method === "gtin") gtinMatched++;
    else if (m.method === "fuzzy") fuzzyMatched++;
    else if (m.method === "new") newProducts++;
    if (m.needsReview) needsReview++;
    await repo.upsertChainItem({
      chainId, itemCode: item.itemCode, productId: m.productId, rawName: item.name, matchMethod: m.method,
      matchScore: m.score, needsReview: m.needsReview, manufacturer: item.manufacturer,
    });
    prices.push({ itemCode: item.itemCode, price: item.price, unitPrice: item.unitPrice, priceUpdatedAt: item.priceUpdatedAt });
  }

  const written = await repo.recordPrices(chainId, storeKey, prices, meta.fileTime ?? now);
  const issues = checkFile(
    { expectedChainId: meta.expectedChainId, fileChainId: file.chainId, itemsTotal: prices.length, itemsInvalid: invalid, duplicates, gtinMatched, fileTime: meta.fileTime },
    prev, opts.config, now,
  );
  const run: IngestRunInfo = {
    chainId, storeId: `${file.subChainId}-${file.storeId}`, fileName: meta.fileName, fileTime: meta.fileTime,
    itemsTotal: prices.length, itemsInvalid: invalid, gtinMatched, fuzzyMatched, newProducts, needsReview,
    priceChanges: written.changed,
    status: issues.some((i) => i.severity === "error") ? "failed" : issues.length ? "warning" : "ok",
    issues: issues.map((i) => `${i.code}: ${i.message}`),
  };
  await repo.recordIngestRun(run);
  return run;
}

/** Stores one parsed promo file as the store's current promotion snapshot. */
export async function ingestPromoFile(
  repo: Repository,
  file: PromoFile,
  meta: { fileName: string; fileTime: Date | null; expectedChainId: string | null; chainName?: string | null },
  opts: IngestOptions,
): Promise<IngestRunInfo> {
  const now = opts.now?.() ?? new Date();
  const chainId = file.chainId || meta.expectedChainId || "unknown";
  await repo.upsertChain(chainId, meta.chainName ?? null);
  const storeKey = await repo.ensureStore(chainId, file.subChainId, file.storeId);
  const written = await repo.replaceStorePromotions(chainId, storeKey, meta.fileName, meta.fileTime ?? now, file.promotions);
  const run: IngestRunInfo = {
    chainId, storeId: `${file.subChainId}-${file.storeId}`, fileName: meta.fileName, fileTime: meta.fileTime,
    itemsTotal: written.promotions, itemsInvalid: file.skipped, gtinMatched: 0, fuzzyMatched: 0, newProducts: 0,
    needsReview: 0, priceChanges: 0, status: "ok",
    issues: [`PROMOS: ${written.promotions} מבצעים (${written.clubPromotions} מועדון), ${written.items} פריטים`],
  };
  await repo.recordIngestRun(run);
  return run;
}

export interface SourceIngestSummary {
  source: string;
  filesSeen: number;
  filesIngested: number;
  filesSkipped: number;
  failures: Array<{ file: string; error: string }>;
  runs: IngestRunInfo[];
}

const stripZeros = (id: string) => id.replace(/^0+(?=\d)/, "");

/**
 * Some chains publish a different StoreID inside the file than in its name (Carrefour online:
 * file name 471, XML field 530). The file name is what the Stores file and the directory agree on,
 * so it wins when the two differ numerically (zero padding alone is normalized silently).
 */
export function reconcileStoreId(parsed: PriceFile, file: RemoteFile): { file: PriceFile; note: string | null } {
  if (!file.storeId || file.storeId === parsed.storeId) return { file: parsed, note: null };
  // only zero padding differs (Rami Levy: "39" in the XML, "039" in the name and Stores file): same store, keep the Stores spelling
  if (stripZeros(file.storeId) === stripZeros(parsed.storeId)) return { file: { ...parsed, storeId: file.storeId }, note: null };
  return {
    file: { ...parsed, storeId: file.storeId, subChainId: file.subChainId ?? parsed.subChainId },
    note: `STORE_ID_FROM_FILENAME: StoreID בקובץ (${parsed.storeId}) שונה משם הקובץ (${file.storeId}); נעשה שימוש בשם הקובץ`,
  };
}

/** Keeps only the newest file per store (for price kinds). */
export function latestPerStore(files: RemoteFile[]): RemoteFile[] {
  const best = new Map<string, RemoteFile>();
  for (const f of files) {
    const key = `${f.kind}:${f.chainId}:${f.subChainId}:${f.storeId}`;
    const cur = best.get(key);
    if (!cur || (f.publishedAt?.getTime() ?? 0) > (cur.publishedAt?.getTime() ?? 0)) best.set(key, f);
  }
  return [...best.values()];
}

export async function ingestSource(
  repo: Repository,
  source: ChainSource,
  opts: IngestOptions & { kinds?: FileKind[]; maxFiles?: number; expectedChainId?: string | null; onlineOnly?: boolean },
): Promise<SourceIngestSummary> {
  const onlineOnly = opts.onlineOnly ?? false;
  const kinds = opts.kinds ?? ["pricefull"];
  const summary: SourceIngestSummary = { source: source.key, filesSeen: 0, filesIngested: 0, filesSkipped: 0, failures: [], runs: [] };
  const listed = await source.listFiles(["stores"]);
  summary.filesSeen = listed.length;

  const onlineStoreIds = new Set<string>();
  const canonical = new Map<string, StoreRecord>(); // chain:sub:store without zero padding -> the Stores file spelling
  const storeFiles = latestPerStore(listed.filter((f) => f.kind === "stores"));
  for (const sf of storeFiles) {
    try {
      const stores = parseStoresFile(await source.download(sf));
      await repo.upsertChain(stores[0]?.chainId ?? sf.chainId ?? source.key, source.name);
      await repo.upsertStores(onlineOnly ? stores.filter((s) => s.isOnline) : stores);
      for (const s of stores) canonical.set(`${s.chainId}:${stripZeros(s.subChainId)}:${stripZeros(s.storeId)}`, s);
      for (const s of stores) if (s.isOnline) onlineStoreIds.add(`${s.chainId}:${stripZeros(s.storeId)}`);
    } catch (e) {
      summary.failures.push({ file: sf.name, error: (e as Error).message });
    }
  }

  const ids = [...onlineStoreIds].map((key) => key.split(":")[1]!);
  const prices = onlineOnly && ids.length === 0 ? [] : await source.listFiles(kinds, onlineOnly ? ids : undefined);
  summary.filesSeen += prices.length;
  let priceFiles = latestPerStore(prices.filter((f) => kinds.includes(f.kind)));
  if (onlineOnly) {
    // only stores the Stores file marks as StoreType=2; without a readable Stores file nothing is ingested
    priceFiles = priceFiles.filter((f) => f.chainId && f.storeId && onlineStoreIds.has(`${f.chainId}:${stripZeros(f.storeId)}`));
  }
  if (onlineOnly && onlineStoreIds.size === 0) summary.failures.push({ file: "online-store-selection", error: "No online stores identified from readable Stores files; physical stores will not be used" });
  else if (onlineOnly && priceFiles.length === 0) summary.failures.push({ file: "online-price-selection", error: "No online price files available; physical stores will not be used" });
  if (opts.maxFiles) priceFiles = priceFiles.slice(0, opts.maxFiles);
  for (const f of priceFiles) {
    if (await repo.hasIngestedFile(f.name)) {
      summary.filesSkipped++;
      continue;
    }
    try {
      if (f.kind === "promofull") {
        const parsedPromo = parsePromoFile(await source.download(f));
        const pseudo: PriceFile = { chainId: parsedPromo.chainId, subChainId: parsedPromo.subChainId, storeId: parsedPromo.storeId, items: [], skipped: 0 };
        const { file: rec } = reconcileStoreId(pseudo, f);
        const exactP = canonical.get(`${rec.chainId}:${stripZeros(rec.subChainId)}:${stripZeros(rec.storeId)}`);
        const candidatesP = [...canonical.values()].filter((s) => s.chainId === rec.chainId && stripZeros(s.storeId) === stripZeros(rec.storeId));
        const knownP = exactP ?? (candidatesP.length === 1 ? candidatesP[0] : undefined);
        if (onlineOnly && !knownP?.isOnline) throw new Error("Online store identity could not be verified");
        const finalPromo = knownP ? { ...parsedPromo, subChainId: knownP.subChainId, storeId: knownP.storeId } : parsedPromo;
        const run = await ingestPromoFile(repo, finalPromo, { fileName: f.name, fileTime: f.publishedAt, expectedChainId: opts.expectedChainId ?? f.chainId, chainName: source.name }, opts);
        summary.runs.push(run);
        summary.filesIngested++;
        continue;
      }
      const { file: reconciled, note } = reconcileStoreId(parsePriceFile(await source.download(f)), f);
      // "1"/"39" in the XML vs "001"/"039" in the Stores file are the same store: use one spelling
      const exact = canonical.get(`${reconciled.chainId}:${stripZeros(reconciled.subChainId)}:${stripZeros(reconciled.storeId)}`);
      // Shufersal may use different sub-chain IDs in Stores and Prices. Only use an unambiguous store match.
      const candidates = [...canonical.values()].filter((s) => s.chainId === reconciled.chainId && stripZeros(s.storeId) === stripZeros(reconciled.storeId));
      const known = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (onlineOnly && !known?.isOnline) throw new Error("Online store identity could not be verified");
      const parsed = known ? { ...reconciled, subChainId: known.subChainId, storeId: known.storeId } : reconciled;
      const run = await ingestPriceFile(repo, parsed, { fileName: f.name, fileTime: f.publishedAt, expectedChainId: opts.expectedChainId ?? f.chainId, chainName: source.name }, opts);
      if (note) run.issues.push(note);
      summary.runs.push(run);
      summary.filesIngested++;
    } catch (e) {
      summary.failures.push({ file: f.name, error: (e as Error).message });
    }
  }
  return summary;
}
