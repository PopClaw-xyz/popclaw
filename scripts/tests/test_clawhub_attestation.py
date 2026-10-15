"""Retained ClawHub provenance must be verified before any attestation."""
import unittest
import hashlib
import test_verify_retained_clawhub as fixtures
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

class WorkflowAttestation(unittest.TestCase):
    def test_native_success_and_explicit_dry_run_gate_signing(self):
        workflow = (ROOT / '.github/workflows/release-clawhub-native.yml').read_text()
        self.assertIn('  attest-main:', workflow)
        job = workflow.split('  attest-main:', 1)[1]
        self.assertIn('needs: [prepare, publish-native]', job)
        self.assertIn('if: ${{ !inputs.dry_run }}', job)
        self.assertIn('attestations: write', job)
        self.assertIn('artifact-ids: ${{ needs.prepare.outputs.artifact_id }}', job)
        self.assertLess(job.index('verify-retained-clawhub.py attestation'), job.index('uses: actions/attest@'))
        self.assertNotIn('just pack', job)


class AttestationSubjects(unittest.TestCase):
    # Reuse the real six-archive byte fixtures without repeating inherited tests.
    write_archives = fixtures.ArchiveGuards.write_archives

    def setUp(self):
        fixtures.ArchiveGuards.setUp(self)
        (self.out / 'release-context.json').write_bytes(fixtures.json_bytes(self.context))
        self.checksums = self.root / 'attestation.sha256'

    def prepare(self, context=None):
        return fixtures.v.attestation_subjects(
            self.out, self.full_path, self.context if context is None else context, self.checksums)

    def test_exact_main_receipt_and_source_context_are_bound(self):
        subjects = self.prepare()
        self.assertEqual(subjects, ['popclaw-clawhub-0.1.3.tgz', 'receipt.json', 'release-context.json'])
        expected = ''.join(hashlib.sha256((self.out / name).read_bytes()).hexdigest()
                           + '  ' + name + '\n' for name in subjects)
        self.assertEqual(self.checksums.read_text(), expected)

    def test_resume_signs_the_same_original_bytes_and_context(self):
        before = {p.name: p.read_bytes() for p in self.out.iterdir()}
        self.prepare(dict(self.context, resume={'runId': 456}))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.out.iterdir()})

    def test_changed_archive_fails_before_subjects_are_emitted(self):
        archive = self.out / 'popclaw-clawhub-0.1.3.tgz'
        archive.write_bytes(archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'receipt archive digest mismatch'):
            self.prepare()
        self.assertFalse(self.checksums.exists())

    def test_resigning_the_receipt_cannot_hide_modified_code(self):
        self.archives['popclaw-clawhub']['dist/bundled/index.js'] = (b'changed executable', 0o644)
        self.write_archives()
        with self.assertRaisesRegex(ValueError, 'client changed source bytes/mode'):
            self.prepare()
        self.assertFalse(self.checksums.exists())

    def test_wrong_full_source_is_rejected_before_signing(self):
        with self.assertRaisesRegex(ValueError, 'full archive differs'):
            self.prepare(dict(self.context, fullSha256='0' * 64))
        self.assertFalse(self.checksums.exists())

    def test_different_retained_build_context_is_rejected(self):
        for key, value in [('sourceCommit', 'b' * 40), ('source', {'runId': 789}),
                           ('repository', 'unrelated/repo'), ('tag', 'v9.9.9')]:
            with self.subTest(key=key):
                previous = dict(self.context, **{key: value})
                (self.out / 'release-context.json').write_bytes(fixtures.json_bytes(previous))
                with self.assertRaisesRegex(ValueError, 'retained context differs: ' + key):
                    self.prepare()
                self.assertFalse(self.checksums.exists())

    def test_missing_or_symlinked_context_is_not_attested(self):
        path = self.out / 'release-context.json'
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'requires the retained release context'):
            self.prepare()
        target = self.root / 'outside-context.json'
        target.write_bytes(fixtures.json_bytes(self.context))
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'requires the retained release context'):
            self.prepare()
        self.assertFalse(self.checksums.exists())

    def test_output_must_not_overwrite_a_signed_subject(self):
        before = (self.out / 'receipt.json').read_bytes()
        self.checksums = self.out / 'receipt.json'
        with self.assertRaisesRegex(ValueError, 'overwrite a subject'):
            self.prepare()
        self.assertEqual(before, self.checksums.read_bytes())
