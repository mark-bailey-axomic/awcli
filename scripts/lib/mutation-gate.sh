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
#   expect_red "<criterion>" src/one.ts 's/first/one/' 's/second/two/'   # both must apply
#   mutation_gate_finish "each X criterion has a test that fails when it is broken"

MG_SUITE=""
MG_SUBJECTS=()
MG_BACKUP_DIR=""
MG_STASH=""
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

mutation_gate_init() {
  MG_SUITE="$1"
  shift
  MG_SUBJECTS=("$@")
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

  # INT and TERM as well as EXIT: this spends most of its run with tracked source files
  # deliberately broken, and an interrupt in that window must not leave them that way — on a
  # developer's machine it would look like their own work in progress.
  #
  # Measured, because the reason usually given for this is not the reason that holds: bash does run
  # an EXIT trap when it dies of INT, TERM or HUP, so EXIT alone already restores the files here.
  # These are for the shells and platforms where that is not guaranteed, which is worth having in
  # the scripts whose entire job is to be trustworthy about failure.
  trap mg_cleanup EXIT
  trap 'mg_on_signal INT' INT
  trap 'mg_on_signal TERM' TERM
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
  [[ -n "$MG_BACKUP_DIR" ]] || return 0
  mg_restore
  rm -rf "$MG_BACKUP_DIR"
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

# Through the package script rather than `npx`: `npx` will fetch a package when the local one is
# missing, so a broken install would turn a gate into a silent download of some other version of
# vitest. A gate has to run the pinned one or fail.
mg_run_suite() {
  # shellcheck disable=SC2086 # MG_SUITE is deliberately word-split: it is a list of spec paths.
  npm run test --silent -- $MG_SUITE --testTimeout="$MG_TEST_TIMEOUT_MS" >/dev/null 2>&1
}

# expect_red <criterion> <subject-file> <perl-substitution>...
#
# Every substitution must apply exactly once. Counting them is not fussiness: a multi-substitution
# mutation whose *second* half no longer matched would previously still change the file, so the
# no-op guard passed, and the suite could then go red for the half that did apply while the other
# half silently stopped being tested. The substitutions travel to perl through the environment so
# that no amount of quoting in them can be reinterpreted by the shell.
expect_red() {
  local criterion="$1" subject="$2"
  shift 2
  local -a subs=("$@")

  mg_restore

  local index
  for index in "${!subs[@]}"; do
    export "MG_SUB_$index=${subs[$index]}"
  done
  export MG_SUB_COUNT="${#subs[@]}"

  if ! perl -0i -pe '
      BEGIN { $applied = 0 }
      for my $i (0 .. $ENV{MG_SUB_COUNT} - 1) {
        my $code = $ENV{"MG_SUB_$i"};
        my $n = eval $code;
        die "mutation $i failed to compile: $@" if $@;
        $applied += $n;
      }
      END { exit(3) unless $applied == $ENV{MG_SUB_COUNT} }
    ' "$subject"; then
    echo "FAIL: mutation for '$criterion' did not apply cleanly to $subject." >&2
    echo "      Every substitution must match exactly once; an anchor has drifted." >&2
    echo "      Update the mutation to match the current code; do not delete it." >&2
    exit 1
  fi

  for index in "${!subs[@]}"; do
    unset "MG_SUB_$index"
  done
  unset MG_SUB_COUNT

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
