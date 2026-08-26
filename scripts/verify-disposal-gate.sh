#!/usr/bin/env bash
# Prove the disposal tests are gates. Every acceptance criterion on WB-2's first half is a claim
# about a failure path — reverse order, continuing past a failure, not leaking, giving up on a hung
# release — and a test for a failure path is the easiest kind to write so that it cannot fail.
# AWCLI-00 shipped a ticked criterion whose check was structurally incapable of failing; this
# script is the answer to that, for this unit.
#
# Each mutation below is a plausible wrong implementation, not a syntax error: forward order is
# what you get from forgetting one call, `break` is what a reviewer would suggest to "fail fast",
# and awaiting the release directly is the version without the bound. If the suite still passes
# with one applied, the criterion it belongs to is not being checked.
#
# The harness — backup, restore on any exit including a signal, refuse a drifted anchor, run the
# pinned vitest — is shared with the other gate scripts. See scripts/lib/mutation-gate.sh for why
# that is not merely tidiness.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/lib/mutation-gate.sh
source "$REPO_ROOT/scripts/lib/mutation-gate.sh"

# The short per-test timeout is so the unbounded-wait mutation is caught quickly rather than
# sitting on the default. The real suite runs in well under a second.
MG_TEST_TIMEOUT_MS=1500
mutation_gate_init "test/runtime/disposal.test.ts" src/runtime/disposal.ts

expect_red "resources unwind in reverse" src/runtime/disposal.ts \
  's/for \(let index = this\.#entries\.length - 1; index >= 0; index--\)/for (let index = 0; index < this.#entries.length; index++)/'

expect_red "a failing release does not stop the rest" src/runtime/disposal.ts \
  's/else failures\.push\(failure\);/else { failures.push(failure); break; }/'

expect_red "a leak is reported" src/runtime/disposal.ts \
  's/(leaks\(\): readonly string\[\] \{\n)/$1    return [];\n/'

expect_red "a hung release is abandoned after a bounded wait" src/runtime/disposal.ts \
  's/Promise\.race\(\[attempt, abandonment\]\)/attempt/'

# Added after review on PR #10 caught this one for real: the first version of unwind snapshotted
# the stack and so could report cleanup complete while an acquisition was still opening. The tests
# written for the other four criteria all passed against that. This mutation is the one that would
# have failed.
expect_red "an in-flight acquisition is unwound, not raced" src/runtime/disposal.ts \
  's/for \(const entry of await this\.#awaitOpening\(\)\)/for (const entry of [])/'

# The second review round on PR #10 found two more, both from the same root cause: stranded
# acquisitions were tracked in a list of their own, separate from the entries, and the two were
# never reconciled. One ledger fixes that by construction — these three mutations are what keeps
# the behaviour that used to depend on the reconciliation from quietly going missing again.
expect_red "an acquisition that lands mid-drain is still released" src/runtime/disposal.ts \
  's/entry\.state = "held";/entry.state = this.#closed ? "stranded" : "held";/'

expect_red "an acquisition that lands after the drain is released by acquire" src/runtime/disposal.ts \
  's/if \(this\.#unwound\) await this\.#release\(entry\);/if (false) await this.#release(entry);/'

expect_red "a stranded verdict is withdrawn when the resource turns up" src/runtime/disposal.ts \
  's/failures\.splice\(failures\.indexOf\(stranded\), 1\);/void stranded;/'

mutation_gate_finish "each disposal criterion has a test that fails when it is broken"
