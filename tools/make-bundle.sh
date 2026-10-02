#!/usr/bin/env bash
# Build a self-contained deployment bundle: one tarball, no build step, no
# install step, that runs on any box with Node 22 and a reachable Postgres.
#
#   bash tools/make-bundle.sh                  # source + node_modules
#   bash tools/make-bundle.sh --no-deps        # source only (npm install on target)
#   OUT=/tmp bash tools/make-bundle.sh
#
# WHY THIS IS ONE TARBALL AND NOT A PIPELINE. Three measured facts about this
# application, checked rather than assumed:
#
#   * FOUR runtime dependencies (net-snmp, pg, pg-copy-streams, nodemailer).
#   * ZERO native modules - no .node binaries, no binding.gyp anywhere in the
#     tree. So node_modules is PLATFORM-INDEPENDENT: a bundle built on
#     Windows runs on Linux unchanged, with no rebuild on the target. This is
#     the fact that makes the whole thing a copy instead of a deployment.
#   * NO BUILD STEP - Node strips the TypeScript types at load.
#
# 1.55 MB of source, ~32 MB with dependencies. The complexity of this product
# is in its architecture, not its delivery.
#
# WHAT THIS SCRIPT DOES NOT DO, deliberately: install Postgres, create roles,
# apply the schema, or configure anything. That is the installer's job, and
# INSTALL.md is the procedure; both travel INSIDE the bundle so the box has
# the procedure with the payload. The private runbooks ride along when the
# tree has them and are not required.
set -uo pipefail

WITH_DEPS=1
[ "${1:-}" = "--no-deps" ] && WITH_DEPS=0
OUT="${OUT:-$(pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# The dependencies ship FROM this tree, so they have to be in it. A fresh
# clone has none: until 2026-09-28 INSTALL.md's one build command met that
# as "tar: node_modules: Cannot stat" and left a partial tarball behind.
if [ "$WITH_DEPS" = 1 ] && [ ! -d node_modules/pg ]; then
    echo "node_modules is missing or incomplete - run 'npm ci' in $HERE first (or --no-deps to ship without)" >&2
    exit 1
fi

# NAMED, NOT DISCOVERED - the same rule every destructive path in this tree
# follows, applied to the constructive one. An exclude-list bundle ships
# whatever happens to be lying in the working directory (scratch SQL, a
# .env, a heap dump); an include-list bundle ships what somebody chose. The
# 2026-08-13 restore drill learned the same lesson from the other side: a
# --table= include-list that was stale hours after being written.
PAYLOAD=(
    package.json package-lock.json tsconfig.json
    src sql public tools
    README.md INSTALL.md TESTING.md KNOWN-ISSUES.md CHANGELOG.md LICENSE NOTICE-ICONS.md
    # CHANGELOG.md since 0.1.0-alpha.2: the README tells a reader it "says what
    # changed", and a bundle that ships the README without it sends them looking.
    # The installer travels WITH the code it installs, because the sequence it
    # encodes is version-specific: the slice list, the build-then-harden order
    # and the role split all belong to this commit. An installer fetched
    # separately is an installer that can be a different version than the tree
    # it is pointed at, which is the whole class of problem it exists to end.
    rscanvas-setup.sh
    # ...and so does the backup tool, for the same reason: what a backup must
    # hold and how a restore hands back to the installer are this version's.
    rscanvas-backup.sh
)
# What the private tree carries and the public tree does not: the operator's
# runbooks and the storage spike's SQL, which nothing at runtime reads. They
# ride along when present so a bundle from either tree is complete for it.
for extra in RUNBOOK-INSTALL.md RUNBOOK-BACKUP.md RUNBOOK-CREDENTIAL-ROTATION.md spike/sql; do
    [ -e "$extra" ] && PAYLOAD+=("$extra")
done

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="rscanvas-${STAMP}-${COMMIT}"
[ "$DIRTY" != "0" ] && NAME="${NAME}-dirty"
TAR="${OUT}/${NAME}.tar.gz"

echo "=== building ${NAME}"
echo "  commit:  ${COMMIT}"
if [ "$DIRTY" != "0" ]; then
    # LOUD, not fatal. Shipping uncommitted work is legitimate during a test
    # cycle and dishonest only if unmarked - so the bundle NAME carries it,
    # the manifest carries it, and the target can see it without asking.
    echo "  WARNING: ${DIRTY} uncommitted change(s) - this bundle is NOT reproducible from git"
    git status --porcelain | head -8 | sed 's/^/    /'
fi
echo "  node:    $(node --version 2>/dev/null || echo 'not found')"
echo "  deps:    $([ "$WITH_DEPS" = 1 ] && echo 'included (portable - no native modules)' || echo 'EXCLUDED - run npm install on the target')"

# DEPENDENCY VINTAGE AND AUDIT (2026-08-31, independent review S6).
#
# The position was good and unmonitored: four runtime dependencies, zero
# vulnerabilities, integrity hashes for all 26 resolved packages. What was
# missing was anything that would say when it stopped being true. `npm audit`
# was in no gate, the manifest recorded the COMMIT but not the dependency
# versions, and node_modules ships inside the tarball - so a CVE in `pg`
# would have been invisible to this project indefinitely.
#
# WHY HERE AND NOT IN `npm test`, which is what the review proposed. `npm
# audit` needs the network. A test suite that fails on a train is a test
# suite people learn to skip, and this project's gates are only worth having
# because they are never skipped. The bundle is also the honest moment: it is
# the artifact that gets deployed, and cutting one is exactly when "what am I
# about to ship" is the live question.
#
# A REGISTRY THAT CANNOT BE REACHED IS NOT A CLEAN AUDIT, and the manifest
# says which of the two happened. Recording "not run" is the whole point -
# an artifact that cannot say whether it was checked must not read as checked.
echo "=== dependency audit"
AUDIT_LINE=""
# THE EXIT STATUS IS NOT THE ANSWER (2026-09-24). npm audit exits 1 when it
# FINDS vulnerabilities, and this gate used to read any non-zero exit as
# "registry unreachable" - so the one case it exists for, a high advisory in
# a runtime dependency, was recorded as NOT RUN and shipped. Found cutting the
# 6ade0d8 production bundle: nodemailer 9.0.3 carried a high advisory
# (GHSA-2x7j-588g-ccc2) and the bundle built anyway. The JSON is the answer:
# a report with metadata.vulnerabilities is a real audit whatever the exit
# status; no report is an audit that did not happen.
AUDIT_JSON="$(npm audit --omit=dev --json 2>/dev/null)"
AUDIT_RC=$?
VULNS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const t=JSON.parse(s).metadata.vulnerabilities;
    if(!t||typeof t!=="object")throw new Error("no report");
    const bad=(t.critical||0)+(t.high||0);
    console.log(bad+" "+((t.moderate||0)+(t.low||0)));}catch(e){console.log("? ?")}})' <<< "$AUDIT_JSON")"
HIGH="${VULNS%% *}"
REST="${VULNS##* }"
if [ "$HIGH" = "?" ]; then
    if [ "$AUDIT_RC" != "0" ]; then
        AUDIT_LINE="audit:       NOT RUN - no report from npm audit (registry unreachable?) at build time"
        echo "  WARNING: npm audit produced no report (exit ${AUDIT_RC}) - the bundle records NOT RUN"
    else
        AUDIT_LINE="audit:       INCONCLUSIVE - could not parse npm audit output"
        echo "  WARNING: could not parse npm audit output"
    fi
elif [ "$HIGH" != "0" ]; then
    AUDIT_LINE="audit:       ${HIGH} high/critical, ${REST} moderate/low"
    echo "  REFUSING: ${HIGH} high or critical advisory in runtime dependencies."
    echo "  Run 'npm audit --omit=dev' and fix or justify before shipping."
    exit 1
else
    AUDIT_LINE="audit:       clean (0 high/critical, ${REST} moderate/low) at ${STAMP}"
    echo "  ok   0 high/critical, ${REST} moderate/low"
fi

# The four resolved runtime versions, so a deployed tree can name its
# dependency vintage the same way DEPLOYED_COMMIT let it name its code.
DEPS_LINE="$(node -e '
const l=require("./package-lock.json"), p=require("./package.json");
console.log(Object.keys(p.dependencies||{}).sort().map(n=>{
  const e=l.packages&&l.packages["node_modules/"+n];
  return n+"@"+(e&&e.version?e.version:"?");
}).join(" "));' 2>/dev/null || echo unknown)"
echo "  deps:    ${DEPS_LINE}"

# The manifest travels INSIDE the tarball. A bundle that cannot say what it
# is on the target box is how two boxes end up running different code while
# both are believed current - the same reason soak.log stamps its inputs.
MANIFEST="$(mktemp)"
{
    echo "bundle:      ${NAME}"
    echo "commit:      ${COMMIT}"
    echo "dirty_files: ${DIRTY}"
    echo "built_utc:   ${STAMP}"
    echo "built_by:    $(whoami)@$(hostname)"
    echo "built_node:  $(node --version 2>/dev/null || echo unknown)"
    echo "deps:        $([ "$WITH_DEPS" = 1 ] && echo bundled || echo external)"
    echo "dep_versions: ${DEPS_LINE}"
    echo "${AUDIT_LINE}"
    echo ""
    echo "To install on a fresh box (the one-command path, INSTALL.md section 2):"
    echo "  sudo mkdir -p /opt/rscanvas && sudo tar -xzf <this bundle> -C /opt/rscanvas"
    echo "  cd /opt/rscanvas && sudo ./rscanvas-setup.sh --tls"
    echo ""
    echo "Or run by hand (INSTALL.md, from source):"
    echo "  DATABASE_URL=postgres://rscanvas:...@localhost:5432/rscanvas \\"
    echo "    COLLECTOR_ENABLED=1 JOBS_ENABLED=1 SNMP_COMMUNITY=... \\"
    echo "    HTTP_PORT=8080 SYSLOG_PORT=514 TRAP_PORT=162 \\"
    echo "    ADMIN_USERNAME=admin ADMIN_PASSWORD=... \\"
    echo "    node src/main.ts"
} > "$MANIFEST"
cp "$MANIFEST" "$HERE/BUNDLE-MANIFEST.txt"
# Readable by anyone: it is the answer to "what is this box running", and
# `--check` reads it as a plain user. mktemp makes files 0600, cp keeps
# that, and Linux tar records it - a bundle built on Linux shipped a
# manifest only root could read (2026-09-28). Windows builds never showed it.
chmod 0644 "$HERE/BUNDLE-MANIFEST.txt"

FILES=("${PAYLOAD[@]}" BUNDLE-MANIFEST.txt)
[ "$WITH_DEPS" = 1 ] && FILES+=(node_modules)

# set -o pipefail is at the top FOR THIS LINE. The 2026-08-14 full-scale
# drill found the cold-backup procedure reporting success while tar printed
# warnings, because tar's exit rode into a pipe and the compressor's 0 was
# the one the shell saw. Same shape here, same fix.
# Owned by root in the archive (review L13): extracted as root it was the
# builder's uid - 197121, User - until the installer's chown, and the
# installer now makes the tree root's anyway (F6).
tar -czf "$TAR" \
    --owner=0 --group=0 --numeric-owner \
    --exclude='node_modules/.cache' \
    --exclude='*.log' \
    --exclude='__pycache__' \
    "${FILES[@]}"
RC=$?
rm -f "$HERE/BUNDLE-MANIFEST.txt" "$MANIFEST"
# A failed tar can still leave a file with the bundle's name, and a file with
# the right name is what the next person copies to the target.
if [ "$RC" != "0" ]; then echo "  TAR FAILED (exit $RC) - no bundle written"; rm -f "$TAR"; exit 1; fi

# VERIFY THE CARGO, NOT THE CARRIER: read the critical paths back OUT of the
# artifact. "tar exited 0" is the claim; this is the check. A bundle missing
# src/main.ts fails here rather than on the target at midnight.
#
# HERE-STRINGS, NEVER `printf "$LIST" | grep -q` (2026-09-28, the outsider
# drill). grep -q exits at its first match; the listing with node_modules is
# larger than a Linux pipe's 64 KB, so printf was still writing, took
# SIGPIPE, and pipefail reported every critical path MISSING. On Windows the
# pipe is big enough, which is why no bundle built here ever showed it - and
# why nobody could build one on Linux.
echo "=== verifying the artifact"
LIST="$(tar -tzf "$TAR")"
MISSING=0
for want in package.json src/main.ts src/collector/sensors.ts sql/bootstrap.sql \
            public/index.html INSTALL.md BUNDLE-MANIFEST.txt \
            rscanvas-setup.sh rscanvas-backup.sh src/db/apply-schema.ts tools/harden-roles.sh; do
    grep -qxF -- "$want" <<< "$LIST" || { echo "  MISSING: $want"; MISSING=1; }
done
if [ "$WITH_DEPS" = 1 ]; then
    for want in node_modules/pg node_modules/net-snmp; do
        grep -q "^${want}/" <<< "$LIST" || { echo "  MISSING: $want"; MISSING=1; }
    done
fi
SQLN=$(grep -c '^sql/.*\.sql$' <<< "$LIST")
# Every slice file has to travel: a bundle one migration short builds a
# database that is subtly the wrong shape, which is install break 2 wearing
# a different hat.
LOCALN=$(ls sql/*.sql | wc -l | tr -d ' ')
[ "$SQLN" = "$LOCALN" ] || { echo "  SQL MISMATCH: ${SQLN} in bundle, ${LOCALN} in tree"; MISSING=1; }
# The two scripts INSTALL.md runs as ./name must arrive executable, and the
# hardening script with them (review F13a: stored 100644, it was skipped). Until
# 2026-09-27 git stored the installer 100644: bundles built on Windows came
# out right only because Git Bash marks any file opening with #! executable,
# and one built from a Linux clone of the public repository would have
# answered the first install command with "command not found".
for want in rscanvas-setup.sh rscanvas-backup.sh tools/harden-roles.sh; do
    perm="$(tar -tvzf "$TAR" "$want" 2>/dev/null || true)"
    [[ "$perm" == -rwx* ]] || { echo "  NOT EXECUTABLE: $want"; MISSING=1; }
done
# ...and must be LF. A clone made by Git for Windows with its default
# core.autocrlf=true has CRLF in every file, and a bundle built from it
# answers the first command on Linux with "/usr/bin/env: 'bash\r': No such
# file or directory" - demonstrated on a clean box 2026-09-28, from a bundle
# this check (then absent) had passed. .gitattributes now pins LF in the
# working tree; this catches a tree that predates it or ignores it.
SCRIPTS=$(grep '\.sh$' <<< "$LIST" | grep -v '^node_modules/' || true)
if [ -n "$SCRIPTS" ]; then
    # shellcheck disable=SC2086 - one argument per listed member
    CR=$(tar -xzOf "$TAR" $SCRIPTS | tr -cd '\r' | wc -c | tr -d ' ')
    [ "$CR" = 0 ] || { echo "  CRLF LINE ENDINGS in the shell scripts - they will not run on Linux (see .gitattributes)"; MISSING=1; }
fi
[ "$MISSING" = "0" ] || { echo "  BUNDLE IS INCOMPLETE - not shipping this"; rm -f "$TAR"; exit 1; }

SIZE="$(du -h "$TAR" | cut -f1)"
SHA="$(sha256sum "$TAR" 2>/dev/null | cut -c1-16 || shasum -a 256 "$TAR" | cut -c1-16)"
echo "  ok   $(printf '%s\n' "$LIST" | wc -l | tr -d ' ') entries, ${SQLN} schema files, all critical paths present"
echo
echo "=== ${TAR}"
echo "  size:   ${SIZE}"
echo "  sha256: ${SHA}..."
echo
echo "On the target box:"
echo "  sudo mkdir -p /opt/rscanvas && sudo tar -xzf ${NAME}.tar.gz -C /opt/rscanvas"
echo "  cat /opt/rscanvas/BUNDLE-MANIFEST.txt     # what am I running?"
echo "  less /opt/rscanvas/INSTALL.md             # the procedure, the flags, upgrades, backups"
