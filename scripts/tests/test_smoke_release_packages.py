"""Focused artifact regressions using explicitly supplied retained archives."""
import argparse
import hashlib
import io
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

parser = argparse.ArgumentParser()
for name in ['main-tgz', 'shell-tgz', 'node', 'commit', 'output']:
    parser.add_argument('--' + name, required=True)
parser.add_argument('--sdk-root')
args, remaining = parser.parse_known_args()
SCRIPT = Path(__file__).resolve().parents[1] / 'smoke-release-packages.py'


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='release-smoke-test-')
        self.root = Path(self.tmp.name)
        self.main = Path(args.main_tgz).resolve()
        self.shell = Path(args.shell_tgz).resolve()
        self.original_hashes = {str(p): self.sha(p) for p in [self.main, self.shell]}

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def tearDown(self):
        for path, expected in self.original_hashes.items():
            self.assertEqual(self.sha(Path(path)), expected)
        self.tmp.cleanup()

    def mutate(self, source, target, replace=None, remove=False):
        dest = self.root / source.name
        found = False
        with tarfile.open(source) as old, tarfile.open(dest, 'w:gz') as new:
            for member in old.getmembers():
                if member.name == target:
                    found = True
                    if remove:
                        continue
                    content = replace(old.extractfile(member).read()) if callable(replace) else replace
                    member.size = len(content)
                    new.addfile(member, io.BytesIO(content))
                elif member.isfile():
                    new.addfile(member, old.extractfile(member))
                else:
                    new.addfile(member)
        self.assertTrue(found, 'mutation target must exist')
        return dest

    def run_smoke(self, main=None, shell=None, timeout=30, sdk=False, commit=None, bad_checksum=False):
        main, shell = main or self.main, shell or self.shell
        metadata = self.root / 'release-metadata.json'
        metadata.write_text(json.dumps({'tag': 'v0.1.0', 'version': '0.1.0',
            'commit': commit or args.commit, 'main': main.name, 'shell': shell.name}))
        before = {str(p): self.sha(p) for p in [main, shell]}
        sums = self.root / 'SHA256SUMS.txt'
        sums.write_text(''.join(('0' * 64 if bad_checksum else before[str(p)]) + '  ' + p.name + '\n'
                               for p in [main, shell]))
        out = self.root / 'result'
        command = [sys.executable, str(SCRIPT), '--main-tgz', str(main), '--shell-tgz', str(shell),
            '--metadata', str(metadata), '--checksums', str(sums), '--node', str(Path(args.node).resolve()),
            '--output', str(out), '--timeout-seconds', str(timeout)]
        if sdk:
            self.assertIsNotNone(args.sdk_root, 'explicit SDK root is required for this optional test')
            command += ['--sdk-root', str(Path(args.sdk_root).resolve())]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        receipt = json.loads((out / 'receipt.json').read_text())
        evidence = Path(args.output)
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / (self._testMethodName + '.json')).write_text(json.dumps({
            'command': command, 'exit': result.returncode, 'stdout': result.stdout,
            'stderr': result.stderr, 'receipt': receipt}, indent=2) + '\n')
        logs = evidence / (self._testMethodName + '-logs')
        logs.mkdir(exist_ok=True)
        for log in out.glob('*.log'):
            shutil.copyfile(log, logs / log.name)
        for path in [main, shell]:
            self.assertEqual(self.sha(path), before[str(path)])
        self.assertTrue(receipt['inputsUnchanged'])
        self.assertTrue(receipt['fixtureRemoved'])
        for child in receipt['steps']:
            self.assertTrue(child['reaped'])
            self.assertTrue(child['processGroupClean'])
            with self.assertRaises(ProcessLookupError):
                os.kill(child['pid'], 0)
        return result, receipt

    def rejected(self, result, receipt, stage):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(receipt['status'], 'FAIL')
        self.assertIn(stage, receipt['error'])

    def assert_valid(self, result, receipt):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['requiredCheckCount'], 5)
        self.assertTrue(all(step['status'] == 'PASS' and step['exit'] == 0 for step in receipt['steps']))
        mcp = [step for step in receipt['steps'] if step['name'] in ['main-mcp', 'shell-mcp', 'main-mcp-restart']]
        self.assertEqual(len(mcp), 3)
        self.assertEqual([step['toolCount'] for step in mcp], [55, 55, 55])
        for field in ['buildStamp', 'identitySha256', 'toolDigest']:
            self.assertEqual(len({step[field] for step in mcp}), 1)
        self.assertIn('abi', receipt['runtime'])

    def test_broken_main_entry_rejected(self):
        broken = self.mutate(self.main, 'package/dist/bundled/cli.js', b'not valid JavaScript !!!\n')
        self.rejected(*self.run_smoke(main=broken), 'cli-help')

    def test_missing_shell_bin_rejected(self):
        broken = self.mutate(self.shell, 'package/bin/popclaw-mcp.js', remove=True)
        self.rejected(*self.run_smoke(shell=broken), 'shell-entry')

    def test_missing_shell_import_target_rejected(self):
        broken = self.mutate(self.shell, 'package/bin/popclaw-mcp.js', b"import 'popclaw/missing-entry';\n")
        self.rejected(*self.run_smoke(shell=broken), 'shell-mcp')

    def test_checksum_mismatch_rejected(self):
        result, receipt = self.run_smoke(bad_checksum=True)
        self.rejected(result, receipt, 'archive checksum mismatch')
        self.assertEqual(receipt['steps'], [])

    def test_wrong_build_stamp_rejected(self):
        self.rejected(*self.run_smoke(commit='0' * 40), 'wrong release build stamp')

    def test_tool_contract_mismatch_rejected(self):
        def changed(content):
            manifest = json.loads(content)
            manifest['contracts']['tools'][0] = 'popclaw_nonexistent_tool'
            return json.dumps(manifest).encode()
        broken = self.mutate(self.main, 'package/openclaw.plugin.json', changed)
        self.rejected(*self.run_smoke(main=broken), 'tool manifest mismatch')

    def test_invalid_json_rpc_rejected(self):
        broken = self.mutate(self.shell, 'package/bin/popclaw-mcp.js',
            b"process.stdin.once('data',()=>console.log(JSON.stringify({jsonrpc:'wrong',id:1,result:{}})));\n")
        self.rejected(*self.run_smoke(shell=broken), 'invalid JSON-RPC')

    def test_timeout_reaped(self):
        broken = self.mutate(self.main, 'package/dist/bundled/cli.js', b'setInterval(()=>{},1000);\n')
        self.rejected(*self.run_smoke(main=broken, timeout=.3), 'cli-help')

    def test_output_limit_reaped(self):
        broken = self.mutate(self.main, 'package/dist/bundled/cli.js',
            b"setInterval(()=>process.stdout.write('x'.repeat(65536)+'\\n'),1);\n")
        self.rejected(*self.run_smoke(main=broken), 'cli-help')

    def test_exited_leader_term_ignoring_descendant_cleaned(self):
        spec = importlib.util.spec_from_file_location('release_smoke_driver', SCRIPT)
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        marker = self.root / 'descendant.pid'
        child_code = "import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(" + repr(str(marker)) + ").write_text(str(os.getpid()));time.sleep(60)"
        parent_code = "import subprocess,sys,time;from pathlib import Path;subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);p=Path(" + repr(str(marker)) + ");\nwhile not p.exists():time.sleep(.01)\n"
        receipt = {'steps': []}
        child = driver.Child([sys.executable, '-c', parent_code], 'owned-descendant',
            os.environ.copy(), self.root, self.root, 10, receipt)
        descendant = None
        try:
            child.finish()
            descendant = int(marker.read_text())
            os.kill(descendant, 0)
            child.cleanup(True)
            self.assertEqual(receipt['steps'][0]['status'], 'PASS')
            self.assertTrue(receipt['steps'][0]['processGroupClean'])
            with self.assertRaises(ProcessLookupError):
                os.kill(descendant, 0)
        finally:
            if descendant is not None:
                try:
                    os.kill(descendant, 9)
                except ProcessLookupError:
                    pass
            evidence = Path(args.output)
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / (self._testMethodName + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')

    def test_valid_pair_without_sdk(self):
        result, receipt = self.run_smoke()
        self.assert_valid(result, receipt)
        self.assertEqual(receipt['nativeSdkRegistration']['status'], 'not_run')

    @unittest.skipUnless(args.sdk_root, 'optional SDK registration needs explicit --sdk-root')
    def test_valid_pair_with_explicit_sdk(self):
        result, receipt = self.run_smoke(sdk=True)
        self.assert_valid(result, receipt)
        self.assertEqual(receipt['nativeSdkRegistration']['status'], 'PASS')
        self.assertEqual(receipt['nativeSdkRegistration']['sdkVersion'], '2026.9.8')


if __name__ == '__main__':
    unittest.main(argv=['test_smoke_release_packages.py'] + remaining)
