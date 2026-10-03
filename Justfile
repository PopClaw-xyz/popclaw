set shell := ["bash", "-euc", "-o", "pipefail"]

# Default: list recipes
default:
    @just --list

# --- Install / build / test ---

install:
    pnpm install --frozen-lockfile --ignore-scripts
    # --ignore-scripts blocks every dependency's install/postinstall script
    # (supply-chain posture). better-sqlite3 is the one native dependency
    # the test suite actually needs a compiled binding for, so build only
    # that one, by name, instead of lifting the blanket block.
    pnpm rebuild -r better-sqlite3
    pnpm --filter popclaw run setup:protocol

build:
    pnpm --filter popclaw run build

test:
    pnpm --filter popclaw test

lint:
    pnpm --filter popclaw lint

pack-plugin:
    #!/usr/bin/env bash
    set -euo pipefail
    cd apps/popclaw-plugin
    mkdir -p /tmp/popclaw
    pnpm pack --pack-destination /tmp/popclaw >/dev/null   # runs prepack → build:bundle
    version=$(node -p "require('./package.json').version")
    sha=$(git rev-parse --short HEAD)
    ts=$(TZ='Asia/Shanghai' date +%Y-%m-%d-%H%M)   # owner tz UTC+8 (Beijing)
    dirty=""; [ -z "$(git status --porcelain)" ] || dirty="-dirty"
    src="/tmp/popclaw/popclaw-${version}.tgz"
    dst="/tmp/popclaw/popclaw-plugin-${version}+${ts}-${sha}${dirty}.tgz"
    mv "$src" "$dst"
    # A tarball missing prebuilt bindings installs fine on the packer's own
    # machine and dies on everyone else's — the failure surfaces days later, on
    # someone else's host. Count them here, where it is still cheap to fix.
    # (`POPCLAW_NATIVE_DEPS_MINIMAL=1` is the known way to produce such a
    # tarball; this catches any other cause too.)
    bindings=$(tar -tzf "$dst" | grep -c '\.node$' || true)
    if [ "$bindings" -lt 11 ]; then
      rm -f "$dst"
      echo "pack aborted: only ${bindings} native bindings in the tarball (expect >=11)." >&2
      echo "  the prebuild matrix did not run — check POPCLAW_NATIVE_DEPS_MINIMAL is unset, then re-pack." >&2
      exit 1
    fi
    echo "packed → $dst  (${bindings} native bindings)"
    echo "boot log will show:  popclaw: build ${version} <YYYY-MM-DD HH:MM>+08 ${sha}${dirty} (<branch>)"

# Pack the thin `popclaw-mcp` shell: two bin aliases and an exact dependency on
# `popclaw`, and nothing else.
#
# Deliberately NOT part of pack-plugin. That recipe's ">= 11 native bindings"
# floor is a promise about the IMPLEMENTATION package; the shell has to pass the
# opposite test — a shell carrying a bundle, bindings or migrations is a shell
# that copied the runtime, which is the one thing the two-package split exists
# to prevent. Neither floor may be loosened to accommodate the other package.
#
# The checks below read the TARBALL, not the working tree: `files` in
# package.json decides what is packed, prepack-style rewrites can change a
# manifest on the way in, and `pnpm pack` is the only thing that knows the
# final answer. A `tar -t` listing would not show file modes or shebangs.
#
# SHELL_DIR and DEST are parameters so scripts/selfcheck-pack-mcp-shell.sh can
# aim this recipe at a deliberately broken copy of the shell and watch it
# refuse. A release always uses the defaults.
pack-mcp-shell SHELL_DIR="packages/popclaw-mcp" DEST="/tmp/popclaw":
    #!/usr/bin/env bash
    set -euo pipefail
    plugin_json="$(pwd)/apps/popclaw-plugin/package.json"
    [ -f "{{SHELL_DIR}}/package.json" ] || { echo "pack aborted: no package.json in {{SHELL_DIR}}" >&2; exit 1; }
    shell_dir=$(cd "{{SHELL_DIR}}" && pwd)
    mkdir -p "{{DEST}}"
    dest=$(cd "{{DEST}}" && pwd)

    read_field() {
      node -e 'const fs=require("node:fs");const doc=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>(o==null?o:o[k]),doc);process.stdout.write(v==null?"":String(v))' "$1" "$2"
    }

    plugin_version=$(read_field "$plugin_json" version)
    shell_version=$(read_field "$shell_dir/package.json" version)
    shell_dep=$(read_field "$shell_dir/package.json" dependencies.popclaw)

    # Lock step, checked before anything is packed. The shell's entire contract
    # is "the same version as popclaw, depending on exactly that version".
    if [ "$shell_version" != "$plugin_version" ]; then
      echo "pack aborted: popclaw-mcp is ${shell_version} but popclaw is ${plugin_version}." >&2
      echo "  the shell publishes in lock step with the package it aliases; bump both or neither." >&2
      exit 1
    fi
    if [ "$shell_dep" != "$plugin_version" ]; then
      echo "pack aborted: dependencies.popclaw is \"${shell_dep}\", expected exactly \"${plugin_version}\"." >&2
      echo "  a range (^ ~ >=) lets the alias resolve to a build it was never tested against;" >&2
      echo "  workspace:/file: does not survive publishing at all." >&2
      exit 1
    fi

    (cd "$shell_dir" && pnpm pack --pack-destination "$dest" >/dev/null)
    tgz="$dest/popclaw-mcp-${shell_version}.tgz"
    [ -f "$tgz" ] || { echo "pack aborted: expected ${tgz}, pnpm pack produced something else" >&2; exit 1; }

    work=$(mktemp -d "${TMPDIR:-/tmp}/popclaw-mcp-inspect.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    # -p, and a fixed umask: the modes recorded in the archive are the whole
    # point of the bin check below, and a stricter umask would rewrite them.
    (umask 022; tar -xzpf "$tgz" -C "$work")

    if ! contents=$(node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const [pkgDir, version] = process.argv.slice(1);
      let failed = false;
      const fail = (m) => { failed = true; console.error("pack aborted: " + m); };
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const deps = JSON.stringify(manifest.dependencies);
      const wanted = JSON.stringify({ popclaw: version });
      if (deps !== wanted) fail("the packed manifest depends on " + deps + ", expected exactly " + wanted);
      const raw = manifest.repository && manifest.repository.url ? manifest.repository.url : (manifest.repository || "");
      const url = String(raw).replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
      if (url !== "https://github.com/PopClaw-xyz/popclaw") {
        fail("the packed manifest names repository " + (url || "(none)") + ", expected https://github.com/PopClaw-xyz/popclaw — npm refuses provenance for any other repository");
      }
      const bins = Object.entries(manifest.bin || {});
      if (bins.length !== 2) fail("the packed manifest declares " + bins.length + " bin entries, expected 2");
      for (const [command, rel] of bins) {
        const file = path.join(pkgDir, rel);
        if (!fs.existsSync(file)) { fail("bin " + command + " points at " + rel + ", which is not in the tarball"); continue; }
        const mode = (fs.statSync(file).mode & 0o777).toString(8);
        if (mode !== "755") fail(rel + " is mode " + mode + " in the tarball, expected 755");
        const first = fs.readFileSync(file, "utf8").split("\n")[0];
        if (first !== "#!/usr/bin/env node") fail(rel + " starts with " + JSON.stringify(first) + ", expected #!/usr/bin/env node");
      }
      const banned = ["dist", "native-deps", "migrations", "wallet-migrations"];
      const files = [];
      (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full); else files.push(path.relative(pkgDir, full));
        }
      })(pkgDir);
      for (const rel of files) {
        for (const part of rel.split("/")) {
          if (banned.includes(part)) fail(rel + " is inside the tarball; the shell must not carry a second copy of the runtime (" + banned.join(", ") + ")");
        }
      }
      if (failed) process.exit(1);
      process.stdout.write("shell contents: " + files.sort().join(" "));
    ' "$work/package" "$shell_version"); then
      rm -f "$tgz"
      echo "  removed ${tgz}; a tarball that fails inspection must not be lying around when the release job goes looking for one." >&2
      exit 1
    fi

    if command -v sha256sum >/dev/null 2>&1; then
      sha=$(sha256sum "$tgz" | cut -d' ' -f1)
    else
      sha=$(shasum -a 256 "$tgz" | cut -d' ' -f1)
    fi
    echo "packed → $tgz"
    echo "sha256   $sha"
    echo "$contents"

# Build the plugin + install it into OpenClaw via tarball (bypasses the
# pnpm symlink security scan; --link on a workspace package always trips it).
# `pnpm pack` has no --filter; must be run inside the package directory.
plan-6-install:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm --filter popclaw build
    mkdir -p /tmp/popclaw
    cd apps/popclaw-plugin
    pnpm pack --pack-destination /tmp/popclaw
    version=$(node -p "require('./package.json').version")
    openclaw plugins install --force "/tmp/popclaw/popclaw-${version}.tgz"
    openclaw plugins list 2>&1 | grep -i popclaw

# Rehearse the managed install against a REAL OpenClaw host (default our
# production floor 2026.7.1-2; pass HOST to rehearse other versions, e.g.
# `just rehearse-install pkg.tgz 2026.8.1-beta.2`), entirely inside a scratch
# dir — never touches this machine's ~/.openclaw.
# HOME isolation (not just OPENCLAW_STATE_DIR) is mandatory: with the real
# HOME, the scratch host migrates legacy ~/.openclaw state on first run (it
# archived this machine's real exec-approvals.json the first time we forgot).
rehearse-install TGZ HOST="2026.7.1-2":
    #!/usr/bin/env bash
    set -euo pipefail
    tgz=$(cd "$(dirname "{{TGZ}}")" && pwd)/$(basename "{{TGZ}}")
    [ -f "$tgz" ] || { echo "rehearse-install: no such file: $tgz" >&2; exit 1; }
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/popclaw-rehearse.XXXXXX")
    echo "scratch dir: $scratch (host openclaw@{{HOST}})"
    mkdir -p "$scratch/prefix" "$scratch/home" "$scratch/state"
    npm install -g --prefix "$scratch/prefix" "openclaw@{{HOST}}" --silent
    export PATH="$scratch/prefix/bin:$PATH"
    export HOME="$scratch/home"
    export OPENCLAW_STATE_DIR="$scratch/state"

    pass=1
    t0=$(date +%s)
    # Mirrors install-popclaw.sh: 8.2 capability-consent gate — without the
    # flag the install exits 1 and rolls the plugin back entirely. Probe
    # --help so 7.1-2 (which rejects the flag) still rehearses.
    accept_cap=""
    if openclaw plugins install --help 2>&1 | grep -q -- '--accept-capabilities'; then
      accept_cap="--accept-capabilities"
    fi
    if ! install_out=$(openclaw plugins install --force $accept_cap "$tgz" 2>&1); then
      echo "$install_out"
      echo "FAIL: plugins install exited non-zero"
      pass=0
    fi
    secs=$(( $(date +%s) - t0 ))
    echo "install took ${secs}s"

    # Mirrors install-popclaw.sh: ≥2026.8.1 gates before_prompt_build (our
    # routing lifeline) behind this key; accepted-but-inert on 7.1 (#71221).
    openclaw config set plugins.entries.popclaw.hooks.allowConversationAccess true >/dev/null
    if [ "$secs" -ge 60 ]; then
      echo "FAIL: install took ${secs}s (>=60s, ADR-0035)"
      pass=0
    fi

    # Clean-run wording differs by host: 7.1 "No plugin issues detected.",
    # ≥8.1-beta.2 "… checks passed." — accept both, fail on anything else.
    doctor_out=$(openclaw plugins doctor 2>&1 || true)
    if ! grep -qE 'No plugin issues detected|checks passed' <<<"$doctor_out"; then
      echo "$doctor_out"
      echo "FAIL: plugins doctor did not report clean"
      pass=0
    fi

    # The PASS gate depends on this flag existing and on its JSON shape
    # (top-level findings[]). A missing/renamed flag or changed shape must
    # surface as "harness needs updating", never blend into "found issues".
    if ! post_out=$(openclaw doctor --post-upgrade --json 2>&1); then
      echo "$post_out"
      echo "FAIL: doctor --post-upgrade --json exited non-zero (flag missing/renamed on this host? update the harness gate)"
      pass=0
    elif ! node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(d.findings)&&d.findings.length===0?0:1)' <<<"$post_out"; then
      echo "$post_out"
      echo "FAIL: doctor --post-upgrade findings not empty, or JSON shape changed (see output above)"
      pass=0
    fi

    # Informational (P0 question: does a fresh install land enabled on 8.1?)
    echo "--- openclaw plugins list ---"
    openclaw plugins list 2>&1 || true

    # The AI manual ships inside the plugin (manifest skills[]) — assert the
    # host actually publishes it, or weak-model behavior silently regresses.
    skills_out=$(openclaw skills list 2>&1 || true)
    if ! grep -q 'popclaw-social' <<<"$skills_out"; then
      echo "$skills_out"
      echo "FAIL: popclaw-social skill not visible in openclaw skills list"
      pass=0
    fi

    if [ "$pass" -eq 1 ]; then
      echo "PASS: rehearsal clean (scratch left at $scratch)"
    else
      echo "FAIL: see above (scratch left at $scratch for inspection)"
      exit 1
    fi

# Stage 1 of the manual-demo flow: PG DB + seeded verifier pool + lore-house.
# After running this, start OpenClaw in a second terminal and exercise
# /popclaw-status, /popclaw-invite, /popclaw-follow.
run-ranger:
    POPCLAW_DATA_ROOT="$(pwd)/.data" \
    pnpm --filter popclaw exec tsx src/main.ts

# --- Fixture regeneration ---
