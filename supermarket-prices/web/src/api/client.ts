import { mockFetch } from "./mock";
import type { BasketArea, BasketInput, BasketResponse, ChainFreshness, ClubInfo, HistoryResponse, ProductPromosResponse, ReviewItem, SearchHit, StoreRow } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ApiClient {
  search(q: string, limit?: number): Promise<SearchHit[]>;
  history(ref: string | number): Promise<HistoryResponse>;
  stores(opts?: { online?: boolean; text?: string; limit?: number }): Promise<StoreRow[]>;
  basket(items: BasketInput[], area: BasketArea, requireAll: boolean): Promise<BasketResponse>;
  freshness(): Promise<ChainFreshness[]>;
  clubs(): Promise<ClubInfo[]>;
  productPromos(ref: string | number, clubs: Record<string, string>): Promise<ProductPromosResponse>;
  review(): Promise<ReviewItem[]>;
}

export function createClient(baseUrl: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, init);
    } catch {
      throw new ApiError(0, "אין חיבור לשרת. בדקו שה-API רץ או הפעילו מצב דמו.");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? `שגיאה ${res.status}`);
    }
    return (await res.json()) as T;
  }
  return {
    search: async (q, limit = 30) => (await call<{ results: SearchHit[] }>(`/products/search?q=${encodeURIComponent(q)}&limit=${limit}`)).results,
    history: (ref) => call<HistoryResponse>(`/products/${encodeURIComponent(String(ref))}/history`),
    stores: async (opts = {}) => {
      const p = new URLSearchParams();
      if (opts.online !== undefined) p.set("online", String(opts.online));
      if (opts.text) p.set("text", opts.text);
      p.set("limit", String(opts.limit ?? 200));
      return (await call<{ stores: StoreRow[] }>(`/stores?${p}`)).stores;
    },
    basket: (items, area, requireAll) =>
      call<BasketResponse>("/basket/cheapest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, area, requireAll, limit: 30 }),
      }),
    clubs: async () => (await call<{ clubs: ClubInfo[] }>("/promos/clubs")).clubs,
    productPromos: (ref, clubs) => {
      const q = Object.entries(clubs).map(([c, v]) => `${c}:${v}`).join(",");
      return call<ProductPromosResponse>(`/products/${encodeURIComponent(String(ref))}/promos${q ? `?clubs=${encodeURIComponent(q)}` : ""}`);
    },
    freshness: async () => (await call<{ chains: ChainFreshness[] }>("/quality/freshness")).chains,
    review: async () => (await call<{ items: ReviewItem[] }>("/quality/review")).items,
  };
}

export function isMockMode(): boolean {
  if (import.meta.env.VITE_USE_MOCK === "true") return true;
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";
}

export function defaultClient(): ApiClient {
  if (isMockMode()) return createClient("/mock", mockFetch);
  return createClient(import.meta.env.VITE_API_BASE_URL ?? "/api");
}
