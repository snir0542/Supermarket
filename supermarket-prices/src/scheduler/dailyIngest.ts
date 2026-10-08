import type { ChainSource } from "../types.js";
import type { Repository } from "../ingest/repository.js";
import { ingestSource, type SourceIngestSummary } from "../ingest/ingest.js";
import { evaluateFreshness, type ChainFreshness } from "../quality/checks.js";
import type { Config } from "../config.js";

export interface RetryPolicy {
  /** total attempts per chain (1 = no retry) */
  attempts: number;
  /** wait before the 2nd attempt; doubles (x factor) on every further attempt */
  baseDelayMs: number;
  factor: number;
}

export type ChainStatus = "ok" | "partial" | "failed";

export interface ChainResult {
  chain: string;
  status: ChainStatus;
  attempts: number;
  filesIngested: number;
  filesSkipped: number;
  fileFailures: number;
  error?: string;
  durationMs: number;
}

export interface DailyIngestReport {
  startedAt: Date;
  finishedAt: Date;
  chains: ChainResult[];
  freshness: ChainFreshness[];
  freshnessError?: string;
}

export interface DailyIngestDeps {
  repo: Repository;
  sources: ChainSource[];
  config: Config;
  retry: RetryPolicy;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /** injectable for tests; defaults to the real ingestSource */
  ingest?: (repo: Repository, source: ChainSource, config: Config) => Promise<SourceIngestSummary>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A run where every single file failed (and nothing was new/skipped) is treated as a failure worth retrying. */
function isTotalFailure(s: SourceIngestSummary): boolean {
  return s.failures.length > 0 && s.filesIngested === 0 && s.filesSkipped === 0;
}

/**
 * One chain with retry + backoff. Never throws: a dead chain becomes a "failed" result,
 * so it cannot stop the other chains.
 */
export async function ingestChainWithRetry(source: ChainSource, deps: DailyIngestDeps): Promise<ChainResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  const ingest =
    deps.ingest ?? ((repo, src, config) => ingestSource(repo, src, { config, kinds: ["pricefull", "promofull"], onlineOnly: config.onlineOnly })); // Stores files + all PriceFull, online stores included
  const started = Date.now();
  const attempts = Math.max(1, deps.retry.attempts);
  let last: SourceIngestSummary | undefined;
  let error: string | undefined;
  let used = 0;
  for (let i = 1; i <= attempts; i++) {
    used = i;
    try {
      last = await ingest(deps.repo, source, deps.config);
      error = last.failures.length ? last.failures[0]!.error : undefined;
      if (!isTotalFailure(last)) break;
      log(`[${source.key}] attempt ${i}/${attempts}: all ${last.failures.length} files failed (${error})`);
    } catch (e) {
      last = undefined;
      error = (e as Error).message;
      log(`[${source.key}] attempt ${i}/${attempts} failed: ${error}`);
    }
    if (i < attempts) {
      const wait = deps.retry.baseDelayMs * Math.pow(deps.retry.factor, i - 1);
      log(`[${source.key}] retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  const fileFailures = last?.failures.length ?? 0;
  const status: ChainStatus = !last || isTotalFailure(last) ? "failed" : fileFailures > 0 ? "partial" : "ok";
  return {
    chain: source.key,
    status,
    attempts: used,
    filesIngested: last?.filesIngested ?? 0,
    filesSkipped: last?.filesSkipped ?? 0,
    fileFailures,
    error: status === "ok" ? undefined : error,
    durationMs: Date.now() - started,
  };
}

/** Full daily ingest: every configured chain (sequentially), then the freshness check. */
export async function runDailyIngest(deps: DailyIngestDeps): Promise<DailyIngestReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const startedAt = now();
  const chains: ChainResult[] = [];
  for (const source of deps.sources) {
    const r = await ingestChainWithRetry(source, deps);
    chains.push(r);
    log(
      `[${r.chain}] ${r.status}: ingested=${r.filesIngested} skipped=${r.filesSkipped} fileFailures=${r.fileFailures} attempts=${r.attempts}` +
        (r.error ? ` error=${r.error}` : ""),
    );
  }
  let freshness: ChainFreshness[] = [];
  let freshnessError: string | undefined;
  try {
    freshness = evaluateFreshness(await deps.repo.freshness(), deps.config, now());
    for (const c of freshness) log(`[quality] ${c.chainId} ${c.chainName ?? ""}: ${c.status} age=${c.ageHours ?? "-"}h stores=${c.stores} prices=${c.currentPrices}`);
  } catch (e) {
    freshnessError = (e as Error).message;
    log(`[quality] freshness check failed: ${freshnessError}`);
  }
  const report: DailyIngestReport = { startedAt, finishedAt: now(), chains, freshness, freshnessError };
  const ok = chains.filter((c) => c.status === "ok").length;
  log(`[daily-ingest] done: ${ok}/${chains.length} chains ok, ${chains.filter((c) => c.status === "failed").length} failed`);
  return report;
}
