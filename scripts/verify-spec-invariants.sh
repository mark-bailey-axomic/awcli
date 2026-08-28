#!/usr/bin/env bash
# Prove the specification's own numbers still agree with each other.
#
# The rules file, the feature file, the manifest and the ticket README each restate counts the
# others imply — 40 rules, 75 scenarios, 26 tickets, 66 points — and every one of those numbers is
# prose that a person maintains by hand. Three review rounds on PR #8 moved all four documents, and
# each time the drift was caught by a reader happening to notice, which does not scale and did not
# reliably work: a scenario added to the feature file and to no ticket has no owner, a ticket
# claiming a scenario nobody wrote has no criteria, and neither shows up as a broken build.
#
# So this is arithmetic over the approved documents rather than a review of them. It asserts nothing
# about whether a rule is right. It asserts that the four files describe the same corpus, that every
# scenario is an acceptance criterion on exactly one ticket, and that every @BR tag names a rule
# that exists.
#
# Two later checks reach past those four. Check 9 reads the DELIVERED_BY table in
# src/runtime/context.ts and the work breakdown in the TDD, because that table is the pointer saying
# which unit delivers each unbuilt context member and it has shipped wrong; check 10 reads the
# manifest's own freshness stamp against git. Both are still comparisons between things a person
# maintains by hand, which is the only thing this script knows how to do.
#
# Unlike the other gates here it perturbs nothing, so there is no backup to restore and no window
# in which a Ctrl-C leaves a tracked file corrupted. Every check is a comparison, and all of them
# run before anything is reported — a spec that has drifted in four places should say so once. That
# is also why this is the one script here without `set -e`: `grep -c` exits non-zero when a count is
# legitimately zero, and an aggregate check must not abort on its first arithmetic.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `|| exit` matters more here than in the other gates: without `set -e` a failed cd would leave
# every path below resolving against whatever directory this was started from.
cd "$REPO_ROOT" || exit 1

DESIGN=".atelier/design"
TICKETS=".atelier/tickets"
RULES="$DESIGN/agentic-workflow-cli-rules.md"
BDD="$DESIGN/agentic-workflow-cli-bdd.feature"
MANIFEST="$DESIGN/agentic-workflow-cli-spec-manifest.yaml"
README="$TICKETS/README.md"
TDD="$DESIGN/agentic-workflow-cli-tdd.md"
CONTEXT="src/runtime/context.ts"

fail=0
ok() { printf '  ok: %s\n' "$1"; }
bad() {
  printf 'FAIL: %s\n' "$1" >&2
  fail=1
}
# Every check reduces to two numbers that must agree. Reporting both, always, is what makes a
# failure actionable without opening the documents.
same() {
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — $2 != $3"; fi
}

# A renamed or moved document would otherwise make every grep below return nothing, and eleven
# simultaneous count mismatches do not say "the path is wrong".
for document in "$RULES" "$BDD" "$MANIFEST" "$README" "$TDD" "$CONTEXT"; do
  if [ ! -f "$document" ]; then
    echo "FAIL: $document is not on disk — this script is checking nothing" >&2
    exit 1
  fi
done

# Numbers this script reads out of prose a person wrote. Exactly one line may match: zero means the
# sentence was reworded and the check has quietly stopped applying, and two means one of them can
# drift unnoticed behind the other. Both answer with a token that is not a number, so the mismatch
# names the cause rather than showing a blank.
sole_match() {
  local pattern="$1" file="$2" found
  found="$(grep -cE "$pattern" "$file")"
  if [ "$found" != "1" ]; then
    printf 'no-unique-match(%s)\n' "$found"
    return
  fi
  grep -oE "$pattern" "$file"
}

# One number out of such a line — `head` for the first, `tail` for the last. The token from
# sole_match is passed straight through rather than having its digits picked out, which is the
# whole point: `no-unique-match(0)` reduced to `0` would report a reworded sentence as a count of
# zero and send the reader looking for a missing scenario that is not missing.
sole_number() {
  local line
  line="$(sole_match "$1" "$2")"
  case "$line" in
  no-unique-match*)
    printf '%s\n' "$line"
    return
    ;;
  esac
  printf '%s\n' "$line" | grep -oE '[0-9]+' | "$3" -1
}

# The `count:` belonging to one manifest block, bounded to that block. Scanning forward for the
# first `count:` after a key would silently read the next block's number if a block ever lost its
# own — comparing scenarios against flows, which is a mismatch whose message points nowhere.
manifest_count() {
  awk -v key="$1" '
    $0 ~ "^  " key ":[[:space:]]*$" { inside = 1; next }
    inside && /^  [^[:space:]]/ { exit }
    inside && /^    count:[[:space:]]/ { print $2; exit }
  ' "$MANIFEST"
}

# --- 1. The rules file counts its own rules -----------------------------------------------------
# Headings are `### BR-nnn` under `## Category n`, but the depth has changed once already, so both
# are accepted rather than pinning a formatting decision this check does not care about.
front_matter_rules="$(awk '/^---$/ { n++; next } n == 1 && /^rules:/ { print $2 }' "$RULES")"
rule_headings="$(grep -cE '^#{2,3} BR-[0-9]+' "$RULES")"
same "1  rules front-matter == BR- rule headings" "$front_matter_rules" "$rule_headings"

# --- 2. The manifest counts the same corpus -----------------------------------------------------
bdd_scenarios="$(grep -c '^  Scenario: ' "$BDD")"
same "2a manifest requirements.rules.count == BR headings" "$(manifest_count rules)" "$rule_headings"
same "2b manifest requirements.scenarios.count == feature Scenarios" \
  "$(manifest_count scenarios)" "$bdd_scenarios"

# --- 3. The ticket README counts the same scenarios ---------------------------------------------
readme_scenarios="$(sole_number 'Every one of the [0-9]+ BDD scenarios' "$README" head)"
same "3  README scenario total == feature Scenarios" "$readme_scenarios" "$bdd_scenarios"

# --- 4. Every scenario is an acceptance criterion on exactly one ticket -------------------------
# The invariant with teeth, and the only one that cannot be done in shell: it needs the scenario
# names matched verbatim against the italic criteria inside each ticket's Acceptance Criteria
# section, in both directions. A scenario owned by two tickets has two sets of criteria that can
# diverge; one owned by none is unbuilt; and an italic criterion that is not a scenario name is a
# ticket claiming approval it does not have. That last one is why emphasis inside an Acceptance
# Criteria section fails this gate — the italics there are a reference, not a typographic choice.
if ! python3 - "$TICKETS" "$BDD" <<'PY'
import re, sys, pathlib, collections

tickets, feature = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
names = [
    line.strip()[len("Scenario: ") :]
    for line in feature.read_text().splitlines()
    if line.startswith("  Scenario: ")
]

owner = collections.defaultdict(list)
italics = collections.defaultdict(list)
for path in sorted(tickets.glob("AWCLI-*.md")):
    # findall, not search: a ticket should have one Acceptance Criteria section, and reading only
    # the first would make the criteria of a malformed ticket that has two invisible here.
    for section in re.findall(
        r"^## Acceptance Criteria\s*$(.*?)(?=^## |\Z)", path.read_text(), re.M | re.S
    ):
        # Criteria are hard-wrapped, so a scenario name can straddle a line break.
        unwrapped = re.sub(r"\n\s+", " ", section)
        for italic in re.findall(r"(?<!\*)\*([^*\n][^*]*)\*(?!\*)", unwrapped):
            italics[path.name].append(italic.strip())

broken = 0
for ticket, found in italics.items():
    for italic in found:
        if italic in names:
            owner[italic].append(ticket)

for name in names:
    carried = owner.get(name, [])
    if len(carried) != 1:
        print(f"FAIL: 4  scenario carried by {len(carried)} tickets {carried}: {name!r}",
              file=sys.stderr)
        broken = 1

known = set(names)
for ticket, found in italics.items():
    for italic in found:
        if italic not in known:
            print(f"FAIL: 4  {ticket} italic criterion is not a verbatim scenario name: "
                  f"{italic!r}", file=sys.stderr)
            broken = 1

if not broken:
    print(f"  ok: 4  {len(names)} scenarios, each an italic criterion on exactly one ticket")
sys.exit(broken)
PY
then
  fail=1
fi

# --- 5. The README's totals match the tickets on disk ------------------------------------------
disk_tickets="$(find "$TICKETS" -maxdepth 1 -name 'AWCLI-*.md' | wc -l | tr -d ' ')"
disk_points="$(grep -hoE '^\*\*Points:\*\* [0-9]+' "$TICKETS"/AWCLI-*.md |
  grep -oE '[0-9]+' | awk '{ total += $1 } END { print total + 0 }')"

# One sentence carries both numbers, so both are read out of the same match. Two independent greps
# could disagree about which line they found, and `bc` is one dependency this needs less than awk.
readme_totals='^[0-9]+ tickets, [0-9]+ points'
readme_tickets="$(sole_number "$readme_totals" "$README" head)"
readme_points="$(sole_number "$readme_totals" "$README" tail)"
table_rows="$(grep -cE '^\| \[AWCLI-[0-9]+\]' "$README")"
same "5a README ticket count == tickets on disk" "$readme_tickets" "$disk_tickets"
same "5b README points total == sum of ticket Points" "$readme_points" "$disk_points"
same "5c README table rows == tickets on disk" "$table_rows" "$disk_tickets"

# --- 6. The manifest's ticket list matches the tickets on disk ---------------------------------
manifest_ids="$(grep -oE '^  - id: AWCLI-[0-9]+' "$MANIFEST" | awk '{ print $3 }' | sort)"
disk_ids="$(find "$TICKETS" -maxdepth 1 -name 'AWCLI-*.md' -exec basename {} \; |
  grep -oE '^AWCLI-[0-9]+' | sort)"
if [ "$manifest_ids" = "$disk_ids" ]; then
  ok "6a manifest ticket ids == tickets on disk ($(printf '%s\n' "$manifest_ids" | wc -l |
    tr -d ' '))"
else
  bad "6a manifest ticket ids differ from disk"
  diff <(printf '%s\n' "$manifest_ids") <(printf '%s\n' "$disk_ids") >&2 || true
fi

# A manifest entry is a promise that a document exists. An id that matches while its path does not
# resolve is the same broken reference, one level down.
missing_paths=0
while read -r path; do
  [ -n "$path" ] || continue
  if [ ! -f ".atelier/$path" ]; then
    bad "6b manifest path is not on disk: $path"
    missing_paths=1
  fi
done < <(grep -oE '^    path: tickets/.*\.md$' "$MANIFEST" | awk '{ print $2 }')
[ "$missing_paths" -eq 0 ] && ok "6b every manifest ticket path exists on disk"

# --- 7. Every @BR tag in the feature file names a rule that exists -----------------------------
# The direction that catches a renumbered rule. A scenario tagged @BR-041 reads as governed by
# something and is governed by nothing.
unknown_tags=0
while read -r tag; do
  [ -n "$tag" ] || continue
  if ! grep -qE "^#{2,3} ${tag#@} " "$RULES"; then
    bad "7  $tag is tagged in the feature file but no such rule exists"
    unknown_tags=1
  fi
done < <(grep -oE '@BR-[0-9]+' "$BDD" | sort -u)
distinct_tags="$(grep -oE '@BR-[0-9]+' "$BDD" | sort -u | wc -l | tr -d ' ')"
[ "$unknown_tags" -eq 0 ] && ok "7  all $distinct_tags distinct @BR tags name existing rules"

# --- 8. Every rule is exercised by at least one scenario (informational) ------------------------
# Deliberately not a failure. A rule with no scenario cannot give a ticket approved criteria, which
# is the exact gap BR-038, BR-039 and BR-040 were written to close — but whether an untagged rule is
# a hole or a rule that needs no scenario is a judgement for the specifier, not arithmetic. It is
# reported either way so the answer is never simply unknown.
untagged=0
while read -r rule; do
  [ -n "$rule" ] || continue
  if ! grep -q "@$rule\$" "$BDD"; then
    printf 'note: 8  %s has no scenario tagged to it\n' "$rule"
    untagged=$((untagged + 1))
  fi
done < <(grep -oE '^#{2,3} BR-[0-9]+' "$RULES" | grep -oE 'BR-[0-9]+')
[ "$untagged" -eq 0 ] && ok "8  every rule has at least one scenario tagged to it"

# --- 9. Every DELIVERED_BY id names a ticket, and one the work breakdown agrees with ------------
# The only check here that reads source rather than specification, and it is here because this is
# the one number in the corpus that has shipped wrong on a branch that looked finished. DELIVERED_BY
# in src/runtime/context.ts says, for each declared-but-unbuilt context member, which unit delivers
# it — the pointer the amendments call authoritative — and until now nothing read it. `git` moved
# twice inside PR #15: to AWCLI-11, which owns WB-7 and no part of the member, and then to AWCLI-14.
# Both values named a ticket that exists, so existence alone would have caught neither.
#
# What decides it is the work breakdown. The TDD's Contracts column assigns a member to a unit, and
# a ticket's `**Source:**` line names the unit it came from, so a member whose id points outside its
# own unit is a mismatch with teeth: it is what makes AWCLI-11 (WB-7) wrong for `ctx.git` (WB-8).
#
# Be clear about what it does not catch. The first wrong value, AWCLI-13, is inside WB-8 — it is the
# other half of a split unit, and the work breakdown cannot see a split it predates. Nothing
# arithmetic can decide which half of a split owns a member; that is what a ticket's own scope text
# is for. This check catches the id that left its unit, which is the failure that reached a commit.
if ! python3 - "$CONTEXT" "$TDD" "$TICKETS" <<'DELIVERED_BY_PY'
import pathlib, re, sys

context, tdd, tickets = (pathlib.Path(a) for a in sys.argv[1:4])

# The DELIVERED_BY object literal, and only it: `member: "AWCLI-nn"` lines between the opening
# brace and the `as const` that closes it.
body = re.search(r"const DELIVERED_BY = \{(.*?)\n\} as const", context.read_text(), re.S)
if not body:
    print(f"FAIL: 9  DELIVERED_BY is not in the shape this check reads — renamed or reformatted "
          f"in {context}", file=sys.stderr)
    sys.exit(1)
delivered = dict(re.findall(r'^\s*(\w+):\s*"(AWCLI-\d+)"', body.group(1), re.M))

# `ctx.<member>` anywhere in a unit's Contracts line assigns the member to that unit. A member may
# legitimately be named by more than one, so this is a set and not a single answer.
assigned = {}
unit = None
for line in tdd.read_text().splitlines():
    heading = re.match(r"^### (WB-\d+):", line)
    if heading:
        unit = heading.group(1)
    elif unit and line.startswith("- **Contracts:**"):
        for member in re.findall(r"`ctx\.(\w+)", line):
            assigned.setdefault(member, set()).add(unit)

# `ctx.schema` is the one place this table and the TDD knowingly disagree, and the disagreement is
# argued at length above DELIVERED_BY: SchemaApi declares only storable(), which answers BR-008's
# question about shared state, and AWCLI-09 is the unit that has to answer it anyway — so the code
# side stands and WB-10's Contracts line is the side that needs correcting. Named here rather than
# silently skipped, so that settling the disagreement means deleting this line.
KNOWN_DISAGREEMENT = {"schema": "WB-10 names ctx.schema; the code side stands — see context.ts"}

broken = 0
for member, ticket_id in sorted(delivered.items()):
    found = sorted(tickets.glob(f"{ticket_id}-*.md"))
    if not found:
        print(f"FAIL: 9  DELIVERED_BY.{member} names {ticket_id}, which is not a ticket on disk",
              file=sys.stderr)
        broken = 1
        continue
    units = assigned.get(member)
    if not units:
        print(f"note: 9  the work breakdown assigns ctx.{member} to no unit, so {ticket_id} "
              f"cannot be checked against it")
        continue
    if member in KNOWN_DISAGREEMENT:
        print(f"note: 9  ctx.{member} -> {ticket_id} is the recorded disagreement "
              f"({KNOWN_DISAGREEMENT[member]})")
        continue
    source = re.search(r"\*\*Source:\*\*\s*(WB-\d+)", found[0].read_text())
    named = ", ".join(sorted(units))
    if source is None:
        print(f"FAIL: 9  {ticket_id} has no **Source:** line, so DELIVERED_BY.{member} cannot be "
              f"checked against the work breakdown, which assigns ctx.{member} to {named}",
              file=sys.stderr)
        broken = 1
    elif source.group(1) not in units:
        print(f"FAIL: 9  DELIVERED_BY.{member} names {ticket_id}, which is {source.group(1)}; "
              f"the work breakdown assigns ctx.{member} to {named}", file=sys.stderr)
        broken = 1

if not broken:
    print(f"  ok: 9  {len(delivered)} DELIVERED_BY ids name a ticket, each from the unit the "
          f"work breakdown assigns the member to")
sys.exit(broken)
DELIVERED_BY_PY
then
  fail=1
fi

# --- 10. The manifest's own freshness stamp is not behind its contents --------------------------
# `metadata.updated` exists so a reader can tell whether the manifest has been reconciled with a
# given round of work, and it has now drifted behind its own contents twice — the 2026-08-25
# amendment row records the first as a finding that was fixed, and PR #15 changed a status and a
# points value in this file without moving it again. Author date rather than commit date, so a
# rebase that changes nothing about the file does not fail this.
manifest_updated="$(sole_match '^  updated: "[0-9]{4}-[0-9]{2}-[0-9]{2}' "$MANIFEST" |
  grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  printf 'note: 10 not a git checkout, so the manifest freshness stamp cannot be checked\n'
elif [ -z "$manifest_updated" ]; then
  bad "10 manifest metadata.updated is missing, duplicated, or not a plain date"
else
  if git diff --quiet -- "$MANIFEST" && git diff --cached --quiet -- "$MANIFEST"; then
    manifest_touched="$(git log -1 --format=%as -- "$MANIFEST")"
    touched_by="its last commit"
  else
    # Uncommitted changes are the moment the stamp is meant to move, and a change being made now is
    # being made today.
    manifest_touched="$(date -u +%Y-%m-%d)"
    touched_by="uncommitted changes"
  fi
  if [ -z "$manifest_touched" ]; then
    printf 'note: 10 the manifest has no commit history here, so its stamp cannot be checked\n'
  elif [[ "$manifest_updated" < "$manifest_touched" ]]; then
    bad "10 manifest metadata.updated ($manifest_updated) is behind $touched_by ($manifest_touched)"
  else
    ok "10 manifest metadata.updated ($manifest_updated) is not behind $touched_by"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS: the rules file, the feature file, the manifest and the ticket README describe one"
  echo "      corpus — $rule_headings rules, and $bdd_scenarios scenarios each owned by exactly"
  echo "      one of $disk_tickets tickets — and the work breakdown, the DELIVERED_BY table and the"
  echo "      manifest's own stamp agree with them"
  exit 0
fi
echo "FAIL: the specification's documents disagree — see the failures above" >&2
exit 1
