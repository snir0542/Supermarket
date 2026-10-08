import type { StoreRecord } from "../types.js";

export interface ProductRow {
  id: number;
  gtin: string | null;
  name: string;
  nameNorm: string;
  sizeKey: string | null;
}

export interface SimilarProduct extends ProductRow {
  similarity: number;
}

export type MatchMethod = "gtin" | "chain-code" | "fuzzy" | "new";

export interface ChainItemRow {
  chainId: string;
  itemCode: string;
  productId: number;
  rawName: string;
  matchMethod: MatchMethod;
  matchScore: number | null;
  needsReview: boolean;
}

export interface PriceWrite {
  itemCode: string;
  price: number;
  unitPrice: number | null;
  priceUpdatedAt: Date | null;
}

export interface WriteResult {
  inserted: number;
  changed: number;
  unchanged: number;
}

export interface IngestRunInfo {
  chainId: string;
  storeId: string;
  fileName: string;
  fileTime: Date | null;
  itemsTotal: number;
  itemsInvalid: number;
  gtinMatched: number;
  fuzzyMatched: number;
  newProducts: number;
  needsReview: number;
  priceChanges: number;
  status: "ok" | "warning" | "failed";
  issues: string[];
}

export interface StoreArea {
  /** substring matched against store city / address / name (normalized) */
  text?: string;
  chainIds?: string[];
  storeKeys?: string[];
  /** true = only online stores (StoreType=2), false/omitted = only physical branches. Never mixed. */
  online?: boolean;
}

export interface BasketLine {
  productId: number;
  qty: number;
}

export interface BasketStoreResult {
  chainId: string;
  chainName: string | null;
  storeKey: string;
  storeName: string | null;
  address: string | null;
  city: string | null;
  isOnline: boolean;
  total: number;
  found: number;
  missingProductIds: number[];
}

export interface SearchHit extends ProductRow {
  minPrice: number | null;
  maxPrice: number | null;
  chains: number;
  score: number;
}

export interface HistoryPoint {
  chainId: string;
  storeKey: string;
  price: number;
  validFrom: Date;
}

export interface FreshnessRow {
  chainId: string;
  chainName: string | null;
  stores: number;
  currentPrices: number;
  lastFileTime: Date | null;
  lastIngestAt: Date | null;
}

export interface StoreListRow {
  chainId: string;
  chainName: string | null;
  storeKey: string;
  storeName: string | null;
  address: string | null;
  city: string | null;
  isOnline: boolean;
}

export interface Repository {
  upsertChain(chainId: string, name: string | null): Promise<void>;
  upsertStores(stores: StoreRecord[]): Promise<void>;
  /** ensures a store row exists (price files do not always have a Stores file yet); returns "sub-store" key */
  ensureStore(chainId: string, subChainId: string, storeId: string): Promise<string>;
  getChainItem(chainId: string, itemCode: string): Promise<ChainItemRow | null>;
  findProductByGtin(gtin: string): Promise<ProductRow | null>;
  findSimilarProducts(nameNorm: string, minSimilarity: number, limit: number): Promise<SimilarProduct[]>;
  createProduct(p: { gtin: string | null; name: string; nameNorm: string; sizeKey: string | null }): Promise<ProductRow>;
  upsertChainItem(row: ChainItemRow & { manufacturer: string | null }): Promise<void>;
  /** writes current prices and appends history rows when the price is new or changed */
  recordPrices(chainId: string, storeKey: string, prices: PriceWrite[], observedAt: Date): Promise<WriteResult>;
  hasIngestedFile(fileName: string): Promise<boolean>;
  recordIngestRun(run: IngestRunInfo): Promise<void>;
  previousRun(chainId: string, storeId: string): Promise<IngestRunInfo | null>;

  searchProducts(query: string, limit: number): Promise<SearchHit[]>;
  getProduct(id: number): Promise<ProductRow | null>;
  getProductByGtin(gtin: string): Promise<ProductRow | null>;
  priceHistory(productId: number, opts: { chainId?: string; storeKey?: string; since?: Date }): Promise<HistoryPoint[]>;
  basket(lines: BasketLine[], area: StoreArea, limit: number, requireAll: boolean): Promise<BasketStoreResult[]>;
  freshness(): Promise<FreshnessRow[]>;
  /** online undefined = both physical and online stores */
  listStores(opts: { text?: string; chainIds?: string[]; online?: boolean; limit: number }): Promise<StoreListRow[]>;
  reviewQueue(limit: number): Promise<Array<ChainItemRow & { productName: string }>>;  /** replaces the store's promotion snapshot with the given file's promotions */
  replaceStorePromotions(chainId: string, storeKey: string, fileName: string, observedAt: Date, promotions: PromotionWrite[]): Promise<PromoWriteResult>;
  /** promotions for a product (joined through chain_items), across online stores by default */
  productPromotions(productId: number, opts: { chainId?: string }): Promise<PromotionRow[]>;
  /** lowest current price per chain for a product (online stores when scoped) */
  currentChainPrices(productId: number): Promise<Array<{ chainId: string; chainName: string | null; price: number }>>;
  /** clubs seen in current promotions (club_id != '0'), per chain */
  listClubs(): Promise<ClubRow[]>;

}

export interface PromotionWrite {
  promotionId: string;
  description: string | null;
  clubId: string;
  clubName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allowMultipleDiscounts: boolean;
  isCoupon: boolean;
  items: Array<{
    itemCode: string;
    itemType: number | null;
    isGift: boolean;
    minQty: number | null;
    maxQty: number | null;
    discountRate: number | null;
    discountedPrice: number | null;
    minPurchaseAmount: number | null;
    isWeighted: boolean;
  }>;
}

export interface PromoWriteResult {
  promotions: number;
  clubPromotions: number;
  items: number;
}

export interface PromotionRow {
  chainId: string;
  chainName: string | null;
  storeKey: string;
  promotionId: string;
  description: string | null;
  clubId: string;
  clubName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allowMultipleDiscounts: boolean;
  isCoupon: boolean;
  itemCode: string;
  isGift: boolean;
  minQty: number | null;
  maxQty: number | null;
  discountRate: number | null;
  discountedPrice: number | null;
  minPurchaseAmount: number | null;
  isWeighted: boolean;
}

export interface ClubRow {
  chainId: string;
  chainName: string | null;
  clubId: string;
  clubName: string | null;
  promoCount: number;
}
