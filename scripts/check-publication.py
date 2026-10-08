#!/usr/bin/env python3
"""Check tracked public content. Does not scan secrets, history or live services."""
import argparse
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

# Private implementation and working records excluded from the public snapshot.
PRIVATE_PREFIXES = (
    'external/', '.claude/', '.agents/', '.claude-roles/', 'docs/research/',
    'docs/superpowers/', 'apps/lore-house/', 'apps/popclaw-web/',
    'apps/popclaw-canvas/', 'packages/evm-contracts/',
)
PRIVATE_FILES = {'CLAUDE.md', 'apps/popclaw-plugin/docs/perf/idle-cpu-baseline-2026-09-27.md'}
INTERNAL_REFERENCE = re.compile(r'docs/(?:superpowers|research)/[^\s`<>]*')
INLINE_LINK = re.compile(r'!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+[\'\"][^\n]*?[\'\"])?\)')
REFERENCE_LINK = re.compile(r'^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?', re.MULTILINE)
HTML_LINK = re.compile(r'\b(?:href|src)=[\'\"]([^\'\"]+)[\'\"]', re.IGNORECASE)
PUBLIC_COMMIT = re.compile(r'^/PopClaw-xyz/popclaw/(?:tree|blob|commit)/([0-9a-f]{7,40})(?:/|$)')


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE)


def prose(text: str) -> str:
    """Drop fenced and inline code examples before recognizing Markdown links."""
    lines = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            continue
        if marker:
            fence = marker[1]
            continue
        lines.append(line)
    return re.sub(r'(`+).*?\1', '', '\n'.join(lines))


def check_repository(root: Path) -> list[str]:
    root = root.resolve()
    tracked = set(git(root, 'ls-files', '-z').split('\0')) - {''}
    findings = []
    workflow = '.github/workflows/release.yml'
    if workflow not in tracked or not (root / workflow).is_file():
        findings.append('publisher-workflow: retain .github/workflows/release.yml; both npm trust bindings name it')
    commit_cache = {}
    for name in sorted(tracked):
        if name in PRIVATE_FILES or name.startswith(PRIVATE_PREFIXES):
            findings.append(f'internal-path: {name}')
        # The sealed protocol bundle has its own manifest verifier. Its history
        # and provenance labels must not be rewritten to satisfy this checker.
        if name.startswith('protocol/'):
            continue
        path = root / name
        if not path.is_file():
            continue
        source = name.startswith('apps/popclaw-plugin/') and path.suffix in {'.ts', '.sql'}
        document = path.suffix == '.md'
        if not (source or document):
            continue
        text = path.read_text(encoding='utf-8')
        if INTERNAL_REFERENCE.search(text):
            findings.append(f'internal-reference: {name}: replace unavailable working-record references with the actual invariant')
        if not document:
            continue
        visible = prose(text)
        links = [match[1] for pattern in (INLINE_LINK, REFERENCE_LINK, HTML_LINK) for match in pattern.finditer(visible)]
        for link in links:
            try:
                parts = urlsplit(link)
            except ValueError:
                findings.append(f'invalid-link: {name}: {link}')
                continue
            if parts.netloc.lower() == 'github.com':
                match = PUBLIC_COMMIT.match(parts.path)
                if match:
                    sha = match[1]
                    if sha not in commit_cache:
                        try:
                            git(root, 'merge-base', '--is-ancestor', sha, 'HEAD')
                            commit_cache[sha] = True
                        except subprocess.CalledProcessError:
                            commit_cache[sha] = False
                    if not commit_cache[sha]:
                        findings.append(f'missing-commit: {name}: {sha} is not in this checkout history (use a full clone)')
            if parts.scheme or parts.netloc or not parts.path:
                continue
            target = (path.parent / unquote(parts.path)).resolve()
            try:
                relative = target.relative_to(root).as_posix()
            except ValueError:
                relative = ''
            present = bool(relative) and target.exists() and (
                relative in tracked or any(item.startswith(relative.rstrip('/') + '/') for item in tracked)
            )
            # A link to the repository root is a legitimate directory link.
            if target == root:
                present = True
            if not present:
                findings.append(f'missing-link: {name}: {link} is not in the tracked public tree')
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        findings = check_repository(args.root)
    except (OSError, UnicodeError, subprocess.CalledProcessError) as error:
        print(f'publication check could not inspect the checkout: {error}')
        return 2
    for finding in findings:
        print(finding)
    if not findings:
        print('Publication content checks passed (tracked tree and public commit links).')
    return int(bool(findings))


if __name__ == '__main__':
    raise SystemExit(main())
