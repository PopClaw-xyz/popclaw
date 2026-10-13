#!/usr/bin/env python3
"""Read-only release identity, archive and real SQLite checks; never builds or publishes."""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = '.github/workflows/release-clawhub-native.yml'
FULL_WORKFLOW = '.github/workflows/release.yml'
PLATFORMS = [('darwin', 'arm64'), ('darwin', 'x64'), ('linux', 'arm64'), ('linux', 'x64'), ('win32', 'x64')]
NAMES = ['popclaw-native-sqlite-' + p + '-' + a for p, a in PLATFORMS]
NATIVE = 'dist/native-deps/better-sqlite3'
MARKER = NATIVE + '/POPCLAW-PLATFORM-DEPS.json'
RELEASE = NATIVE + '/build/Release/'
ABI = {24: '137', 26: '147'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), 'missing or non-regular JSON: ' + str(path))
    return json.loads(path.read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def validate_inputs(tag, commit, full_sha256, run_id):
    for value, pattern, label in [(tag, r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', 'tag'),
                                  (commit, r'[0-9a-f]{40}', 'source commit'),
                                  (full_sha256, r'[0-9a-f]{64}', 'full SHA-256'),
                                  (str(run_id), r'[1-9][0-9]*', 'run ID')]:
        require(isinstance(value, str) and re.fullmatch(pattern, value), 'invalid ' + label)
    return tag[1:]


def validate_run(run, jobs, repository, run_id, workflow, commit=None, tag=None):
    require(run.get('id') == int(run_id), 'wrong run ID')
    require(run.get('repository', {}).get('full_name') == repository and
            run.get('head_repository', {}).get('full_name') == repository, 'foreign source repository')
    require(run.get('path') == workflow and run.get('event') in ('push', 'workflow_dispatch'), 'wrong source workflow/event')
    require(run.get('status') == 'completed' and run.get('conclusion') in ('success', 'failure'), 'source run is not completed')
    require(isinstance(run.get('run_attempt'), int) and run['run_attempt'] > 0, 'missing source run attempt')
    if commit is not None:
        require(run.get('head_sha') == commit, 'source head differs from the expected commit')
    if tag is not None:
        require(run.get('head_branch') == tag, 'source run must have run on the exact tag')
    job_name, required_steps = ('build, verify and publish', ['Smoke the exact packages before publication']) if workflow == FULL_WORKFLOW else (
        'prepare and retain', ['Verify and smoke retained ClawHub bytes', 'Retain ClawHub release bytes'])
    candidates = [job for job in jobs if job.get('name') == job_name]
    require(len(candidates) == 1, 'missing or ambiguous source verification job')
    for name in required_steps:
        steps = [step for step in candidates[0].get('steps', []) if step.get('name') == name]
        require(len(steps) == 1 and steps[0].get('conclusion') == 'success', 'source did not pass: ' + name)
    return run


def select_artifact(artifacts, name, run):
    candidates = [item for item in artifacts if item.get('name') == name]
    require(len(candidates) == 1, 'missing or ambiguous retained artifact: ' + name)
    item = candidates[0]
    require(item.get('expired') is False, 'retained artifact expired')
    require(item.get('workflow_run', {}).get('id') == run['id'] and
            item.get('workflow_run', {}).get('head_sha') == run['head_sha'], 'artifact belongs to another run/head')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', item.get('digest', '')), 'missing artifact digest')
    require(isinstance(item.get('id'), int) and item['id'] > 0, 'invalid artifact ID')
    return item


def api(path):
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    require(token, 'GH_TOKEN is required for run identity verification')
    request = Request('https://api.github.com' + path, headers={
        'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28'})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def api_list(path, key):
    rows = []
    for page in range(1, 101):
        batch = api(path + '?per_page=100&page=' + str(page))[key]
        require(isinstance(batch, list), 'invalid paginated GitHub response')
        rows.extend(batch)
        if len(batch) < 100:
            return rows
    raise ValueError('GitHub pagination limit exceeded')


def resolve_context(args):
    version = validate_inputs(args.tag, args.commit, args.full_sha256, args.source_run_id)
    repository = os.environ['GITHUB_REPOSITORY']
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'invalid repository')
    prefix = '/repos/' + repository
    target = api(prefix + '/git/ref/tags/' + args.tag)['object']
    for _ in range(8):
        if target.get('type') == 'commit':
            break
        require(target.get('type') == 'tag' and re.fullmatch(r'[0-9a-f]{40}', target.get('sha', '')), 'invalid tag object')
        target = api(prefix + '/git/tags/' + target['sha'])['object']
    require(target.get('type') == 'commit' and target.get('sha') == args.commit, 'tag moved or expected source commit is wrong')

    def inspect(run_id, workflow, artifact_name, commit=None, tag=None):
        run = api(prefix + '/actions/runs/' + str(run_id))
        attempt = run.get('run_attempt')
        require(isinstance(attempt, int) and attempt > 0, 'invalid run attempt')
        jobs = api_list(prefix + '/actions/runs/' + str(run_id) + '/attempts/' + str(attempt) + '/jobs', 'jobs')
        validate_run(run, jobs, repository, run_id, workflow, commit, tag)
        artifact = select_artifact(api_list(prefix + '/actions/runs/' + str(run_id) + '/artifacts', 'artifacts'), artifact_name, run)
        return {'runId': run['id'], 'runAttempt': attempt, 'workflow': workflow, 'headSha': run['head_sha'],
                'artifactId': artifact['id'], 'artifactDigest': artifact['digest']}

    result = {'format': 1, 'repository': repository, 'tag': args.tag, 'version': version,
              'sourceCommit': args.commit, 'fullSha256': args.full_sha256,
              'source': inspect(args.source_run_id, FULL_WORKFLOW, 'release-artefacts-' + args.tag, args.commit, args.tag)}
    if args.resume_from_run_id:
        require(re.fullmatch(r'[1-9][0-9]*', args.resume_from_run_id), 'invalid resume run ID')
        result['resume'] = inspect(args.resume_from_run_id, WORKFLOW, 'clawhub-native-' + args.tag)
    write_json(args.output, result)
    github_output(args.github_output, source_artifact_id=result['source']['artifactId'],
                  resume_artifact_id=result.get('resume', {}).get('artifactId', ''), version=version)
    return result


def github_output(path, **values):
    if path:
        with open(path, 'a') as stream:
            for key, value in values.items():
                require('\n' not in str(value) and '\r' not in str(value), 'unsafe output value')
                stream.write(f'{key}={value}\n')


def archive_files(path):
    """Audit every member, then expose only regular files. No tar extraction API."""
    require(path.is_file() and not path.is_symlink(), 'archive must be a regular file')
    files, members, total = {}, {}, 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = item.name.rstrip('/') if item.isdir() else item.name
            parts = name.split('/')
            require(parts[0] == 'package' and (len(parts) > 1 or item.isdir()) and
                    all(part not in ('', '.', '..') for part in parts) and
                    all(ord(char) >= 32 and char not in '\\:' for char in name), 'unsafe archive path')
            require((item.isfile() or item.isdir()) and not item.linkname and item.sparse is None and
                    not item.mode & 0o7000 and item.size >= 0, 'unsupported archive member')
            require(name not in members, 'duplicate archive path')
            members[name] = item
            total += item.size
            require(total <= 256 * 1024 * 1024 and len(members) <= 20000, 'archive limits exceeded')
        for name, item in members.items():
            parts = name.split('/')
            for index in range(1, len(parts)):
                parent = '/'.join(parts[:index])
                require(parent not in members or members[parent].isdir(), 'file used as archive parent')
            if item.isfile():
                data = archive.extractfile(item).read()
                require(len(data) == item.size, 'short archive member')
                files[name.removeprefix('package/')] = (data, item.mode & 0o777)
    require('package.json' in files, 'missing package manifest')
    return files


def manifest(files, name='package.json'):
    require(name in files, 'missing ' + name)
    return json.loads(files[name][0])


def verify_full(directory, context):
    metadata = read_json(directory / 'release-metadata.json')
    require(all(metadata.get(k) == context[v] for k, v in [('tag', 'tag'), ('commit', 'sourceCommit'), ('version', 'version')]), 'full release metadata mismatch')
    names = [metadata.get('main'), metadata.get('shell')]
    require(all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.+-]+\.tgz', name) for name in names) and len(set(names)) == 2, 'unsafe full archive filenames')
    sums = {}
    for line in (directory / 'SHA256SUMS.txt').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *](?:\./)?([A-Za-z0-9_.+-]+\.tgz)', line)
        require(match and match[2] not in sums, 'unsafe or duplicate checksum entry')
        sums[match[2]] = match[1]
    require(set(sums) == set(names), 'full checksum file set mismatch')
    for name in names:
        path = directory / name
        require(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == sums[name], 'full archive digest mismatch')
    main_path = directory / names[0]
    require(digest(main_path.read_bytes()) == context['fullSha256'], 'full archive differs from fixed SHA-256')
    main, shell = manifest(archive_files(main_path)), manifest(archive_files(directory / names[1]))
    require(main.get('name') == 'popclaw' and main.get('version') == context['version'], 'wrong full package')
    require(shell.get('name') == 'popclaw-mcp' and shell.get('version') == context['version'] and
            shell.get('dependencies') == {'popclaw': context['version']}, 'wrong retained shell')
    # Existing verifier stays authoritative for the original release contract.
    subprocess.run(['bash', str(ROOT / 'scripts/verify-retained-artefacts.sh'), str(directory.resolve()),
                    context['tag'], context['sourceCommit'], context['version']], check=True)
    subprocess.run(['node', str(ROOT / 'apps/popclaw-plugin/scripts/prepare-native-deps.mjs'),
                    '--verify-tarball', str(main_path.resolve())], check=True)
    return main_path


def verify_derived(directory, full_path, context):
    require(digest(full_path.read_bytes()) == context['fullSha256'], 'full archive differs from fixed SHA-256')
    full = archive_files(full_path)
    source_main, source_native = manifest(full), manifest(full, NATIVE + '/package.json')
    version = context['version']
    require(source_main.get('name') == 'popclaw' and source_main.get('version') == version, 'wrong source package')
    receipt = read_json(directory / 'receipt.json')
    expected_source = {'fullArchiveFilename': full_path.name, 'fullArchiveSha256': context['fullSha256'],
                       'fullArchiveBytes': full_path.stat().st_size, 'package': {'name': 'popclaw', 'version': version}}
    require(receipt.get('format') == 1 and receipt.get('profile') == 'clawhub' and receipt.get('source') == expected_source, 'receipt source mismatch')
    require(receipt.get('artifactDirectory') == f'popclaw-clawhub-{version}-{context["fullSha256"][:12]}', 'receipt directory identity mismatch')
    rows = receipt.get('packages')
    require(isinstance(rows, list) and len(rows) == 6 and
            sorted(row.get('name', '') for row in rows) == sorted(['popclaw-clawhub'] + NAMES), 'receipt package allowlist mismatch')
    actual, archive_rows = {}, {}
    for row in rows:
        name = row['name']
        require(row.get('version') == version and row.get('filename') == f'{name}-{version}.tgz', 'receipt package identity mismatch')
        path = directory / row['filename']
        require(path.is_file() and not path.is_symlink(), 'missing retained package')
        data = path.read_bytes()
        require(row.get('sha256') == digest(data) and row.get('bytes') == len(data) and
                row.get('integrity') == 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(), 'receipt archive digest mismatch')
        files = archive_files(path)
        pkg = manifest(files)
        require(pkg.get('name') == name and pkg.get('version') == version and not pkg.get('scripts'), 'archive manifest identity/scripts mismatch')
        actual[name], archive_rows[name] = files, row
    require({p.name for p in directory.glob('*.tgz')} == {row['filename'] for row in rows}, 'unexpected retained archive')
    main = actual['popclaw-clawhub']
    deps = {name: version for name in NAMES}
    expected_main = copy.deepcopy(source_main)
    expected_main.update(name='popclaw-clawhub', optionalDependencies=deps)
    expected_main.setdefault('openclaw', {}).setdefault('install', {})['requiredPlatformPackages'] = NAMES
    expected_native = dict(source_native, optionalDependencies=deps)
    require(manifest(main) == expected_main and manifest(main, NATIVE + '/package.json') == expected_native, 'derived manifest changed beyond platform dependency metadata')
    bindings = {f'better_sqlite3-{p}-{a}-node{major}.node' for p, a in PLATFORMS for major in ABI}
    removed = {RELEASE + name for name in bindings}
    require({path for path in full if path.endswith('.node')} == removed, 'source matrix is not exactly ten bindings')
    changed = {'package.json', NATIVE + '/package.json'}
    require(set(main) == (set(full) - removed) | {MARKER}, 'main file set differs from source preservation contract')
    for path in set(full) - removed - changed:
        require(main[path] == full[path], 'main changed source bytes/mode: ' + path)
    platform_rows = []
    source_provenance = manifest(full, NATIVE + '/POPCLAW-RUNTIME-MANIFEST.json')
    for (platform, arch), name in zip(PLATFORMS, NAMES):
        files, pkg = actual[name], manifest(actual[name])
        require(pkg.get('os') == [platform] and pkg.get('cpu') == [arch] and
                pkg.get('libc') == (['glibc'] if platform == 'linux' else None) and
                pkg.get('repository') == source_main.get('repository') and pkg.get('engines') == source_main.get('engines'), 'native platform/repository metadata mismatch')
        require(set(pkg) <= {'name', 'version', 'description', 'license', 'repository', 'os', 'cpu', 'libc', 'engines', 'files'}, 'native package must be data-only without publication overrides')
        license_name = source_main['license'] if source_main['license'] == source_native['license'] else f'({source_main["license"]} AND {source_native["license"]})'
        require(pkg.get('license') == license_name, 'native license metadata mismatch')
        row = {'name': name, 'version': version, 'platform': platform, 'arch': arch}
        if platform == 'linux':
            row['libc'] = 'glibc'
        row['bindings'] = []
        for major, abi in ABI.items():
            filename = f'better_sqlite3-{platform}-{arch}-node{major}.node'
            data, mode = full[RELEASE + filename]
            require(len(data) >= 500000 and files.get('build/Release/' + filename) == (data, mode), 'native binding bytes/mode differ from full source')
            row['bindings'].append({'nodeMajor': major, 'abi': abi, 'file': filename, 'sha256': digest(data), 'size': len(data)})
        platform_rows.append(row)
        provenance = manifest(files, 'POPCLAW-NATIVE-PROVENANCE.json')
        require(provenance.get('format') == 1 and provenance.get('source') == expected_source and
                provenance.get('package') == {key: value for key, value in row.items() if key != 'bindings'} and
                provenance.get('bindings') == row['bindings'], 'native provenance identity/bindings mismatch')
        require(provenance.get('upstream') == {'name': source_native['name'], 'version': source_native['version'],
                'manifestSha256': source_provenance['upstreamManifestSha256'],
                'runtimeProvenanceSha256': digest(full[NATIVE + '/POPCLAW-RUNTIME-MANIFEST.json'][0])}, 'native upstream provenance mismatch')
        license_paths = [path for path in full if path in ('LICENSE', 'NOTICE') or
                         (path.startswith(NATIVE + '/') and re.match(r'^(license|notice|copying)([.-]|$)', Path(path).name, re.I))]
        source_paths = [path for path in full if path.startswith(NATIVE + '/') and re.search(r'\.(c|h|cpp|hpp|gyp|gypi)$', path)]
        for field, paths in [('licenses', license_paths), ('sourceFiles', source_paths)]:
            expected = {path: {'path': path, 'size': len(full[path][0]), 'sha256': digest(full[path][0])} for path in paths}
            recorded = provenance.get(field)
            require(isinstance(recorded, list) and len(recorded) == len(expected) and {item['path']: item for item in recorded} == expected, 'native provenance ' + field + ' mismatch')
        allowed = {'package.json', 'README.md', 'POPCLAW-NATIVE-PROVENANCE.json'}
        allowed.update('build/Release/' + b['file'] for b in row['bindings'])
        for path in license_paths:
            target = path if path in ('LICENSE', 'NOTICE') else 'licenses/better-sqlite3/' + path[len(NATIVE) + 1:]
            require(target in files and files[target][0] == full[path][0], 'native license bytes mismatch')
            allowed.add(target)
        require(set(files) == allowed, 'unexpected native package files')
    expected_marker = {'format': 1, 'distribution': 'clawhub-platform-dependencies', 'version': version, 'packages': platform_rows}
    require(manifest(main, MARKER) == expected_marker and receipt.get('marker') == expected_marker, 'platform marker mismatch')
    retained_context = directory / 'release-context.json'
    if context.get('resume'):
        require(retained_context.is_file(), 'missing retained context for resume')
    if retained_context.exists():
        previous = read_json(retained_context)
        for key in ('format', 'repository', 'tag', 'version', 'sourceCommit', 'fullSha256', 'source'):
            require(previous.get(key) == context.get(key), 'retained context differs: ' + key)
    return actual, archive_rows


def smoke(actual, nodes):
    require(nodes, 'at least one Node executable is required for real SQLite smoke')
    results = []
    with tempfile.TemporaryDirectory(prefix='clawhub-smoke-') as temporary:
        root = Path(temporary)
        for name, files in actual.items():
            for path, (data, mode) in files.items():
                destination = root / 'node_modules' / name / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(mode)
        script = r"""
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[1];
assert([24,26].includes(Number(process.versions.node.split('.')[0])));
const Database = require(path.join(root, 'node_modules/popclaw-clawhub/dist/native-deps/better-sqlite3'));
const file = path.join(root, `smoke-${process.versions.modules}.db`);
let db = new Database(file); db.exec("CREATE TABLE smoke(value TEXT); INSERT INTO smoke VALUES ('retained-bytes')"); db.close();
db = new Database(file); assert.equal(db.prepare('SELECT value FROM smoke').get().value, 'retained-bytes'); db.close();
console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,sqlite:'open/write/close/reopen passed'}));
"""
        for node in nodes:
            completed = subprocess.run([node, '-e', script, str(root)], check=True, capture_output=True, text=True,
                                       env={key: value for key, value in os.environ.items() if key not in ('NODE_PATH', 'NODE_OPTIONS')})
            results.append(json.loads(completed.stdout))
    return results


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    resolve = commands.add_parser('resolve')
    for name in ('tag', 'commit', 'full-sha256', 'source-run-id', 'output'):
        resolve.add_argument('--' + name, required=True)
    resolve.add_argument('--resume-from-run-id', default='')
    resolve.add_argument('--github-output')
    full = commands.add_parser('full')
    full.add_argument('--directory', type=Path, required=True)
    full.add_argument('--context', type=Path, required=True)
    full.add_argument('--github-output')
    verify = commands.add_parser('verify')
    for name in ('directory', 'full-tarball', 'context', 'output'):
        verify.add_argument('--' + name, type=Path, required=True)
    verify.add_argument('--node', action='append', required=True)
    args = parser.parse_args()
    if args.command == 'resolve':
        resolve_context(args)
    elif args.command == 'full':
        path = verify_full(args.directory, read_json(args.context))
        github_output(args.github_output, full_tarball=path.resolve())
    else:
        context = read_json(args.context)
        actual, rows = verify_derived(args.directory, args.full_tarball, context)
        results = smoke(actual, args.node)
        write_json(args.output, {'format': 1, 'source': context, 'receiptSha256': digest((args.directory / 'receipt.json').read_bytes()),
                                 'packages': list(rows.values()), 'nativeMatrixCells': 10, 'smoke': results})
        print('Six retained archives verified; SQLite smoke passed: ' + json.dumps(results))


if __name__ == '__main__':
    try:
        cli()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit('ClawHub verification failed: ' + str(error)) from error
