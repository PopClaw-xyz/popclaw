"""Exercise publication boundaries in isolated Git repositories."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publication', Path(__file__).resolve().parents[1] / 'check-publication.py')
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)

class PublicationChecks(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='popclaw-publication-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.git('init', '-q')
        self.write('.github/workflows/release.yml', 'name: Release\n')
        self.write('README.md', '[Guide](docs/guide.md)\n')
        self.write('docs/guide.md', '# Guide\n')
        self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True, stderr=subprocess.STDOUT)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git('add', '--', path)

    def commit(self):
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')

    def findings(self):
        return publication.check_repository(self.root)

    def test_public_content_and_historical_provenance_are_allowed(self):
        sha = self.git('rev-parse', 'HEAD').strip()
        self.write('README.md', f'[Guide](docs/guide.md#guide)\n[Source](https://github.com/PopClaw-xyz/popclaw/tree/{sha})\nClaude Code, Codex, DeepSeek harness, GLM models.\nPlan 9 is a historical label, not a secret.\n')
        self.write('docs/guide.md', '[Reference][local]\n\n[local]: ../README.md\n`0.1.0-public-envelope-01.6` is historical.\n')
        self.write('protocol/SOURCE-PROVENANCE.json', '{"historical_commit": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}\n')
        self.write('apps/popclaw-plugin/src/example.ts', '// A valid protocol hash: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')
        self.assertEqual(self.findings(), [])

    def test_internal_working_records_do_not_return_to_public_tree(self):
        self.write('docs/superpowers/plans/private-plan.md', 'Working approval record\n')
        self.assertTrue(any('internal-path' in f for f in self.findings()), self.findings())

    def test_private_implementation_modules_are_rejected(self):
        for path in ('apps/lore-house/src/lib.rs', 'apps/popclaw-web/page.tsx',
                     'apps/popclaw-canvas/server.ts', 'packages/evm-contracts/src/Token.sol',
                     '.claude/settings.json', '.agents/skills/internal/SKILL.md'):
            with self.subTest(path=path):
                self.write(path, 'Private implementation or agent configuration\n')
                self.assertTrue(any(f == f'internal-path: {path}' for f in self.findings()), self.findings())

    def test_internal_source_reference_is_rejected(self):
        self.write('apps/popclaw-plugin/src/example.ts', '// See docs/superpowers/specs/missing.md\n')
        self.assertTrue(any('internal-reference' in f for f in self.findings()), self.findings())

    def test_internal_workflow_reference_is_rejected(self):
        self.write('.github/workflows/release.yml', 'name: Release\n# docs/research/private-ruling.md\n')
        self.assertTrue(any('internal-reference' in f for f in self.findings()), self.findings())

    def test_missing_relative_target_fails(self):
        self.write('docs/guide.md', '[Unavailable](missing-guide.md)\n')
        self.assertTrue(any('missing-link' in f for f in self.findings()), self.findings())

    def test_reference_style_missing_target_fails(self):
        self.write('docs/guide.md', '[Unavailable][guide]\n\n[guide]: missing-guide.md\n')
        self.assertTrue(any('missing-link' in f for f in self.findings()), self.findings())

    def test_untracked_target_cannot_make_ci_pass(self):
        (self.root/'docs'/'local-only.md').write_text('Not in the release\n')
        self.write('docs/guide.md', '[Local](local-only.md)\n')
        self.assertTrue(any('missing-link' in f for f in self.findings()), self.findings())

    def test_unresolvable_public_commit_link_fails(self):
        self.write('docs/guide.md', '[Source](https://github.com/PopClaw-xyz/popclaw/tree/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)\n')
        self.assertTrue(any('missing-commit' in f for f in self.findings()), self.findings())

    def test_renaming_trusted_publisher_workflow_fails(self):
        self.git('mv', '.github/workflows/release.yml', '.github/workflows/publish.yml')
        self.assertTrue(any('publisher-workflow' in f for f in self.findings()), self.findings())

    def test_code_examples_are_not_broken_document_links(self):
        self.write('docs/guide.md', '```md\n[Example](not-a-real-file.md)\n```\n')
        self.assertEqual(self.findings(), [])

if __name__ == '__main__':
    unittest.main()
