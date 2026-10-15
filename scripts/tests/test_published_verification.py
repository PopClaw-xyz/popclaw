"""Run the production registry reader against a sequential fake npm CLI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/verify-published-package.sh'


class PublishedVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.archive = self.base / 'original.tgz'
        self.archive.write_bytes(b'original immutable archive fixture')
        import base64
        self.dist = {'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(self.archive.read_bytes()).digest()).decode(),
                     'attestations': {'url': 'https://registry.npmjs.org/-/npm/v1/attestations/popclaw@0.1.7'}}
        npm = self.base / 'npm'
        npm.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, sys
b = pathlib.Path(os.environ['FAKE_REGISTRY'])
counter = b / 'counter'
i = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(i + 1))
with (b / 'calls').open('a') as out: out.write(json.dumps(sys.argv[1:]) + '\\n')
rows = json.loads((b / 'responses').read_text())
row = rows[min(i, len(rows)-1)]
print(row.get('stdout', ''), end='')
print(row.get('stderr', ''), end='', file=sys.stderr)
sys.exit(row.get('status', 0))
''')
        npm.chmod(0o755)

    def run_reader(self, rows, **overrides):
        (self.base / 'responses').write_text(json.dumps(rows))
        env = dict(os.environ, PATH=str(self.base) + os.pathsep + os.environ['PATH'],
                   FAKE_REGISTRY=str(self.base), REGISTRY_POLL_ATTEMPTS='3', REGISTRY_POLL_SLEEP='0')
        env.update(overrides)
        return subprocess.run(['bash', str(SCRIPT), 'popclaw', '0.1.7', str(self.archive)],
                              capture_output=True, text=True, env=env, timeout=15)

    def ready(self):
        return {'stdout': json.dumps(self.dist)}

    def test_read_error_is_visible_then_success_is_allowed(self):
        result = self.run_reader([{'status': 1, 'stderr': 'npm error code EAI_AGAIN\n'}, self.ready()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('EAI_AGAIN', result.stderr)
        self.assertIn('attempt 1 of 3', result.stderr + result.stdout)

    def test_missing_attestation_can_arrive_after_the_version(self):
        pending = dict(self.dist)
        del pending['attestations']
        result = self.run_reader([{'stdout': json.dumps(pending)}, self.ready()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / 'counter').read_text(), '2')

    def test_malformed_or_empty_metadata_can_recover(self):
        result = self.run_reader([{'stdout': '{partial'}, {'stdout': '{}'}, self.ready()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / 'counter').read_text(), '3')

    def test_persistent_read_failure_reports_actual_error_without_claiming_delay(self):
        result = self.run_reader([{'status': 1, 'stderr': 'npm error code E403\nForbidden\n'}])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('E403', result.stderr)
        self.assertIn('is not readable from the registry', result.stderr + result.stdout)
        self.assertNotIn('not ready yet', result.stderr + result.stdout)
        self.assertEqual((self.base / 'counter').read_text(), '3')

    def test_matching_bytes_and_attestation_still_pass(self):
        result = self.run_reader([self.ready()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('attestation present, registry bytes match', result.stdout)
        self.assertEqual((self.base / 'counter').read_text(), '1')

    def test_wrong_bytes_stop_immediately_instead_of_waiting_for_replacement(self):
        wrong = dict(self.dist, integrity='sha512-WRONG')
        result = self.run_reader([{'stdout': json.dumps(wrong)}, self.ready()])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('serving bytes that were never tested here', result.stderr)
        self.assertEqual((self.base / 'counter').read_text(), '1')

    def test_each_read_is_public_online_and_has_a_finite_network_timeout(self):
        result = self.run_reader([self.ready()])
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.base / 'calls').read_text().splitlines()[0])
        for arg in ['--registry=https://registry.npmjs.org', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000']:
            self.assertIn(arg, args)

    def test_invalid_retry_configuration_fails_before_contacting_npm(self):
        result = self.run_reader([self.ready()], REGISTRY_POLL_ATTEMPTS='0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('REGISTRY_POLL_ATTEMPTS', result.stderr)
        self.assertFalse((self.base / 'counter').exists())


if __name__ == '__main__':
    unittest.main()
