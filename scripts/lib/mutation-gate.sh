# shellcheck shell=bash
#
# The shared harness for "prove this test is a gate" scripts.
#
# Each of those scripts applies plausible wrong implementations to its subject and requires the
# suite to go red for every one. The mechanics of doing that safely — back the sources up, restore
# them however the script exits including on a signal, refuse a mutation whose anchor has drifted,
# run the pinned vitest rather than whatever `npx` would fetch — were duplicated verbatim between
# verify-disposal-gate.sh and verify-lock-gate.sh, rationale comments included. Review flagged it,
# and the duplication is worse than ordinary copy-paste here: this is the code that decides whether
# the other gates are trustworthy, so a fix applied to one copy and not the other is a gate that
# quietly stops being one.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/mutation-gate.sh"
#   mutation_gate_init "test/a.test.ts test/b.test.ts" src/one.ts src/two.ts
#   expect_red "<criterion>" src/one.ts 's/pattern/replacement/'
#   expect_red "<criterion>" src/one.ts 's/first/one/' 's/second/two/'   # each must apply once
#   mutation_gate_finish "each X criterion has a test that fails when it is broken"
#
# A script that needs to run something other than vitest against a mutation — see
# verify-acquisition-returns.sh, which has to run a plain node process — uses `mg_mutate` and
# `mg_restore` directly and skips `expect_red`.

MG_SUITE=""
MG_SUBJECTS=()
MG_BACKUP_DIR=""
MG_STASH=""
MG_ORIGIN=""
MG_WORKDIR=""
MG_EXIT_HOOKS=()
MG_TEST_TIMEOUT_MS="${MG_TEST_TIMEOUT_MS:-5000}"

# Where a subject's pristine copy lives, as a path mirroring the subject's own.
#
# Not its basename. Review caught that: two subjects sharing a basename — `src/a/index.ts` and
# `src/b/index.ts` — would have shared one backup, so the second `cp` would overwrite the first and
# `mg_restore` would write one subject's contents over the other. No gate here has same-basename
# subjects today, which is exactly why it was worth fixing: it is a trap set for whoever adds one,
# in the one file whose job is to be trustworthy about restoring a tree it deliberately broke.
#
# Sets MG_STASH rather than echoing, so a path containing a space or a newline cannot be re-split by
# a command substitution.
mg_stash_path() {
  MG_STASH="$MG_BACKUP_DIR/subjects/$1"
}

# Run <command> when this script exits, alongside the harness's own cleanup.
#
# The harness installs an EXIT trap, and a `trap ... EXIT` set by the calling script *before* it
# calls `mutation_gate_init` used to be silently replaced by it — which is how the harness's own
# self-test leaked a temp directory on every run. Review found the leak; this fixes the class rather
# than the instance, by inheriting whatever was already there and offering somewhere to add more.
mg_on_exit() {
  MG_EXIT_HOOKS+=("$1")
}

mg_inherit_exit_trap() {
  local existing
  existing="$(trap -p EXIT)"
  # `trap -p` prints nothing when no trap is set, and `trap -- 'command' EXIT` when one is. The
  # command comes back quoted the way bash would re-read it, so `eval` in mg_cleanup is exact.
  [[ -n "$existing" ]] || return 0
  local body="${existing#trap -- }"
  body="${body% EXIT}"
  # One round of unquoting, without running anything. `trap -p` prints the command quoted the way
  # bash would re-read it, so `eval` on it as-is treats the whole thing as a single command *name* —
  # which is how the first attempt at inheriting it reported `rm -rf "$SANDBOX": command not found`.
  # Assigning through `eval` strips exactly that layer; the variables inside stay unexpanded until
  # mg_cleanup evaluates the hook.
  local command
  eval "command=$body"
  mg_on_exit "$command"
}

# Copy the working tree somewhere private and work there instead.
#
# Review's objection, and it had bitten the reviewer three times: these scripts spend most of their
# run with tracked source files deliberately broken *in the developer's own checkout*. Anything else
# reading the tree in that window — an editor, a language server, another agent, a person running
# `git status` — sees a mutation and has no way to know it is not theirs. Restoring afterwards does
# not help; the hazard is the window, not the end state.
#
# The working tree rather than HEAD, because the gates must test the code as it stands, uncommitted
# changes included — which is also why this is a copy and not `git worktree add`. `node_modules` is
# symlinked rather than copied: it is the one directory large enough to matter, and nothing here
# writes to it.
mg_isolate() {
  MG_ORIGIN="$PWD"
  MG_WORKDIR="$(mktemp -d)"

  # tar's status is not the check. It exits non-zero for warnings as well as errors — "file changed
  # as we read it" being the one a live checkout produces — and treating a warning as a failed gate
  # would make this flaky for no reason. What the copy has to be is *usable*, so that is what is
  # asserted, below.
  tar --exclude=./node_modules --exclude=./.git --exclude=./dist \
    -cf - -C "$MG_ORIGIN" . 2>/dev/null | tar -xf - -C "$MG_WORKDIR" || true

  if [[ ! -f "$MG_WORKDIR/package.json" ]]; then
    echo "FAIL: could not copy the working tree to $MG_WORKDIR" >&2
    exit 1
  fi

  # Defensive: if a tar without `--exclude` support ever copied node_modules in, the symlink below
  # would fail and the gate would stop for a reason that has nothing to do with the code.
  rm -rf "$MG_WORKDIR/node_modules"
  ln -s "$MG_ORIGIN/node_modules" "$MG_WORKDIR/node_modules"
  cd "$MG_WORKDIR"
}

mutation_gate_init() {
  MG_SUITE="$1"
  shift
  MG_SUBJECTS=("$@")

  mg_inherit_exit_trap
  # INT and TERM as well as EXIT: this spends most of its run with source files deliberately broken,
  # and an interrupt in that window must not leave the copy — or anything the calling script set up
  # — lying around.
  #
  # Measured, because the reason usually given for this is not the reason that holds: bash does run
  # an EXIT trap when it dies of INT, TERM or HUP, so EXIT alone already suffices here. These are
  # for the shells and platforms where that is not guaranteed, which is worth having in the scripts
  # whose entire job is to be trustworthy about failure.
  trap mg_cleanup EXIT
  trap 'mg_on_signal INT' INT
  trap 'mg_on_signal TERM' TERM

  mg_isolate

  MG_BACKUP_DIR="$(mktemp -d)"
  local file
  for file in "${MG_SUBJECTS[@]}"; do
    [[ -f "$file" ]] || {
      echo "FAIL: subject $file does not exist" >&2
      exit 1
    }
    mg_stash_path "$file"
    mkdir -p "$(dirname "$MG_STASH")"
    cp "$file" "$MG_STASH"
  done
}

# A loop variable named `subject` here would clobber expect_red's, because bash locals are
# dynamically scoped and this is called from inside it. That bug cost a debugging round the first
# time this harness was written.
mg_restore() {
  local file
  for file in "${MG_SUBJECTS[@]}"; do
    mg_stash_path "$file"
    cp "$MG_STASH" "$file"
  done
}

mg_cleanup() {
  if [[ -n "$MG_BACKUP_DIR" ]]; then
    mg_restore
    rm -rf "$MG_BACKUP_DIR"
  fi
  # Out of the copy before removing it, or the shell is left in a directory that no longer exists.
  if [[ -n "$MG_WORKDIR" ]]; then
    cd "$MG_ORIGIN" || true
    rm -rf "$MG_WORKDIR"
    MG_WORKDIR=""
  fi
  # Quoted array expansion with a `+` guard: bash 3.2 (which is what macOS ships) treats an
  # unguarded `"${arr[@]}"` on an empty array as unset under `set -u`, and dropping the quotes to
  # avoid that would word-split a hook containing a space — which is every hook worth having.
  local hook
  for hook in ${MG_EXIT_HOOKS[@]+"${MG_EXIT_HOOKS[@]}"}; do
    eval "$hook" || true
  done
  MG_EXIT_HOOKS=()
}

# Restore, then die of the signal rather than returning a status of our own. A gate that exits 1
# when it was killed tells its caller the gate failed, which is a different and more alarming thing
# than being interrupted — and misreporting how something ended is the exact failure these scripts
# exist to catch in the code they test.
mg_on_signal() {
  mg_cleanup
  trap - EXIT INT TERM
  kill -"$1" $$
}

# The installed binary directly, never `npx`: `npx` will fetch a package when the local one is
# missing, so a broken install would turn a gate into a silent download of some other version of
# vitest. A gate has to run the pinned one or fail. Directly rather than through `npm run test` for
# the same reason plus one more: a gate runs one vitest per mutation, and npm's own start-up is paid
# every time.
mg_run_suite() {
  local vitest="$PWD/node_modules/.bin/vitest"
  if [[ ! -x "$vitest" ]]; then
    echo "FAIL: vitest is not installed; run npm ci" >&2
    exit 1
  fi
  # shellcheck disable=SC2086 # MG_SUITE is deliberately word-split: it is a list of spec paths.
  "$vitest" run $MG_SUITE --testTimeout="$MG_TEST_TIMEOUT_MS" >/dev/null 2>&1
}

# mg_mutate <criterion> <subject-file> <perl-substitution>...
#
# Applies every substitution to the subject, and fails the script unless *each one* matched exactly
# once.
#
# Each, not the total. Review caught the first version adding the counts up and comparing the sum
# against the number of substitutions, which one `/g` or one pattern matching twice is enough to
# satisfy while a sibling matches nothing at all — so a mutation could half-apply, the suite could
# go red for the half that landed, and the criterion the other half was testing would silently stop
# being tested. That is the same defect this check was added to close, one level up: a gate that
# reports ok for something it is no longer looking at.
#
# The substitutions travel to perl through the environment so that no amount of quoting in them can
# be reinterpreted by the shell.
mg_mutate() {
  local criterion="$1" subject="$2"
  shift 2
  local -a subs=("$@")

  local index
  for index in "${!subs[@]}"; do
    export "MG_SUB_$index=${subs[$index]}"
  done
  export MG_SUB_COUNT="${#subs[@]}"

  local status=0
  perl -0i -pe '
      BEGIN { @wrong = () }
      for my $i (0 .. $ENV{MG_SUB_COUNT} - 1) {
        my $code = $ENV{"MG_SUB_$i"};
        my $n = eval $code;
        die "mutation $i failed to compile: $@" if $@;
        push @wrong, "$i (matched $n times)" if $n != 1;
      }
      END {
        if (@wrong) {
          print STDERR "      substitutions that did not match exactly once: @wrong\n";
          exit(3);
        }
      }
    ' "$subject" || status=$?

  for index in "${!subs[@]}"; do
    unset "MG_SUB_$index"
  done
  unset MG_SUB_COUNT

  if ((status != 0)); then
    echo "FAIL: mutation for '$criterion' did not apply cleanly to $subject." >&2
    echo "      Every substitution must match exactly once; an anchor has drifted." >&2
    echo "      Update the mutation to match the current code; do not delete it." >&2
    exit 1
  fi
}

# expect_red <criterion> <subject-file> <perl-substitution>...
expect_red() {
  local criterion="$1" subject="$2"
  shift 2

  mg_restore
  mg_mutate "$criterion" "$subject" "$@"

  if mg_run_suite; then
    echo "FAIL: the suite passes with '$criterion' broken — that criterion is not being checked" >&2
    exit 1
  fi
  echo "  ok: breaking '$criterion' turns the suite red"
}

mutation_gate_finish() {
  mg_restore
  if ! mg_run_suite; then
    echo "FAIL: the suite does not pass on the restored tree — it was already broken" >&2
    exit 1
  fi
  echo "PASS: $1"
}
