import { describe, expect, it } from 'vitest';
import { mapVerifiedProfiles, renderVerifiedProfileSummary, safeAvatarUrl, snapshotText } from '../../../src/identity/profile-snapshot.js';
import { namecardDetails, renderPassport } from '../../../src/identity/passport-renderer.js';

describe('public verified profile snapshots', () => {
  it('retains exact source biography, follower evidence, proof and source task in details', () => {
    const bio = 'Public biography.\nSecond line.  ';
    const profiles = mapVerifiedProfiles([{ platform: 'x', handle: 'owner', verified_at: '2026-10-08T00:00:00Z',
      bio, follower_count: 0, follower_count_observed: true, source_task_id: 'verified-source',
      profile_url: 'https://x.com/owner', proof_url: 'https://x.com/owner/status/1', avatar_url: 'https://img.example/avatar.png' }]);
    const details = namecardDetails({ popclawId: 'id', sigil: 'abc123', handle: 'Owner', profiles });
    expect(details.profiles).toEqual(profiles);
    expect(details.profiles[0]).toMatchObject({ bio, follower_count: 0, follower_count_observed: true,
      source_task_id: 'verified-source', proof_url: 'https://x.com/owner/status/1', avatar_url: 'https://img.example/avatar.png' });
  });

  it('distinguishes observed zero, historical zero and an absent follower snapshot', () => {
    const row = { platform: 'x', handle: 'owner', verified_at: '' };
    expect(renderVerifiedProfileSummary({ ...row, follower_count: 0, follower_count_observed: true }, 'en')).toContain('X followers at verification: 0');
    expect(renderVerifiedProfileSummary({ ...row, follower_count: 0 }, 'en')).toContain('X followers at verification: unconfirmed');
    expect(renderVerifiedProfileSummary(row, 'en')).toContain('X followers at verification: unconfirmed');
    expect(renderVerifiedProfileSummary({ ...row, follower_count: 1300000 }, 'en')).toContain('X followers at verification: about 1.3m');
  });

  it('ignores malformed rows and refuses invalid follower or avatar evidence', () => {
    expect(mapVerifiedProfiles(null)).toEqual([]);
    expect(mapVerifiedProfiles([null, 'row', {}, { platform: 'x' }])).toEqual([]);
    expect(mapVerifiedProfiles([{ platform: 'x', handle: 'owner', follower_count: -1, avatar_url: 'javascript:alert(1)' }])[0]).toMatchObject({ follower_count: null });
    for (const url of ['http://img.example/avatar.png', 'https://user:secret@img.example/avatar.png', 'https://img.example/a\n.png']) {
      expect(safeAvatarUrl(url)).toBeUndefined();
    }
    expect(safeAvatarUrl('https://img.example/avatar.png')).toBe('https://img.example/avatar.png');
  });

  it('keeps a short normal summary and the complete biography and proof in details', () => {
    const bio = 'x'.repeat(150);
    const profiles = [{ platform: 'x', handle: 'owner', verified_at: '2026-10-08T00:00:00Z', bio,
      follower_count: 7, proof_url: 'https://x.com/owner/status/1', avatar_url: 'https://img.example/avatar.png' }];
    const summary = renderVerifiedProfileSummary(profiles[0]!, 'en').join('\n');
    expect(summary).toContain('x'.repeat(120) + '…');
    expect(summary).not.toContain(bio);
    const rendered = renderPassport({ popclawId: 'id', sigil: 'abc123', handle: 'Owner', profiles }).join('\n');
    expect(rendered).toContain(bio);
    expect(rendered).toContain('https://x.com/owner/status/1');
    expect(rendered).toContain('https://img.example/avatar.png');
  });

  it('renders public source text as data while retaining its original structured value', () => {
    const bio = '<script>*instruction*\nnext\u202e';
    expect(snapshotText(bio)).toBe('&lt;script&gt;\\*instruction\\* next');
    expect(mapVerifiedProfiles([{ platform: 'x', handle: 'owner', bio }])[0]?.bio).toBe(bio);
  });
});
