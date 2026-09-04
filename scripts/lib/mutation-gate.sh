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
MG_SUITE_LOG=""
MG_TEST_TIMEOUT_MS="${MG_TEST_TIMEOUT_MS:-5000}"
# The hook bound is derived rather than defaulted here, in `mg_run_suite`, because a gate may set
# `MG_TEST_TIMEOUT_MS` after sourcing this file and because it must never fall below what vitest
# would have used unprompted. Set this to override it. See `mg_run_suite`.
MG_HOOK_TIMEOUT_MS="${MG_HOOK_TIMEOUT_MS:-}"

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
  # would make this flaky for no reason. What is asserted instead is narrower than "usable", which is
  # what this said and could not deliver: a recognisable tree root here, and then every subject file
  # in `mutation_gate_init`. A tar that truncated a file it did copy would pass both.
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

# Refuse a subject that would be mutated in the developer's own checkout despite the copy.
#
# The copy only helps for subjects named *relatively*: those resolve inside it, because `mg_isolate`
# changes directory. An absolute path does not — it goes on pointing at the original tree, so a gate
# spelling its subject `"$REPO_ROOT/src/foo.ts"` would break the real file for the length of its run
# and the isolation would be decoration.
#
# Absolute is not itself the problem, which is why this looks at where the path points: the
# harness's own self-test has subjects in a temp sandbox, and those are absolute and must stay
# allowed. Both sides are resolved before they are compared, because a prefix match answers a
# question about spelling and the question here is which tree the path reaches — a symlink into the
# checkout is not spelled like the checkout.
mg_check_subject() {
  local file="$1"
  case "$file" in
    /*) ;;
    *) return 0 ;;
  esac
  # Resolved with the deepest existing ancestor, because the subject itself may be a path a gate is
  # about to create, and `realpath` on a missing file answers nothing on macOS.
  local resolved="$file" parent
  parent="$(cd "$(dirname "$file")" 2>/dev/null && pwd -P)" || parent=""
  [[ -n "$parent" ]] && resolved="$parent/$(basename "$file")"
  local origin="$MG_ORIGIN"
  [[ -d "$origin" ]] && origin="$(cd "$origin" && pwd -P)"
  case "$resolved" in
    "$origin" | "$origin"/*)
      echo "FAIL: subject $file is an absolute path into the checkout at $MG_ORIGIN" >&2
      echo "      Mutating it would break the developer's own tree for the length of this run," >&2
      echo "      which the private copy exists to prevent. Name the subject relative to the" >&2
      echo "      repository root instead." >&2
      exit 1
      ;;
  esac
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
  # Kept rather than discarded, so a suite that went red for the wrong reason can be looked at. In
  # the backup directory, which is already removed on every exit path including a signal.
  MG_SUITE_LOG="$MG_BACKUP_DIR/suite.log"
  local file
  for file in "${MG_SUBJECTS[@]}"; do
    mg_check_subject "$file"
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
  # Refused rather than allowed to mean "everything". `MG_SUITE` is word-split below, so an empty one
  # degrades to `vitest run` over every spec in the repository — slower, and green for reasons that
  # have nothing to do with the mutation. Two gates initialise the harness with no suite because they
  # run something other than vitest; documenting that arrangement is weaker than refusing to run a
  # suite that was never named.
  if [[ -z "${MG_SUITE// /}" ]]; then
    echo "FAIL: this gate was initialised with no test suite, so there is nothing to run." >&2
    echo "      Pass the specs to mutation_gate_init, or use mg_mutate directly and run whatever" >&2
    echo "      this gate runs instead of vitest." >&2
    exit 1
  fi
  # `--hookTimeout` as well as `--testTimeout`, which this passed only the latter of. A gate's suites
  # do their real filesystem work in *hooks* — the workspace suites' `afterEach` removes a git
  # repository plus a checked-out worktree per test, and their `afterAll` a scratch `HOME` — and a
  # gate is the slowest context that teardown ever runs in: ten vitest workers contending, once per
  # mutation. With only the test bound raised to 30s the hook stayed on vitest's 10s default, a third
  # of it, so the first thing to time out under load would have been the cleanup — a red that fails
  # the mutation for a reason that says nothing about the criterion, which is exactly what
  # `MG_TEST_TIMEOUT_MS` exists to prevent. vitest.config.ts sets both for the same reason, so a
  # timeout means the same thing wherever the suite is run from.
  #
  # Never *below* what vitest would have used unprompted, which is the trap in "set them to the same
  # value": two gates here lower the test bound deliberately — 1500ms for the disposal gate, so an
  # unbounded-wait mutation is caught quickly rather than sitting on the default — and equalising
  # would have cut their hook bound from 10s to 1.5s, a tightening no finding asked for and a flake
  # nobody would attribute to this line. So the hook bound is the larger of the two, computed here
  # rather than at source time because a gate may set `MG_TEST_TIMEOUT_MS` after sourcing this file
  # (the disposal gate does).
  local hook_timeout="${MG_HOOK_TIMEOUT_MS:-}"
  if [[ -z "$hook_timeout" ]]; then
    hook_timeout=$((MG_TEST_TIMEOUT_MS > 10000 ? MG_TEST_TIMEOUT_MS : 10000))
  fi
  # shellcheck disable=SC2086 # MG_SUITE is deliberately word-split: it is a list of spec paths.
  "$vitest" run $MG_SUITE \
    --testTimeout="$MG_TEST_TIMEOUT_MS" \
    --hookTimeout="$hook_timeout" >"$MG_SUITE_LOG" 2>&1
}

# Did the suite actually run and report failing tests, or did it fail to run at all?
#
# The distinction the gates were missing. `expect_red` took any non-zero exit as proof that a
# criterion is checked, and vitest exits non-zero for a mutation it cannot even parse — printing
# `Tests  no tests` and a parse error, with not one assertion evaluated. So a mutation whose
# substitution produced invalid TypeScript reported `ok` for a criterion nothing had looked at, which
# is precisely the failure these scripts exist to catch, in the script doing the catching. Review
# found it; reproduced by breaking a mutation on purpose before fixing.
#
# ANSI stripped first: vitest colours its summary even when its output is a file.
mg_suite_reported_failures() {
  perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$1" |
    grep -qE '^[[:space:]]*Tests[[:space:]]+.*[0-9]+ failed'
}

# The last suite run's output, for a gate that has to explain itself.
mg_suite_tail() {
  [[ -f "$MG_SUITE_LOG" ]] || return 0
  perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$MG_SUITE_LOG" | tail -n "${1:-25}"
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
#
# A replacement half containing an unescaped `$` is refused, and that is not a style rule. Perl treats
# a replacement as a double-quoted string, so `${path}` in it is a symbolic dereference of `path` —
# which under no strict refs is silently the empty string, not the four characters the author meant.
# Two mutations here spent a round claiming to insert a template literal and inserting a broken one
# instead; both still turned the suite red, for the wrong reason, which is the failure mode this
# entire harness exists to catch. Write `\$` and the mutation says what it does.
#
# A capture-group backreference — `$1`, `${2}` — is the one interpolation that is meant, and stays
# allowed. One mutation here depends on it: it keeps the line it matched and inserts a return above.
mg_mutate() {
  local criterion="$1" subject="$2"
  shift 2
  local -a subs=("$@")

  # The subject has to exist. `perl -0i` on a path that does not merely warns and exits 0, and with no
  # input the substitution loop never runs — so the mutation applies to nothing, the suite passes
  # unchanged, and `expect_red` reports the criterion as unchecked when the truth is that nothing was
  # broken. A quoting mistake in a criterion string is enough to get here: an apostrophe inside the
  # double-quoted argument split it, and the word after the split arrived as the subject.
  if [[ ! -f "$subject" ]]; then
    echo "FAIL: mutation for '$criterion' names a subject that does not exist: $subject" >&2
    echo "      Nothing would have been mutated, and the gate would have reported on a suite that" >&2
    echo "      was never broken. Check the subject path, and check the quoting of the arguments" >&2
    echo "      before it — an apostrophe in a double-quoted criterion splits them." >&2
    exit 1
  fi

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
        # The replacement half, when this is an ordinary slash-delimited s///. Anything else is left
        # to the eval below to accept or reject.
        if ($code =~ m{\As/((?:[^/\\]|\\.)*)/((?:[^/\\]|\\.)*)/[a-z]*\z}) {
          my $replacement = $2;
          # Backreferences are the legitimate interpolation; anything else is a variable that will
          # silently be empty.
          my $probe = $replacement;
          $probe =~ s/\$\{?[1-9][0-9]*\}?//g;
          if ($probe =~ /(?<!\\)\$/) {
            push @wrong, "$i (replacement has an unescaped \$, which perl interpolates)";
            next;
          }
        }
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
    echo "      Every substitution must match exactly once and must not contain an unescaped \$ in" >&2
    echo "      its replacement — perl interpolates that, so the mutation would insert something" >&2
    echo "      other than what it says. Either an anchor has drifted or a \$ needs escaping." >&2
    echo "      Update the mutation to match the current code; do not delete it." >&2
    exit 1
  fi
}

# Did the suite go red *only* by timing out?
#
# A timeout is the one red that as easily means "the machine was busy" or "this mutation made the
# suite slower" as it does "the criterion failed" — MG_TEST_TIMEOUT_MS is a cold-transform safety
# margin, not an assertion. But it is not enough to refuse any red containing a timeout: several
# honest mutations make one test hang *and* several others fail their assertions, and refusing those
# would be a false alarm in the other direction. So the question is whether a timeout is all there
# was. If some test failed for a reason other than the clock, the criterion is checked.
#
# A few mutations have nothing but a hang to show — removing the acquisition loop's bound, removing
# the bounded wait a release gets — and those say so at the call site with `expect_red_by_timeout`.
mg_suite_only_timed_out() {
  local plain failures timeouts
  plain="$(perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$1")"
  failures="$(printf '%s' "$plain" | sed -nE 's/^[[:space:]]*Tests[[:space:]]+.*[^0-9]([0-9]+) failed.*/\1/p' | head -1)"
  timeouts="$(printf '%s' "$plain" | grep -cE 'Test timed out in [0-9]+ms' || true)"
  # No failing count in the summary means the suite did not get as far as running tests, which is a
  # different complaint and `mg_suite_reported_failures` makes it. Otherwise the arithmetic answers
  # both questions at once: with no timeouts at all, no positive failure count is <= 0.
  [[ -n "$failures" ]] || return 1
  ((failures <= timeouts))
}

# expect_red <criterion> <subject-file> <perl-substitution>...
expect_red() {
  mg_expect_red_inner "no" "$@"
}

# expect_red_by_timeout <criterion> <subject-file> <perl-substitution>...
#
# For a mutation whose red *is* a hang. See mg_suite_timed_out.
expect_red_by_timeout() {
  mg_expect_red_inner "yes" "$@"
}

mg_expect_red_inner() {
  local timeout_expected="$1" criterion="$2" subject="$3"
  shift 3

  mg_restore
  mg_mutate "$criterion" "$subject" "$@"

  if mg_run_suite; then
    echo "FAIL: the suite passes with '$criterion' broken — that criterion is not being checked" >&2
    exit 1
  fi
  if [[ "$timeout_expected" == "no" ]] && mg_suite_only_timed_out "$MG_SUITE_LOG"; then
    echo "FAIL: the suite went red with '$criterion' broken, but every failure was a timeout." >&2
    echo "      A timeout is as likely to be a slow machine, or a mutation that made the suite" >&2
    echo "      merely slower, as it is to be the criterion failing. Raise MG_TEST_TIMEOUT_MS, or" >&2
    echo "      use expect_red_by_timeout if the hang is the point." >&2
    mg_suite_tail >&2
    exit 1
  fi
  # Red is not enough: it has to be red because a *test* failed. See mg_suite_reported_failures.
  if ! mg_suite_reported_failures "$MG_SUITE_LOG"; then
    echo "FAIL: the suite did not pass with '$criterion' broken, but no test failed either." >&2
    echo "      The mutation probably produced code that cannot be parsed or imported, so nothing" >&2
    echo "      was asserted and this mutation proves nothing. Fix the substitution so that it" >&2
    echo "      produces a plausible wrong implementation rather than a broken file." >&2
    mg_suite_tail >&2
    exit 1
  fi
  echo "  ok: breaking '$criterion' turns the suite red"
}

mutation_gate_finish() {
  mg_restore
  if ! mg_run_suite; then
    echo "FAIL: the suite does not pass on the restored tree — it was already broken" >&2
    mg_suite_tail >&2
    exit 1
  fi
  echo "PASS: $1"
}
