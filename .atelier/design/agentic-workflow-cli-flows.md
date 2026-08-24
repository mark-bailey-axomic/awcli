---
feature: agentic-workflow-cli
artifact: flow-diagrams
status: Approved
date: 2026-08-24
source: agentic-workflow-cli-bdd.feature
---

# awcli — Flow Diagrams

## Diagram Index

| Diagram | Covers rules | Covering scenarios |
|---|---|---|
| 1. Startup gates | BR-001…007, BR-009, BR-010, BR-035 | *Native Windows is refused*, *A directory that is not a repository*, *The repository's required version range*, *A workflow file with no usable entry point*, *A portable workflow meeting a repository that lacks a fact*, *Asking for tagged output the prompt never requests*, *Stored state no longer matching*, *Two runs of the same name cannot overlap* |
| 2. The iteration loop and how a run ends | BR-017…019, BR-037 | *The tool drives the loop*, *Finishing the work early*, *Exhausting the iterations*, *A monitor-style workflow declares*, *The time limit ends a run*, *One bad iteration does not end the night*, *A run where nothing succeeded* |
| 3. Choosing isolation for an agent | BR-004, BR-014, BR-015 | *A requested container is never silently downgraded*, *A workflow that asks for no container*, *The default protects my checkout*, *Working on the live checkout requires asking*, *Every agent call states how isolated it is* |
| 4. Getting a usable result out of an agent | BR-020, BR-022, BR-026 | *A malformed result is re-asked for*, *A result that stays malformed*, *An agent that goes silent*, *An agent that finished but has not exited*, *Detail that cannot be read degrades once* |
| 5. One agent call, end to end | BR-013, BR-014, BR-016, BR-025 | *Parallel agents never share a working copy*, *The default protects my checkout*, *Credentials are lent to a container*, *Every run can be explained the next morning* |
| 6. Fan-out and recording results | BR-012, BR-013, BR-028 | *A parallel branch may read shared state but not write it*, *The workflow body records results*, *Four agents at once stay readable* |
| 7. Crash and resume | BR-023, BR-024, BR-036 | *A crash mid-iteration*, *Resuming restores the work and says what it inherited*, *Starting fresh discards state and working copies together* |

---

## 1. Startup gates

Everything here happens before anything is created. The order matters: the cheapest, most certain
refusals come first, so an operator never waits on a container build to be told their platform is
unsupported.

```mermaid
flowchart TD
    A[Operator runs a workflow] --> B{Supported platform?}
    B -- No --> R1[Refuse: use a Linux environment]
    B -- Yes --> C{Target is a repository?}
    C -- No --> R2[Refuse: suggest putting it under version control]
    C -- Yes --> D{Required version range satisfied?}
    D -- No --> R3[Refuse: name the required range and mine]
    D -- Yes --> E{Workflow has a usable entry point?}
    E -- No --> R4[Refuse: needs a default function]
    E -- Yes --> F{Profile facts and prompt tags present?}
    F -- No --> R5[Refuse: name the missing field or tag]
    F -- Yes --> G{Stored state matches its declared shape?}
    G -- No --> R6[Refuse: offer to reset]
    G -- Yes --> H{Run name free?}
    H -- Held, owner alive --> R7[Refuse: name the run in progress]
    H -- Held, owner gone --> H2[Reclaim the stale lock and say so]
    H -- Free --> I[Take the lock and begin]
    H2 --> I
```

## 2. The iteration loop and how a run ends

Four exits, and the workflow's own declaration decides whether running out of room counts as
finishing.

```mermaid
flowchart TD
    A[Begin iteration] --> B[Invoke the workflow with shared state]
    B --> C{Outcome of this pass}
    C -- Declared done --> C2[Await agents still in flight, discard their results]
    C2 --> D[Report: finished]
    C -- Failed --> E[Record the failure]
    C -- Continue --> F{Any room left?}
    E --> F
    F -- Yes --> A
    F -- No, limit reached --> G{Workflow declares limits as expected?}
    G -- Yes --> D
    G -- No --> H[Report: incomplete, ran out of room]
    D --> I{Every iteration failed?}
    H --> I
    I -- Yes --> J[Report the run as failed]
    I -- No --> K[Report per-iteration failures in the summary]
```

## 3. Choosing isolation for an agent

The default is chosen *for* the operator; weaker isolation is never chosen for them.

```mermaid
flowchart TD
    A[Workflow asks for an agent] --> B{What did it ask for?}
    B -- Container --> C{Container support available?}
    C -- No --> R[Fail the run: never downgrade silently]
    C -- Yes --> D[Build or reuse the image, mount credentials read-only]
    D --> E[Fresh working copy on its own branch]
    B -- Nothing specified --> E
    B -- Live checkout, explicitly --> F[Use the operator's checkout as-is]
    E --> G[State the isolation level in the output]
    F --> G
    G --> H[Run the agent]
```

## 4. Getting a usable result out of an agent

The agent's committed work and the agent's *reported result* are separate concerns — which is why a
malformed result costs a decision, not the work.

```mermaid
flowchart TD
    A[Agent running] --> B{Producing output?}
    B -- Silent past the idle limit --> C[Fail the iteration: went silent]
    B -- Finished but process lingers --> D[Grace period, then treat as successful]
    B -- Finished and exited --> E[Read commits from the repository]
    D --> E
    E --> F{Tagged result valid?}
    F -- Yes --> G[Return the result to the workflow]
    F -- No --> H[Re-ask: change nothing, correct the result only]
    H --> I{Valid now?}
    I -- Yes --> G
    I -- No --> J[Fail the iteration, keep the committed work]
```

---

## 5. One agent call, end to end

```mermaid
sequenceDiagram
    actor Operator
    participant awcli
    participant Repo as Repository
    participant Agent

    Operator->>awcli: Run the workflow
    awcli->>Repo: Create a working copy on its own branch
    awcli->>awcli: Record versions and starting position
    awcli->>Agent: Start with the prompt, credentials lent read-only
    Agent->>Repo: Make changes and commit them
    Agent-->>awcli: Output, including the tagged result
    awcli->>Repo: Read back what was actually committed
    awcli-->>Operator: Summary — isolation level, commits, result
```

## 6. Fan-out and recording results

The permission boundary is visible here: branches return, the body records.

```mermaid
sequenceDiagram
    participant Body as Workflow body
    participant B1 as Branch 1
    participant B2 as Branch 2
    participant State as Shared state

    Body->>B1: Start agent on its own working copy
    Body->>B2: Start agent on its own working copy
    B1->>State: Attempt to record result
    State--)B1: Refused — read-only in a branch
    B1-->>Body: Return the result instead
    B2-->>Body: Return the result
    Body->>State: Record both results
    State-->>Body: Stored durably as written
```

## 7. Crash and resume

```mermaid
sequenceDiagram
    actor Operator
    participant awcli
    participant State as Shared state
    participant Repo as Repository

    Operator->>awcli: Run for ten iterations
    awcli->>State: Record progress as the workflow makes it
    Note over awcli,State: Killed forty minutes into iteration four
    Operator->>awcli: Run again
    awcli->>State: Load what was recorded before the crash
    awcli->>Repo: Reattach the run's existing working copy
    awcli-->>Operator: Resuming at five — copy at abc123, 3 uncommitted files inherited
    Operator->>awcli: Or: start fresh
    awcli->>State: Discard state and working copies together
```
