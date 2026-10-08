import type { ChainPromos } from "../api/types";
import { useApp, useAsync } from "../state";

/**
 * בחירת מועדון לכל רשת שיש לה מבצעי מועדון. הבחירה נשמרת מקומית ומשפיעה
 * על המחיר האפקטיבי שמוצג במוצרים. מועדון = clubId מהנתונים הרשמיים של הרשת.
 */
export function ClubSelector({ offers }: { offers: ChainPromos[] }) {
  const { api, clubs, setClub } = useApp();
  const { data: allClubs } = useAsync(() => api.clubs(), []);
  const chainIds = offers.map((o) => o.chainId);
  const byChain = new Map<string, typeof allClubs>();
  for (const c of allClubs ?? []) if (chainIds.includes(c.chainId)) byChain.set(c.chainId, [...(byChain.get(c.chainId) ?? []), c]);
  if (byChain.size === 0) return null;
  return (
    <div className="club-selector">
      {[...byChain.entries()].map(([chainId, list]) => {
        const name = list![0]?.chainName ?? offers.find((o) => o.chainId === chainId)?.chainName ?? chainId;
        return (
          <label key={chainId} className="club-field">
            <span>{name}</span>
            <select value={clubs[chainId] ?? ""} onChange={(e) => setClub(chainId, e.target.value || null)} aria-label={`מועדון ${name}`}>
              <option value="">לא חבר מועדון</option>
              {list!.map((c) => (
                <option key={c.clubId} value={c.clubId}>
                  {c.clubName ?? `מועדון ${c.clubId}`} ({c.promoCount} מבצעים)
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
