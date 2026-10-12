/**
 * Typebox schemas for popclaw tool registrations. One TSchema per tool
 * input. Centralized here so register-tools.ts is a thin wiring layer.
 *
 */
import { Type, type TSchema } from 'typebox';

export const EmptySchema = Type.Object({});

export const ShowFeedSchema = Type.Object({
  filter_by_author: Type.Optional(
    Type.String({
      description:
        'a popclaw_id, or the name the owner said (e.g. "Elon Musk"); a name is resolved to a popclaw_id first (optional)',
    }),
  ),
  limit: Type.Optional(
    Type.Number({ default: 20, description: 'max items to show' }),
  ),
});

export const SearchFeedSchema = Type.Object({
  query: Type.String({
    description:
      'keyword / topic / person (e.g. "Elon", "SpaceX launch"); several words are ANDed together. ' +
      'Matched against the cached posts\' body preview / handle / source link.',
  }),
  limit: Type.Optional(
    Type.Number({ default: 10, description: 'max matches to return' }),
  ),
});

export const FindBondsSchema = Type.Object({
  query: Type.String({
    description: 'natural language, e.g. "what my business partners have been up to" / "the investors I know"',
  }),
});

export const ShowBondsSchema = Type.Object({
  min_tier: Type.Optional(
    Type.String({
      description: 'only show bonds at or above this tier: acquaintance|friend|close',
    }),
  ),
  limit: Type.Optional(
    Type.Number({ default: 30, minimum: 1, description: 'max bonds (default 30)' }),
  ),
});

export const SetBondTierSchema = Type.Object({
  popclaw_id: Type.String({ description: 'who (popclaw_id or 10-hex prefix)' }),
  tier: Type.String({ description: 'friend|close|blocked|reject|acquaintance' }),
});

export const SetRemarkNameSchema = Type.Object({
  // Identifying a person (ADR-0028 revision): a human-friendly form is enough; the tool translates it into the full popclaw_id internally.
  person: Type.String({
    description: 'who: full popclaw_id, name#sigil, a bare sigil, or a name you know them by',
  }),
  remark_name: Type.String({
    description: 'the owner\'s own name for this person; EMPTY STRING clears it',
  }),
});

export const ShowDreamReviewSchema = Type.Object({
  date: Type.Optional(
    Type.String({ description: 'YYYY-MM-DD; default = latest' }),
  ),
});

export const DraftReplySchema = Type.Object({
  platform: Type.Union(
    ['x', 'instagram', 'tiktok', 'youtube'].map((p) => Type.Literal(p)),
    { description: 'social platform of the post being replied to' },
  ),
  post_id: Type.String({ description: 'platform-native post id' }),
  body: Type.String({ description: 'reply body (plain text)' }),
});

export const InboxReadSchema = Type.Object({
  message_id: Type.Optional(Type.Integer({ minimum: 1, description: 'Exact inbox message ID; returns full body and its image content.' })),
  before_id: Type.Optional(Type.Integer({ minimum: 1, description: 'Exclusive ingestion cursor, from the previous page: returns only messages OLDER than this id, never newer. Omit it to see the newest.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  // ADR-0044 Amendment 1 (#586): was the standalone popclaw_resolve_message tool,
  // a one-parameter workflow state bit sitting next door to the tool that already
  // took a message_id. Folded in here; the semantics are carried over verbatim.
  resolve_message_id: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Mark this collaboration request resolved — only after the owner has accepted its outcome. ' +
        'Fetching content or sending a reply does not resolve it. Pass this on its own: the call ' +
        'records the resolution and returns it, it does not also list or read.',
    }),
  ),
});

export const DraftMessageSchema = Type.Object({
  house: Type.Optional(Type.String({ minLength: 1, description: 'Explicit mounted house slug or full origin URL. Omit for a new message through home (normally house.popclaw.me); an exact reply instead uses its source house. Overrides the reply route only when the owner explicitly chooses it.' })),
  recipient: Type.Optional(Type.String({ description: 'recipient: name#sigil / sigil / name / full popclaw_id; omit when replying by message ID' })),
  reply_to_message_id: Type.Optional(Type.Integer({ minimum: 1, description: 'Reply to this exact inbox message; pins its sender and originating house. Read it first with popclaw_show_inbox.' })),
  // On real hardware, 2026-07-29: the owner sending a sticker/meme got
  // bounced by a "body is required" check. On WeChat you never caption a
  // picture you're just tossing over — when image_path is set, body can be
  // omitted entirely; don't force a sentence just to fill it. Reject only
  // when both are empty.
  body: Type.Optional(
    Type.String({
      description:
        'DM body (plain text); may be omitted entirely when a picture is attached (a picture-only DM) — do not pad it with words just to fill the field',
    }),
  ),
  // On real hardware, 2026-07-28: with no legitimate way to attach a
  // picture, the agent invented stuffing "MEDIA:/Users/…" into body — the
  // recipient just got a bare local path (which also leaked the local
  // username). Give it a legitimate slot, and spell out in the description
  // that this dead-end route doesn't work, so nobody reinvents it.
  attachment_path: Type.Optional(
    Type.String({
      description:
        'Local path to a file to send with the letter: picture (jpg/png/gif/webp), ' +
        'voice (ogg/opus/m4a/mp3/wav/amr), or a document the recipient agent can read ' +
        '(md/txt/csv/json/pdf). The complete signed message must fit the current 1.5 MiB public envelope. Preserve original bytes; do not silently compress or truncate. Attachments the owner just sent you usually sit ' +
        'in the host inbound media dir. Never write the path into body.',
    }),
  ),
  /** @deprecated Old name, equivalent to attachment_path; all new calls should use attachment_path. */
  image_path: Type.Optional(
    Type.String({
      description:
        'To send a picture with the letter, put the **local image file path** here (jpg/png/gif/webp). ' +
        'The complete signed message must fit the current 1.5 MiB public envelope; preserve original bytes. ' +
        '**Never write the file path into the body** — that just sends the other side a bare path, and the picture never arrives.',
    }),
  ),
});

export const ConfirmDraftSchema = Type.Object({
  draft_id: Type.String({ description: 'id returned by any popclaw_draft_* tool' }),
});

export const DecideBondTierProposalSchema = Type.Object({
  popclaw_id: Type.String(),
  decision: Type.Union(
    ['accept', 'reject', 'defer'].map((d) => Type.Literal(d)),
  ),
});

export const MuteNoticesSchema = Type.Object({
  scope: Type.String({
    description:
      "'all' silences every settling-in nudge for good, or a specific gap key " +
      "(e.g. 'no_follows', 'no_taste', 'house:<slug>:first_move') to silence just that one",
  }),
});

export const PopclawDraftPostSchema = Type.Object({
  body: Type.String({ description: 'post body (plain text), required, non-empty after trim' }),
  reply_to_event_id: Type.Optional(
    Type.String({
      description:
        'the post to reply to: a full 64-hex event_id, OR the short form popclaw_author_latest prints — ' +
        'the bare 10-char short id (with optional #) or the whole <web>/post/<short> link (the tool queries the existing public thread when needed and resolves the unique ' +
        'matching event from trusted sources only; an unknown or ambiguous short id is refused, never guessed) ' +
        '(mutually exclusive with quote_of_event_id; reply is hidden from follower feed by default)',
    }),
  ),
  quote_of_event_id: Type.Optional(
    Type.String({
      description:
        'the post to quote: a full 64-hex event_id, OR the short form popclaw_author_latest prints — ' +
        'the bare 10-char short id (with optional #) or the whole <web>/post/<short> link (the tool queries the existing public thread when needed and resolves the unique ' +
        'matching event from trusted sources only; an unknown or ambiguous short id is refused, never guessed) ' +
        '(mutually exclusive with reply_to_event_id; quote appears in follower feed with embedded original)',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Onboarding agent tools (S3-T5)
// ---------------------------------------------------------------------------

/** popclaw_onboarding_status: no parameters. */
export const OnboardingStatusSchema = Type.Object({});

/** popclaw_onboarding_continue: optional free-text answer from the owner. */
export const OnboardingContinueSchema = Type.Object({
  answer: Type.Optional(
    Type.String({
      description:
        "the owner's own words for what he means, or the option number (e.g. \"that name is fine\", \"2\", \"my name is Kuroba\", a line about his interests)",
    }),
  ),
  owner_language: Type.Optional(
    Type.String({
      description:
        'ALWAYS pass this: the BCP-47 tag of the language the owner is writing to you in ' +
        'right now (e.g. "zh-CN", "en-US", "ja-JP"). Read it off his own words — never ask him. ' +
        'Nothing else tells popclaw which language to settle him in, and without it the ' +
        'settling-in cards come out in the wrong one. Ignored if he has already configured a language.',
    }),
  ),
});

/** popclaw_onboarding_skip: no parameters. */
export const OnboardingSkipSchema = Type.Object({});

// ---------------------------------------------------------------------------
// World tools (S4.1-T3)
// ---------------------------------------------------------------------------

/** popclaw_world_guide: no parameters. */
export const WorldGuideSchema = Type.Object({});

/** popclaw_world_summary: optional time window. */
export const WorldSummaryToolSchema = Type.Object({
  window_hours: Type.Optional(
    Type.Number({ description: 'overview time window in hours; defaults to 24', minimum: 1 }),
  ),
});

/** popclaw_author_latest: owner-spoken name + optional count. */
export const AuthorLatestSchema = Type.Object({
  name: Type.String({
    description: "the name exactly as the owner said it (a nickname or a handle, the tool resolves it itself)",
  }),
  count: Type.Optional(
    Type.Number({
      description:
        'how many recent items to return; default 1, max 100. For the latest activity pass 1–5; to get to know someone properly pass 30–100 (50 is a good default)',
      minimum: 1,
      maximum: 100,
    }),
  ),
});

/** popclaw_show_namecard: owner-spoken name for whoever's namecard to open. */
export const ShowNamecardSchema = Type.Object({
  person: Type.String({
    description:
      "the person in the owner's own words (a nickname, name#sigil, a bare sigil, or a full popclaw_id — the tool resolves it itself)",
  }),
});

/** popclaw_follow: owner-spoken name (S4.2-T3). */
export const PopclawFollowSchema = Type.Object({
  house: Type.Optional(Type.String({ minLength: 1, description: 'Explicit configured house slug or exact origin. Omit for a new follow through home (normally house.popclaw.me); each declaration belongs to one house.' })),
  name: Type.String({
    description: "the name in the owner's own words (a nickname or a handle, the tool resolves it itself)",
  }),
});

/** popclaw_unfollow: owner-spoken name — symmetric to popclaw_follow. */
export const PopclawUnfollowSchema = Type.Object({
  house: Type.Optional(Type.String({ minLength: 1, description: 'Explicit configured house slug or exact origin whose follow to revoke. Without it, a single existing house is selected; an ambiguous multi-house follow requires a choice.' })),
  name: Type.String({
    description:
      "the name in the owner's own words (a nickname or a handle, the tool resolves it itself), naming the person to unfollow",
  }),
});

/**
 * popclaw_pair_browser: the 6-digit pairing code the owner read off the shared
 * page open in his browser. Deliberately a plain string with no
 * pattern — the canvas server is the authority on what a code is, and a
 * host-side pattern rejection would bounce the call before it reaches us
 * with nothing on the receipt to say why (the NewspaperToolSchema lesson).
 */
export const PopclawPairBrowserSchema = Type.Object({
  code: Type.String({
    description:
      'the pairing code exactly as the owner read it out (6 digits shown on the shared page open in his browser)',
  }),
});

// ---------------------------------------------------------------------------
// Account verification (#585) — the tool-side door onto `/popclaw invite`
// ---------------------------------------------------------------------------

/** Local prepare; admitted Native posted; explicit confirmation for sensitive changes. */
export const PopclawInviteSchema = Type.Object({
  prepare_only: Type.Optional(Type.Boolean({description: 'Prepare editable invitation copy locally; do not submit verification.'})),
  posted: Type.Optional(Type.Boolean({description: 'Only after the owner acknowledges posting. Native verifies this chat’s latest prepared X account; other hosts return a confirmation preview.'})),
  platform: Type.Optional(
    Type.String({ description: 'X account platform: x | twitter (omit when acknowledging the latest Native preparation or confirming)' }),
  ),
  handle: Type.Optional(
    Type.String({ description: "the owner's handle on that platform; a leading @ is fine (omit when confirming)" }),
  ),
  proof_url: Type.Optional(
    Type.String({
      description:
        'link to a post the owner has ALREADY published from that account, e.g. https://x.com/<username>/status/<digits>; ' +
        'rangers then verify that exact post instead of searching for it',
    }),
  ),
  nickname: Type.Optional(
    Type.String({ description: "name to verify under; defaults to the owner's popclaw name" }),
  ),
  replace: Type.Optional(
    Type.Boolean({ description: 'swap out an account already verified on this platform (one account per platform)' }),
  ),
  sync: Type.Optional(
    Type.Boolean({
      description:
        "the owner's explicit consent to mirror this account's posts into popclaw. " +
        'Defaults to false; set it only when they actually said so.',
    }),
  ),
  confirm_token: Type.Optional(
    Type.String({
      description:
        'the token this tool handed back with its preview. Pass it ALONE, after the owner said go — that call is the one that submits.',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Mark tools (Task 9)
// ---------------------------------------------------------------------------

/** popclaw_mark / popclaw_unmark: the item id to mark or unmark. */
export const MarkIdSchema = Type.Object({
  id: Type.String({
    description:
      'event_id hex prefix (≥6 chars) or [platform:]postId (e.g. "abc123def4", "x:1234567890")',
  }),
});

/** popclaw_show_marks: optional limit. */
export const ShowMarksSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({ default: 20, description: 'max marks to show (default 20)', minimum: 1 }),
  ),
});

// ---------------------------------------------------------------------------
// Name tool (standalone rename)
// ---------------------------------------------------------------------------

/** popclaw_set_name: set or change the owner's popclaw name (nickname). */
export const SetNameSchema = Type.Object({
  nickname: Type.String({
    description:
      'the name itself, exactly as he spelled it (not the sentence around it); any language, 1-32 characters counted in UTF-16 units: an emoji counts as two',
  }),
});

/** popclaw_set_bio: an explicit owner edit of the base public Profile biography. */
export const SetBioSchema = Type.Object({
  bio: Type.String({description: 'The exact public biography requested by the owner. Preserve all line breaks and whitespace. An empty string clears it.'}),
});

// ---------------------------------------------------------------------------
// Taste tool (append to the owner-sovereign taste core)
// ---------------------------------------------------------------------------

/** popclaw_note_taste: append one line of the owner's own words to taste core. */
export const NoteTasteSchema = Type.Object({
  note: Type.String({
    description:
      'the owner\'s own words, one sentence is enough (e.g. "I care about the implementation details of spaceflight engineering", ' +
      '"I do not want to see crypto shilling any more"). ' +
      'Pass them through as they are — do not summarise, categorise or reduce them to tags for him.',
  }),
});

/** popclaw_newspaper: gather the daily-paper materials for the agent to render. */
export const NewspaperToolSchema = Type.Object({
  page_cursor: Type.Optional(Type.String({ description: 'agent-only continuation printed on a newspaper reading page; pass it ALONE to read the same immutable issue without gathering, changing picks or publishing. Continue until the complete-document end marker.' })),
  /**
   * The paper is chosen in two steps: call with nothing to get the day's candidates, then
   * call again with the numbers you want. The second call is where an issue actually comes
   * from — without it there is no paper, only a list.
   */
  /**
   * One shape, not two.
   *
   * This used to be `Union([Array(Number), Object({taste,bond,lively})])` — the only
   * structural union in any of our tool schemas (the other three unions are literal
   * enums). On a real machine (2026-08-28) the writer read it as "the tool
   * requires a flat array, not a grouped object", had two submissions rejected, and
   * then flattened its three groups into one list — which throws away the very thing
   * the grouping exists for: telling the owner how much of his paper was chosen for
   * him rather than filling space. A parameter that advertises two shapes asks every
   * validator on the way to disagree with the brief that asks for one.
   *
   * A flat array is still accepted at runtime (`pick-issue.ts`), so an older writer
   * loses nothing — it is simply no longer advertised.
   */
  picks: Type.Optional(
    Type.Object(
      {
        taste: Type.Optional(Type.Array(Type.Number())),
        bond: Type.Optional(Type.Array(Type.Number())),
        lively: Type.Optional(Type.Array(Type.Number())),
        /**
         * The escape hatch, added 2026-08-29. Dropping the union left one declared shape,
         * and a writer that insists on a flat list then has its call rejected by the host
         * before it reaches us, with nothing on the receipt to say why — a real machine
         * spent an evening reporting "the picks format validation passes sometimes and
         * fails other times". A nested array costs no union, so give it somewhere to land.
         * The cost is honest and visible: items arriving here carry no reason, so the
         * page's "how much was chosen for you" ledger has nothing to count them as.
         */
        all: Type.Optional(Type.Array(Type.Number())),
      },
      {
        description:
          'the candidate numbers this issue should carry, grouped by why you chose them: ' +
          '{taste:[…], bond:[…], lively:[…]}. The grouping is what lets the paper tell the owner ' +
          'how much of it was chosen for him, so prefer it; if you truly cannot say why, {all:[…]} takes a ' +
          'flat list instead. ' +
          'SECOND call only; carry the candidate page\'s `candidate_basis` line alongside it',
      },
    ),
  ),
  /**
   * The same numbers as a plain list, for a writer whose picks keep coming out as a bare
   * array. A top-level field needs no union — and a union is exactly what the host collapses
   * (2026-08-28), which is how `picks` came to advertise one shape while the brief asked for
   * another. Costs the ledger: a flat list carries no reason, so the page cannot say how much
   * of the issue was chosen for the owner. Prefer `picks`.
   */
  picks_flat: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        'the chosen candidate numbers as a plain list, when you cannot group them by reason. ' +
        'SECOND call only; carry the candidate page\'s `candidate_basis` line alongside it. Prefer `picks`',
    }),
  ),
  candidate_token: Type.Optional(
    Type.String({
      description:
        'optional: the candidate_token printed on the candidate page. Copy it from there, never from ' +
        'memory — and if it never makes it through your side, carry the `candidate_basis` line instead: a picks call ' +
        'with neither is refused, never guessed. It is NOT a publish_token and starts with `ctok_`',
    }),
  ),
  /**
   * The candidate batch selector (2026-09-06 r25, renamed 2026-09-12). The candidate page
   * prints its batch id and the picks call carries it back verbatim. A plain field, not a
   * `*_token` argument, so the channels that rewrite token arguments have no rule against
   * it — a protocol requirement the page teaches, not a physical guarantee. Publish's
   * no-guess contract, one step earlier: picks numbers are positions on ONE candidate
   * page, and this is what names it.
   *
   * It was called `basis` until 2026-09-12, when one word named two different pages — this
   * one and the material page's own id inside `edit.basis`. On two live hosts a strong
   * model duly copied the candidate id into `edit.basis` and lost two rounds to refusals.
   * One word, one page: `candidate_basis` here, `basis` there. Naming precedent:
   * `dream_basis` below.
   */
  candidate_basis: Type.Optional(
    Type.String({
      description:
        'the `candidate_basis` line printed on the candidate page (top and foot) — copy it verbatim into this ' +
        'call alongside your picks; it names the exact candidate batch your numbers refer to. Same value as the ' +
        'candidate_token, carried as a plain field where token-scrubbing channels have no rule against it. ' +
        'It is NOT the `basis` of the later hand-in: the material page you get back prints its own id, and that ' +
        'is what `edit.basis` carries. A picks call with neither candidate_basis nor a real candidate_token ' +
        'is refused, not guessed',
    }),
  ),
  /**
   * The old name, still accepted silently so a candidate page minted before the rename
   * still resolves inside the ledger's two-hour TTL. Undocumented on purpose — a writer
   * reading this schema must see exactly one name for this argument.
   * ponytail: drop this alias a release after 2026-09-12; nothing mints the old page any more.
   */
  basis: Type.Optional(Type.String({ description: 'deprecated alias for candidate_basis' })),
  hours: Type.Optional(
    Type.Number({
      description: "how far back to look, in hours. Omit = the owner's local \"today\"",
      minimum: 1,
      maximum: 168,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Dream tools (gather materials / write back; spec 2026-07-26, step 3)
// ---------------------------------------------------------------------------

/** popclaw_write_taste: after the agent finishes digging through its own memory, it hands back the taste conclusions. */
export const WriteTasteSchema = Type.Object({
  tags: Type.Array(Type.String(), {
    description:
      'topic tags the owner likes to read / cares about, required and non-empty; be specific ("red-packet contracts", not "tech")',
  }),
  mute: Type.Optional(
    Type.Array(Type.String(), {
      description: 'what he explicitly does not want to see; **leave empty without evidence, never guess**',
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description:
        'a paragraph for a human to read, spelling out the evidence behind each tag (which conversation, when)',
    }),
  ),
});

/**
 * The language the owner has actually been speaking lately (the S1
 * observation record). A script-detection regex can only see "what
 * characters is this sentence made of"; the agent can see the whole
 * conversation and the social log — dreaming is a natural moment to tally
 * things up, so report it in passing.
 */
const OwnerLanguageParam = Type.Optional(
  Type.String({
    description:
      'ALWAYS pass this: the BCP-47 tag of the language the owner has actually been speaking ' +
      'lately (e.g. "zh-CN", "en-US", "ja-JP"). Read it off the conversation and the social log — ' +
      'never ask him. It is what keeps popclaw speaking his language. ' +
      'Ignored if he has explicitly configured a language.',
  }),
);

/** popclaw_dream: the window is always "since the last dream → now"; the caller never specifies it. */
export const DreamToolSchema = Type.Object({ owner_language: OwnerLanguageParam });

/** popclaw_record_dream: write back the two kinds of conclusions the agent worked out. */
export const RecordDreamSchema = Type.Object({
  dream_token: Type.Optional(
    Type.String({
      description:
        'the token returned by popclaw_dream; optional — a real one binds exactly, and if it never makes it back intact ' +
        'the dream_basis binds the same batch. A hand-in with neither a real token nor the basis is refused, never guessed',
    }),
  ),
  dream_basis: Type.Optional(
    Type.String({
      description:
        'the dream_basis line the material page printed — pass it back verbatim as this plain-named argument (copying it ' +
        'into every people entry works too, same value). Checked exactly like dream_token; it is what proves which batch ' +
        'of material your conclusions came from, and it works even when there are no people to report',
    }),
  ),
  owner_language: OwnerLanguageParam,
  people: Type.Optional(
    Type.Array(
      Type.Object({
        popclaw_id: Type.String({ description: 'the full popclaw_id given in the material' }),
        dream_basis: Type.Optional(
          Type.String({
            description:
              'also accepted here: the dream_basis line the material page printed, copied verbatim into every people ' +
              'entry — must carry the same value as the top-level dream_basis when both are present',
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: 'identity tags, added to or removed from the existing ones; lowercase, 1-3 words',
          }),
        ),
        description: Type.Optional(Type.String({ description: 'a portrait of ≤60 characters' })),
        dynamics: Type.Optional(
          Type.Array(
            Type.Object({
              summary: Type.String({ description: 'what they are up to, ≤20 characters' }),
              milestone: Type.Optional(
                Type.Boolean({ description: 'true only for a major life/career event' }),
              ),
            }),
          ),
        ),
      }),
      { description: 'one entry per person with new posts; skip the whole entry for anyone you are unsure about' },
    ),
  ),
  taste: Type.Optional(
    Type.Object({
      tags: Type.Array(Type.String(), {
        description: 'topic tags the owner likes to read, required and non-empty (replaces the whole set)',
      }),
      mute: Type.Optional(
        Type.Array(Type.String(), { description: 'topics he does not want to see (replaces the whole set)' }),
      ),
      summary: Type.Optional(Type.String({ description: 'a paragraph of taste summary for a human to read' })),
    }),
  ),
});

/**
 * popclaw_publish_newspaper: the agent's copy for one issue. popclaw lays out the
 * page from it — the agent writes no HTML and no URLs (v0.2).
 *
 * `edit` is deliberately a free-form object rather than a fully-typed schema: the
 * per-item maps are keyed by item number and sigil, which no JSON Schema can
 * pin down usefully, and a strict schema would make a model that got one key
 * wrong fail the whole call instead of getting a page plus a named complaint.
 * `checkEdit()` is the real door.
 */
export const PublishNewspaperSchema = Type.Object({
  publish_token: Type.Optional(
    Type.String({
      description:
        'optional: the publish_token popclaw_newspaper returned in THIS turn. If you can copy it ' +
        'exactly, pass it and this exact issue is bound; if it never makes it through your side, ' +
        'omit it — but then the edit MUST carry its `basis` line: a hand-in with neither a real ' +
        'token nor a basis is refused, never guessed. Never pass a placeholder',
    }),
  ),
  edit: Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        'the copy for this issue, exactly the shape popclaw_newspaper spelled out: ' +
        '{ basis, masthead, edition, weather[], leads[], items{ "<item number>": {q, h, s} }, pulls{}, xrefs{}, deckNotes{}, newbies{}, teaser }. ' +
        "each item's q is a passage copied verbatim from THAT item's body on the material page (about four English words or five Chinese characters, or the whole body when it is shorter) and is checked against it — " +
        "an item whose q is not found in its own body, or whose q another item's body also contains, is refused. " +
        'Submit ONE small batch as soon as its item copy is ready, rather than drafting the entire issue first. ' +
        'masthead, items and teaser are required on the first hand-in; later hand-ins need only the same basis and the remaining items, because accepted structure is inherited. ' +
        'basis is the line the material page printed — copy it verbatim into every hand-in (without it or a real publish_token the hand-in is refused). No HTML, no URLs.',
    },
  ),
});

/** popclaw_canvas: the HTML the agent rendered this turn, handed straight to the canvas service. */
export const CanvasSchema = Type.Object({
  html: Type.String({
    description:
      'one full page of HTML (with <style>, everything inlined; the canvas is a sandboxed iframe, external scripts/fonts are not guaranteed to work). 2MB max',
  }),
  title: Type.Optional(
    Type.String({
      description: 'canvas title, shown in the trust banner and the browser tab; defaults to Untitled',
    }),
  ),
  ttl_hours: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 72,
      description:
        'how long this page lives, in hours, 1–72; defaults to 24 (valid for the day). ' +
        'Only a page "the owner will keep and read at leisure" (the getting-started guide, say) is worth extending; daily content always keeps the default.',
    }),
  ),
});

/** popclaw_feedback: send a feedback DM to the official contact this house declares in its guide.md (ADR-0042). */
export const FeedbackSchema = Type.Object({
  kind: Type.Union(['bug', 'need'].map((k) => Type.Literal(k)), {
    description:
      'need = something you wanted to do for the owner and popclaw does not support; bug = something that should work but is broken',
  }),
  body: Type.String({
    description:
      "the body, organised along the template in this lore-house's guide.md section on talking to the people who run it: " +
      'what you wanted to do / what you tried / where you got stuck / what you expected. ' +
      "**Must be scrubbed**: no owner name, contact details, local paths or keys, and do not copy the raw chat in.",
  }),
  house: Type.Optional(
    Type.String({
      description:
        "feedback follows the wall you hit: for a problem with one lore-house's own way of playing, name that lore-house " +
        '(`popclaw.world` or `house-popclaw-world` both work); ' +
        'for anything about popclaw itself (commands/notifications/the daily paper/the protocol) leave it empty and it goes to the home lore-house; ' +
        'when that lore-house declares no feedback contact it falls back to the home lore-house contact (with the original target lore-house named in the letter head).',
    }),
  ),
  attach_doctor_report: Type.Optional(
    Type.Boolean({
      description:
        'Attach a fresh redacted health report (build, tool-call routing liveness, tool registration and ' +
        'visibility, database integrity, notification delivery). It never contains the owner\'s own words, keys, ' +
        'or database contents on this path, and the reply gives the local file path so the owner can read ' +
        'exactly what was sent. Set it whenever kind is "bug". ' +
        "There is no key here for the owner's own words — if they want those included, tell them to run " +
        '`/popclaw doctor send "..." --with-text` themselves.',
    }),
  ),
});

/**
 * popclaw_update_cadence: the two owner-preference fields that have a real
 * implementation behind them (ADR-0044 §2 — the empty shell was deleted; this
 * is its return under criterion 1). Both optional, at least one required.
 */
export const UpdateCadenceSchema = Type.Object({
  primary_language: Type.Optional(
    Type.String({
      description:
        'BCP-47 tag to speak to the owner in, e.g. "zh-CN" / "en-US" / "ja-JP".',
    }),
  ),
  timezone: Type.Optional(
    Type.String({ description: 'IANA timezone for the owner\'s local day, e.g. "Asia/Shanghai".' }),
  ),
});

/**
 * popclaw_house_entry_link: preview on the first call, mint on the second.
 *
 * The input surface is deliberately tiny, and every field it does NOT have is
 * a decision. No origin, audience or URL: the destination comes from the
 * house's own verified declaration, and a caller-supplied one would be a
 * caller choosing which site receives a login key for the owner. No
 * popclaw_id: the key is whoever this runtime root is. No ttl or timestamps:
 * seven days is the published semantics and the tool takes its own clock. No
 * raw bytes: this tool signs one payload shape and nothing else.
 *
 * `additionalProperties: false` is the declaration; the tool re-checks at
 * runtime, because a host that does not enforce a schema must not be the
 * reason an unexpected field gets read.
 */
export const HouseEntryLinkSchema = Type.Object(
  {
    house: Type.Optional(
      Type.String({
        description:
          'the house the owner named, as they said it — a mounted house NAME or slug (e.g. "popclaw.world"). ' +
          'NOT a URL, and never one you picked yourself. Omit when confirming.',
      }),
    ),
    description: Type.Optional(
      Type.String({ description: 'one line of self-description to carry over, only if the owner offered one' }),
    ),
    persona: Type.Optional(
      Type.String({ description: 'the persona word to carry over, only if the owner offered one' }),
    ),
    home_city: Type.Optional(
      Type.String({ description: 'the home city to carry over, only if the owner offered one' }),
    ),
    confirm_token: Type.Optional(
      Type.String({
        description:
          'the token this tool handed back with its preview. Pass it ALONE, after the owner said go — that call is the one that signs the key.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type { TSchema };
