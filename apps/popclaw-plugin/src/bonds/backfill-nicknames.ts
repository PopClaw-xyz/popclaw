/**
 * Startup nickname sync: reconcile the **nicknames** cached in the bond book
 * against the lore-house.
 *
 * A nickname is **a name someone else self-reports**, and it changes — in
 * the bond book it's a cache, not a one-time snapshot. Real-machine incident,
 * 2026-07-30: the owner changed their nickname on the lore-house to
 * "Blackfeather", but DMs arriving on host-b still displayed
 * `owl_scribe_7#7t4k2n9q`. Investigation: host-b's bond-book row had
 * `nickname = owl_scribe_7` — **an X handle had been written into the
 * nickname field**, and `fillNickname` only fills an empty slot (`WHERE
 * nickname = ''`), so:
 *   - the real nickname could never overwrite it;
 *   - `namelessIds()` no longer listed them either (the name "existed");
 *   - the `learn` write-back only fires on "no local hit, had to ask the
 *     lore-house", and locally they already existed → it would never fire
 *     again.
 * All three paths blocked at once = that handle permanently squatted the
 * nickname slot.
 *
 * Why the lore-house hands back a handle at all: `/v1/resolve`'s nickname is
 * "namecard, otherwise the first verified handle" (see the enrich section of
 * `resolve.rs`). Someone with no namecard gets propped up by their handle,
 * which beats nothing — but that **is not a nickname** and shouldn't be
 * stored as one on the client side into the bond book. The test is already
 * there for free: a candidate carries its own `profiles[].handle`, and if
 * `nickname` equals one of them, that's the tell that it's a propped-up
 * handle.
 *
 * So this pass does two things: **only write real nicknames**, and **keep
 * following the real nickname whenever it changes**.
 *
 * Bounded + best-effort: at most `limit` per run, serial, a single failure
 * just gets skipped. Not-found / unreachable always leaves the local value
 * untouched (`null`) — never erase a known name just because the lore-house
 * momentarily couldn't answer.
 *
 * ponytail: the worklist is "every bond-book row, top `limit` by
 * updated_at", one `/v1/resolve` per person. With a roster of a few dozen,
 * that's a few dozen GETs at startup, serial, off the hot path, best-effort
 * — cheap enough to ignore. Only worth revisiting a batch endpoint or a
 * "how often to sync" cadence once the roster hits the thousands.
 */

/** What the lore-house says about this person. `handles` is used to tell whether `nickname` is a handle propped up as a stand-in. */
export interface HouseName {
  readonly nickname: string;
  readonly handles: readonly string[];
}

export interface NicknameBackfillDeps {
  /** The worklist + write-back handle (two BondsStore methods). */
  store: {
    /** People due for a nickname sync (bond-book row must already exist; this function never creates one). */
    idsForNicknameSync(limit: number): string[];
    /** Unconditionally write the nickname; returns false if it matches what's stored (no pointless write). */
    syncNickname(popclawId: string, nickname: string): boolean;
  };
  /** One id → what the lore-house says about them; not-found / unreachable both resolve to null. */
  lookup: (popclawId: string) => Promise<HouseName | null>;
  /** Cap on one sync run, defaults to 50. */
  limit?: number;
  debug?: (msg: string) => void;
}

const DEFAULT_LIMIT = 50;

/** Case-insensitive: a handle's casing isn't stable across platforms — never mistake a handle for a nickname purely on casing. */
function isHandle(name: string, handles: readonly string[]): boolean {
  const n = name.trim().toLowerCase();
  return handles.some((h) => h.trim().toLowerCase() === n);
}

/** Returns the number of people whose name actually changed. An overall failure is the caller's to catch (this function only swallows per-person failures). */
export async function backfillBondNicknames(deps: NicknameBackfillDeps): Promise<number> {
  const ids = deps.store.idsForNicknameSync(deps.limit ?? DEFAULT_LIMIT);
  if (ids.length === 0) return 0;
  let changed = 0;
  for (const id of ids) {
    try {
      const house = await deps.lookup(id);
      // Not found / unreachable → leave the local value untouched.
      if (!house) continue;
      const name = house.nickname.trim();
      // Empty, or just a handle propped up as a stand-in → not a real
      // nickname, better to leave the slot empty (display falls back to the
      // handle tier on its own, see the name chain in identity/person-name.ts).
      if (!name || isHandle(name, house.handles)) continue;
      if (deps.store.syncNickname(id, name)) changed += 1;
    } catch {
      /* One person failing to resolve just gets skipped — the sync isn't worth stalling over anyone */
    }
  }
  deps.debug?.(`bond nickname sync: ${changed}/${ids.length} updated`);
  return changed;
}
