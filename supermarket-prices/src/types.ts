export interface PriceItem {
  itemCode: string;
  /** 1 = barcode (GTIN) according to the price-transparency spec, 0 = chain internal code */
  itemType: number | null;
  name: string;
  manufacturer: string | null;
  manufacturerDescription: string | null;
  unitQty: string | null;
  quantity: number | null;
  unitOfMeasure: string | null;
  isWeighted: boolean;
  qtyInPackage: string | null;
  price: number;
  unitPrice: number | null;
  priceUpdatedAt: Date | null;
  status: string | null;
}

export interface PriceFile {
  chainId: string;
  subChainId: string;
  storeId: string;
  items: PriceItem[];
  /** items that could not be read (missing code or price) */
  skipped: number;
}

export interface StoreRecord {
  chainId: string;
  subChainId: string;
  storeId: string;
  name: string | null;
  address: string | null;
  /** Some chains publish a CBS city code here (e.g. "3000"), others a name. Kept raw. */
  city: string | null;
  zip: string | null;
  /** StoreType=2 in the Stores file: an online/delivery store (its prices differ from physical branches) */
  isOnline: boolean;
}

export type FileKind = "price" | "pricefull" | "promo" | "promofull" | "stores" | "unknown";

export interface RemoteFile {
  chainKey: string;
  name: string;
  kind: FileKind;
  chainId: string | null;
  subChainId: string | null;
  storeId: string | null;
  publishedAt: Date | null;
  /** opaque handle the source understands (URL, file name...) */
  ref: string;
}

export interface ChainSource {
  key: string;
  name: string;
  listFiles(kinds: FileKind[], storeIds?: string[]): Promise<RemoteFile[]>;
  download(file: RemoteFile): Promise<Buffer>;
}

export interface PromoItem {
  itemCode: string;
  itemType: number | null;
  isGift: boolean;
  /** minimum quantity to get the promo price; null/0/1 = no condition */
  minQty: number | null;
  maxQty: number | null;
  /** percent off the regular price (mutually exclusive with discountedPrice in practice) */
  discountRate: number | null;
  /** promo price: the unit price when minQty <= 1, otherwise the price for the whole minQty bundle */
  discountedPrice: number | null;
  /** minimum basket amount for the promo (rare) */
  minPurchaseAmount: number | null;
  isWeighted: boolean;
}

export interface Promotion {
  promotionId: string;
  description: string | null;
  /** "0" = everyone; anything else = a chain club */
  clubId: string;
  clubName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allowMultipleDiscounts: boolean;
  isCoupon: boolean;
  items: PromoItem[];
}

export interface PromoFile {
  chainId: string;
  subChainId: string;
  storeId: string;
  promotions: Promotion[];
  /** promotions that could not be read (no items) */
  skipped: number;
}
