-- Which key we trust at which house, and what to do when that changes.
--
-- This is NOT the handshake cache. `data/lorehouses/<slug>.handshake.json` says
-- at the top of its own module that it is regenerable — delete it, restart, and
-- it comes back — which is exactly right for a guide and exactly wrong for a
-- pin: deleting a cache would then reset trust, and re-pinning silently to
-- whatever answered next. So the pin lives here, in the data root, alongside
-- the relations whose namespace it decides.
--
-- `house_key` IS that namespace: an edge is (house, author, target). A key that
-- quietly changes re-names every edge into a space nobody wrote them in, which
-- is why a change is fail-closed rather than a migration. Old evidence stays,
-- nothing moves, and nothing new applies until somebody resolves it on purpose.
CREATE TABLE house_binding_pin (
  -- Canonical origin, no trailing slash, no path. One row per house.
  origin           TEXT PRIMARY KEY,
  -- base58 Ed25519, the same spelling as a popclaw_id.
  house_key        TEXT NOT NULL,
  -- Stable across the house's restarts; changed by its restore/rebuild.
  incarnation      TEXT NOT NULL,
  -- How this pin was established. `configured` is the owner saying so and
  -- outranks everything; `tofu` is a first contact over validated HTTPS during
  -- an explicit first-trust step. A background reconnect establishes neither.
  source           TEXT NOT NULL CHECK (source IN ('configured', 'tofu')),
  first_trusted_at INTEGER NOT NULL,
  -- Last time a proof was verified against this pin. Evidence of liveness
  -- only; it never updates the key or the incarnation.
  confirmed_at     INTEGER NOT NULL,
  -- Set when a verified binding disagreed with this pin. While it is set the
  -- house is refused, and nothing here is overwritten — the record of what we
  -- trusted has to survive the thing that contradicted it, or there is nothing
  -- left to compare against when somebody comes to sort it out.
  blocked_reason   TEXT,
  blocked_at       INTEGER,
  -- Bumped by every change to this row. An owner deciding what to do about a
  -- block is deciding about a state they SAW, and by the time they answer the
  -- row may have moved — a newer configured pin, a newer block. Matching on
  -- "is blocked" alone let a stale decision revert both. The revision is what
  -- a decision names.
  revision         INTEGER NOT NULL DEFAULT 1
);
