#!/usr/bin/env python3
"""Exercise the real scanner against new synthetic secrets in every allowed path.

Requires Python 3.11+ and the pinned Gitleaks executable. No network requests,
real credentials or files in the working checkout are used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gitleaks', default='gitleaks')
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[1] / '.gitleaks.toml')
    args = parser.parse_args()
    binary = shutil.which(args.gitleaks)
    if not binary:
        raise SystemExit('Gitleaks executable not found')
    config = args.config.resolve()
    data = tomllib.loads(config.read_text())
    paths = set()
    for entry in data['allowlists']:
        for pattern in entry['paths']:
            path = re.sub(r'\\(.)', r'\1', pattern[1:-1])
            if pattern != '^' + re.escape(path) + '$' or Path(path).is_absolute() or '..' in Path(path).parts:
                raise SystemExit('Fixture self-check requires exact repository-relative paths')
            paths.add(path)
    if not paths:
        raise SystemExit('No fixture paths were exercised')
    with tempfile.TemporaryDirectory(prefix='popclaw-gitleaks-') as directory:
        root = Path(directory)
        checkout = root / 'repo'
        checkout.mkdir()
        subprocess.run(['git', 'init', '-q', str(checkout)], check=True)

        def scan(label):
            subprocess.run(['git', '-C', str(checkout), 'add', '--', *sorted(paths)], check=True)
            subprocess.run(['git', '-C', str(checkout), '-c', 'user.name=Fixture', '-c',
                            'user.email=fixture@example.invalid', 'commit', '-qm', label], check=True)
            report = root / (label + '.json')
            result = subprocess.run([binary, 'git', '.', '--config', str(config),
                                     '--log-opts=--all', '--redact=100', '--no-banner',
                                     '--report-format=json', '--report-path', str(report)],
                                    cwd=checkout, text=True, capture_output=True)
            if result.returncode not in (0, 1) or not report.is_file():
                raise SystemExit(f'Scanner failed to run {label}: exit {result.returncode}\n{result.stderr}')
            return result.returncode, json.loads(report.read_text())

        for path in paths:
            target = checkout / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('ordinary clean content\n')
        code, findings = scan('clean')
        if code != 0 or findings:
            raise SystemExit('Clean control did not pass')
        for path in paths:
            # Deterministic, synthetic values; never issued by any provider.
            generic = hashlib.sha256(('generic control ' + path).encode()).hexdigest()
            github = 'ghp_' + hashlib.sha256(('github control ' + path).encode()).hexdigest()[:36]
            (checkout / path).write_text(f'api_key = "{generic}"\ngithub_token = "{github}"\n')
        code, findings = scan('injected')
        observed = {(item['File'], item['RuleID']) for item in findings}
        expected = {(path, rule) for path in paths for rule in ('generic-api-key', 'github-pat')}
        missing = expected - observed
        if code != 1 or missing:
            raise SystemExit(f'New secrets escaped detection: exit={code}, missing={sorted(missing)}')
        print(f'Gitleaks controls passed: clean history plus 2 synthetic secrets in each of {len(paths)} fixture paths.')


if __name__ == '__main__':
    main()
