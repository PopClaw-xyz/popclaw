"""Execute the release workflow's retained-both gates without publishing."""
import os
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def step(name):
    text = (ROOT / '.github/workflows/release.yml').read_text()
    for block in text.split('\n      - '):
        if block.startswith('name: ' + name + '\n'):
            return block
    raise AssertionError('Missing workflow step: ' + name)


def shell(name):
    block = step(name).split('        run: |\n', 1)[1]
    lines = []
    for line in block.splitlines():
        if line and not line.startswith('          '):
            break
        lines.append(line[10:])
    return '\n'.join(lines)


class RetainedBoth(unittest.TestCase):
    def resolve(self, run='38074322285', tag='v0.1.0', only='all'):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'output'
            env = dict(os.environ, GITHUB_EVENT_NAME='workflow_dispatch',
                       INPUT_TAG=tag, INPUT_DRY_RUN='false', INPUT_ONLY=only,
                       INPUT_RESUME=run, GITHUB_OUTPUT=str(output))
            result = subprocess.run(['bash', '-c', shell('Resolve what to build')],
                                    env=env, capture_output=True, text=True)
            return result, output.read_text() if output.exists() else ''

    def test_original_failed_run_can_resume_both_without_a_new_build(self):
        result, output = self.resolve()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('mode=resume', output)
        self.assertIn('only=all', output)

    def test_other_run_or_tag_is_refused(self):
        for run, tag in [('38074322286', 'v0.1.0'), ('38074322285', 'v0.1.1')]:
            with self.subTest(run=run, tag=tag):
                result, _ = self.resolve(run, tag)
                self.assertNotEqual(result.returncode, 0)

    def test_existing_shell_resume_and_fresh_modes_remain(self):
        for run, only, mode in [('12345', 'shell', 'resume'), ('', 'all', 'fresh')]:
            result, output = self.resolve(run=run, only=only)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('mode=' + mode, output)
        self.assertNotEqual(self.resolve(run='', only='shell')[0].returncode, 0)

    def state(self, main=False, alias=False, mutation=None):
        source = shell('Check the original retained-both release and registry state')
        source = source.split("python3 - <<'PYTHON'\n", 1)[1].rsplit('\nPYTHON', 1)[0]
        commit = 'd9a849e177a2c760bc50a2b1bd2849b88abc723e'
        original = dict(id=38074322285, head_sha=commit, head_branch='v0.1.0',
                        event='push', path='.github/workflows/release.yml',
                        status='completed', conclusion='failure', repository={'id': 1402869531})
        artifact = dict(id=11677679013, name='release-artefacts-v0.1.0', expired=False,
                        digest='sha256:41354d6ec1bd30e5b2f98548e063d495f39f60bedafd46675e448433b351ff5d',
                        workflow_run={'head_sha': commit})
        metadata = dict(tag='v0.1.0', commit=commit, version='0.1.0',
                        main='popclaw-plugin-0.1.0+2026-10-11-0219-d9a849e.tgz',
                        shell='popclaw-mcp-0.1.0.tgz')
        # Synthetic archive bytes substitute only the two expected digest
        # constants. The production hashing/comparison code executes unchanged.
        fixture = {'main': b'main archive fixture', 'shell': b'shell archive fixture'}
        pins = {'main': '5b72e6f341f6eae0bf247100875bb7aa26c19c8362cf2e9f11c81baf4121ad2f',
                'shell': 'b01e68c42ad007bf7517673aaa2f2991e408535ee8cdd0ae1bd629ca0e6d45f9'}
        for role in fixture:
            self.assertEqual(source.count(pins[role]), 1)
            source = source.replace(pins[role], hashlib.sha256(fixture[role]).hexdigest())
        documents = [original, {'artifacts': [artifact]},
                     {'name': 'popclaw', 'versions': {'0.1.0': {}} if main else {'0.0.0-placeholder': {}}},
                     {'name': 'popclaw-mcp', 'versions': {'0.1.0': {}} if alias else {'0.0.0-placeholder': {}}}]
        if mutation:
            mutation(documents, metadata, fixture)
        urls = []

        def get(request, timeout):
            urls.append(request.full_url)
            data = documents[len(urls) - 1]
            if isinstance(data, Exception):
                raise data
            response = io.BytesIO(json.dumps(data).encode())
            response.status = 200
            return response

        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'artefacts'
            folder.mkdir()
            for role, value in fixture.items():
                (folder / metadata[role]).write_bytes(value)
            (folder / 'release-metadata.json').write_text(json.dumps(metadata))
            output = Path(temp) / 'output'
            env = dict(ORIGINAL_RUN='38074322285', GITHUB_REPOSITORY='PopClaw-xyz/popclaw',
                       RUNNER_TEMP=temp, GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(Path(temp) / 'summary'))
            with patch.dict(os.environ, env), patch('urllib.request.urlopen', get):
                exec(compile(source, 'actual-retained-both-gate', 'exec'), {})
            self.assertEqual(urls, [
                'https://api.github.com/repos/PopClaw-xyz/popclaw/actions/runs/38074322285',
                'https://api.github.com/repos/PopClaw-xyz/popclaw/actions/runs/38074322285/artifacts',
                'https://registry.npmjs.org/popclaw', 'https://registry.npmjs.org/popclaw-mcp'])
            return dict(line.split('=', 1) for line in output.read_text().splitlines())

    def test_both_absent_selects_main_then_shell(self):
        self.assertEqual(self.state(), dict(main_present='false', main_missing='true',
                                           shell_present='false', shell_missing='true'))

    def test_present_versions_are_never_selected_for_republication(self):
        for main, alias in [(True, False), (True, True)]:
            state = self.state(main, alias)
            self.assertEqual(state['main_missing'], 'false')
            self.assertEqual(state['shell_missing'], str(not alias).lower())

    def test_shell_without_main_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Shell exists without'):
            self.state(False, True)

    def test_unknown_registry_state_is_not_absence(self):
        for value in [OSError('network unavailable'), {'error': 'unauthorized'},
                      {'name': 'wrong-package', 'versions': {}}]:
            with self.subTest(value=value), self.assertRaises((OSError, KeyError, ValueError)):
                self.state(mutation=lambda docs, meta, files: docs.__setitem__(2, value))

    def test_wrong_run_artifact_metadata_or_bytes_are_refused(self):
        mutations = [
            lambda d, m, f: d[0].update(head_sha='f' * 40),
            lambda d, m, f: d[0].update(path='.github/workflows/other.yml'),
            lambda d, m, f: d[0].update(status='in_progress'),
            lambda d, m, f: d[0]['repository'].update(id=1),
            lambda d, m, f: d[1]['artifacts'][0].update(id=1),
            lambda d, m, f: d[1]['artifacts'][0].update(digest='sha256:wrong'),
            lambda d, m, f: d[1]['artifacts'][0].update(expired=True),
            lambda d, m, f: m.update(commit='f' * 40),
            lambda d, m, f: m.update(tag='v0.1.1'),
            lambda d, m, f: f.update(main=b'altered main'),
            lambda d, m, f: f.update(shell=b'altered shell'),
        ]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.state(mutation=mutation)

    def test_workflow_conditions_gate_each_publish(self):
        def condition(name, values):
            text = step(name)
            raw = text.split('        if: ', 1)[1].split('\n        shell:', 1)[0]
            raw = ' '.join(raw.replace('>-\n', '').split())
            raw = re.sub(r'steps\.[a-z_]+\.(?:outputs\.[a-z_]+|outcome)',
                         lambda m: repr(values.get(m[0], '')), raw)
            return eval(raw.replace('&&', ' and ').replace('||', ' or '), {'__builtins__': {}}, {})

        for main_present, shell_present in [(False, False), (True, False), (True, True)]:
            values = {'steps.target.outputs.mode': 'resume', 'steps.target.outputs.only': 'all',
                      'steps.target.outputs.dry_run': 'false',
                      'steps.resume_state.outputs.main_missing': str(not main_present).lower(),
                      'steps.resume_state.outputs.main_present': str(main_present).lower(),
                      'steps.resume_state.outputs.shell_present': str(shell_present).lower()}
            self.assertEqual(condition('Publish popclaw with provenance', values), not main_present)
            self.assertEqual(condition('The registry already holds exactly this popclaw', values), main_present)
            self.assertEqual(condition('Verify an already-published retained shell', values), shell_present)
            self.assertFalse(condition('Publish popclaw-mcp with provenance', values))
            values['steps.verify_main.outcome' if not main_present else 'steps.verify_retained_main.outcome'] = 'success'
            self.assertEqual(condition('Publish popclaw-mcp with provenance', values), not shell_present)
            values['steps.target.outputs.dry_run'] = 'true'
            self.assertFalse(condition('Publish popclaw with provenance', values))
            self.assertFalse(condition('Publish popclaw-mcp with provenance', values))

    def test_resume_cannot_rebuild_or_move_tag(self):
        text = (ROOT / '.github/workflows/release.yml').read_text()
        for command in ['just install', 'just build', 'just test', 'just lint']:
            self.assertIn('run: ' + command + "\n        if: steps.target.outputs.mode == 'fresh'", text)
        self.assertIn("if: steps.target.outputs.mode == 'fresh'", step('Pack both packages'))
        self.assertIn('github.event.inputs.tag || github.ref_name', text)
        self.assertNotIn('GITHUB_SHA:', text)
        self.assertNotIn('git tag ', text)

    def test_failed_retained_smoke_blocks_both_publish_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            binaries = folder / 'bin'
            binaries.mkdir()
            (binaries / 'python3').write_text('#!/bin/sh\necho broken-retained-entry >&2\nexit 17\n')
            (binaries / 'npm').write_text('#!/bin/sh\necho published >> "$CALLS"\n')
            for path in binaries.iterdir():
                path.chmod(0o755)
            blocks = [shell('Smoke the exact packages before publication')]
            for name in ['Publish popclaw with provenance', 'Publish popclaw-mcp with provenance']:
                block = step(name)
                self.assertNotIn('continue-on-error', block)
                self.assertNotRegex(block, r'\b(always|failure|cancelled)\(')
                blocks.append(block.split('        run: ', 1)[1].splitlines()[0])
            env = dict(os.environ, PATH=str(binaries) + ':' + os.environ['PATH'],
                       RUNNER_TEMP=temp, MAIN_TGZ='fixed-main.tgz', SHELL_TGZ='fixed-shell.tgz',
                       CALLS=str(folder / 'calls'))
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', '\n'.join(blocks)],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 17)
            self.assertIn('broken-retained-entry', result.stdout)
            self.assertFalse((folder / 'calls').exists())


if __name__ == '__main__':
    unittest.main()
