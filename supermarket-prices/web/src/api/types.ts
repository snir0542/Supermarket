/** צורת התשובות של ה-API (ראו src/api/app.ts בצד השרת). תאריכים מגיעים כמחרוזות ISO. */
export interface Product {
  id: number;
  gtin: string | null;
  name: string;
  nameNorm: string;
  sizeKey: string | null;
}

export interface SearchHit extends Product {
  minPrice: number | null;
  maxPrice: number | null;
  chains: number;
  score: number;
}

export interface HistoryPoint {
  chainId: string;
  storeKey: string;
  price: number;
  validFrom: string;
}

export interface HistoryResponse {
  product: Product;
  points: HistoryPoint[];
}

export interface StoreRow {
  chainId: string;
  chainName: string | null;
  storeKey: string;
  storeName: string | null;
  address: string | null;
  city: string | null;
  isOnline: boolean;
}

export interface BasketInput {
  gtin?: string;
  query?: string;
  qty?: number;
}

export interface BasketArea {
  text?: string;
  chainIds?: string[];
  storeKeys?: string[];
  online?: boolean;
}

export interface BasketStore {
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

export interface BasketResponse {
  resolved: Array<{ input: BasketInput; product: Product | null; note?: string }>;
  stores: BasketStore[];
  complete: boolean;
}

export interface ChainFreshness {
  chainId: string;
  chainName: string | null;
  status: "fresh" | "stale" | "never";
  ageHours: number | null;
  stores: number;
  currentPrices: number;
}

export interface ReviewItem {
  chainId: string;
  itemCode: string;
  productId: number;
  rawName: string;
  matchMethod: string;
  matchScore: number | null;
  needsReview: boolean;
  productName: string;
}

export interface ClubInfo {
  chainId: string;
  chainName: string | null;
  clubId: string;
  clubName: string | null;
  promoCount: number;
}

export interface EffectiveOffer {
  price: number;
  kind: "base" | "promo" | "club";
  conditional: boolean;
  condition: string | null;
}

export interface PromoView {
  chainId: string;
  chainName: string | null;
  promotionId: string;
  description: string | null;
  clubId: string;
  clubName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isCoupon: boolean;
  itemCode: string;
  isGift: boolean;
  minQty: number | null;
  maxQty: number | null;
  discountRate: number | null;
  discountedPrice: number | null;
  minPurchaseAmount: number | null;
  isWeighted: boolean;
  active: boolean;
  unitPrice: number | null;
  condition: string | null;
}

export interface ChainPromos {
  chainId: string;
  chainName: string | null;
  basePrice: number;
  selectedClub: string | null;
  regular: EffectiveOffer;
  member: EffectiveOffer;
  promotions: PromoView[];
}

export interface ProductPromosResponse {
  product: Product;
  chains: ChainPromos[];
}
