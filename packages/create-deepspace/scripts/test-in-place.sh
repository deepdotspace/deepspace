#!/usr/bin/env bash
# Verify the in-place scaffolding modes of create-deepspace.
#
# Exercises the cartesian product of:
#   {invoke from parent dir, invoke from inside target dir}
#       x {target near-empty with .git+boilerplate, target fully empty}
#
# All four cells must succeed. Scenarios 3 and 4 (no .git) are the ones the
# pre-2026-05-04 build rejected; they are the regression guardrail for the
# .git-requirement removal.
#
# Each scenario runs in its own mktemp dir so this script never touches the
# user's workspace. Logs land in $TMP/<scenario>/run.log for forensic review.
#
# Usage (from packages/create-deepspace/):
#   pnpm test                       # builds dist/ and runs all scenarios
#   pnpm test --keep                # keep tmp dirs on exit (for debugging)
#
# Or invoke directly (assumes dist/ is already built):
#   ./scripts/test-in-place.sh
#   ./scripts/test-in-place.sh --keep

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
SCAFFOLD="$PKG_DIR/dist/index.js"

if [[ ! -f "$SCAFFOLD" ]]; then
  echo "FATAL: $SCAFFOLD not found. Run 'pnpm --filter create-deepspace build' first." >&2
  exit 2
fi

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

ROOT="$(mktemp -d -t cds-in-place.XXXXXX)"
cleanup() {
  if [[ $KEEP -eq 1 ]]; then
    echo
    echo "Logs preserved at: $ROOT"
    return
  fi
  # Each scaffold run spawns a detached background install worker (pid recorded
  # in .deepspace/install.pid). Kill any still running so they can't re-create
  # files (bun.lock, node_modules) while — or after — we rm the tree, which
  # would fail this script despite all scenarios passing.
  local pidfile pid
  for pidfile in "$ROOT"/*/action-coding/.deepspace/install.pid; do
    [[ -f "$pidfile" ]] || continue
    pid="$(cat "$pidfile" 2>/dev/null)" || continue
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  rm -rf "$ROOT" 2>/dev/null || { sleep 1; rm -rf "$ROOT" 2>/dev/null; } || true
}
trap cleanup EXIT

# Distinct sentinel so we can prove .gitattributes was preserved across an
# in-place scaffold (instead of clobbered by cpSync of the template).
SENTINEL='# preserved-by-test-in-place'

PASS=0
FAIL=0
FAILED_SCENARIOS=()

# run_scenario <id> <description> <invoke-mode> <seed-mode>
#   invoke-mode: "parent" or "inside"
#   seed-mode:   "boilerplate" (.git + .gitattributes with sentinel), "empty",
#                or "docs-and-md" (.git + README.md + CLAUDE.md + docs/ — the
#                2026-07-12 quant-repo case: markdown-only repo from git init)
run_scenario() {
  local id="$1" desc="$2" invoke="$3" seed="$4"
  local scenario_dir="$ROOT/$id"
  local target="$scenario_dir/action-coding"
  local log="$scenario_dir/run.log"

  echo
  echo "================================================================="
  echo "Scenario $id: $desc"
  echo "  invoke from : $invoke"
  echo "  target seed : $seed"
  echo "================================================================="

  mkdir -p "$target"
  if [[ "$seed" == "boilerplate" ]]; then
    (cd "$target" && git init -q)
    printf '%s\n* text=auto eol=lf\n' "$SENTINEL" > "$target/.gitattributes"
  elif [[ "$seed" == "docs-and-md" ]]; then
    (cd "$target" && git init -q)
    printf '%s\n# my project readme\n' "$SENTINEL" > "$target/README.md"
    printf '%s\n# my project agent notes\n' "$SENTINEL" > "$target/CLAUDE.md"
    mkdir -p "$target/docs"
    printf '%s\n# design notes\n' "$SENTINEL" > "$target/docs/notes.md"
  fi

  echo "--- pre-state of $target ---"
  ls -A "$target" 2>/dev/null || true

  local cwd
  case "$invoke" in
    parent) cwd="$scenario_dir" ;;
    inside) cwd="$target" ;;
    *) echo "FATAL: unknown invoke mode '$invoke'" >&2; exit 2 ;;
  esac

  echo "--- running scaffold (cwd=$cwd) ---"
  # Strip ANSI + carriage returns so spinner spam does not pollute the log.
  if ! (cd "$cwd" && node "$SCAFFOLD" action-coding --local "$SDK_ROOT") \
        2>&1 \
        | sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g' \
        | tr -d '\r' \
        > "$log"
  then
    echo "FAIL: scaffold exited non-zero. Log:"
    sed 's/^/  /' "$log"
    FAIL=$((FAIL+1)); FAILED_SCENARIOS+=("$id"); return
  fi

  # ---- Verifications -----------------------------------------------------
  # NOTE: do NOT check for "Scaffolding into existing repo" / "Copying template"
  # spinner labels. @clack/prompts suppresses spinner.start() labels in non-TTY
  # contexts (i.e. anywhere this script captures output), so those strings are
  # absent regardless of which code branch ran. The next-steps box and the
  # filesystem layout below are the reliable in-place signals.
  local errors=()

  # 1. Scaffold completed end-to-end. The final clack outro prints this line.
  if ! grep -qF 'action-coding is ready' "$log"; then
    errors+=("scaffold did not finish (no '<name> is ready' outro line)")
  fi
  if grep -qF 'Directory action-coding already exists' "$log"; then
    errors+=("scaffold rejected the directory (in-place branch did not fire)")
  fi

  # 2. In-place runs omit the leading 'cd action-coding' line in next-steps
  #    (see src/index.ts: ...(isInPlace ? [] : [\`cd \${appName}\`])).
  if grep -qF 'cd action-coding' "$log"; then
    errors+=("'cd action-coding' present in output (means new-directory branch fired)")
  fi

  # 3. Files must land at $target, not a nested action-coding/action-coding.
  if [[ ! -f "$target/package.json" ]]; then
    errors+=("$target/package.json missing")
  else
    local name
    name=$(node -p "require('$target/package.json').name")
    [[ "$name" == "action-coding" ]] || errors+=("package.json name='$name' (want 'action-coding')")
  fi
  if [[ ! -f "$target/worker.ts" ]]; then
    errors+=("$target/worker.ts missing")
  fi
  if [[ -d "$target/action-coding" ]]; then
    errors+=("nested $target/action-coding/ exists (scaffold landed in wrong dir)")
  fi

  # 3b. Identity + TOML sanity: wrangler.toml must carry a real minted app id,
  #     no unsubstituted placeholders, and exactly ONE [vars] table (a second
  #     one is invalid TOML and bricks build/dev/deploy — regression for the
  #     duplicate-[vars] scaffold bug).
  if [[ -f "$target/wrangler.toml" ]]; then
    if ! grep -qE 'DEEPSPACE_APP_ID = "app_[0-9A-HJKMNP-TV-Z]{26}"' "$target/wrangler.toml"; then
      errors+=("wrangler.toml missing a minted DEEPSPACE_APP_ID")
    fi
    if grep -qF '__APP_' "$target/wrangler.toml"; then
      errors+=("wrangler.toml still contains __APP_*__ placeholders")
    fi
    local vars_count
    vars_count=$(grep -c '^\[vars\]' "$target/wrangler.toml" || true)
    if [[ "$vars_count" != "1" ]]; then
      errors+=("wrangler.toml has $vars_count [vars] tables (want exactly 1 — duplicates are invalid TOML)")
    fi
  else
    errors+=("$target/wrangler.toml missing")
  fi

  # 4. Boilerplate-seeded scenarios must preserve the original .gitattributes.
  if [[ "$seed" == "boilerplate" ]]; then
    if [[ ! -f "$target/.gitattributes" ]]; then
      errors+=(".gitattributes was deleted by scaffold")
    elif ! grep -qF "$SENTINEL" "$target/.gitattributes"; then
      errors+=(".gitattributes sentinel '$SENTINEL' missing (file was overwritten)")
    fi
    if [[ ! -d "$target/.git" ]]; then
      errors+=(".git directory was deleted by scaffold")
    fi
  fi

  # 5. Empty-seed scenarios: scaffolder must `git init` at the end (line ~252).
  if [[ "$seed" == "empty" ]]; then
    if [[ ! -d "$target/.git" ]]; then
      errors+=("scaffold did not run 'git init' on empty-seed target")
    fi
  fi

  # 6. docs-and-md seed: user content must survive, colliding template files
  #    land alongside as <name>.deepspace.md, docs/ untouched, .git preserved.
  if [[ "$seed" == "docs-and-md" ]]; then
    for f in README.md CLAUDE.md docs/notes.md; do
      if [[ ! -f "$target/$f" ]]; then
        errors+=("$f was deleted by scaffold")
      elif ! grep -qF "$SENTINEL" "$target/$f"; then
        errors+=("$f sentinel missing (file was overwritten)")
      fi
    done
    if [[ ! -d "$target/.git" ]]; then
      errors+=(".git directory was deleted by scaffold")
    fi
    # Template CLAUDE.md collided → must be written alongside, fully configured.
    if [[ ! -f "$target/CLAUDE.deepspace.md" ]]; then
      errors+=("CLAUDE.deepspace.md missing (template version of colliding CLAUDE.md not written alongside)")
    elif grep -qF "$SENTINEL" "$target/CLAUDE.deepspace.md"; then
      errors+=("CLAUDE.deepspace.md contains the user sentinel (wrong file copied)")
    fi
    # Template README does not exist, so no README.deepspace.md should appear.
    if [[ -f "$target/README.deepspace.md" ]]; then
      errors+=("README.deepspace.md exists but template has no README.md")
    fi
    # AGENTS.md has no collision → copied under its own name, placeholders substituted.
    if [[ ! -f "$target/AGENTS.md" ]]; then
      errors+=("AGENTS.md missing (non-colliding template file not copied)")
    fi
    if grep -rqF '__APP_NAME__' "$target/CLAUDE.deepspace.md" "$target/AGENTS.md" 2>/dev/null; then
      errors+=("__APP_NAME__ placeholder left unsubstituted in copied markdown")
    fi
    if grep -qF 'Kept existing CLAUDE.md' "$log"; then
      :
    else
      errors+=("log missing 'Kept existing CLAUDE.md' preservation notice")
    fi
  fi

  if (( ${#errors[@]} == 0 )); then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "FAIL ($id):"
    printf '  - %s\n' "${errors[@]}"
    echo "  log: $log"
    FAIL=$((FAIL+1)); FAILED_SCENARIOS+=("$id")
  fi
}

# Scenario matrix.
run_scenario 1 "parent dir + near-empty (.git + .gitattributes)" parent boilerplate
run_scenario 2 "inside dir + near-empty (.git + .gitattributes)" inside boilerplate
run_scenario 3 "inside dir + fully empty (no .git)"              inside empty
run_scenario 4 "parent dir + fully empty (no .git)"              parent empty
run_scenario 5 "parent dir + docs/ + README.md + CLAUDE.md"      parent docs-and-md
run_scenario 6 "inside dir + docs/ + README.md + CLAUDE.md"      inside docs-and-md

# ---- Agent-friendly CLI contract ------------------------------------------
# These exercise the non-scaffolding entry points: --help, --version, missing
# app name (must NOT prompt — agents pipe stdin and would hang forever), and
# invalid name (must reject before any clack output).
run_cli_test() {
  local id="$1" desc="$2" expected_exit="$3"; shift 3
  local args=("$@")
  local out_dir="$ROOT/cli-$id"
  local log="$out_dir/run.log"
  mkdir -p "$out_dir"

  echo
  echo "================================================================="
  echo "CLI $id: $desc"
  echo "  argv         : ${args[*]:-<none>}"
  echo "  expected exit: $expected_exit"
  echo "================================================================="

  local actual_exit=0
  # Run with </dev/null so the test would HANG (and timeout would kill it) if
  # the CLI ever falls through to interactive p.text() on a closed stdin.
  # The "${args[@]+...}" guard is required for the no-args case under bash 3.2
  # + `set -u`, where expanding an empty array would otherwise be treated as
  # an unbound variable error and abort the subshell before `node` even runs.
  ( cd "$out_dir" && node "$SCAFFOLD" ${args[@]+"${args[@]}"} </dev/null ) >"$log" 2>&1 \
    || actual_exit=$?

  local errors=()
  [[ "$actual_exit" == "$expected_exit" ]] \
    || errors+=("exit code $actual_exit (want $expected_exit)")
  # Anything we did NOT want to see.
  if grep -qF 'What is your app name?' "$log"; then
    errors+=("prompted interactively for app name (must not prompt by default)")
  fi
  # Per-test extra assertions are passed via the CLI_EXTRA_GREP env, set below.
  if [[ -n "${CLI_EXPECT:-}" ]] && ! grep -qF "$CLI_EXPECT" "$log"; then
    errors+=("expected substring not found: '$CLI_EXPECT'")
  fi
  if [[ -n "${CLI_NOT_EXPECT:-}" ]] && grep -qF "$CLI_NOT_EXPECT" "$log"; then
    errors+=("unexpected substring present: '$CLI_NOT_EXPECT'")
  fi

  if (( ${#errors[@]} == 0 )); then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "FAIL (cli-$id):"
    printf '  - %s\n' "${errors[@]}"
    echo "  log: $log"
    FAIL=$((FAIL+1)); FAILED_SCENARIOS+=("cli-$id")
  fi
  unset CLI_EXPECT CLI_NOT_EXPECT
}

CLI_EXPECT='USAGE'                 run_cli_test help-long    "--help shows usage and exits 0" 0 --help
CLI_EXPECT='USAGE'                 run_cli_test help-short   "-h shows usage and exits 0"     0 -h
CLI_EXPECT='.'                     run_cli_test version      "--version prints version, exits 0" 0 --version
CLI_EXPECT='missing required'      run_cli_test no-args      "no args errors, prints usage, exits 1" 1
CLI_EXPECT='lowercase alphanumeric' run_cli_test bad-name    "invalid name rejected with validator message" 1 Bad-Name

# ---------------------------------------------------------------------------
# Identity guard: scaffolding over an existing DeepSpace app must REFUSE and
# leave its DEEPSPACE_APP_ID untouched (a re-mint silently forks the app's
# data, secrets, and routes).
# ---------------------------------------------------------------------------
run_identity_guard_test() {
  local id="identity-guard"
  local out_dir="$ROOT/$id"
  local target="$out_dir/action-coding"
  local log="$out_dir/run.log"
  mkdir -p "$target"
  local sentinel_id='app_00000000000000000SENTINEL'
  printf 'name = "action-coding"\n[vars]\nDEEPSPACE_APP_ID = "%s"\n' "$sentinel_id" \
    > "$target/wrangler.toml"

  echo
  echo "================================================================="
  echo "SCENARIO $id: refuses to scaffold over an existing app"
  echo "================================================================="

  local actual_exit=0
  ( cd "$out_dir" && node "$SCAFFOLD" action-coding --local "$SDK_ROOT" </dev/null ) >"$log" 2>&1 \
    || actual_exit=$?

  local errors=()
  [[ "$actual_exit" == "1" ]] || errors+=("exit code $actual_exit (want 1)")
  grep -qF 'already a DeepSpace app' "$log" \
    || errors+=("refusal message missing ('already a DeepSpace app')")
  grep -qF "$sentinel_id" "$target/wrangler.toml" \
    || errors+=("existing DEEPSPACE_APP_ID was overwritten")
  [[ -f "$target/worker.ts" ]] && errors+=("template files were copied despite refusal")

  if (( ${#errors[@]} == 0 )); then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "FAIL ($id):"
    printf '  - %s\n' "${errors[@]}"
    echo "  log: $log"
    FAIL=$((FAIL+1)); FAILED_SCENARIOS+=("$id")
  fi
}
run_identity_guard_test

# ---------------------------------------------------------------------------
# Blocked-dir guard: a target containing non-boilerplate entries (package.json,
# src/) must REFUSE, list the blocking entries by name, and copy nothing.
# Boilerplate sitting next to the blockers (README.md) must NOT be listed.
# ---------------------------------------------------------------------------
run_blocked_dir_test() {
  local id="blocked-dir"
  local out_dir="$ROOT/$id"
  local target="$out_dir/action-coding"
  local log="$out_dir/run.log"
  mkdir -p "$target/src"
  printf '{ "name": "someone-elses-project" }\n' > "$target/package.json"
  printf '# existing readme\n' > "$target/README.md"

  echo
  echo "================================================================="
  echo "SCENARIO $id: refuses non-boilerplate dir and lists blockers"
  echo "================================================================="

  local actual_exit=0
  ( cd "$out_dir" && node "$SCAFFOLD" action-coding --local "$SDK_ROOT" </dev/null ) >"$log" 2>&1 \
    || actual_exit=$?

  local errors=()
  [[ "$actual_exit" == "1" ]] || errors+=("exit code $actual_exit (want 1)")
  grep -qF 'package.json' "$log" \
    || errors+=("refusal does not list blocking entry 'package.json'")
  grep -qF 'src' "$log" \
    || errors+=("refusal does not list blocking entry 'src'")
  grep -qF 'README.md' "$log" \
    && errors+=("refusal lists boilerplate 'README.md' as a blocker")
  [[ -f "$target/worker.ts" ]] && errors+=("template files were copied despite refusal")
  grep -qF 'someone-elses-project' "$target/package.json" \
    || errors+=("existing package.json was modified")

  if (( ${#errors[@]} == 0 )); then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "FAIL ($id):"
    printf '  - %s\n' "${errors[@]}"
    echo "  log: $log"
    FAIL=$((FAIL+1)); FAILED_SCENARIOS+=("$id")
  fi
}
run_blocked_dir_test

echo
echo "================================================================="
echo "Summary: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  printf '  failed: %s\n' "${FAILED_SCENARIOS[@]}"
  exit 1
fi
echo "================================================================="
