-- What a house declared about reads, as read out of the manifest we VERIFIED.
--
-- This is a projection, not a ledger. Nothing writes here except the one
-- transaction that commits a prepared house trust, from the exact bytes that
-- transaction's proof was checked over. It cannot advance on its own, it never
-- carries a declaration forward past a proof, and deleting a row only closes
-- reads until the next verified manifest re-establishes one.
--
-- The declaration used to live in `data/lorehouses/<slug>.handshake.json`,
-- written from an ordinary cache fetch that never looked at
-- `X-Popclaw-Manifest-Proof`. So the pin said "this key" and the declaration
-- said "this scheme" and nothing tied the two to one response: whoever could
-- answer the unauthenticated fetch chose which credential the client would
-- send to the house the pin named.
CREATE TABLE house_read_declaration (
  -- Canonical origin, the same key `house_binding_pin` is filed under.
  origin        TEXT PRIMARY KEY,
  -- The verified binding's key at the moment of projection. A read only uses
  -- this row when the pin still names the SAME key: a block that was resolved
  -- to a different key must not go on using the old key's declaration.
  house_key     TEXT NOT NULL,
  -- `read_auth.schemes` as a JSON array, verbatim. NULL is the house declaring
  -- nothing at all, which is a refusal; `[]` is the house declaring something
  -- that named nothing, which is a different refusal. The two stay distinct.
  schemes       TEXT,
  -- 1 when the SAME verified manifest carried a valid `house_session` board.
  -- This is what positively selects the house-issued session read lane; a
  -- leftover session row on this machine is not a declaration.
  session_board INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
