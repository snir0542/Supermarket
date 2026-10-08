import { ProductImages } from "./productImages.js";
import type { IngestStatus } from "./autoIngest.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Config } from "../config.js";
import { evaluateFreshness } from "../quality/checks.js";
import { PriceService } from "../service.js";

const basketSchema = z.object({
  items: z.array(z.object({ gtin: z.string().optional(), query: z.string().optional(), qty: z.number().positive().optional() })
    .refine((i) => i.gtin || i.query, "gtin or query required")).min(1).max(100),
  area: z.object({
    text: z.string().optional(),
    chainIds: z.array(z.string()).optional(),
    storeKeys: z.array(z.string()).optional(),
    online: z.boolean().optional(),
  }).default({}),
  limit: z.number().int().min(1).max(50).optional(),
  requireAll: z.boolean().optional(),
});

/** Hono was picked over Fastify: tiny, Web-standard Request/Response (easy to test with app.request), first-class TS types. */
export function createApp(service: PriceService, config: Pick<Config, "maxFileAgeHours">, opts: { corsOrigin?: string; ingestStatus?: () => IngestStatus } = {}) {
  const app = new Hono();
  const images = new ProductImages(process.env.IMAGE_CACHE_PATH ?? "data/product-images.json");
  // רק כשה-web app רץ על origin אחר (CORS_ORIGIN=http://localhost:5173 או *). בברירת מחדל ה-proxy של Vite/nginx מספיק.
  if (opts.corsOrigin) app.use("*", cors({ origin: opts.corsOrigin === "*" ? "*" : opts.corsOrigin.split(",").map((o) => o.trim()) }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ingest/status", (c) => c.json(opts.ingestStatus?.() ?? { phase: "disabled" }));

  app.get("/products/:gtin/image", async (c) => {
    const image = await images.get(c.req.param("gtin"));
    c.header("Cache-Control", image.retryAfter ? "no-store" : "public, max-age=3600");
    return c.json(image);
  });

  app.get("/products/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ error: "q is required" }, 400);
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({ results: await service.searchProducts(q, Number.isFinite(limit) ? limit : 20) });
  });

  app.get("/products/:ref/history", async (c) => {
    const ref = c.req.param("ref");
    const isGtin = /^\d{8,14}$/.test(ref);
    const days = c.req.query("days") ? Number(c.req.query("days")) : undefined;
    const out = await service.priceHistory(
      isGtin ? { gtin: ref } : /^\d+$/.test(ref) ? { id: Number(ref) } : { query: decodeURIComponent(ref) },
      { chainId: c.req.query("chain") || undefined, storeKey: c.req.query("store") || undefined, days },
    );
    return out ? c.json(out) : c.json({ error: "product not found" }, 404);
  });

  app.get("/promos/clubs", async (c) => c.json({ clubs: await service.listClubs() }));

  app.get("/products/:ref/promos", async (c) => {
    const ref = c.req.param("ref");
    const isGtin = /^\d{8,14}$/.test(ref);
    // clubs=7290027600007:3,7290058140886:2 — המועדון שהמשתמש בחר לכל רשת
    const clubs: Record<string, string> = {};
    for (const part of (c.req.query("clubs") ?? "").split(",")) {
      const [chainId, clubId] = part.split(":");
      if (chainId && clubId) clubs[chainId.trim()] = clubId.trim();
    }
    const out = await service.productPromos(
      isGtin ? { gtin: ref } : /^\d+$/.test(ref) ? { id: Number(ref) } : { query: decodeURIComponent(ref) },
      clubs,
    );
    return out ? c.json(out) : c.json({ error: "product not found" }, 404);
  });

  app.post("/basket/cheapest", async (c) => {
    const parsed = basketSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    const { items, area, limit, requireAll } = parsed.data;
    return c.json(await service.cheapestBasket(items, area, { limit, requireAll }));
  });

  app.get("/stores", async (c) => {
    const online = c.req.query("online");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({
      stores: await service.listStores({
        text: c.req.query("text")?.trim() || undefined,
        chainIds: c.req.query("chain")?.split(",").filter(Boolean),
        online: online === undefined ? undefined : online === "true",
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  app.get("/quality/freshness", async (c) => c.json({ chains: evaluateFreshness(await service.freshness(), config) }));
  app.get("/quality/review", async (c) => c.json({ items: await service.reviewQueue() }));

  return app;
}
