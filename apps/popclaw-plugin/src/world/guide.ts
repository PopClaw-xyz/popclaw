/**
 * guide.md frontmatter parser (S4-T2)
 *
 * Input: full text of guide.md (fetched from lore-house GET /v1/guide.md).
 * Output: { frontmatter: WorldDescriptor | null, body: string }
 *
 * Parsing rules (a YAML subset, hand-written in the style of soul.ts):
 *  - top-level `key: value` lines;
 *  - `streams:` followed by `  - key: value` list items;
 *  - `lexicon:` uses the same list shape (house-side routing lexicon entries, ADR-0043 §4, 2026-07-30);
 *  - `feedback:` followed by `  key: value` (this house's official feedback contact, 2026-07-29);
 *  - `entry:` followed by `  key: value` (this house's self-reported "first thing to do," 2026-07-30 R1);
 *  - `newspaper:` followed by `  key: value` (this house's interface for the daily paper, 2026-07-31 slice G);
 *  - tolerates CRLF; unknown keys are ignored; bad lines are skipped, never thrown.
 * Backward compatible: no `---` frontmatter → frontmatter=null, body=original text.
 */

export interface StreamDescriptor {
  readonly name: string;
  readonly endpoint: string;
  readonly transport?: string;
  readonly note?: string;
}

/**
 * This house's official feedback contact (the recipient for `/popclaw feedback`).
 * The guide.md frontmatter is the formal contract: the machine reads the id
 * here, the agent reads the feedback template in the body text.
 * Absent = this house hasn't declared a contact — honestly report the gap, never guess an id.
 */
export interface FeedbackContact {
  readonly contact?: string;
  readonly popclawId?: string;
}

/**
 * This house's self-reported **first thing to do** (R1 spec §1). Carried
 * through verbatim, with zero policy judgment applied here — URL scheme
 * allow-listing, length truncation, and dropping invalid values are all
 * consolidated in `readHouseEntry` (house-handshake.ts); the parser's job is
 * only "what did the house say." All fields are optional: nothing declared = no such block.
 */
export interface HouseEntry {
  /** The door to point a person at (may be a relative address, protocol not yet validated). */
  readonly home?: string;
  readonly headline?: string;
  /** What the owner tells the agent to kick things off. */
  readonly firstMove?: string;
  /**
   * English variants (`headline_en` / `first_move_en`). Additive keys: a house
   * that declares neither is read exactly as before. Which one a surface gets
   * is decided in `readHouseEntry` by the owner's language — the parser only
   * reports what the house wrote.
   */
  readonly headlineEn?: string;
  readonly firstMoveEn?: string;
  /** The corresponding section heading in the guide, for the agent to navigate to. */
  readonly recipe?: string;
}

/**
 * This house's interface for the **daily paper** (slice G). Currently just one
 * field: `digest_url` — a cheap static export address, which may include a
 * `{popclaw_id}` placeholder. Carried through verbatim (placeholder
 * substitution and protocol allow-listing are consolidated in
 * `readHouseDigestUrl`); absent = this house doesn't offer a digest, the daily
 * paper still runs as usual.
 */
export interface NewspaperHints {
  readonly digestUrl?: string;
}

/**
 * House-side routing lexicon entries (ADR-0043 §4) — **extracted verbatim, no
 * gating happens here**: legality checks (tool name ∈ visible set / phrase
 * length / metacharacters / ≤12 per house) all live in `routing/house-lexicon.ts`.
 * The parser only reads the words, it doesn't judge authority.
 */
export interface LexiconItem {
  readonly tool: string;
  /** Comma-separated raw text (deliberately not a YAML inline array: minimizes what the parser needs to handle). */
  readonly say: string;
}

export interface WorldDescriptor {
  readonly world?: string;
  readonly kind?: string;
  readonly voice?: string;
  /** English variant of `voice` (`voice_en`); absent = this house only declared one. */
  readonly voiceEn?: string;
  readonly streams: StreamDescriptor[];
  readonly lexicon?: LexiconItem[];
  readonly feedback?: FeedbackContact;
  readonly entry?: HouseEntry;
  readonly newspaper?: NewspaperHints;
}

export interface ParsedGuide {
  readonly frontmatter: WorldDescriptor | null;
  readonly body: string;
}

/** One `  - key: value` list item, keys as written. Unknown keys are harmless. */
type ListItem = Record<string, string>;

function buildStream(b: ListItem): StreamDescriptor | null {
  if (!b.name || !b.endpoint) return null;
  const s: { name: string; endpoint: string; transport?: string; note?: string } = {
    name: b.name,
    endpoint: b.endpoint,
  };
  if (b.transport !== undefined) s.transport = b.transport;
  if (b.note !== undefined) s.note = b.note;
  return s;
}

/**
 * Parse the YAML frontmatter of a guide.md string.
 *
 * Returns `{ frontmatter: null, body: md }` if no frontmatter fence is found.
 */
export function parseGuideFrontmatter(md: string): ParsedGuide {
  // Match opening --- fence (possibly CRLF)
  const fenceMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fenceMatch) {
    return { frontmatter: null, body: md };
  }

  const fullMatch = fenceMatch[0] ?? '';
  const frontmatterText = fenceMatch[1] ?? '';
  const body = md.slice(fullMatch.length);

  // Parse YAML subset
  let world: string | undefined;
  let kind: string | undefined;
  let voice: string | undefined;
  let voiceEn: string | undefined;
  const streams: StreamDescriptor[] = [];
  const lexicon: LexiconItem[] = [];

  // Parsing state for the list blocks (`streams:` / `lexicon:` — same shape)
  let listBlock: 'streams' | 'lexicon' | null = null;
  let currentItem: ListItem | null = null;
  // Parsing state for the flat (2-space) blocks — `feedback:` and `entry:` share
  // one parser: collect raw `key: value` pairs, map to types once at the end.
  let flatBlock: FlatBlockName | null = null;
  const flat: Partial<Record<FlatBlockName, Record<string, string>>> = {};

  const flushItem = (): void => {
    if (!currentItem) return;
    if (listBlock === 'streams') {
      const s = buildStream(currentItem);
      if (s) streams.push(s);
    } else if (listBlock === 'lexicon' && currentItem.tool && currentItem.say) {
      lexicon.push({ tool: currentItem.tool, say: currentItem.say });
    }
    currentItem = null;
  };

  const lines = frontmatterText.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (flatBlock) {
      const kv = line.match(/^[ \t]+(\w+):[ \t]*(.*)$/);
      if (kv) {
        flat[flatBlock]![kv[1] ?? ''] = (kv[2] ?? '').trim();
        continue;
      }
      // Blank / unrecognised indented line → skip; non-indented → block ended,
      // fall through so this line is parsed as a top-level key.
      if (line.trim() === '' || line.match(/^[ \t]/)) continue;
      flatBlock = null;
    }

    // Detect start of a flat block (`feedback:` / `entry:` / `newspaper:`)
    const flatStart = line.trim().match(/^(feedback|entry|newspaper):$/);
    if (flatStart) {
      flushItem();
      listBlock = null;
      flatBlock = flatStart[1] as FlatBlockName;
      flat[flatBlock] = {};
      continue;
    }

    // Detect start of a list block
    if (line.trim() === 'streams:' || line.trim() === 'lexicon:') {
      flushItem(); // (shouldn't be one, but be safe)
      listBlock = line.trim() === 'streams:' ? 'streams' : 'lexicon';
      continue;
    }

    if (listBlock) {
      // New list item: `  - key: value` or `  - ` alone (bare dash)
      const newItemMatch = line.match(/^[ \t]+-[ \t]+(\w+):[ \t]*(.*)$/);
      if (newItemMatch) {
        flushItem(); // Flush previous item
        currentItem = { [(newItemMatch[1] ?? '').trim()]: (newItemMatch[2] ?? '').trim() };
        continue;
      }

      // Continuation line within a list item: `    key: value`
      const contMatch = line.match(/^[ \t]{4,}(\w+):[ \t]*(.*)$/);
      if (contMatch && currentItem) {
        currentItem[(contMatch[1] ?? '').trim()] = (contMatch[2] ?? '').trim();
        continue;
      }

      // Non-indented line → end of the list block (back to top-level)
      if (line.trim() !== '' && !line.match(/^[ \t]/)) {
        flushItem(); // Flush last item
        listBlock = null;
        // Fall through to parse this line as a top-level key
      } else {
        // Skip blank/unrecognised indented lines
        continue;
      }
    }

    // Top-level key: value
    const kvMatch = line.match(/^(\w+):[ \t]*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1] ?? '';
    const val = (kvMatch[2] ?? '').trim();

    switch (key) {
      case 'world':
        world = val;
        break;
      case 'kind':
        kind = val;
        break;
      case 'voice':
        voice = val;
        break;
      case 'voice_en':
        voiceEn = val;
        break;
      // 'streams' / 'lexicon' handled above; all other keys ignored
    }
  }

  // Flush trailing list item
  flushItem();

  const frontmatter: WorldDescriptor = { streams };
  if (world !== undefined) (frontmatter as { world?: string }).world = world;
  if (kind !== undefined) (frontmatter as { kind?: string }).kind = kind;
  if (voice !== undefined) (frontmatter as { voice?: string }).voice = voice;
  if (voiceEn !== undefined) (frontmatter as { voiceEn?: string }).voiceEn = voiceEn;
  if (lexicon.length > 0) (frontmatter as { lexicon?: LexiconItem[] }).lexicon = lexicon;
  const fb = flat.feedback;
  if (fb) {
    (frontmatter as { feedback?: FeedbackContact }).feedback = pick(fb, {
      contact: 'contact',
      popclaw_id: 'popclawId',
    });
  }
  const en = flat.entry;
  if (en) {
    (frontmatter as { entry?: HouseEntry }).entry = pick(en, {
      home: 'home',
      headline: 'headline',
      headline_en: 'headlineEn',
      first_move: 'firstMove',
      first_move_en: 'firstMoveEn',
      recipe: 'recipe',
    });
  }
  const np = flat.newspaper;
  if (np) {
    (frontmatter as { newspaper?: NewspaperHints }).newspaper = pick(np, {
      digest_url: 'digestUrl',
    });
  }

  return { frontmatter, body };
}

type FlatBlockName = 'feedback' | 'entry' | 'newspaper';

/** raw `key: value` → known fields (unknown keys ignored; an empty value still counts as declared, the caller decides what to do with it). */
function pick<T>(raw: Record<string, string>, keys: Record<string, string>): T {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(keys)) {
    if (raw[from] !== undefined) out[to] = raw[from]!;
  }
  return out as T;
}
