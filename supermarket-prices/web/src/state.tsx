import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { defaultClient, type ApiClient } from "./api/client";
import type { BasketInput, Product } from "./api/types";

export interface BasketItem {
  id: number;
  gtin: string | null;
  name: string;
  qty: number;
}

interface AppState {
  api: ApiClient;
  items: BasketItem[];
  add: (p: Pick<Product, "id" | "gtin" | "name">, qty?: number) => void;
  setQty: (id: number, qty: number) => void;
  remove: (id: number) => void;
  clear: () => void;
  online: boolean;
  setOnline: (v: boolean) => void;
  /** המועדון שנבחר לכל רשת (chainId -> clubId) */
  clubs: Record<string, string>;
  setClub: (chainId: string, clubId: string | null) => void;
}

const Ctx = createContext<AppState | null>(null);
const KEY = "supermarket-web-v1";

function load(): { items: BasketItem[]; online: boolean; clubs: Record<string, string> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { items?: BasketItem[]; online?: boolean; clubs?: Record<string, string> } | null;
    return { items: Array.isArray(raw?.items) ? raw!.items : [], online: true, clubs: raw?.clubs && typeof raw.clubs === "object" ? raw.clubs : {} };
  } catch {
    return { items: [], online: true, clubs: {} };
  }
}

export function AppProvider({ children, api }: { children: ReactNode; api?: ApiClient }) {
  const client = useMemo(() => api ?? defaultClient(), [api]);
  const [state, setState] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* מצב פרטי: ממשיכים בלי שמירה */
    }
  }, [state]);

  const add = useCallback((p: Pick<Product, "id" | "gtin" | "name">, qty = 1) => {
    setState((s) => {
      const ex = s.items.find((i) => i.id === p.id);
      const items = ex ? s.items.map((i) => (i.id === p.id ? { ...i, qty: i.qty + qty } : i)) : [...s.items, { id: p.id, gtin: p.gtin, name: p.name, qty }];
      return { ...s, items };
    });
  }, []);
  const setQty = useCallback((id: number, qty: number) => setState((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, qty: Math.max(1, Math.min(99, qty)) } : i)) })), []);
  const remove = useCallback((id: number) => setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) })), []);
  const clear = useCallback(() => setState((s) => ({ ...s, items: [] })), []);
  const setOnline = useCallback((_online: boolean) => setState((s) => ({ ...s, online: true })), []);
  const setClub = useCallback((chainId: string, clubId: string | null) => setState((s) => {
    const clubs = { ...s.clubs };
    if (clubId === null) delete clubs[chainId];
    else clubs[chainId] = clubId;
    return { ...s, clubs };
  }), []);

  const value = useMemo(() => ({ api: client, items: state.items, add, setQty, remove, clear, online: state.online, setOnline, clubs: state.clubs, setClub }), [client, state, add, setQty, remove, clear, setOnline, setClub]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider missing");
  return v;
}

export const toBasketInput = (i: BasketItem): BasketInput => (i.gtin ? { gtin: i.gtin, qty: i.qty } : { query: i.name, qty: i.qty });

/** טעינה אסינכרונית פשוטה עם מצבי loading/error */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => alive && (setData(d), setLoading(false)),
      (e: unknown) => alive && (setError(e instanceof Error ? e.message : "שגיאה"), setLoading(false)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
