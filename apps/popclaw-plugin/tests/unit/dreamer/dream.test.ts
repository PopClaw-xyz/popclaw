import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { Value } from 'typebox/value';
import { RecordDreamSchema } from '../../../src/tools/tool-schemas.js';
import { coerceRecordDream } from '../../../src/tools/dream-taste-tools.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import type { SocialLogRecord } from '../../../src/social-log/social-log.js';
import type { LearnedTaste } from '../../../src/taste/learned-writer.js';
import {
  gatherDreamMaterials,
  recordDream,
  _resetDreamTokensForTest,
  type DreamPost,
  type GatherDreamDeps,
  type RecordDreamDeps,
} from '../../../src/dreamer/dream.js';
import { dreamTodo } from '../../../src/commands/status.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 rollout slice 4: gatherDreamMaterials's "empty" message and recordDream's
// receipts now render in `ownerLang()` (S1 process-wide singleton). Pin
// zh-CN so this file's pre-lexicon assertions stay byte-for-byte unchanged
// (same fix as status.test.ts / write-taste.test.ts). buildDreamPayload
// itself (the "ready" branch) is S2 scope and is plain English regardless —
// see dream.ts's doc comment on that function.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const NOW = 1_800_000_000;

function freshBonds(): BondsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new BondsStore(db, () => NOW);
}

function post(authorPopclawId: string, ts: number, text = 'shipped a rocket'): DreamPost {
  return { authorPopclawId, handle: '@a', textPreview: text, platform: 'x', platformPostCreatedAt: ts };
}

function logRec(over: Partial<SocialLogRecord> = {}): SocialLogRecord {
  return { v: 1, ts: NOW - 3600, tz: '+08', kind: 'reply_sent', ...over } as SocialLogRecord;
}

const EMPTY_LEARNED: LearnedTaste = { tags: [], mute: [], summary: '' };

function gatherDeps(over: Partial<GatherDreamDeps> = {}): GatherDreamDeps {
  return {
    bondsStore: freshBonds(),
    cache: { recent: () => [] },
    readSocialLog: () => [],
    coreTaste: '',
    learned: EMPTY_LEARNED,
    lastDreamAt: NOW - 86_400,
    now: () => NOW,
    mintToken: () => 'dream_test',
    ...over,
  };
}

beforeEach(() => _resetDreamTokensForTest());

describe('gatherDreamMaterials', () => {
  it('an empty attempt leaves the old write-back cursor honest in status', () => {
    const deps = gatherDeps({ lastDreamAt: NOW - 16 * 86_400 });
    const mintToken = vi.fn(deps.mintToken);
    const result = gatherDreamMaterials({ ...deps, mintToken });
    expect(result.kind).toBe('empty');
    expect(mintToken).not.toHaveBeenCalled();
    expect(deps.lastDreamAt).toBe(NOW - 16 * 86_400);
    const todo = dreamTodo({ lastDreamAt: deps.lastDreamAt, dreamCron: { scheduled: true } }, NOW, 'zh-CN');
    expect(todo.title).toContain('有效写回已 16 天');
    expect(Object.values(todo).join('\n')).not.toMatch(/没跑|没跑成|多半|投递失败/);
  });

  it('no posts and no social log → honest empty, no token minted', () => {
    const r = gatherDreamMaterials(gatherDeps());
    expect(r.kind).toBe('empty');
    if (r.kind === 'empty') expect(r.message).toContain('没有新素材');
  });

  it('carries both materials, the existing knowledge, and the merge instruction', () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    bonds.setKnowledge('ALICE', { tags: ['investor'], description: 'angel in SF' });
    const r = gatherDreamMaterials(
      gatherDeps({
        bondsStore: bonds,
        cache: { recent: () => [post('ALICE', NOW - 1000)] },
        readSocialLog: () => [logRec({ text: '我也想造火箭', actor: { name: '苍梧阁', tier_then: 'friend' } })],
        coreTaste: '我关心航天工程的实现细节',
        learned: { tags: ['开源治理'], mute: ['币圈喊单'], summary: '旧总结' },
      }),
    );
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.payload).toContain('popclaw_id=ALICE');
    expect(r.payload).toContain('investor'); // Include existing tags or they will be overwritten.
    expect(r.payload).toContain('shipped a rocket'); // Material A.
    expect(r.payload).toContain('我也想造火箭'); // Material B.
    expect(r.payload).toContain('苍梧阁');
    expect(r.payload).toContain('我关心航天工程的实现细节'); // Sovereign layer.
    expect(r.payload).toContain('开源治理'); // Previous suggestion layer.
    expect(r.payload).toContain('dream_test');
    expect(r.payload).toContain('popclaw_record_dream');
  });

  it('window is [上次做梦 → 现在] — a missed run just widens it', () => {
    const readSocialLog = vi.fn().mockReturnValue([logRec()]);
    gatherDreamMaterials(gatherDeps({ lastDreamAt: NOW - 5 * 86_400, readSocialLog }));
    expect(readSocialLog).toHaveBeenCalledWith(NOW - 5 * 86_400, NOW);
  });

  it('never dreamed → capped first window, still gathers', () => {
    const readSocialLog = vi.fn().mockReturnValue([logRec()]);
    const r = gatherDreamMaterials(gatherDeps({ lastDreamAt: null, readSocialLog }));
    expect(readSocialLog).toHaveBeenCalledWith(NOW - 30 * 86_400, NOW);
    expect(r.kind).toBe('ready');
    // buildDreamPayload is S2 scope (LLM-facing, not owner-facing) — plain
    // English regardless of ownerLang() (see dream.ts doc comment).
    if (r.kind === 'ready') expect(r.payload).toContain('never dreamed before');
  });

  it('only posts newer than the per-person cursor are offered', () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    bonds.markDreamed('ALICE', NOW - 500);
    const r = gatherDreamMaterials(
      gatherDeps({
        bondsStore: bonds,
        cache: { recent: () => [post('ALICE', NOW - 900, 'old news')] },
      }),
    );
    expect(r.kind).toBe('empty'); // No newer posts and no logs.
  });

  it('social log alone is enough to dream (taste has no dependency on the feed)', () => {
    const r = gatherDreamMaterials(gatherDeps({ readSocialLog: () => [logRec({ text: 'hello' })] }));
    expect(r.kind).toBe('ready');
  });

  // B4 (ADR-0045 / charter D3): describe each day using the timezone that applied that day.
  it('每条日志按它自己 write-time 存的 tz 记日期，没存 tz 才回落 owner tz', () => {
    // 2026-07-30T20:30Z: already 7/31 at +08, still 7/30 at -07.
    const ts = Math.floor(Date.UTC(2026, 6, 30, 20, 30) / 1000);
    setOwnerTz('America/Los_Angeles');
    const r = gatherDreamMaterials(
      gatherDeps({
        now: () => ts + 60,
        lastDreamAt: ts - 86_400,
        readSocialLog: () => [
          logRec({ ts, tz: '+08', text: '在上海发的' }),
          logRec({ ts, tz: undefined as unknown as string, text: '没存时区的老记录' }),
        ],
      }),
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    // renderLogLine is S2 scope — plain English template, but the log text
    // itself is pass-through user data and stays untranslated verbatim.
    expect(r.payload).toContain('2026-07-31 reply_sent text="在上海发的"');
    expect(r.payload).toContain('2026-07-30 reply_sent text="没存时区的老记录"');
    setOwnerTz(undefined);
  });

  // S3 rollout slice 4 — en lane (the "empty" message only; buildDreamPayload
  // is S2 scope and is already plain English regardless of ownerLang()).
  it('empty message renders in en when set', () => {
    setOwnerLang('en', 'config');
    const r = gatherDreamMaterials(gatherDeps());
    expect(r.kind).toBe('empty');
    if (r.kind === 'empty') expect(r.message).toContain('Nothing new to work with');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});

// ---------------------------------------------------------------------------

function recordDeps(bonds: BondsStore, over: Partial<RecordDreamDeps> = {}) {
  const written: LearnedTaste[] = [];
  const stamped: number[] = [];
  const deps: RecordDreamDeps = {
    bondsStore: bonds,
    writeLearnedTaste: async (t) => void written.push(t),
    proposeTierChanges: () => [],
    stampDream: (ts) => void stamped.push(ts),
    now: () => NOW,
    ...over,
  };
  return { deps, written, stamped };
}

/** Mint a real token by running the gather half — record only trusts its own manifest. */
function tokenFor(bonds: BondsStore, postTs = NOW - 1000): string {
  const r = gatherDreamMaterials(
    gatherDeps({ bondsStore: bonds, cache: { recent: () => [post('ALICE', postTs)] } }),
  );
  if (r.kind !== 'ready') throw new Error('expected ready');
  return r.dreamToken;
}

describe('recordDream', () => {
  it('unknown token → tells the agent to re-gather', async () => {
    const bonds = freshBonds();
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: 'nope', taste: { tags: ['x'] } });
    expect(r.text).toContain('过期');
  });

  it('empty taste tags → REJECTED and the token survives for a retry', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps, written, stamped } = recordDeps(bonds);

    const bad = await recordDream(deps, { dreamToken: token, taste: { summary: '一段散文' } });
    expect(bad.text).toContain('tags');
    expect(written).toHaveLength(0);
    expect(stamped).toHaveLength(0);

    const good = await recordDream(deps, { dreamToken: token, taste: { tags: ['航天'] } });
    expect(good.text).toContain('🌙');
    expect(written[0]!.tags).toEqual(['航天']);
  });

  // Nightly dream output previously had no proactive
  // delivery path: it stayed silent unless the owner ran `/popclaw review`. Morning highlights (tier proposals + major events)
  // enter L2 so the agent can mention them on the owner's next turn.
  it('晨间精华入 L2：升档提议与【大事】各成一条', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds, NOW - 1000);
    const queued: Array<{ level: string; kind: string; payload: Record<string, unknown> }> = [];
    const { deps } = recordDeps(bonds, {
      proposeTierChanges: () => [
        { popclawId: 'ALICE', fromTier: 'acquaintance', toTier: 'friend', rationale: '最近往来 7 次' },
      ],
      notify: (a) => void queued.push(a),
    });

    await recordDream(deps, {
      dreamToken: token,
      people: [
        {
          popclaw_id: 'ALICE',
          dynamics: [{ summary: '像是要结婚了', milestone: true }, { summary: '发了个帖' }],
        },
      ],
      taste: { tags: ['航天'] },
    });

    expect(queued.every((q) => q.level === 'L2')).toBe(true);
    const proposal = queued.find((q) => q.kind === 'bond_proposal');
    expect(proposal?.payload).toMatchObject({ popclawId: 'ALICE', toTier: 'friend' });
    const milestone = queued.find((q) => q.kind === 'bond_milestone');
    expect(milestone?.payload).toMatchObject({ popclawId: 'ALICE', summary: '像是要结婚了' });
    // Ordinary updates that are not major events must not interrupt the owner.
    expect(queued.filter((q) => q.kind === 'bond_milestone')).toHaveLength(1);
  });

  it('没提议也没大事 → 一条通知都不塞（做梦不制造噪音）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds, NOW - 1000);
    const queued: unknown[] = [];
    const { deps } = recordDeps(bonds, { notify: (a) => void queued.push(a) });
    await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', dynamics: [{ summary: '发了个帖' }] }],
      taste: { tags: ['航天'] },
    });
    expect(queued).toHaveLength(0);
  });

  it('writes knowledge + dynamics, advances the cursor, stamps the dream', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds, NOW - 1000);
    const { deps, written, stamped } = recordDeps(bonds);

    const r = await recordDream(deps, {
      dreamToken: token,
      people: [
        {
          popclaw_id: 'ALICE',
          tags: ['rocket', 'rocket', ' founder '],
          description: 'builds rockets',
          dynamics: [{ summary: '发射成功', milestone: true }, { summary: '发了个帖' }],
        },
      ],
      taste: { tags: ['航天'], mute: ['八卦'], summary: '爱看工程细节' },
    });

    const alice = bonds.get('ALICE')!;
    expect(alice.tags).toEqual(['rocket', 'founder']); // Deduplicate and trim.
    expect(alice.description).toBe('builds rockets');
    expect(alice.lastDreamTs).toBe(NOW - 1000);
    expect(bonds.recentDynamics('ALICE', 10)).toHaveLength(2);
    expect(written[0]).toEqual({ tags: ['航天'], mute: ['八卦'], summary: '爱看工程细节' });
    expect(stamped).toEqual([NOW]);
    expect(r.text).toContain('大事');
  });

  it('a person the agent skipped keeps their cursor — retried next dream', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps } = recordDeps(bonds);
    await recordDream(deps, { dreamToken: token, people: [], taste: { tags: ['x'] } });
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull();
  });

  it('ignores people that were not in the materials', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps } = recordDeps(bonds);
    await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'MALLORY', tags: ['whatever'], description: 'injected' }],
      taste: { tags: ['x'] },
    });
    expect(bonds.get('MALLORY')).toBeNull();
  });

  it('a backup failure does not lose the dream', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps, stamped } = recordDeps(bonds, {
      backup: () => {
        throw new Error('disk full');
      },
    });
    const r = await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } });
    expect(r.text).toContain('🌙');
    expect(stamped).toEqual([NOW]);
  });

  it('the token is single-use once consumed', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps } = recordDeps(bonds);
    await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } });
    const again = await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } });
    expect(again.text).toContain('过期');
  });

  // S3 rollout slice 4 — en lane.
  it('renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps } = recordDeps(bonds);

    const expired = await recordDream(deps, { dreamToken: 'nope', taste: { tags: ['x'] } });
    expect(expired.text).toContain('expired');

    const noTags = await recordDream(deps, { dreamToken: token, taste: { summary: 'prose only' } });
    expect(noTags.text).toContain('tags is empty');

    const ok = await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', tags: ['rocket'], dynamics: [{ summary: 'launched', milestone: true }] }],
      taste: { tags: ['rockets'] },
    });
    expect(ok.text).toContain('🌙 Dream complete:');
    expect(ok.text).toContain('milestone');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});

// ---------------------------------------------------------------------------
// dream_basis compatibility receipt (authorized 2026-09-06): the material page prints
// the same receipt identifier under a non-*_token name for the agent to copy into people as a regular field.
// The dream equivalent of newspaper edit.basis: accept both fields, never guess, and consume or mark processed only on success.
// ---------------------------------------------------------------------------

/** Mint a batch with a CHOSEN token — the fixed 'dream_test' minter can't tell two batches apart. */
function batch(bonds: BondsStore, token: string, postTs = NOW - 1000): string {
  const r = gatherDreamMaterials(
    gatherDeps({ bondsStore: bonds, cache: { recent: () => [post('ALICE', postTs)] }, mintToken: () => token }),
  );
  if (r.kind !== 'ready') throw new Error('expected ready');
  return r.dreamToken;
}

describe('gatherDreamMaterials — 素材页双名回执', () => {
  it('同一标识以 dream_token 与 dream_basis 两个名字印出，并教 agent 把 basis 作为顶层参数交回', () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const r = gatherDreamMaterials(
      gatherDeps({
        bondsStore: bonds,
        cache: { recent: () => [post('ALICE', NOW - 1000)] },
        mintToken: () => 'dream_r1',
      }),
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain('dream_token = "dream_r1"');
    expect(r.payload).toContain('dream_basis = "dream_r1"');
    // Teach the top-level parameter with a non-token name (the same value also works inside people), independent of nonempty people.
    expect(r.payload).toContain('dream_basis argument');
  });
});

// ---------------------------------------------------------------------------
// Leading batch-metadata block (F1 layout fix). Evidence boundary for the 2026-09-06 run:
// the persisted copy contained this batch's receipt (inner text positions 12429/12562).
// Historical material included an old error report with literal truncated/dream_token text. Historical narrative
// confusing the model remains an unverified hypothesis: neither the final host prompt nor model internals were verified. Layout-only fix:
// move the current receipt and the historical-report-is-not-this-call rule before all dynamic historical material. Keep the original
// footer receipt block unchanged (render the same x.dreamToken twice); leave windows, cursors, sampling, renderLogLine truncation,
// and recordDream validation unchanged. All data is synthetic: this file proves layout and retention, not model
// behavior, which needs a subsequent natural or controlled dream run after installation.
// ---------------------------------------------------------------------------

const FRONT_MARKER = "[This batch's metadata — read before the history below]";
/** Shape of the real 8/31 bug report: the body quotes an older sentence containing truncated/dream_token verbatim. */
const OLD_BUG_REPORT =
  'feedback: popclaw_dream tool output is truncated before the dream_token is shown, please fix';

describe('buildDreamPayload — 页首本批元数据块（先于一切历史材料）', () => {
  it('① 历史引用旧 bug 上报（字面 truncated/dream_token）→ 元数据块居页首，历史区保留且既有裁剪不撤', () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const r = gatherDreamMaterials(
      gatherDeps({
        bondsStore: bonds,
        cache: { recent: () => [post('ALICE', NOW - 1000)] },
        readSocialLog: () => [
          logRec({ text: OLD_BUG_REPORT }),
          logRec({ kind: 'reply_received', text: '收到，复现了', in_reply_to: { text: OLD_BUG_REPORT } }),
          logRec({ text: 'y'.repeat(400) }), // Exceeds LOG_TEXT_PREVIEW=300: history still uses the existing truncation limit.
        ],
      }),
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    // Metadata is the first page line, preceding Material A / Material B (all dynamic historical material).
    expect(r.payload.indexOf(FRONT_MARKER)).toBe(0);
    expect(r.payload.indexOf(FRONT_MARKER)).toBeLessThan(r.payload.indexOf('[Material A'));
    expect(r.payload.indexOf(FRONT_MARKER)).toBeLessThan(r.payload.indexOf("[Material B"));
    // Do not sanitize history: preserve the old bug report verbatim, including truncated/dream_token; synthetic material, not a reproduction of model reasoning.
    expect(r.payload).toContain(OLD_BUG_REPORT);
    expect(r.payload.match(/truncated/g)).toHaveLength(2); // One occurrence in text and one in replying to.
    // Retaining history does not remove limits: renderLogLine still truncates >300 characters to 300 + …
    expect(r.payload).toContain(`text="${'y'.repeat(300)}…"`);
    expect(r.payload).not.toContain('y'.repeat(301));
  });

  it('② 超长 Material B（合成 66 条）→ 元数据块仍居页首', () => {
    const r = gatherDreamMaterials({
      ...gatherDeps(),
      readSocialLog: () => Array.from({ length: 66 }, (_, i) => logRec({ ts: NOW - 3600 - i, text: `entry${i}` })),
    });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload.indexOf(FRONT_MARKER)).toBe(0);
    expect(r.payload.indexOf(FRONT_MARKER)).toBeLessThan(r.payload.indexOf("[Material B"));
    expect(r.payload.match(/entry\d+/g)).toHaveLength(66); // Retain every long-history entry.
  });

  it('③ 页首与页尾回执渲染严格一致（同一个 x.dreamToken，两处一字不差）', () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const r = gatherDreamMaterials(
      gatherDeps({
        bondsStore: bonds,
        cache: { recent: () => [post('ALICE', NOW - 1000)] },
        mintToken: () => 'dream_f1',
      }),
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    const tokens = r.payload.match(/dream_token = "[^"]*"/g) ?? [];
    const bases = r.payload.match(/dream_basis = "[^"]*"/g) ?? [];
    expect(tokens).toHaveLength(2); // Exactly one at the top and one at the bottom.
    expect(bases).toHaveLength(2);
    expect(new Set(tokens).size).toBe(1); // Both renderings use exactly the same string.
    expect(new Set(bases).size).toBe(1);
    expect(tokens[0]).toBe('dream_token = "dream_f1"');
    expect(bases[0]).toBe('dream_basis = "dream_f1"');
    expect(r.payload.indexOf(tokens[0]!)).toBeLessThan(r.payload.lastIndexOf(tokens[0]!)); // Header first, footer last.
  });

  it('④ taste-only 素材（没有人物新帖）→ 页首元数据块同样在场', () => {
    const r = gatherDreamMaterials(
      gatherDeps({ readSocialLog: () => [logRec({ text: 'hello' })], mintToken: () => 'dream_f2' }),
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload.indexOf(FRONT_MARKER)).toBe(0);
    expect(r.payload).toContain('dream_token = "dream_f2"');
    expect(r.payload).toContain('[Material A · new posts from people you follow] No new posts in this window.');
  });

  it('⑤ 页首规则句钉评审措辞：历史报告≠本次调用；不承诺「本页完整」；单腿可用即成立', () => {
    const r = gatherDreamMaterials(gatherDeps({ readSocialLog: () => [logRec()] }));
    if (r.kind !== 'ready') throw new Error('want ready');
    const front = r.payload.slice(0, r.payload.indexOf('[Two outputs]'));
    // Sentences pinned by r37/r39: error reports concern past calls; stop on missing or conflicting receipts, without guessing or using historical values.
    expect(front).toContain('describe PAST calls, not this one');
    expect(front).toContain('stop — do not guess, do not fall back to values found in history');
    // r37 rejects an unconditional complete-page guarantee; the header must not make that promise.
    expect(front).not.toMatch(/complete/i);
    // r39 point 2: do not imply both fields are required; either usable path suffices (retain PR#560 compatibility).
    expect(front).toContain('either one alone proves this batch');
  });

  it('⑥ 页尾拒绝条款补准确：顶层 dream_basis 与 people 内层兼容腿都写到，后半句原样', () => {
    const r = gatherDreamMaterials(gatherDeps({ readSocialLog: () => [logRec()] }));
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain('nor a dream_basis (top-level or inside people) is refused');
    expect(r.payload).toContain('refusal never consumes the material, so fix the field up and submit again.');
  });
});

describe('recordDream — dream_basis 双标识回执', () => {
  it('真令牌单独（people 不带 basis）→ 照旧成功，主腿一字不变', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_t1');
    const { deps, written, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('🌙');
    expect(bonds.get('ALICE')!.lastDreamTs).toBe(NOW - 1000);
    expect(written[0]!.tags).toEqual(['航天']);
    expect(stamped).toEqual([NOW]);
  });

  it('真令牌 + basis 被洗成占位符 → 照旧按令牌走（*** 不构成主张）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_t2');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', dream_basis: '***', tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('🌙');
    expect(bonds.get('ALICE')!.lastDreamTs).toBe(NOW - 1000);
  });

  it('两标识一致配对 → 正常成功', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_t3');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', dream_basis: token, tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('🌙');
  });

  it('令牌被洗成 *** 时，people 里带回的 dream_basis 单独成立（同等批次/生命周期校验）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_b1');
    const { deps, written, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: '***',
      people: [{ popclaw_id: 'ALICE', dream_basis: '"dream_b1"', tags: ['rocket'] }], // Accept a value copied back with quotation marks.
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('🌙');
    expect(bonds.get('ALICE')!.lastDreamTs).toBe(NOW - 1000);
    expect(written[0]!.tags).toEqual(['航天']);
    expect(stamped).toEqual([NOW]);
    // Same lifecycle: resubmitting a consumed identifier (via the token path this time) is expired.
    const again = await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } });
    expect(again.text).toContain('过期');
  });

  it('两标识都真但指向不同批次 → 拒，两张台账都不销账', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const a = batch(bonds, 'dream_c1');
    const b = batch(bonds, 'dream_c2', NOW - 999);
    const { deps, written, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: b,
      people: [{ popclaw_id: 'ALICE', dream_basis: a, tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('两批不同的素材');
    expect(r.text).toContain('dream_c1');
    expect(written).toHaveLength(0);
    expect(stamped).toHaveLength(0);
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull(); // Not incorrectly marked processed.
    // Neither was consumed: each path can still be resubmitted independently.
    expect((await recordDream(deps, { dreamToken: b, taste: { tags: ['x'] } })).text).toContain('🌙');
    expect((await recordDream(deps, { dreamToken: a, taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  it('两个都不可用（被洗/缺失）→ 拒，不销账、不误标已处理，真令牌补交还能成', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_n1');
    const { deps, written, stamped } = recordDeps(bonds);
    const scrubbed = await recordDream(deps, {
      dreamToken: '***',
      people: [{ popclaw_id: 'ALICE', dream_basis: '***', tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(scrubbed.text).toContain('无法证明');
    const missing = await recordDream(deps, {
      dreamToken: '',
      people: [{ popclaw_id: 'ALICE', tags: ['rocket'] }],
      taste: { tags: ['航天'] },
    });
    expect(missing.text).toContain('无法证明');
    expect(written).toHaveLength(0);
    expect(stamped).toHaveLength(0);
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull();
    expect((await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  it('basis 指向已过期/不存在的素材 → 与令牌过期同一条规则拒绝，不销账', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_e1');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: '***',
      people: [{ popclaw_id: 'ALICE', dream_basis: 'dream_gone', tags: ['x'] }],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('dream_basis'); // Specify which path expired, rather than reporting generic token expiry.
    expect(r.text).toContain('过期');
    expect((await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  it('people 条目里带回互不相同的 dream_basis → 自相矛盾，拒（不挑一个猜）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    batch(bonds, 'dream_p1');
    batch(bonds, 'dream_p2', NOW - 999);
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: '***',
      people: [
        { popclaw_id: 'ALICE', dream_basis: 'dream_p1', tags: ['x'] },
        { popclaw_id: 'ALICE', dream_basis: 'dream_p2', tags: ['y'] },
      ],
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('互不相同');
    expect((await recordDream(deps, { dreamToken: 'dream_p1', taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  // S3 rollout slice 4: en lane (new rejection copy also covers both language lanes).
  it('renders the new refusals in en when set', async () => {
    setOwnerLang('en', 'config');
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_l1');
    const { deps } = recordDeps(bonds);

    const neither = await recordDream(deps, { dreamToken: '***', taste: { tags: ['x'] } });
    expect(neither.text).toContain('neither a usable dream_token');

    const conflict = await recordDream(deps, {
      dreamToken: token,
      people: [{ popclaw_id: 'ALICE', dream_basis: 'dream_other', tags: ['x'] }],
      taste: { tags: ['x'] },
    });
    expect(conflict.text).toContain('two different material batches');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});

// ---------------------------------------------------------------------------
// Batch receipts are independent of people. Taste-only submissions and skipping
// all people are normal workflows explicitly allowed by gather; receipts must not depend on nonempty people.
// The top-level non-token-named dream_basis is primary; the same value inside people is compatible, and contradictions are rejected.
// ---------------------------------------------------------------------------

describe('recordDream — 顶层 dream_basis：回执独立于 people', () => {
  it('①a people 缺失、仅 taste 交稿 + 顶层 basis → 过（脱参信道上 taste-only 也有路可交）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_s1');
    const { deps, written, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: '***', dreamBasis: token, taste: { tags: ['航天'] } });
    expect(r.text).toContain('🌙');
    expect(written[0]!.tags).toEqual(['航天']);
    expect(stamped).toEqual([NOW]);
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull(); // No conclusions about people; do not move the cursor.
  });

  it('①b people=[] 且仅 taste + 顶层 basis → 过', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_s2');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: '***', dreamBasis: token, people: [], taste: { tags: ['航天'] } });
    expect(r.text).toContain('🌙');
  });

  it('② 跳过所有人物（条目在、结论空）+ 顶层 basis → 过，不动任何游标', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_s3');
    const { deps, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, {
      dreamToken: '***',
      dreamBasis: token,
      people: [{ popclaw_id: 'ALICE' }], // All empty means no conclusion about her this time; revisit next round.
      taste: { tags: ['航天'] },
    });
    expect(r.text).toContain('🌙');
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull();
    expect(stamped).toEqual([NOW]);
  });

  it('③ 真实工具路径：schema 结构校验 + coerce + handler，basis-only 全程可过', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_s4');
    // (a) Structure gate: the host validates arguments with this JSON Schema; dream_token is now optional.
    // Calls without a token must not fail structural validation (this schema is the host's actual validation contract;
    // MCP passes inputSchema through directly, see mcp.ts / toInputSchema).
    const basisOnly = { dream_basis: token, taste: { tags: ['航天'] } };
    expect(Value.Check(RecordDreamSchema, basisOnly)).toBe(true);
    expect(Value.Check(RecordDreamSchema, {})).toBe(true); // Missing both is a ledger-layer rejection, not a structural one.
    // (b) Normalization gate: coerce neither drops fields nor throws when dream_token is missing.
    const input = coerceRecordDream(basisOnly);
    expect(input.dreamToken).toBe('');
    expect(input.dreamBasis).toBe(token);
    // (c) Ledger gate: real batch, identical validation → successful writeback.
    const { deps, written } = recordDeps(bonds);
    const r = await recordDream(deps, input);
    expect(r.text).toContain('🌙');
    expect(written[0]!.tags).toEqual(['航天']);
  });

  it('④ 旧 token-only 调用照旧保通（无 basis 字段）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_s5');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } });
    expect(r.text).toContain('🌙');
  });

  it('⑤ 顶层 basis 与真 token 指向不同批次 → 拒：不写、不销账，两条腿各自仍可赎', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const a = batch(bonds, 'dream_s6');
    const b = batch(bonds, 'dream_s7', NOW - 999);
    const { deps, written, stamped } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: b, dreamBasis: a, taste: { tags: ['航天'] } });
    expect(r.text).toContain('两批不同的素材');
    expect(written).toHaveLength(0);
    expect(stamped).toHaveLength(0);
    expect(bonds.get('ALICE')!.lastDreamTs).toBeNull();
    expect((await recordDream(deps, { dreamToken: b, taste: { tags: ['x'] } })).text).toContain('🌙');
    expect((await recordDream(deps, { dreamBasis: a, dreamToken: '', taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  it('顶层与 people 内层并存：同值一致即过，矛盾即拒（不挑一边）', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const both = batch(bonds, 'dream_s8'); // The consistent path consumes only its own receipt.
    const token = batch(bonds, 'dream_s8b', NOW - 997);
    const other = batch(bonds, 'dream_s9', NOW - 998);

    const consistent = await recordDream(
      recordDeps(bonds).deps,
      {
        dreamToken: '***',
        dreamBasis: both,
        people: [{ popclaw_id: 'ALICE', dream_basis: both, tags: ['x'] }],
        taste: { tags: ['航天'] },
      },
    );
    expect(consistent.text).toContain('🌙');

    const { deps, written } = recordDeps(bonds);
    const conflict = await recordDream(deps, {
      dreamToken: '***',
      dreamBasis: token,
      people: [{ popclaw_id: 'ALICE', dream_basis: other, tags: ['x'] }],
      taste: { tags: ['航天'] },
    });
    expect(conflict.text).toContain('互不相同');
    expect(written).toHaveLength(0);
    // Neither ledger has been consumed.
    expect((await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } })).text).toContain('🌙');
    expect((await recordDream(deps, { dreamToken: other, taste: { tags: ['x'] } })).text).toContain('🌙');
  });

  it('顶层 basis 过期/不存在 → 拒且点名 basis 腿，未销账', async () => {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = batch(bonds, 'dream_sa');
    const { deps } = recordDeps(bonds);
    const r = await recordDream(deps, { dreamToken: '***', dreamBasis: 'dream_gone2', taste: { tags: ['航天'] } });
    expect(r.text).toContain('dream_basis');
    expect(r.text).toContain('过期');
    expect((await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } })).text).toContain('🌙');
  });
});

// A capability should introduce itself when it first provides real value (spec §5). A mechanism that needs scheduling
// but never asks to be scheduled is unfinished, not deferred work.
describe('recordDream — 梦做完那一刻问要不要每晚自动', () => {
  async function record(dreamCron?: RecordDreamDeps['dreamCron']) {
    const bonds = freshBonds();
    bonds.setFollowed('ALICE', true);
    const token = tokenFor(bonds);
    const { deps } = recordDeps(bonds, dreamCron ? { dreamCron } : {});
    return (await recordDream(deps, { dreamToken: token, taste: { tags: ['x'] } })).text;
  }

  it('确定没排 → 问，且说清它不占注意力', async () => {
    const text = await record(async () => ({ scheduled: false }));
    expect(text).toContain('每天凌晨 3 点');
    expect(text).toContain('不占你的注意力');
  });

  it('已经排了 → 不问（不要每晚都问一遍已经排好的人）', async () => {
    expect(await record(async () => ({ scheduled: true }))).not.toContain('每天凌晨 3 点');
  });

  it('查不到 → 不问（查不到 ≠ 没排）', async () => {
    expect(await record(async () => null)).not.toContain('每天凌晨 3 点');
    expect(await record()).not.toContain('每天凌晨 3 点');
  });

  it('查询本身抛异常也不许弄坏写回', async () => {
    const text = await record(async () => { throw new Error('cron store gone'); });
    expect(text).toContain('🌙');
    expect(text).not.toContain('每天凌晨 3 点');
  });
});
