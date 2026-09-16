### REPO: diqierjia/StrataGate-AgentMemory  SUBDIR:   BRANCH: 
ATOM OK branch=main
COMMIT 2026-09-16T05:49:42Z :: Merge pull request #52 from zenglinjie666/main
COMMIT 2026-09-16T05:34:37Z :: Merge branch 'diqierjia:main' into main
COMMIT 2026-09-15T15:59:53Z :: Merge pull request #51 from diqierjia/codex/release-stratagate-dsh-0.…
COMMIT 2026-09-15T15:35:27Z :: release: stratagate-dsh 0.2.71
COMMIT 2026-09-14T15:43:53Z :: Merge pull request #50 from diqierjia/codex/release-stratagate-dsh-0.…
=== README FROM: https://raw.githubusercontent.com/diqierjia/StrataGate-AgentMemory/main/README.md (len=36945) ===
<div align="center">

<img src="docs/assets/stratagate-avatar.png" alt="StrataGate Agent Memory banner" width="100%" />

# StrataGate

### Recent conversations stay detailed. Older memories grow more concise.

StrataGate gradually condenses an AI agent's short-term memory as the conversation progresses, with original details available to expand when needed. Important information becomes Events and a knowledge graph, preserving historical changes and current state for future sessions.

[![CI](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml/badge.svg)](https://github.com/diqierjia/StrataGate-AgentMemory/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![npm downloads](https://img.shields.io/npm/dt/stratagate-dsh.svg)](https://www.npmjs.com/package/stratagate-dsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg)](https://www.typescriptlang.org/)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

[中文说明](README.zh-CN.md) · [DeepSeek Harness guide](docs/DSH.md) · [Architecture](docs/ARCHITECTURE.md) · [Full evaluation](docs/EVALUATION.md)

<strong>Current public result:</strong> on LoCoMo `conv-26`, StrataGate averaged <strong>80.46%</strong> across 10 independent Judge runs, versus <strong>63.22%</strong> for Mem0 base. [See the scope and protocol](#experimental-results).

</div>

> **In plain words:** StrataGate keeps recent conversations detailed and gradually condenses older ones as the conversation progresses. Important information becomes Events and a knowledge graph for future sessions. Original records remain available to expand and verify when needed.

## Why StrataGate?

1. **Short-term memory: details fade as the conversation progresses and expand when needed.**

   (1) **Recent history stays detailed; older history becomes concise.** Each conversation block has six views, L0–L5, with different levels of detail. As more conversation accumulates, older memories gradually shift from full dialogue to key facts, short summaries, and title indexes, reducing the context occupied by history. → [Layered memory](#layered-memory)

   (2) **Views shrink while original records remain.** Complete L5 source messages and tool records are preserved. When details need checking, the agent can expand a memory to recover the original wording and context. → [Layered memory](#layered-memory)

2. **Long-term memory: an event timeline preserves history, while a knowledge graph organizes current state.**

   (1) **Events record what happened.** Important decisions, preferences, plans, and changes are extracted from conversations as Events. Each retains its source and distinguishes when something was mentioned from when it happened, so future sessions can retrieve and trace it. → [Event cards](#event-cards)

   (2) **The knowledge graph represents current state.** Historical Events provide the basis for current information and relationships about people, projects, organizations, tools, and places. New Events can supplement or supersede an earlier state while historical Events and their sources remain preserved. → [Current-state graph](#current-state-graph)

   (3) **Long-term weights decay too.** As conversations progress, memories that have not been adopted gradually lose weight, affecting their priority during retrieval and automatic recall. Their sources remain available for verification even after their weights decay. → [Weights and adoption-based reinforcement](#use-only-reinforcement)

   (4) **Bring memories from other AIs.** Imported content can become traceable Events and update the knowledge graph while the original imported text remains preserved. → [External memory import](#external-memory-import)

3. **Evidence gate: check whether retrieved evidence is sufficient before answering.**

   A relevant search result may still be insufficient to answer the question. The agent assesses the evidence and, when needed, searches again, expands Events, or checks the original messages. If it still cannot confirm the answer, it states the uncertainty. → [Evidence gate](#evidence-gate)

4. **Reinforce only memories actually used.**

   Search hits and automatic context injection do not trigger reinforcement. Only evidence recorded as actually used in the final answer increases the adoption count and resets the decay anchor. More adoptions mean slower future decay, preventing a memory from reinforcing itself merely because it is frequently retrieved. → [Use-only reinforcement](#use-only-reinforcement)

Get started: → [Quick start](#quick-start-deepseek-harness)

## Choose your path

| Path | Best for | Start here |
| --- | --- | --- |
| **DeepSeek Harness plugin** | Users who want automatic, local-first memory with a visual Memory UI | [Install `stratagate-dsh`](#quick-start-deepseek-harness) |
| **Core TypeScript library** | Developers building a custom agent or memory integration | [Library entry points](#code-entry-points) |

<a id="quick-start-deepseek-harness"></a>

## Quick start: DeepSeek Harness

If DeepSeek Harness is already installed, add StrataGate to the profile you use:

```bash
dsh plugin --profile web add stratagate-dsh
```

Restart that profile, then keep using DSH normally. StrataGate will capture completed main-agent turns, build searchable memory in the background, and expose its Memory UI under **DSH Settings → StrataGate-AgentMemory**.

By default, the database is stored at:

```text
DSH_HOME/stratagate/memory.db
```

Removing the plugin does not delete the database. For screenshots, configuration, memory tools, and the exact automatic-capture rules, see the [DeepSeek Harness plugin guide](docs/DSH.md).

## The problem behind the design

As conversations accumulate, an AI agent has to fit the current task, earlier discussions, and lasting information into a limited context window.

Recent discussions often need their full detail. Older conversations can remain as concise summaries and expand when needed. Meanwhile, user preferences, project decisions, and task plans change, making it necessary to distinguish historical records from current state. StrataGate addresses these needs by managing short-term views, long-term updates, retrieval assessment, and usage feedback separately.

| Common problem | How StrataGate handles it |
| --- | --- |
| Conversations keep growing, and historical details continue to occupy context | Store each conversation block as L0–L5 views; as more conversation accumulates, older content defaults to a more concise view and expands when needed |
| Important information is scattered across conversations, and old decisions can be confused with current state | Extract Events with sources and timestamps, preserve history in an event timeline, and organize current state in a knowledge graph |
| Search finds related content but misses details needed to answer | Assess the evidence through the evidence gate; search again, expand memories, or inspect the source when necessary |
| A memory keeps gaining weight merely because it is frequently retrieved | Separate retrieval from adoption: long-term weights decay as conversations progress, and only memories recorded as actually used receive reinforcement |

Short-term decay gradually reduces the detail that older conversations contribute to current context. Long-term memory and its weighting mechanism help the agent recall information that remains useful in future sessions. Both retain sources so condensed information can still be traced and checked.

<a id="how-stratagate-works"></a>

## How it works

![Figure 1: StrataGate workflow—memory formation, automatic activation, active retrieval, and evidence assessment (Chinese labels)](docs/assets/aaed14b0b43a76334008117f6ca104af.png)

*The four-round retrieval budget in Figure 1 is an example evaluation setting. Integrations control their own retrieval loops and budgets. The diagrams use Chinese labels; the accompanying text explains each mechanism in English.*

StrataGate's workflow covers memory formation, recall when answering, and feedback after adoption.

### 1. Accumulate conversations into layered short-term memory

Each completed turn and its tool records are saved first. The DeepSeek Harness plugin seals a Block every **6 turns** by default. Users can configure this size; turns below the boundary remain in the current conversation.

Each Block stores six levels of detail, L0–L5, from title indexes and short summaries to complete source records. Decay begins only after background processing finishes: as more Blocks become ready in the same conversation, older Blocks default to shallower views.

This reduces the historical detail presented in context while preserving the complete L5 source records. → [Layered memory](#layered-memory)

### 2. Turn important information into Events and update the knowledge graph

Decisions, preferences, plans, and changes worth keeping become Events. Each Event records content, time, and provenance for future conversations to retrieve.

The knowledge graph then organizes current information and relationships about entities such as people, projects, and tools. New Events can supplement or supersede an earlier state while historical Events and their sources remain available. → [Event cards](#event-cards) · [Current-state graph](#current-state-graph)

### 3. Activate relevant memories before answering and retrieve more when needed

Before each main-model call, the plugin uses the current question and recent conversation to bring in a small set of relevant long-term Events and graph information as background.

The current DSH integration includes at most **4 Events and 4 graph nodes**, subject to a total budget of approximately **900 tokens**. The active conversation's history is supplied through layered Blocks and unsealed turns.

If the available context is sufficient, the agent can answer directly. Otherwise, it uses memory tools to search Events, the graph, or source messages, expanding details as needed.

### 4. Assess whether actively retrieved evidence answers the question

After finding relevant memories, the agent determines whether they answer the actual question: which evidence supports the answer, what is missing, and whether further retrieval is needed.

For example, “the project uses pnpm” answers which tool is currently used, but does not explain why pnpm was originally chosen. The agent should expand the relevant Event or inspect the original discussion.

The evidence gate requires an explicit assessment, while code validates evidence references and protocol constraints. If evidence remains insufficient, the agent continues searching or states that it cannot confirm the answer. → [Evidence gate](#evidence-gate)

### 5. Record adopted evidence and update long-term weights

Search hits and automatic context injection do not reinforce memories.

When the agent determines which evidence supports its final answer, it submits a usage receipt. Events recorded as actually used update their adoption counts and decay anchors. More adoptions lead to slower future decay. Unused search results receive no reinforcement from that selection. → [Use-only reinforcement](#use-only-reinforcement)

For example, a user first decides to use npm, then switches the project to pnpm. StrataGate preserves both decisions and updates the graph's current state. A later question about what the project uses can be answered from that state; questions about when or why the change happened can follow the Event back to the original conversation.

[See a retrieval example that follows an event card back to source messages](#a-real-retrieval-path).

## Core design

StrataGate separately manages conversation detail, long-term information updates, retrieval assessment, and feedback from adopted memories.

**Short-term decay controls how much detail older conversations display. Long-term weights influence information's priority in later recall.** Neither form of decay deletes the original sources.

<a id="layered-memory"></a>

### 1. Short-term memory: gradually condense older conversations and expand them when needed

Recent discussions usually need their full detail. Older conversations can remain in context as concise views. StrataGate stores several levels of detail for the same conversation block and gradually reduces what older Blocks display by default as more conversation accumulates.

![Figure 2: Short-term memory—L0–L5 views, display decay, and on-demand expansion (Chinese labels)](docs/assets/41fc676096d0a13337a1c03aaf8f499b.png)

**One conversation block, six levels of detail.**

The DeepSeek Harness plugin seals a Block every **6 complete turns** by default. A turn consists of a user question and the assistant's complete response. The Block size is configurable; the core-library default is 12 turns. Content below the boundary remains in the current conversation.

Each fully processed Block contains these views:

| Level | Contents | Primary use |
| --- | --- | --- |
| L0 | Title and tags | Identify a piece of history with minimal context |
| L1 | Short summary | Understand the discussion's topic |
| L2 | Key facts | Review decisions, constraints, plans, and outcomes |
| L3 | Rule-condensed dialogue | Preserve the discussion while removing bounded redundancy |
| L4 | Readable, near-verbatim dialogue | Check fuller language context |
| L5 | Source messages and tool records | Verify provenance and specific details |

The model produces L0–L2 summaries. Code generates L3 and L4 deterministically. L3 may condense standalone greetings, pure confirmations, repeated long pasted content, and tool arguments; it does not perform free-form semantic paraphrasing.

Source records are saved first, followed by summarization and Event processing. Only a fully processed, ready Block can replace its corresponding native history and participate in decay.

**As more conversation accumulates, older Blocks default to less detail.**

Display changes follow exponential decay:

$$
w_{\text{block}}(age)=e^{-\lambda_{\text{block}}\,age}
$$

The default $\lambda_{\text{block}}$ is **0.30**. Code maps weight ranges to display levels. Smaller coefficients preserve detail for longer and therefore consume more context.

In this formula, `age` is the distance between the current display anchor and the latest ready Block in the same conversation. It measures conversation progress, **not elapsed calendar days**. Unsealed turns and Blocks still awaiting model processing do not advance this decay.

For a Block that starts at L5 and is never expanded again, the default schedule is:

| Additional ready Blocks | Default display level |
| ---: | --- |
| 0–1 | L5 |
| 2 | L4 |
| 3–4 | L3 |
| 5–6 | L2 |
| 7–8 | L1 |
| 9 or more | L0 |

The figure illustrates the trend. Actual changes depend on both the decay coefficient and level thresholds; a new Block does not necessarily cause a one-level drop.

**Expand again when details are needed.**

Suppose an older conversation currently shows only:

> Discussed the project's technical approach and near-term plans.

If the user asks why pnpm was chosen, the agent can expand key facts, condensed dialogue, or the complete source records to find the original reason.

Expansion can proceed one level at a time or jump directly to a requested level. The selected level and current Block position become the new decay anchor. As subsequent conversation accumulates, the view gradually becomes concise again.

Older conversations can therefore remain lightweight during ordinary use while retaining recoverable detail. **L0–L4 are derived views of the source and never overwrite L5.**

<a id="event-cards"></a>

### 2. Long-term memory: preserve history in Events and organize current state in a knowledge graph

Short-term memory retains a discussion's context. Long-term memory extracts information worth using in future sessions. StrataGate records decisions, preferences, plans, and changes as Events, then uses those Events to organize a knowledge graph.

![Figure 4: Long-term memory updates—Event extraction, historical relationships, and the current-state graph (Chinese labels)](docs/assets/fc07e5b6e1cc07c115faa773a2718aa9.png)

**Event cards record what happened and retain their sources.**

A Block can produce multiple Events or contain no information that needs long-term extraction. In addition to content, each Event retains its source Block, source messages, and whatever temporal information can be established.

Two different time axes must be distinguished:

| Time | Meaning |
| --- | --- |
| Mention time | When the conversation referred to the event |
| Occurrence time | When the event happened or is planned to happen |

If a user says “Finish the prototype next week” on May 6, May 6 is the mention date, while “next week” describes the planned completion time. The record should retain its planned status and cannot serve as evidence that the prototype is already complete.

When a date cannot be established, the original wording and uncertainty remain available for later source verification.

**New Events update memory through additions, supersession, or conflicts.**

A project discussion might contain these statements over time:

> “Use npm for this project.”
>
> “Let's switch to pnpm.”
>
> “Finish the prototype next week.”

They play different roles:

- Switching to pnpm updates the package-manager choice; the earlier npm Event remains in history.
- Finishing the prototype next week adds a plan without changing the package-manager decision.
- If statements cannot both be true and their validity cannot yet be resolved, a conflict relationship is retained for later verification.

New Events do not overwrite the content or provenance of earlier Events. Their validity status and relationships can change as new evidence arrives. This lets the system retrieve current information while also explaining what used to be true and what changed.

<a id="current-state-graph"></a>

**The knowledge graph organizes current information and relationships from Events.**

People, projects, organizations, tools, and places become nodes. Connections such as “uses,” “participates in,” and “depends on” become directed edges. Both node attributes and relationships retain their source Events.

In the example, the graph can update the project's current package manager to pnpm while preserving npm as a historical state. Later:

- a question about what the project uses can start with the current graph;
- a question about when it changed can inspect the change Event;
- a question about why it changed can expand the Event and return to the original discussion.

Graph state must be supported by its sources. “Finish the prototype next week” directly supports a plan. The figure's “prototype in development” state and owner information require additional supporting Events.

Graph updates run as independent jobs with persisted progress. A failed update can be retried separately while the committed Events and source records remain available.

<a id="evidence-gate"></a>

### 3. Evidence gate: check whether retrieved results can answer the actual question

After finding relevant memories, the agent still needs to assess whether they support the answer. StrataGate uses a fixed, compact assessment structure that requires an explicit judgment of sufficiency and the next action.

| Field | What it explains |
| --- | --- |
| `verdict` | Whether evidence is sufficient, partial, or mismatched |
| `evidence_refs` | Which retrieved items support the assessment |
| `fit` | How the evidence matches the question |
| `missing` | What information is still missing |
| `next_strategy` | Whether to answer, search again, or expand a memory |

For example, the user asks:

> Why did we originally switch to pnpm?

The only retrieved result says:

> The project switched from npm to pnpm.

That confirms a change but does not explain the reason. The agent should judge the evidence as partial and expand the Event or inspect the original conversation, rather than infer the historical reason from the tool choice alone.

The model assesses semantic sufficiency. Code validates references and protocol constraints: cited evidence must come from the selected retrieval batch, and accepting `sufficient` requires valid evidence references and an explicit choice to answer.

These checks make retrieval traceable and auditable, but the model can still misjudge evidence. When sufficient information is unavailable, the agent should continue searching or state that it cannot confirm the answer.

Integrations control active-retrieval loops and budgets. The four-round limit in Figure 1 is an example evaluation setting, not a fixed limit for every integration.

<a id="use-only-reinforcement"></a>

### 4. Reinforce only memories actually used: more adoptions mean slower future decay

Long-term memories also decay as conversations progress. Here, the changing quantity is an Event's weight, which participates in later recall and ranking. Unlike a short-term Block, an Event does not move through L0–L5 display levels as its weight decays.

![Figure 3: Long-term memory weights—natural decay, retrieval without reinforcement, and adoption-based reinforcement (Chinese labels)](docs/assets/cecc9d191a4b9bf22a479623e2ebdc1d.png)

**New Events have an initial weight that decays when they are not adopted.**

The base Event-weight function is:

$$
w(t,n)=\max\left(floor,e^{-\lambda(n)t}\right)
$$

$$
\lambda(n)=\frac{0.15}{1+1.5\ln(n)}
$$

Here:

- $t$ is the difference between the current turn and the last adoption turn; new Events start counting from creation;
- $n$ is the internal adoption count, initialized to 1 and incremented for each recorded adoption;
- $floor$ is the minimum weight assigned according to the memory's criticality.

Long-term decay also uses conversation turns rather than elapsed wall-clock time. Lower weight may reduce a memory's priority in later recall, but decay does not delete its historical record.

**Retrieval does not trigger reinforcement.**

A search hit only establishes possible relevance. The system may record when a memory was retrieved, but retrieval does not increase its adoption count or reset its decay anchor.

Memories automatically included in context receive no reinforcement merely for being displayed. This prevents a memory from continually gaining weight just because it happened to rank highly and then appeared repeatedly.

**Weights update only after recorded adoption.**

After selecting evidence for the final answer, the agent submits a usage receipt. Validated Event selections increase their adoption counts and move their decay anchors to the current turn. An ordinary active Event without an additional weight cap returns to weight 1.

As the adoption count increases, the decay coefficient decreases. The Event retains more weight over the same number of subsequent turns, so memories that repeatedly help answers decay more slowly.

Adoption is based on the agent's submitted evidence selection. Code checks that the evidence belongs to the corresponding batch and has passed a sufficient assessment. Receipts prevent the same operation from being applied twice. Unused results receive no reinforcement from that selection.

**Different criticality levels have different minimum weights.**

| Memory category | Default minimum weight |
| --- | ---: |
| Routine information | 0 |
| User preference | 0.3 |
| Identity information | 0.9 |
| Safety information | 1.0 |

Pinned memories have an effective weight of 1. Superseded Events normally receive a low weight cap so older states do not retain excessive priority.

These weights express a memory-management policy, not factual accuracy. Even high-weight information must be assessed against the current question, current state, and original source.

<a id="external-memory-import"></a>

## Import memory from another AI

`importExternalMemory()` can migrate a structured memory summary produced by another AI. The core API extracts candidate Events, compares each candidate with a bounded set of existing Events, and lets a model choose one of five actions: add, merge, supersede, mark a conflict, or ignore. Imported text is also retained as a permanent source Block, so every accepted Event remains traceable to the exact import.

The exported prompt and parser use the `stratagate.external-memory.v2` format. Unknown dates remain unknown: the importer preserves the original temporal wording instead of guessing from the current date or message order. See [`docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md`](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md) for the current integration guide.

The DeepSeek Harness UI previews every import, skips exact duplicates deterministically, and asks the configured model to choose add, merge, supersede, conflict, or ignore against Top-K local matches. High-confidence decisions are applied automatically; only low-confidence decisions require confirmation. Each committed batch can be undone from the result screen.

## A real retrieval path

One LoCoMo question asks when Caroline gave a speech at a school.

The event card found the “school speech,” but the card itself did not contain enough date information:

```text
search_events
        ↓
Match the “school speech” event card
        ↓
The event is relevant, but has no exact date
verdict = partial
missing = occurrence date
        ↓
search_raw_memory
        ↓
Find the source message dated 2023-06-09
It says “last week”
        ↓
Resolve the relative date against the message timestamp
verdict = sufficient
        ↓
Answer
```

In this path:

- the event card provides fast location;
- the source timestamp and original message provide final verification;
- the evidence gate requires the agent to identify missing information and keep checking when evidence is insufficient.

## Experimental results

The repository's published R8 comparison uses the LoCoMo conversation sample `conv-26`, containing **419 messages, 35 sessions, and 152 questions** across categories 1–4.

Each system generated answers, and each answer received **10 independent Judge evaluations**. These are repeated evaluations, not ten complete system runs.

| Metric | StrataGate | Mem0 base | Difference |
| --- | ---: | ---: | ---: |
| Mean accuracy across 10 Judge runs | **80.46%** | 63.22% | **+17.24 percentage points** |
| Majority-correct | **121 / 152 (79.61%)** | 96 / 152 (63.16%) | **+25 questions** |
| Temporal | **74.86%** | 34.59% | **+40.27 percentage points** |
| Single-hop | **89.29%** | 75.14% | **+14.14 percentage points** |
| Multi-hop | **66.56%** | 61.56% | +5.00 percentage points |
| Open-domain | 83.08% | **84.62%** | -1.54 percentage points |

Both systems used the same questions, order, answer model, Judge model, evaluation prompt, parser, and evaluation count, and each rebuilt its memory. Memory extraction, retrieval implementation, embedding use, and answer context differed, so this compares two complete system configurations.

These results cover only `conv-26`, not the full LoCoMo dataset. They do not isolate the benefits of short-term decay, the knowledge graph, or the evidence gate. Individual contributions still require ablation experiments.

See the [evaluation document](docs/EVALUATION.md) for the full protocol, per-question results, and Judge variation, and the [machine-readable results](benchmarks/locomo-conv26-r8-final.json) for summary data.

## How these designs emerged

Failures observed across several experimental rounds helped StrataGate refine its memory processing and retrieval strategies:

- **Store temporal information explicitly.** Summaries alone make event dates hard to recover, so event cards distinguish mention time from occurrence time and retain the original temporal wording and source.
- **Keep evidence assessment short and explicit.** Five fields require the agent to state its evidence, gaps, and next action while allowing code to validate references.
- **Change retrieval strategy when repeated searches add no information.** When an event card lacks key details, expanding its source or searching original messages is more useful than repeatedly searching the same cards.

The [evaluation document](docs/EVALUATION.md) retains the full R1–R8 history, version differences, and per-question analysis. Multiple changes occurred between rounds; these observations explain design choices but do not independently establish the effect of any single component.

## Current limitations and next steps

In the R8 evaluation above, **31 questions were judged incorrect by a majority of evaluators**. Grouped by the observable failure stage:

| Failure stage | Questions | What it indicates |
| --- | ---: | --- |
| Incorrect direct answer without retrieval | 15 | The agent sometimes failed to recognize that historical evidence was needed |
| Evidence judged sufficient, but the final answer was incorrect | 14 | Evidence could concern a neighboring event or fail to support the complete answer |
| Evidence remained insufficient at the retrieval budget | 2 | Enough information was not found within the allotted budget |

Within this evaluation, the results point to a need to improve when retrieval starts and whether retrieved evidence actually answers the question. The evidence gate constrains references and assessment procedures, but cannot guarantee the model's semantic judgment or final answer.

Further validation will focus on:

1. Holding the model and memory state fixed while ablating short-term decay and key retrieval mechanisms, comparing accuracy, context use, and call costs.
2. Supplying known-correct source evidence directly to distinguish retrieval failures from reasoning errors that persist despite correct evidence.
3. Repeating the same protocol on more conversation samples before extending it to the full LoCoMo dataset.

## Current status

StrataGate provides an installable DeepSeek Harness plugin, with memory management implemented through a shared TypeScript core engine.

Current functionality includes:

- automatic capture of completed conversations and tool records;
- L0–L5 short-term memory views, display decay, and on-demand expansion;
- Events with provenance and time, plus a knowledge graph updated from those Events;
- automatic activation of relevant long-term memories, active search, and source lookup;
- retrieval-batch management, evidence assessment, and usage receipts;
- long-term weight decay, adoption-based reinforcement, and memory import from other AIs.

The repository includes automated tests, experiment records, and traceable evaluation results. Public APIs, model integration, and evaluation coverage are still evolving. Custom integrations should pin a version and validate behavior for their own use cases.

The standard `StrataGate.open()` entry point uses SQLite persistence; `StrataGate.inMemory()` explicitly selects temporary operation or testing. The storage adapter supports interruption recovery and consistency checks. See the [architecture document](docs/ARCHITECTURE.md) for its constraints.

## When StrataGate is a good fit

StrataGate suits agent workflows that need continuity across extended conversations while controlling the context occupied by history. For example:

- **Sustained project work.** Recent discussions stay detailed; older discussions become concise and can expand when the reasoning behind a decision matters.
- **Continuing work across sessions.** Retrieve project decisions, user preferences, plans, and unfinished work in a new conversation.
- **Tracking changes.** Understand both current project state and historical changes without mistaking an earlier decision for the current one.
- **Verifying memory sources.** Trace Events and graph information back to original records when an answer depends on dates, exact wording, or tool results.
- **Migrating existing memories.** Turn information exported by another AI into Events while retaining the imported source text.

Memory can be organized by project, session, or global scope. The knowledge-graph UI primarily supports viewing current information, relationships, and sources; collaborative editing and cloud synchronization across products are not its primary functions.

DeepSeek Harness users can install the plugin through the [quick start](#quick-start-deepseek-harness). See the [plugin guide](docs/DSH.md) for configuration, memory tools, and recovery behavior.

## Code entry points

This section is for developers. DeepSeek Harness users can follow the [quick start](#quick-start-deepseek-harness) without building the repository themselves.

The development environment requires:

- Node.js **22.19.0 or later within the 22.x series**, or **24.0.0 or later**;
- the declared version range is `^22.19.0 || >=24.0.0`.

After checking out the repository, run these commands from its root:

```bash
npm install
npm run check
npm test
npm run build
```

The main code entry points are:

| Entry point | Contents |
| --- | --- |
| [Core-engine example](packages/core/examples/basic.ts) | Minimal integration example |
| [Core state and lifecycle](packages/core/src/store.ts) | Blocks, Events, graph, import, retrieval, and adoption records |
| [Layering and decay](packages/core/src/blocks.ts) | L0–L5 levels, display decay, and deterministic pruning |
| [Long-term weights](packages/core/src/weights.ts) | Event decay and minimum-weight calculation |
| [Event types](packages/core/src/events.ts) | Event-type normalization |
| [Knowledge graph](packages/core/src/graph.ts) | Provenance checks, graph updates, and state maintenance |
| [Retrieval ranking](packages/core/src/search.ts) | BM25 ranking and RRF fusion |
| [Evidence assessment](packages/core/src/retrieval.ts) | Assessment structure and reference constraints |
| [External-memory import](packages/core/src/external-memory.ts) | Import formats, prompts, and parsing |
| [Legacy Element-card support](packages/core/src/elements.ts) | Element projection and historical time views |

In persistent mode, `recordMemoryUse()` requires a nonempty, stable `receiptId`. Reuse that ID when retrying the same adoption operation to avoid duplicate reinforcement. For example:

```ts
await memory.recordMemoryUse(
  { eventIds: usedEventIds },
  { receiptId: usageReceiptId },
);
```

Here, `usedEventIds` contains the Events the application selected for the answer, and `usageReceiptId` identifies that adoption operation. The DSH plugin handles this through memory tools and its batch protocol; plugin users do not call this API manually.

The core example demonstrates API integration. See the [evaluation document](docs/EVALUATION.md) for the model calls, tool loop, and Judge protocol used in the full evaluation.

## Documentation and reproduction

| Resource | Contents |
| --- | --- |
| [DeepSeek Harness guide](docs/DSH.md) | Installation, configuration, UI, memory tools, and recovery |
| [Architecture](docs/ARCHITECTURE.md) | Layering, Events and graph, retrieval, evidence gate, weights, and storage constraints |
| [External-memory import](docs/EXTERNAL_MEMORY_IMPORT.zh-CN.md) | Export format, import flow, and integration example |
| [Full evaluation](docs/EVALUATION.md) | Protocol, version history, failure analysis, and result scope |
| [Evaluation summary data](benchmarks/locomo-conv26-r8-final.json) | Published results, statistics, and artifact information |
| [Core-engine example](packages/core/examples/basic.ts) | Minimal API integration example |

## Repository layout

```text
src/                    DeepSeek Harness Host and Web client adapter
tests/                  DeepSeek Harness integration tests
cordis.patch.yml        Root-level DSH bundle manifest
packages/core/          Shared memory engine, core tests, and example
integrations/workbuddy/ WorkBuddy Host Adapter and MCP integration
docs/                   DSH usage, architecture, and evaluation
benchmarks/             Machine-readable experiment results
```

## Contributing

Contributions are welcome—whether you are fixing a bug, improving documentation, adding an integration, or exploring a better memory and retrieval strategy.

To get started, read [`CONTRIBUTING.md`](CONTRIBUTING.md). It explains how to set up the monorepo, run checks and tests, choose a useful area to work on, and prepare a focused pull request. If you are unsure whether an idea fits the project, [open an issue](https://github.com/diqierjia/StrataGate-AgentMemory/issues) before investing in a large change.

## License

StrataGate is available under the [MIT License](LICENSE).

