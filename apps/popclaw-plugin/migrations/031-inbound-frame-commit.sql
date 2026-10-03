-- One commit point for an inbound frame.
--
-- Without this there is no place where the raw frame, the consumers' work and
-- the transport cursor become durable together — so a crash between them either
-- loses a frame the cursor has already passed, or replays one that was already
-- handled. Both are silent.

-- The bytes, once, by content identity alone.
--
-- Nothing reaches this table until its identity has been VERIFIED, because the
-- key is a claim until then. Bad bytes announcing a real original's event id
-- used to take the slot first and keep it: the genuine original arrived later,
-- was accepted, and the row still held the forgery's bytes. Keeping the refused
-- frame was right; storing it under the name it claimed was not.
--
-- This table used to carry the source that delivered them, which quietly made
-- it a delivery ledger as well — and a bad one, because `INSERT OR IGNORE` on
-- the event id keeps only whoever arrived FIRST. The same original reaching us
-- through a house that turned out not to be authorised, and later through the
-- one that was, left a record naming only the first. Content identity and
-- delivery authority are different questions and now live in different tables.
CREATE TABLE inbound_frames (
  event_id      TEXT PRIMARY KEY,
  envelope      BLOB    NOT NULL,
  first_seen_at INTEGER NOT NULL
);

-- Every delivery of those bytes, kept apart per source and per participation.
--
-- The key is the whole tuple on purpose: the same original may legitimately
-- arrive from two houses, on two streams, or across a logout and a new login,
-- and each of those is a separate fact about who was entitled to hand it over.
-- `disposition` is the independent state that keeps a refused frame from
-- reading as an accepted one merely because its bytes are on disk. It has three
-- values, not two: a frame no wired consumer claims was neither accepted nor
-- refused, and calling it either would be a lie about who looked at it.
CREATE TABLE inbound_deliveries (
  event_id         TEXT    NOT NULL,
  house_key        TEXT    NOT NULL,
  incarnation      TEXT    NOT NULL,
  owner_generation INTEGER NOT NULL,
  stream           TEXT    NOT NULL,
  disposition      TEXT    NOT NULL
                   CHECK (disposition IN ('accepted', 'refused', 'not-applicable')),
  reason           TEXT,
  received_at      INTEGER NOT NULL,
  PRIMARY KEY (event_id, house_key, incarnation, owner_generation, stream)
);

-- Bytes that never earned a name.
--
-- A separate table with its own key, because a refused frame is evidence about
-- whoever sent it and must be keepable without letting it occupy an identity it
-- has not established. `claimed_event_id` is recorded as what it SAID, next to
-- a digest of what it actually was.
CREATE TABLE inbound_quarantine (
  quarantine_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  claimed_event_id TEXT    NOT NULL,
  bytes_sha256     TEXT    NOT NULL,
  house_key        TEXT    NOT NULL,
  incarnation      TEXT    NOT NULL,
  owner_generation INTEGER NOT NULL,
  stream           TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  envelope         BLOB    NOT NULL,
  received_at      INTEGER NOT NULL
);

CREATE INDEX idx_inbound_quarantine_claimed ON inbound_quarantine (claimed_event_id);

-- The owner's CURRENT participation at a house.
--
-- Three different things get called a generation around here and none of them
-- can vouch for another: the house's own restore/rebuild incarnation, a
-- stream's log epoch, and this — which session of the owner's is the live one.
-- Carrying the number on a frame proves what the connection believed when it
-- opened, not that it is still true; only reading the current value at the
-- commit boundary does that.
--
-- It only ever goes up, and both logging in and logging out move it. Nothing
-- here deletes a cursor or a relation: leaving is not forgetting, and history
-- stays resumable. What stops is the effect a departed session can still have.
-- `active` is here because a number alone cannot say "nobody is here". Logging
-- out used to move the generation and nothing else, so the current value still
-- read as a live session: anything that built a connection from it would be
-- accepted and would advance cursors at a house the owner had left. The
-- generation is the tombstone that invalidates work in flight; `active` is
-- whether there is anyone to invalidate it FOR, and they are different answers.
--
-- One row per house, not per connection. A logical login covers every stream
-- that house serves — personal and world share it — and a second process
-- attaching is not a second login.
--
-- HOST-BOOT-01: this CREATE was removed. The old 2316 runtime creates its
-- OWN `house_participation` at runtime (house_origin-keyed lifecycle state),
-- so on any real install this statement failed and 031 rolled back — the
-- upgrade blocker itself. The relation chain's table now lives under its own
-- name, created by 038-relation-participation.sql; installs that already ran
-- the 031-era CREATE are ported by the runner's port step. Editing a recorded
-- migration's FILE is safe here: the runner records filenames, and this edit
-- removes a statement rather than changing what any recorded install depends
-- on (031's other tables are untouched below).

-- Transport position, per house AND per stream AND per incarnation.
--
-- All three, because none of them alone is the state: two streams from one
-- house advance independently, and a cursor from before a restore/rebuild is
-- not comparable to one after it. A single local counter cannot stand in for
-- eight logical subscriptions.
--
-- `position` is opaque. Nothing here parses it, orders it or takes a maximum of
-- it — a JS number would lose precision on a large one and a lexicographic
-- comparison would rank "10" below "9". What keeps it from going backwards is
-- the participation check above, plus whatever the transport itself knows about
-- its own ordering and hands in.
CREATE TABLE stream_cursors (
  house_key   TEXT NOT NULL,
  stream      TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  position    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (house_key, stream, incarnation)
);
