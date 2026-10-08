/** One issue's verified public materials; no consumer, cache fill or network. */
import { cidFromCanonical } from '@popclaw/algorithms';
import type { PublicDisplayItem } from '../ingress/public-feed-display.js';
import { readPublicJournal, readPublicJournalSnapshot, type PublicMaterialCapture } from '../ingress/public-journal-reader.js';
import { decodeEnvelopeBody, normalizeFeedItem, numberOrZero, type ReadableFeedItem } from '../ingress/feed-item-projection.js';
import type { IssueData, PulseItem } from './issue.js';
import type { HouseRuntime } from '../runtime/house-lifecycle/house-runtime.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface PublicMaterialReference {
  origin: string; slug: string; authority: string; eventId: string; sequence: string;
  frameDigest: string; materialDigest: string;
}
export interface PublicMaterialBasis { version: 1; references: readonly PublicMaterialReference[] }
export interface PublicMaterialCoverage { origin: string; slug: string; incomplete: boolean; unavailable: boolean; truncated: boolean; observedAt: number | null; code?: string }
export interface PublicMaterialBatch {
  items: ReadableFeedItem[];
  references: PublicMaterialReference[];
  coverage: PublicMaterialCoverage[];
}
export class PublicMaterialRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PublicMaterialRefusal'; }
}
const hash = (bytes: Uint8Array | string): string => cidFromCanonical(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
function materialDigest(p: PulseItem): string {
  return hash(JSON.stringify(p));
}
function frameDigest(capture: PublicMaterialCapture, eventId: string, sequence: string): string {
  const c = capture.capability, binding = JSON.stringify([c.house.origin, c.house.houseKey, c.house.incarnation]);
  const row = capture.executionDb.queryOne<{ frame_bytes: Uint8Array; observed_at: number }>(
    'SELECT frame_bytes,observed_at FROM world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? AND event_id=? AND seq=?',
    [binding, c.publicStream.log_incarnation, eventId, sequence]);
  if (!row) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_REFERENCE_MISSING');
  return hash(JSON.stringify([hash(row.frame_bytes), row.observed_at]));
}
function readable(hit: PublicDisplayItem): ReadableFeedItem | null {
  const item = normalizeFeedItem(hit.item);
  if (!item || hit.bodyUnavailable) return null;
  const fields = (hit.item.envelope ? decodeEnvelopeBody(hit.item.envelope)?.fields : undefined);
  return { ...item, body: hit.body, kind: hit.kind, houseSlug: hit.source.slug,
    media: (hit.media ?? []).map(m => ({ kind: m.kind === 'video' || m.kind === 'gif' ? m.kind : 'image', url: m.url })),
    replyToAuthorHandle: hit.item.replyToAuthorHandle ?? '', replyCount: numberOrZero(hit.item.replyCount),
    markCount: numberOrZero(hit.item.markCount), actorNickname: hit.item.actorNickname ?? '',
    actorVerified: (hit.item.actorVerified ?? []).map(v => ({ platform: v.platform ?? '', handle: v.handle ?? '',
      profileUrl: v.profileUrl ?? '', followerCount: numberOrZero(v.followerCount) })), ...(fields ? { houseFields: fields } : {}) };
}
export function publicMaterialSource(runtime: { houseRuntime?: HouseRuntime }): NewspaperPublicMaterialSource | undefined {
  return runtime.houseRuntime?.newspaperPublicV1 ? new NewspaperPublicMaterialSource(runtime.houseRuntime) : undefined;
}

export class NewspaperPublicMaterialSource {
  constructor(private readonly runtime: Pick<HouseRuntime, 'publicMaterialSources'>) {}
  collect(): PublicMaterialBatch {
    const coverage: PublicMaterialCoverage[] = [], references: PublicMaterialReference[] = [], items: ReadableFeedItem[] = [];
    const houses: Array<{ capture: PublicMaterialCapture; coverage: PublicMaterialCoverage; items: ReadableFeedItem[]; refs: PublicMaterialReference[] }> = [];
    for (const source of this.runtime.publicMaterialSources()) {
      try {
        const capture = source.capture(); capture.assertCurrent();
        if (capture.capability.house.origin !== source.origin || capture.producerPolicy.house.origin !== source.origin
          || capture.producerPolicy.house.houseKey !== capture.capability.house.houseKey
          || capture.producerPolicy.house.incarnation !== capture.capability.house.incarnation
          || capture.producerPolicy.capabilityRevision !== capture.capability.capabilityRevision) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_CAPTURE_MISMATCH');
        const { status, converted, refs } = readPublicJournalSnapshot(capture.executionDb, db => {
          const result = readPublicJournal(db, capture, source, { ownProjection: true, completeWindow: true });
          const status: PublicMaterialCoverage = { ...result.status };
          const converted: ReadableFeedItem[] = [], refs: PublicMaterialReference[] = [];
          for (const hit of result.items) {
            const item = readable(hit);
            if (!item) { status.incomplete = true; status.code = 'NEWSPAPER_PUBLIC_BODY_UNAVAILABLE'; continue; }
            converted.push(item);
            refs.push({ origin: source.origin, slug: source.slug, authority: capture.authority, eventId: item.eventId,
              sequence: hit.source.sequence, frameDigest: frameDigest(capture, item.eventId, hit.source.sequence), materialDigest: '' });
          }
          return { status, converted, refs };
        });
        capture.assertCurrent(); houses.push({ capture, coverage: status, items: converted, refs });
      } catch (error) {
        coverage.push({ origin: source.origin, slug: source.slug, incomplete: true, unavailable: true, truncated: false,
          observedAt: null, code: error instanceof Error ? error.message : 'NEWSPAPER_PUBLIC_UNAVAILABLE' });
      }
    }
    const seen = new Set<string>();
    for (const house of houses) {
      try { house.capture.assertCurrent(); }
      catch { house.coverage = { ...house.coverage, unavailable: true, incomplete: true, code: 'NEWSPAPER_PUBLIC_SOURCE_UPDATED' }; house.items = []; house.refs = []; }
      coverage.push(house.coverage);
      house.items.forEach((item, i) => { if (!seen.has(item.eventId)) { seen.add(item.eventId); items.push(item); references.push(house.refs[i]!); } });
    }
    items.sort((a,b) => b.platformPostCreatedAt - a.platformPostCreatedAt || a.platformPostId.localeCompare(b.platformPostId));
    return { items, references, coverage };
  }
  /** Runtime configuration mandates this check even when a disk ledger lost its basis. */
  validate(issue: IssueData): void {
    try {
      const basis = issue.publicMaterials;
      if (!basis || basis.version !== 1 || !Array.isArray(basis.references) || basis.references.length !== issue.pulse.length)
        throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_BASIS_MISSING');
      if (!Array.isArray(issue.publicCoverage) || Object.keys(issue.byHouse).some(slug => !issue.publicCoverage!.some(source => source.slug === slug)))
        throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_COVERAGE_MISSING');
      const sources = this.runtime.publicMaterialSources(), seen = new Set<string>(), captures: PublicMaterialCapture[] = [];
      for (const p of issue.pulse) {
        const key = JSON.stringify([p.eventId, p.houseSlug]);
        if (seen.has(key)) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_REFERENCE_CONFLICT'); seen.add(key);
        const ref = basis.references.find(r => r.eventId === p.eventId && r.slug === p.houseSlug);
        if (!ref || typeof ref.authority !== 'string' || !/^[a-f0-9]{64}$/.test(ref.frameDigest)
          || ref.materialDigest !== materialDigest(p)) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_MATERIAL_CHANGED');
        const source = sources.find(s => s.origin === ref.origin && s.slug === ref.slug);
        if (!source) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_SOURCE_MISSING');
        const capture = source.capture(); capture.assertCurrent();
        if (capture.authority !== ref.authority) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_SOURCE_UPDATED');
        readPublicJournalSnapshot(capture.executionDb, db => {
          if (frameDigest(capture, ref.eventId, ref.sequence) !== ref.frameDigest) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_EVIDENCE_CHANGED');
          const result = readPublicJournal(db, capture, source, { ownProjection: true, reference: ref });
          const hit = result.items[0];
          if (!hit || hit.item.eventId !== p.eventId || hit.item.authorPopclawId !== p.authorPopclawId || hit.item.platform !== p.platform)
            throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_REFERENCE_REFUSED');
          // An editable ledger cannot introduce body text absent from signed material.
          if (hit.body !== p.text)
            throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_BODY_CHANGED');
        });
        capture.assertCurrent(); captures.push(capture);
      }
      for (const capture of captures) capture.assertCurrent();
    } catch (error) { if (error instanceof PublicMaterialRefusal) throw error;
      throw new PublicMaterialRefusal(error instanceof Error ? error.message : 'NEWSPAPER_PUBLIC_SOURCE_REFUSED'); }
  }
}

/** Editorial selection owns the retained array; unselected observations are not dependencies. */
export function retainPublicMaterialBasis(issue: IssueData, references: readonly PublicMaterialReference[]): IssueData {
  return { ...issue, publicMaterials: { version: 1, references: issue.pulse.map(p => {
    const ref = references.find(r => r.eventId === p.eventId && r.slug === p.houseSlug);
    if (!ref) throw new PublicMaterialRefusal('NEWSPAPER_PUBLIC_REFERENCE_MISSING');
    return { ...ref, materialDigest: materialDigest(p) };
  }) } };
}
export function publicCoverageText(coverage: readonly PublicMaterialCoverage[]): string {
  return coverage.filter(s => s.unavailable || s.incomplete || s.truncated).map(s =>
    renderCopy(ownerLang(), s.unavailable ? 'newspaper.source.unavailable' : 'newspaper.source.partial', { house: s.slug })).join('\n');
}
