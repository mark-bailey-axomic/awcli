---
feature: agentic-workflow-cli
artifact: business-rules
status: Amended since approval — amendments pending PM re-approval
approved: 2026-08-24
approved_baseline: 37 rules
amended: 2026-08-26
amended_in: PR #8 (AWCLI-01) review rounds 2, 3 and 4
approved_unchanged: 31 rules
pending_reapproval: 9 rules (BR-038, BR-039, BR-040 added; BR-006, BR-008, BR-012, BR-014, BR-025, BR-028 rewritten)
date: 2026-08-24
source: .atelier/context/agentic-workflow-cli-prd-draft.md
rules: 40
---

# awcli — Business Rules

## Actors

Four actors appear throughout. Two of them have *permissions*, which is what makes several of these
rules genuine authorization rules rather than validation.

| Actor | Who / what | Notes |
|---|---|---|
| **Operator** | The person invoking `awcli` from a terminal or a scheduler | The only actor who can approve, interrupt, or override |
| **Workflow** | The operator's own TypeScript file, executing | A first-class actor with *scoped* permissions — what it may do depends on where in its own execution it is |
| **Agent** | The AI coding tool running as a subprocess | Untrusted with respect to output shape; trusted with the repo it was given |
| **awcli** | The system enforcing these rules | Owns the loop, the locks, the isolation, and the record |

There is no multi-user authorization model: a single operator owns every run. The interesting
permission boundary is *inside* the workflow (body versus fan-out scope), not between people.

---

## Category 1 — Environment preconditions

Every rule here is a refusal *before any side effect occurs*. Nothing is created, no agent is
started, no container is built until all four pass.

### BR-001 — Unsupported platform is refused, with a route forward
**Statement.** awcli refuses to run on native Windows, and the refusal names WSL2 as the supported
Windows path.
**Rationale.** Path translation, file ownership, and process termination all behave differently
there; failing at startup with a route forward beats failing later inside a container mount.
**Actors.** Operator.
**Exceptions.** None.
**Example.** On Windows: *"awcli does not run on native Windows. Install and run it inside WSL2, keeping
your clones in the WSL2 filesystem."*

### BR-002 — A target must be a git repository
**Statement.** awcli refuses to run against a directory that is not a git repository, suggesting
`git init`.
**Rationale.** Isolation and "what did this run change?" are both promises that only git can keep.
**Actors.** Operator.
**Exceptions.** None. There is no reduced-isolation fallback.
**Example.** Pointing a run at `~/scratch` (no git) refuses; after `git init` it proceeds.

### BR-003 — The repo's required version range must include the running awcli
**Statement.** A project declares a version range; awcli refuses to run when its own version falls
outside it, naming the required range and its own version.
**Rationale.** Workflows are committed code calling a contract. A too-old binary must fail as a
sentence, not as a missing method deep in iteration seven.
**Actors.** Operator.
**Exceptions.** A project that declares no range accepts any version.
**Example.** Range `>=0.6 <2` with binary `0.4.1` refuses; with `1.9.0` it runs.

### BR-004 — A requested container is never silently downgraded
**Statement.** When a workflow explicitly asks for a container and container support is unavailable,
the run fails with a clear message. awcli never silently substitutes weaker isolation.
**Rationale.** The operator asked for a boundary. Quietly running without it is the one failure mode
that could damage something outside the repo.
**Actors.** Operator, Workflow.
**Exceptions.** A workflow that never asks for a container is unaffected — the default path needs no
container support at all.
**Example.** `sandbox()` on a machine without Docker fails; the same workflow's non-container agent
calls would have run fine.

---

## Category 2 — Validation

### BR-005 — A workflow file must export a callable default
**Statement.** awcli refuses a workflow file with no default export, or whose default export is not a
function, before creating any run state.
**Rationale.** The contract is the entry point; a missing one is a typo, not a run.
**Actors.** Operator.
**Exceptions.** None.

### BR-006 — Declared profile fields are required; everything else is free-form
**Statement.** Every profile field awcli defines is required in a repository's configuration. The gate
chain refuses the run at startup, naming each field the configuration lacks, before the lock or any
working copy — whether or not a workflow would have read it. Values in the profile's free-form area
carry no such guarantee.
**Rationale.** Portable workflows depend on a small, dependable set of facts; anything beyond it is
the operator's own convention and cannot be validated.
**Actors.** Operator, Workflow.
**Exceptions.** Free-form values are returned as-is or absent.
**Example.** A repo that declares no test command is refused at startup naming `commands.test` — not
mid-loop, and not only when some workflow happens to read it.

### BR-007 — A structured-output request must be asked for in the prompt
**Statement.** When a workflow requests tagged output, awcli verifies the resolved prompt actually
asks the agent for that tag, and refuses at startup if it does not.
**Rationale.** Otherwise the agent is guaranteed to fail a check nobody told it about, after doing
all the work.
**Actors.** Workflow.
**Exceptions.** None.

### BR-008 — Shared state must be storable, and each surface is checked where its value lands
**Statement.** A value the workflow puts into shared state must be storable as plain data. A value
that cannot be stored is rejected at the moment it is set, naming the offending key. The same
requirement holds for a value the workflow logs, and it is checked in a different place and answered
differently: a log field is checked as the line is written down, and a field that cannot be written
down is recorded as unrepresentable — the line is still written, that field is named, and the run
does not fail for it.
**Rationale.** State crosses iterations and process restarts; a live handle cannot. Failing at the
assignment points at the line that caused it. A log field reaches disk too, so the same requirement
applies to it — but a log is the record of what happened, and refusing to keep one is worse than
keeping it with a named hole in it, which is why this is the one place the requirement degrades
rather than refuses. Refusing a log field where it is passed would also refuse awcli's own values: a
command's result, a commit, the run's arguments are all shapes awcli hands the workflow, and none of
them can be logged under a check that admits only plain data written out by hand. A check that makes
the ordinary case impossible is not paid for by what it catches.
**Actors.** Workflow, awcli.
**Exceptions.** A log field may be absent where a state value may not: the most ordinary thing to log
is a number the agent never reported or an argument nobody passed, and refusing those buys nothing.
And because a log field is not decided until the line is written, a workflow that wants to know
sooner asks awcli whether a value is storable and decides for itself.
**Example.** A workflow assigning a live handle into shared state is refused at that line, naming the
key. The same handle passed as a log field leaves one field marked unrepresentable in an otherwise
complete log line, and the run continues.

### BR-009 — A declared state shape is checked on load
**Statement.** When a workflow declares the shape of its shared state, awcli validates the stored
state against it on load, and on mismatch refuses to start — reporting what failed and offering to
reset.
**Rationale.** State outlives the code that wrote it. A renamed field should surface at startup, not
as an undefined value hours in.
**Actors.** Operator, Workflow.
**Exceptions.** A workflow declaring no shape gets no validation.

---

## Category 3 — Concurrency and permission

### BR-010 — One run per name
**Statement.** While a named run holds its lock, a second run of the same name is refused, naming
the holder.
**Rationale.** Same name means same state, same worktrees, same containers. Interleaving them
corrupts all three silently.
**Actors.** Operator.
**Exceptions.** None.
**Example.** A scheduled run firing while the operator tests the same workflow is refused, not
interleaved.

### BR-011 — Differently-named runs coexist
**Statement.** Runs with different names may execute concurrently against the same repository.
**Rationale.** Fan-out across workflows is a legitimate pattern; the name is the isolation key.
**Actors.** Operator.
**Exceptions.** They still contend for the machine's resources; awcli does not schedule them.

### BR-035 — A lock outliving its owner is reclaimed automatically
**Statement.** A run's lock records which process holds it and when that process started. A lock
whose owner no longer exists is stale: the next run reclaims it automatically and says so in its
output.
**Rationale.** A hard kill or a power loss must not render a run name permanently unusable — for a
scheduled run, that failure would go unnoticed for days.
**Actors.** Operator, awcli.
**Exceptions.** A lock whose owner is alive is never reclaimed, however long it has been held: a slow
run is still a running run.
**Example.** A nightly run is killed by a reboot; the next night's run reclaims the lock, noting that
it did so.

### BR-012 — Only the workflow body may write shared state, and not while its own agents are running
**Statement.** Shared state is writable from the workflow's body, and only while that body has no
agent call of its own still running. A `sandbox()` scope hands back a context whose state cannot be
written at all. A write made while agents this body started are still in flight — which is what a
write from inside a parallel branch is — is refused immediately, naming the pattern to use instead:
let the branch return its result, and record it once it has.
**Rationale.** This is the single-writer guarantee made enforceable, and it takes two mechanisms
because the contract gives the two scopes different shapes. `sandbox()` returns a scope, so its
read-only state is structural from the contract onwards and a write there does not compile.
`agent()` returns a result rather than a scope, so a fan-out branch is the body's own code holding
the body's own context: there is nothing there to freeze, and a branch write cannot be told from a
body write by who made it. A rule that named an agent scope would name something the contract does
not give. What does tell them apart is *when* — awcli owns the loop (BR-017) and therefore knows
which agent calls are outstanding, so the in-flight window is a test it can actually apply. AWCLI-10
builds it. A lost update inside a fan-out is invisible and surfaces as inexplicably-wrong state
hours later, which is why an enforceable approximation beats an unenforceable exactness.
**Actors.** Workflow.
**Exceptions.** The window is deliberately blunt: a body write while any agent call it started is
still running is refused even when nothing was fanning out and the write would have been safe. A
refusal naming the pattern costs a line of rewriting; a lost update costs a night. Reads are never
refused — the window closes writes only. Results travel out of a branch as return values, and the
body records them once the branch has returned.
**Example.** Four parallel branches each try to append their result to shared state: each is refused
at once with the pattern to use instead, and the body records all four after awaiting them.

### BR-013 — Parallel agents never share a working copy
**Statement.** Concurrently-running agents each receive their own working copy on their own branch.
**Rationale.** Two agents editing one tree silently overwrite each other, and neither result is
trustworthy.
**Actors.** awcli, Agent.
**Exceptions.** None.

---

## Category 4 — Isolation and safety

### BR-014 — The default is an isolated working copy, never the live tree
**Statement.** With no isolation requested, an agent works in a fresh working copy on its own branch.
Operating on the operator's live checkout requires an explicit opt-in from the operator on the
command line. A workflow cannot request it, and nothing a workflow passes selects the workspace.
**Rationale.** An unattended loop must never be able to damage uncommitted work or move the
operator's branch. The person whose uncommitted work is at stake is the one who has to ask — and
keeping the choice off the workflow's surface is what keeps one workflow file portable across both
modes.
**Actors.** Operator, awcli, Agent.
**Exceptions.** The operator's explicit opt-in on the command line.

### BR-036 — Branches are named predictably, kept by default, and collected on request
**Statement.** Each working copy's branch is named from its run and its slot within that run, so
resuming a run reattaches the branch it already had. awcli never deletes a branch automatically. A
collect operation reclaims branches whose working copies are gone and which are either merged or
empty.
**Rationale.** Deterministic naming is what makes resumption possible at all. And the agent's commits
are the deliverable — the run that went perfectly is precisely the one whose branches the operator
wants to read.
**Actors.** Operator, awcli.
**Exceptions.** Collection never touches a branch carrying unmerged commits.
**Example.** Resuming the "triage" run reattaches its existing branch rather than opening a second
one; a month of nightly runs is tidied with one collect.

### BR-015 — "Sandbox" means container, and isolation is stated at runtime
**Statement.** The word *sandbox* refers only to the container path, in the API, help text, docs, and
logs. The default path is called a *worktree*. Every agent call states its isolation level as it
runs.
**Rationale.** Working-copy isolation protects the repository, not the machine. Calling it a sandbox
invites the operator to assume a boundary that does not exist.
**Actors.** Operator.
**Exceptions.** None.
**Example.** A log line reads *"isolation: worktree — host filesystem and network reachable"*.

### BR-038 — File access resolves within the working copy's tree, and anything else is refused
**Statement.** A path the workflow reads or writes resolves against the working copy the iteration is
operating in, never against the directory awcli was started from. What it may resolve to is that
working copy's *tree* and not its git administrative area — the `.git` directory in a live checkout,
the `.git` pointer file in a worktree — which lies inside the working copy and is refused anyway. A
path that leaves the tree, by climbing out of it, by being given from the root of the machine, or by
following a link whose target is outside it, is refused on the same terms: naming the offending path
and saying where it went, rather than resolved.
**Rationale.** This is hygiene, not a boundary. Only a container is a boundary (BR-015), and reaching
outside the working copy deliberately is what running a command is for (BR-040). The refusal exists
so that a mistyped `../` fails loudly instead of silently reading or writing a file nobody scoped
for this run — the same uncommitted work BR-014 keeps an agent out of by default. The administrative
area is carved out for that reason and no stronger one: a hook written there is run by the next
commit awcli makes, and on the worktree default the `.git` entry is a single line naming which
repository this working copy belongs to, so writing it repoints the working copy at a different
repository without any path having left anything. Both are ways for a careless path to reach past
the run while appearing to have stayed inside it.
**Actors.** Workflow, awcli.
**Exceptions.** None. An escape is never quietly clamped to the working copy root: a path that
resolved to something other than what the workflow asked for is worse than a refusal. And the
carve-out is not a boundary around the administrative area — a command the workflow runs may still
write anything there, on BR-040's terms.
**Example.** A workflow reading `notes.md` reads the one in its own working copy; the same workflow
reading `../notes.md` is refused, naming the path, and writing a commit hook into the working copy's
own git administrative area is refused too — while a command it runs may still read or write
anything on the machine.

### BR-016 — Credentials are lent, never copied
**Statement.** Agent credentials reach a container as a read-only mount for the life of the run, and
are never written into an image.
**Rationale.** An image outlives the run and can be shared or pushed; a mount cannot.
**Actors.** awcli.
**Exceptions.** None.

### BR-039 — The environment answers one name at a time, and answers as unset for what awcli set
**Statement.** awcli sets variables of its own for some runs — the agent credentials it lends a
container being the ones that matter (BR-016). The workflow is not handed the environment as a
collection. It asks by name: whether a name is set, and what that name holds. Exactly the variables
awcli set for *this* run answer as not set, and nothing else does. The test is what awcli set for
this run, which awcli knows at the moment it sets it, so membership is decidable and no judgement
about what looks like a credential enters into it. Every name the operator's own environment already
carried answers with its value — including an agent API key the operator set themselves, which awcli
did not supply and does not withhold. On the host execution target awcli often sets nothing at all,
so the set that answers as unset may be empty, and every name then answers exactly as the operator's
own environment holds it. A name awcli withheld is indistinguishable from one that was never set.
**Rationale.** The reason to withhold anything is BR-016: what awcli sets for the run is lent for the
life of the run and never copied, and answering with it would copy it into every prompt and every run
record that reads the answer. But "the credentials awcli supplies" cannot be the test, because an
inherited key and a lent key are the same name — a rule stated that way does not decide the one case
it exists for. "What awcli set for this run" does decide it, and it is the only version awcli can
actually apply.
Asking by name rather than being handed a collection is the other half, and it is about what the
easy thing to write is. What survives the subtraction is the operator's own environment, which may
hold secrets of its own that awcli neither set nor knows about — so the shape that matters is the one
where reading a known variable is one call and forwarding everything is not available at all. Given
the whole environment in hand, writing it into a prompt or a log line is a single expression and
nothing about it looks wrong; a rule can advise against that and be ignored by every workflow nobody
reviewed. An accessor makes bulk forwarding something a workflow has to set out to do, name by name.
**Actors.** awcli, Workflow.
**Exceptions.** None to the subtraction, but it is hygiene, not a control, and four things remain
true beside it. The set may be empty — on the host target usually is — and an empty subtraction is
still the rule satisfied, not a failure to apply it; awcli claims nothing was withheld when nothing
was. Asking by name discourages bulk forwarding and prevents nothing: a workflow that names the
variables it wants can still forward every one of them, and awcli does not describe the accessor as
protection. A command the workflow runs sees the environment its execution target actually has,
credentials included; nothing is removed from the machine (BR-040). And subtraction is not redaction:
this withholds what awcli set by construction, whereas redacting values that match known secret
shapes is a net cast over values wherever they are written — a separate mechanism no rule here
states, carried by the logging work behind BR-025 and BR-028 (AWCLI-21).
**Example.** A container run lends the agent a credential under a name awcli sets; a workflow asking
for that name is told it is not set, asking for its project's own variables gets their values, and
asking for the API key the operator had set in their own shell gets it. The same workflow on the host
target gets, for every name it asks, exactly what the environment it was started from held. Neither
workflow can ask for the environment itself.

### BR-040 — On the host target a command runs with the operator's own reach, and awcli says so
**Statement.** The default execution target is the machine awcli is running on. A command the
workflow runs there — including a command the repository itself declares — runs as the operator,
with the operator's own reach: the filesystem beyond the working copy, the network, and whatever
credentials that machine holds. awcli names the target a command actually ran on and never
describes the default one as containment. Asking for a container is the only thing that changes
what a command can reach (BR-004, BR-015). Giving a command as a list of arguments settles which
fragment of it can rewrite it — each element stays one argument however it is spelled — and settles
nothing at all about its reach.
**Rationale.** Working-copy confinement (BR-038) is hygiene over the paths a workflow names; it says
nothing about what a command does once it is running, and reaching past the working copy on purpose
is what running a command is for. A repository's declared command is the sharpest case: it is
untrusted whole and its first word is the binary to run, so no way of passing it holds it back.
Saying that plainly is the only thing that stops an operator inferring a boundary from a
confinement that is not one — the same honesty BR-015 buys by refusing to call a worktree a
sandbox.
**Actors.** Operator, Workflow, awcli.
**Exceptions.** None to the reach on this target. A workflow may bound how *long* a command runs,
never what it may touch; only a container narrows that, and BR-004 forbids granting a container
request quietly weaker than it was asked.
**Example.** A run's output reads *"exec: host — the wider filesystem, the network and this machine's
credentials are reachable"*, and the repository's declared test command runs on exactly those terms.
The same call made inside a container reports the container instead.

---

## Category 5 — Execution and termination

### BR-017 — awcli owns iteration; the workflow is invoked once per pass
**Statement.** The operator sets the iteration count; awcli calls the workflow once per iteration,
carrying shared state across passes.
**Rationale.** Loop ownership is what makes durability, resumption, and per-iteration limits possible
at all.
**Actors.** Operator, Workflow.
**Exceptions.** A workflow may still loop internally; that is invisible to awcli.

### BR-018 — Four ways to end, and the workflow says which of them counts as finished
**Statement.** A run ends on: the workflow declaring itself done, the iteration count being reached,
the time limit being reached, or a precondition failure. Whichever occurs first ends the run. A
workflow **declares** whether exhausting its limits is expected completion or an incomplete run;
absent a declaration, exhausting a limit is reported as **incomplete**.
**Rationale.** Both readings are legitimate and they belong to different kinds of workflow. Finite
work that runs out of iterations has not finished; a monitor loop that runs its allotted time has.
Only the workflow's author knows which it is, so the author declares it — and the safer reading is
the default, so a silent workflow errs toward alerting rather than toward quiet.
**Actors.** Operator, Workflow.
**Exceptions.** The declaration is made at the workflow's top level, not through the context — the
context contract does not grow to carry it.
**Example.** Ten iterations requested, workflow declares done at four → finished. Ten requested and
ten consumed, no declaration → incomplete. Same run from a workflow declaring limit-exhaustion
expected → finished.

### BR-037 — Declaring done waits for work already in flight
**Statement.** When a workflow declares itself done while agents it started are still running, those
agents are allowed to finish so their commits land intact. Their results are discarded — the
workflow has already decided.
**Rationale.** An agent killed mid-edit leaves a branch that looks finished and is not, and the
operator only discovers it on review. The operator retains an immediate stop by interrupting the run,
so the conservative default costs nothing in urgency.
**Actors.** Workflow, Agent, Operator.
**Exceptions.** An interrupt (BR-021) stops them at once; that is a deliberate operator choice, not
the default.
**Example.** A workflow finds what it needed after one of four branches reports; the other three
finish and commit, then the run ends as finished.

### BR-019 — One failed iteration does not end the run
**Statement.** A failed iteration is recorded and the loop continues. The run reports failure overall
only when every iteration failed.
**Rationale.** Agents fail transiently. An overnight run that stops at the first stumble wastes the
night.
**Actors.** Operator.
**Exceptions.** Precondition failures (Category 1) end the run immediately — they will not improve on
retry.

### BR-020 — Invalid structured output costs an iteration, not the run
**Statement.** When tagged output fails validation, awcli makes a bounded, deliberately narrow
re-ask that changes nothing and asks only for a corrected block. If that also fails, the iteration
fails and the loop continues.
**Rationale.** The agent's actual work is already committed to its working copy, so a malformed block
costs a decision, not the work.
**Actors.** Agent, Workflow.
**Exceptions.** None.

### BR-021 — An interrupt always releases the lock and always preserves the work
**Statement.** On interruption awcli stops the agents, removes containers it created, leaves working
copies on disk for inspection, and releases the run's lock.
**Rationale.** A held lock after a Ctrl-C makes the next run impossible; a deleted working copy
destroys evidence of what went wrong.
**Actors.** Operator.
**Exceptions.** None. A reclaim command exists for what is deliberately left behind.

### BR-022 — Silence fails; finished-but-lingering does not
**Statement.** An agent producing no output for the idle limit fails its iteration. An agent that has
signalled completion but not exited is allowed a grace window and then treated as successful.
**Rationale.** These look identical from outside and must not be treated identically: one is stuck,
the other is done and holding a pipe open.
**Actors.** Agent.
**Exceptions.** None.

---

## Category 6 — Durability and resumption

### BR-023 — State is durable as it changes
**Statement.** Shared state is written to durable storage as the workflow changes it, not only at
iteration boundaries, and always in a way that cannot leave a partly-written record.
**Rationale.** A crash forty minutes into an iteration must not discard everything the workflow
recorded during it.
**Actors.** Workflow, awcli.
**Exceptions.** None. Resumed workflows may therefore observe mid-iteration state and must tolerate
it.

### BR-024 — A run owns its state and its working copies as one unit
**Statement.** Resuming a run restores both its shared state and its working copies. Starting fresh
discards both together. A resumed run reports the working copy's position and any uncommitted files
it inherited.
**Rationale.** Two different notions of "what carried over" is how an operator ends up debugging a
mystery. One unit, reported plainly.
**Actors.** Operator.
**Exceptions.** None.
**Example.** *"Resuming at iteration 5. Working copy at abc123 with 3 uncommitted files from
iteration 4."*

---

## Category 7 — Observability and attribution

### BR-025 — Every run is attributable, and the workflow cannot replace what writes the record
**Statement.** Each run's record and log header states the awcli version, the agent tool's version,
and the repository position it started from. What writes that record is not the workflow's to
substitute: every function awcli hands the workflow — the logging calls among them — is fixed at the
moment the workflow receives it, so assigning over one is refused rather than taken.
**Rationale.** An unattended failure discovered the next morning must be explicable without guesswork
about what was installed. But the record is written through functions the workflow is holding, and a
workflow is the operator's own TypeScript with its own imports. If those functions were assignable,
a workflow — or a module it imported without reading — could put its own function over the one that
writes the log, and the run would agree with itself while recording nothing. A record its own
subject can rewrite is not attribution. The same fixity is what stops a `sandbox()` scope's members
being swapped for the body's after the scope has been made: the working copy a path resolves against
(BR-038) and the target a command runs on (BR-040) are settled when the scope is constructed, and a
call that reports the wrong one is worse than a call that refuses.
**Actors.** Operator, Workflow, awcli.
**Exceptions.** This is hygiene against accident and against a careless import, not a boundary. A
workflow runs in the same process as awcli, so a workflow whose author sets out to defeat its own
audit trail can: nothing here makes the record proof against the person who wrote the workflow, and
it is not offered as a control over one. Only a container is a boundary (BR-015). What it does buy is
that no member is ever replaced by accident, or as the side effect of an import nobody read.
**Example.** A workflow that assigns its own function over the one awcli gave it to log with is
refused at that assignment, and the run's record still states the versions and the repository
position it started from.

### BR-026 — Optional detail degrades loudly, exactly once
**Statement.** When awcli cannot interpret an agent's detailed output, it warns once and continues
with that detail marked unknown. It never fails a run for this reason, and never degrades in silence.
**Rationale.** The detail is a convenience; the run is not. But silent degradation turns a
five-minute diagnosis into an afternoon.
**Actors.** Operator.
**Exceptions.** None.

### BR-027 — Spend is reported, and an unmeasurable spend says so
**Statement.** awcli reports per-iteration and cumulative spend, and warns when cumulative spend
crosses a configured threshold. When spend cannot be measured, it states this once at startup rather
than leaving the operator believing a threshold is active.
**Rationale.** A threshold that can never fire is worse than no threshold, because it is trusted.
**Actors.** Operator.
**Exceptions.** No spend ceiling is enforced; the time limit is the enforceable bound.

### BR-028 — Every agent has its own log; the terminal stays readable
**Statement.** Each agent's full output goes to its own log file; the terminal carries a compact
summary.
**Rationale.** Four parallel agents interleaved on one terminal is unreadable, and the detail is
exactly what is needed after the fact.
**Actors.** Operator.
**Exceptions.** None to the per-agent log itself. A field awcli cannot write down costs that field
and not the line or the run (BR-008), and the calls that write the log are not the workflow's to
replace (BR-025).

---

## Category 8 — Workspace hygiene and portability

### BR-029 — The workflow library stays portable
**Statement.** The operator's global workflow library contains workflows only. awcli never writes
machine-local state, caches, or logs into it.
**Rationale.** The operator works from more than one machine and syncs that directory themselves. It
has to stay clean enough to commit.
**Actors.** awcli, Operator.
**Exceptions.** None.

### BR-030 — All mutable run data lives under one path
**Statement.** Working copies, logs, state, and locks all live beneath a single runtime directory, so
the generated ignore entry is one line written once. awcli never modifies that ignore file again, and
never adds the operator's committed artifacts to it.
**Rationale.** One ignored path means a later version can add runtime data without touching a file
the operator now owns.
**Actors.** awcli, Operator.
**Exceptions.** None.

### BR-031 — A project's workflow wins; an explicit path always wins
**Statement.** A workflow named on the command line resolves against the project first, then the
global library. A path is always honoured as given.
**Rationale.** Per-project customisation must be able to shadow a shared workflow without renaming
it.
**Actors.** Operator.
**Exceptions.** None.

### BR-032 — A target repository needs nothing installed
**Statement.** Running a workflow requires no package manifest, no installed dependencies, and no
particular language in the target repository.
**Rationale.** This is the whole reason the context is injected rather than imported; repos in any
language are valid targets.
**Actors.** Operator.
**Exceptions.** A workflow that chooses to import third-party code takes on that requirement itself,
unsupported.

---

## Category 9 — Contract discipline

### BR-033 — The context contract is frozen before what implements it
**Statement.** The context's declared surface is fixed as an artifact before the machinery behind it
is built, and additions to it are additive.
**Rationale.** The context is the entire API and the operator's workflows are committed code. A
contract settled late is a contract broken often.
**Actors.** awcli.
**Exceptions.** None before first release.

### BR-034 — A rehearsal never touches real run data
**Statement.** A rehearsal run (no real agent) produces results shaped exactly like real ones,
but under its own run identity — it never reads or writes the real run's stored state.
**Rationale.** Rehearsal exists so workflows can be written and tested for free; it is worthless if
it corrupts the state of the run it is rehearsing.
**Actors.** Operator, Workflow.
**Exceptions.** It still creates a working copy, so that anything derived from repository history
behaves as it will in earnest.

---

## Amendments since approval

This file was approved on **2026-08-24** with **37 rules**, against a feature file of **60
scenarios**. It now carries **40 rules** and **78 scenarios**. Everything in the table below was
added or rewritten *after* that approval, during review of PR #8 (AWCLI-01, freezing the `ctx`
contract), and **none of it has been through a PM approval gate**. The front matter says so rather
than continuing to assert an unqualified approval. This section exists so that a reader can tell
"the spec was wrong" from "the spec was bent" without reconstructing it from six commits.

Three review rounds are referenced, and they did different kinds of work. *Run 2* reconciled the
artifacts against the frozen declaration in `src/contract/awcli.d.ts`. *Run 3* found what run 2's own
amendments had left underdetermined. *Run 4* did three things: it asked run 3's question of the one
remaining scope factory and found the answer was a ticket rather than a rule; it corrected ADR-0005,
which still asserted the model BR-012's run-3 rewrite had retracted; and it took three decisions
about the frozen surface before merge, each of which needed a rule to state it — every function
member becoming one a workflow cannot assign over, log field values widening, and `ctx.env` becoming
an accessor. Run 4 therefore rewrote four rules of its own and moved the re-approval scope, which
the two paragraphs above and the table below now account for.

| Date | Change | Driven by |
|---|---|---|
| 2026-08-25 | **BR-006 widened.** Statement and example rewritten: every declared profile field is required in a repository's configuration, and the run is refused at startup naming what is missing, before the lock or any working copy, whether or not a workflow would have read it. Previously the refusal fired when a workflow *read* a missing field. | Run 2. The frozen declaration asserted the wider rule while this file asserted the narrower one. |
| 2026-08-25 | **BR-006 carried by a scenario.** Added *A missing profile field is refused even when no workflow reads it*. AWCLI-06 restated to match, and AWCLI-22 given the `awcli init` five-fields requirement the TDD already assumed. | Run 3. The widened half had no scenario, and the only ticket that could have written the five fields did not require it. |
| 2026-08-25 | **BR-012 split, then given a mechanism.** Run 2 added the phasing note: only the `sandbox()` half is structural. Run 3 rewrote the statement, rationale and exceptions around the mechanism that makes the rest enforceable — shared state is writable from the body only while it has no agent call of its own still running. Added *A write while the body's own agents are still running is refused*; AWCLI-10 reworked and retitled. | Run 3. The split left the `agent()` half naming no mechanism, and AWCLI-10's criteria still presupposed an agent scope the split said does not exist. |
| 2026-08-25 | **BR-014 rewritten.** Statement, rationale, actors and exceptions: the live-checkout opt-in is the operator's, on the command line; a workflow cannot request it and nothing a workflow passes selects the workspace. Scenario *Working on the live checkout requires asking for it* rewritten with it. | Run 2. The declaration kept the choice off the workflow surface while this rule let a workflow opt in. |
| 2026-08-25 | **BR-038 added, then narrowed.** Run 2 added it, with five scenarios, to govern `ctx.fs` — one of two context members the design gave no rule and no scenario. Run 3 narrowed confinement from the working copy to the working *tree*, carving out the git administrative area on both layouts, and added a sixth scenario. | Run 3. As first written, `.git/hooks/pre-commit` was inside the confinement and ran on the next commit; on the worktree default the `.git` pointer file was inside it too, so writing it repointed the working copy at another repository. |
| 2026-08-25 | **BR-039 added, then rewritten.** Run 2 added it, with three scenarios, to govern `ctx.env` — the other unowned member. Run 3 rewrote it around a decidable test: the variables awcli set *for this run*, not "the credentials awcli itself supplies". Two of those three scenarios rewritten, a fourth added for the empty case, AWCLI-24 reconciled throughout. | Run 3. "The credentials awcli supplies" had no membership test — an inherited API key was the subject of both scenarios at once — and on the host target the subtraction was vacuous, so the first scenario's Given could not be established. |
| 2026-08-25 | **BR-040 added,** with three scenarios, and AWCLI-25 created to build the member. | Run 3. `ctx.exec`'s default target — a command run on the host — was owned by no unit: AWCLI-19 is the container target in every requirement it carries, and AWCLI-23 named it as the builder of `ctx.exec` itself. Third instance of the class of gap BR-038 and BR-039 closed. |
| 2026-08-25 | **ADR-0003 corrected.** Its claim that `liveTree × container` is "excluded by construction" and "unrepresentable" was softened: two independent closed unions can name that cell, so the exclusion is a property of what awcli composes, not of the type. The two-axis decision and the frozen surface stand; no rule text changed. | Run 2. |
| 2026-08-26 | **BR-025 rewritten, BR-028 amended.** Every function member of the context surface becomes one a workflow cannot assign over. BR-025's statement now says what makes the record unforgeable — the calls that write it are fixed at the moment the workflow receives them — and its rationale says why that is worth a change to the frozen surface: a workflow is the operator's own TypeScript with its own imports, and a module it never read could otherwise put its own function over `log.info` and leave the run agreeing with itself while recording nothing. The same fixity keeps a `sandbox()` scope's members from being swapped for the body's after the scope is made (BR-038, BR-040). Exceptions say plainly that this is hygiene and not a boundary: the workflow shares awcli's process, so an author who sets out to defeat their own audit trail can. BR-028 gains a cross-reference. Added *A workflow cannot put its own function over the one that writes the record*; AWCLI-01 requires it and carries it. | Run 4. BR-025 and BR-028 implied an unforgeable record and nothing made it one. |
| 2026-08-26 | **BR-008 rewritten.** Log field values widen to accept anything, so the compile-time refusal that used to sit on them is gone and the rule must say where it now applies: shared state is checked at the assignment that set it, a log field when the line is written down. A field that will not serialise is named as unrepresentable and costs neither the line nor the run — the one place this requirement degrades rather than refuses, because a log is the record of what happened. What forced the widening is that the old field type refused awcli's own return shapes: an interface gets no implicit index signature, so a command's result, a commit and the run's arguments could not be logged at all without being restated by hand. The plain-data requirement on shared state is unchanged. Added *A log field that cannot be written down costs the field, not the run*; AWCLI-21 requires it and carries it. | Run 4. The rule stated one check and the surface had two, one of which refused the ordinary case. |
| 2026-08-26 | **BR-039 rewritten again.** `ctx.env` loses its index signature for a get/has accessor, so the rule stops describing a record handed over and describes what asking by name answers. The decidable test is untouched — the variables awcli set for *this* run, known at the moment it sets them. What changes is the default: with the whole environment in hand, forwarding it into a prompt or a log line is one expression that looks like nothing in particular, and the rule could only advise against it — the more so now that log fields accept anything, which removes the last thing that objected to `ctx.log.info("env", ctx.env)`. Exceptions say the accessor is a shape and not a boundary: a workflow that names its variables can still forward every one. All three remaining record-shaped scenarios rewritten, one renamed with them, and *The environment answers by name and is never handed over whole* added. AWCLI-24 rewritten throughout, including a constraint against adding an enumerating member later. | Run 4. A rule that only advises is a rule a workflow nobody reviewed will not follow. |
| 2026-08-26 | **ADR-0005 corrected.** Its Decision and Decision Rationale still said child scopes receive a frozen view of shared state — the model BR-012's run-3 rewrite retracted. `agent()` returns a result and not a scope, so there is no child view to freeze, and the fan-out half of the rule turns on a time window instead. Amended in place the way ADR-0003 was: the Decision states both mechanisms, the Rationale says plainly which claim was wrong and why the enforceable substitute is blunt, and the differing sharpness of the two refusals — plus the reads the window does not close — are recorded under Consequences/Negative. Loop ownership, write-through and the single writer all stand; no rule text changed. | Run 4. AWCLI-10 would otherwise have been built from an ADR contradicting the rule it implements. |
| 2026-08-25 | **Counts and index reconciled.** `rules:` here, `requirements.rules.count` and `requirements.scenarios.count` in the manifest, the manifest's ticket list, and `.atelier/tickets/README.md`'s totals all moved with the above — leaving 40 rules, 75 scenarios, 26 tickets and 65 points *at the end of run 3*. Those four are a snapshot of that round, not the current totals; the last row of this table carries those. | Run 3. The manifest's own `updated` date had not moved across three commits that changed what it describes. |
| 2026-08-25 | **No rule added for `ctx.sandbox`, and that is the finding.** Run 3's question — which unit builds this member — was put to the last unexamined one. `ctx.sandbox` is a scope factory, and AWCLI-19 required running *in* a container but never building the `Scope` that hands one out. Unlike BR-038, BR-039 and BR-040, nothing behavioural was missing: BR-004, BR-012, BR-015, BR-016, BR-021 and BR-036 already state everything the scope does, and WB-11's Contracts column already named `ctx.sandbox`. So the fix is entirely in the tickets — AWCLI-19 widened to own the member end to end and re-estimated 2 → 3, AWCLI-10 given the AWCLI-19 dependency its `sandbox()` criteria always had. **No rule and no scenario changed; the counts stay at 40 and 75.** Ticket totals move to 26 tickets, 66 points. | Run 4. Fourth and last instance of the class of gap BR-038 opened, and the first that a rule would have been the wrong instrument for. |
| 2026-08-26 | **Counts audited, not just reconciled.** Every number in this section was checked against what the artifacts contain, and four were wrong. The re-approval paragraph said *four* rules rewritten — the fourth was BR-038 and BR-039's own second pass, which rewrites rules added in this same PR and already counted as added; three approved rules were rewritten in rounds 2 and 3 (BR-006, BR-012, BR-014), and round 4 rewrote three more (BR-008, BR-025, BR-028). It said *three* scenarios rewritten as though all three left the approved sixty; only one did (*Working on the live checkout requires asking for it*), the other two being BR-039 scenarios added in run 2. The BR-039 row said *both* original scenarios were rewritten when run 2 had added three. And `.atelier/tickets/README.md` asserted sixty approved scenarios two sentences after saying three were rewritten. A rewritten scenario is not an approved one, and an item added and then rewritten before any gate is one pending item and not two — so the honest totals are **31 of 40 rules and 59 of 78 scenarios still approved as written**, 9 rules and 19 scenarios pending. Current totals: 40 rules, 78 scenarios, 26 tickets, 66 points, and 17 work-breakdown units worth 62 points. | Run 4. The section written to stop a reader reconstructing the truth from six commits could not be added up. |
| 2026-08-28 | **No rule added for `ctx.git`, and that is the finding — AWCLI-14 widened to own the member end to end.** The same shape as the `ctx.sandbox` row above, and reached the same way: the question of which unit builds a member was put to `ctx.git`, and the honest answer was *most of one*. The TDD assigns `ctx.git` to WB-8, which is AWCLI-13 + AWCLI-14. AWCLI-13 delivers the four members a `WorkspaceHandle` carries — `dir`, `branch`, `head`, `dirty` — and constructs no context around one; AWCLI-14 reattaches a working copy and reports what a resumed run inherited. Neither ticket named `GitApi.log`, `.diff` or `.commit`, so those three were owned by nothing while AWCLI-19, AWCLI-23 and AWCLI-25 already carried acceptance criteria that consume them. Nothing behavioural is missing — BR-036 names the branch, BR-025 makes the run record's writes unforgeable, ADR-0004 makes git and text the source of truth — and WB-8's Contracts column already names `ctx.git`, so this is a ticket-scope correction and not a spec amendment. **AWCLI-14 now owns `ctx.git` end to end**, including the commit, log and diff members and the context member that exposes a working copy to a workflow, and is re-estimated 2 → 3. `DELIVERED_BY.git` in `src/runtime/context.ts` points there; it named AWCLI-13 until that unit shipped and then AWCLI-11, which owns WB-7 and no part of the member. **No rule and no scenario changed; the counts stay at 40 and 78.** Ticket totals move to 27 tickets, 69 points. | Run 1 of PR #15 (AWCLI-13). Fifth instance of the class of gap BR-038 opened, and the second that a rule would have been the wrong instrument for. The gap had been recorded only in a source comment, which no ticket reads. |

**What re-approval would have to cover — 9 rules and 19 scenarios:**

| | Rules | Scenarios |
|---|---|---|
| Approved 2026-08-24 | 37 | 60 |
| Added since | 3 — BR-038, BR-039, BR-040 | 18 |
| Of the approved, rewritten | 6 — BR-006, BR-008, BR-012, BR-014, BR-025, BR-028 | 1 — *Working on the live checkout requires asking for it* |
| **Still approved as written** | **31** | **59** |
| **Pending re-approval** | **9** | **19** |
| Now on disk | 40 | 78 |

The two columns are counted the same way, and the way matters, because the obvious arithmetic
double-counts. A rule or scenario **added** during these rounds and then **rewritten** during a later
one has never been through a gate at all: it is one pending item, not one added plus one rewritten.
Two rules (BR-038, BR-039) and three scenarios (all three BR-039's) are in that position, and they
are counted once, inside the added row. A rewritten item that *was* approved is different — it
leaves the approved count and joins the pending one, which is why 31 and 59 are not 37 and 60.

Until re-approval happens, this file is amended-but-not-re-approved, and the tickets derived from it
inherit that status.

---

## Assumptions taken (not determined by the PRD)

Three behavioural points the PRD does not settle. All three were reviewed at approval: A2 was
changed, A1 and A3 were approved as written.

| # | Assumption | Affects |
|---|---|---|
| A1 | A rehearsal run uses its own run identity and never touches the real run's stored state, but does create a working copy | BR-034 |
| ~~A2~~ | **Resolved at approval.** The workflow declares whether limit-exhaustion is completion; default is *incomplete*. Declared at the workflow's top level, not on the context | BR-018 |
| A3 | A single narrow re-ask on invalid structured output, then the iteration fails | BR-020 |
