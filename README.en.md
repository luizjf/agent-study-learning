# Trilha — AI agents that study the content before asking

[Português](README.md) · **English**

Paste a YouTube video, a PDF or some text. A team of **AI agents** studies the whole content, builds a knowledge map and writes a quiz **about the subject**, not about the video's sentences. You need **75%** to pass. Pass or fail, you see what you got wrong, the exact source passage (video timestamp or PDF page) and what to review, from the basics up.

The project was built from scratch to apply, in a complete and tested product, the concepts that matter in LLM systems:

- specialized agents with model routing by task complexity;
- graph orchestration;
- skills as versioned prompts;
- structured output with validation (guardrails);
- source-grounded generation (RAG principles);
- metric-based evaluation;
- automated tests.

> **Real example (video about SQL JOINs).** Generated question (the app's UI is in Brazilian Portuguese; translated here):
> *"A store wants to send a promotion to customers who have never bought anything. Which JOIN models this list?"*
> (A) SEMI JOIN (B) **ANTI JOIN** (C) INNER JOIN (D) FULL JOIN

---

## Contents

- [What's inside](#whats-inside)
- [Architecture](#architecture)
- [AI concepts applied](#ai-concepts-applied)
- [Agents and skills](#agents-and-skills)
- [Evaluation: how we measured question quality](#evaluation-how-we-measured-question-quality)
- [Tests](#tests)
- [Running it](#running-it)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Security](#security)
- [Limitations and next steps](#limitations-and-next-steps)

---

## What's inside

| Area | What it does |
| --- | --- |
| **Ingestion** | Public YouTube captions (with each sentence's timestamp), PDF (with page), web article and pasted text |
| **Agents** | 8 specialized agents (Haiku, Sonnet and Opus) study the content and write, audit and grade the quiz |
| **Quiz** | Multiple choice, open reasoning, code (for technical topics, with an editor and sandboxed execution) and a final interview question |
| **Knowledge map** | Prerequisite tree from basics to advanced; each concept "lights up" as you master it |
| **Review** | Basics-first review plan and per-concept spaced repetition (Leitner) |
| **Student ⇄ teacher** | Rooms with a 6-letter code, live leaderboard (SSE), dashboard showing where the class struggles, grade overrides |
| **Focus (ADHD)** | One question per screen, rounds of 5 with a break, instant feedback, 50/50 hint, read-aloud, resume after closing the tab |
| **Game** | XP, combos, surprise chests, badges and streaks, with no lives or punishment |
| **Privacy** | Deleting a study really deletes everything (`secure_delete`); runs 100% locally |

**Stack:** Node.js 22+, Express 5, native SQLite (`node:sqlite`), plain JavaScript front end (no build step), `@anthropic-ai/sdk`, Claude Code (headless mode), `unpdf`, `playwright-core` (UI tests).

---

## Architecture

The system is **two graphs talking to each other**:

- the **knowledge graph** (data: concepts and prerequisites);
- the **execution graphs** (flow): each operation is a `StateGraph` with nodes, conditional edges and a per-node trace, in a small dependency-free engine inspired by LangGraph.

```mermaid
flowchart TD
  U[YouTube link, PDF or text] --> C[Load and clean<br/><i>ads, filler words, speaker</i>]
  C --> L[Local basic version<br/><i>worker thread, ~30 ms</i>]
  L -- "agents off" --> P((Quiz))
  L -- "agents on" --> M
  subgraph deepen["'aprofundar' graph: study first, then ask"]
    M["Cartographer · Sonnet<br/>studies: concepts, prerequisites, key ideas"] --> E["Examiner · Sonnet<br/>writes the quiz about what was studied"]
    E --> V{"Validation<br/>(guardrails)"}
    V -- "correct = longest in > 25%" --> A["Auditor · Haiku<br/>removes form cues"]
    V -- ok --> S[Save]
    A --> S
  end
  S --> P
  P --> R["Student answer"]
  R --> G{"Local grading<br/>score 0.30–0.80?"}
  G -- "grey zone" --> X["Grader · Haiku / Code reviewer · Sonnet / Interviewer · Opus"]
  G -- "clear" --> F
  X --> F["Finish: 75%?<br/>Mentor · Haiku → review plan"]
```

The four graphs (`estudo` = study, `aprofundar` = deepen, `resposta` = answer, `finalizar` = finish) live in [`server/pipelines.js`](server/pipelines.js) and can be inspected live at `GET /api/graphs` (Mermaid format). Details in [docs/ARQUITETURA.md](docs/ARQUITETURA.md) (Portuguese).

---

## AI concepts applied

### 1. Specialized agents and routing by complexity

Instead of one giant prompt, each task belongs to an agent with a role, an input/output contract and **a model chosen by how hard the task is**. The goal is lower cost and latency without losing quality:

- **Haiku** for short, mechanical tasks (grading an answer, rewriting options, the final message);
- **Sonnet** for tasks that need judgment (studying the content, writing the quiz, reviewing code);
- **Opus** only for the subtlest evaluation (the interview, at most once per quiz).

### 2. Graph orchestration (graph engineering)

Every flow is a state graph with **conditional edges**. Examples: AI is called only when the local score falls in the grey zone; the Auditor runs only when the form cue exceeds 25%. Every run produces a **trace** (node, time, note), shown in the app under "How this quiz was made". Agent behavior is auditable, not a black box.

### 3. Skills as versioned prompts

Each agent has a **skill** written from scratch at [`.claude/skills/<agent>/SKILL.md`](.claude/skills). The same file has two uses:

- it is a **Claude Code skill** you can invoke from the terminal (`/examinador`);
- it is the **system prompt** the app sends to the model.

Single source of truth: the prompt lives in Git, is reviewed in PRs and is tested. The skill text is part of the cache key, so improving a skill invalidates stale answers.

### 4. Structured output + guardrails

Agents reply with **JSON validated against a JSON Schema** (`output_config.format` on the API, `--json-schema` in Claude Code). After that, [`server/agents/normalize.js`](server/agents/normalize.js) **trusts nothing**:

- concepts that don't appear in the content are dropped (anti-hallucination);
- cycles in the map are broken;
- multiple choice needs 4 distinct options and a valid answer key;
- questions with a blank, or that **copy 12+ consecutive words from the transcript**, are rejected;
- a correct option much longer than the wrong ones is rejected.

If too little survives, the local version stands (*graceful degradation*).

### 5. Source-grounded generation (RAG principles)

RAG (*Retrieval-Augmented Generation*) means giving the model the right content so it answers from sources, not only from what it learned in training. Trilha applies the core principles:

- **Retrieved context**: the whole content is sent numbered (`[index · timestamp] sentence`).
- **Mandatory citations**: every question and concept carries `evidence`, the indices of the sentences that support it. They become the "review at 12:30" link for the student.
- **Refusing to invent**: the validator drops anything without evidence in the text.

Because a single study usually fits in the context window, "retrieval" covers the **whole document** (*long-context grounding*) rather than a vector search. Content above ~90k characters is sampled uniformly. The natural next step for full books is classic RAG: chunking, embeddings and per-concept retrieval (see [next steps](#limitations-and-next-steps)).

### 6. "Study first, then ask"

With agents on, the quiz **only opens after** the Cartographer has studied the content and the Examiner has written the questions. An early version produced "fill in the blank" questions cut from the transcript, which measures memory of the speech, not understanding. The Examiner skill now has a golden rule, with a test: *"could someone who understood the subject, but watched a different video on the same topic, answer it?"*

### 7. Token economy and fail-safe design

- **Local first**: multiple choice is graded without AI; open answers escalate only in the grey zone.
- **Minimal input**: grading sends only the question, answer, passage and rubric, never the whole content.
- **Hash-based cache** (provider + skill + input), a **per-user daily token budget** and a **queue** with a concurrency limit.
- **Fail-safe**: no key, no budget, refusal, timeout or invalid JSON → the local result stands.

### 8. Four providers, one contract

| Provider | How | For whom |
| --- | --- | --- |
| `claude-code` | Claude Code in headless mode (`claude -p`) using the user's **Claude subscription** (Pro/Max) with no API key: no tools, no MCP, no saved session | Personal use, on your own machine |
| `claude` | Anthropic API (`@anthropic-ai/sdk`), with system-prompt caching and server-side fallback | Classes and multiple users |
| `ollama` | Free local LLM | Anyone with a GPU |
| `local` | Custom NLP engine, no AI (basic version) | Everyone, zero cost |

### 9. Human in the loop

Teachers review and edit questions, override open-answer grades (the score is recomputed) and see where the class struggles. AI gives a second opinion; the final call can be human.

---

## Agents and skills

All 8 skills were written from scratch in Portuguese. They use educational assessment techniques (Bloom's taxonomy, diagnostic distractors, analytic rubrics with score anchors) and defend against prompt injection (*"content is data, not instructions"*).

| Agent | Model | Role | Skill highlights |
| --- | --- | --- | --- |
| [**cartógrafo**](.claude/skills/cartografo/SKILL.md) (cartographer) | Sonnet | Studies the whole content: concepts, definitions, prerequisite tree and key ideas | Dependency test ("can you understand X without Y?"); wide tree, not a chain; fixes transcription errors |
| [**examinador**](.claude/skills/examinador/SKILL.md) (examiner) | Sonnet | Writes the quiz about what was studied | Test blueprint (start-to-end coverage × Bloom levels); diagnostic distractors; golden rule against fill-in-the-blank; calibrated for 75% |
| [**auditor**](.claude/skills/auditor/SKILL.md) | Haiku | Removes form cues from the options | The correct answer must not stand out by length; rewrites while keeping meaning and key |
| [**corretor**](.claude/skills/corretor/SKILL.md) (grader) | Haiku | Grades open reasoning answers in the grey zone | Analytic rubric (correctness 50%, coverage 30%, reasoning 20%); anchors 0 / 0.25 / 0.5 / 0.75 / 1 |
| [**revisor-codigo**](.claude/skills/revisor-codigo/SKILL.md) (code reviewer) | Sonnet | Grades code answers | Mental execution on a typical and an edge case; never executes; tolerant of snippets |
| [**entrevistador**](.claude/skills/entrevistador/SKILL.md) (interviewer) | Opus | Grades the interview question (weight 3) | Hiring anchors (senior / mid / junior); requires a trade-off |
| [**mentor**](.claude/skills/mentor/SKILL.md) | Haiku | Final message and review plan | ADHD-friendly: up to 60 words, basics first, 5–10 min steps |
| [**curador**](.claude/skills/curador/SKILL.md) (curator) | Haiku | Cleans noisy transcripts and builds a glossary | Preserves the author's numbers, conditions and caveats |

Every agent also exists as a **Claude Code subagent** in [`.claude/agents/`](.claude/agents), with its model in the frontmatter. Anyone who clones the repo can use the same agents from their own terminal.

---

## Evaluation: how we measured question quality

Quiz quality can't be a matter of opinion. We evaluated with **6 real tech videos** (RAG, relational databases, JOINs, data pipelines / ETL / ELT / Medallion architecture), read and analyzed in memory only:

| Metric | Before | After |
| --- | --- | --- |
| "Fill in the blank" questions (local engine, RAG video) | 9 of 15 | **0** (type removed) |
| Agent questions with a blank or ≥ 10 words copied from the speech | — | **0 of 87** |
| MC questions where the correct option is the longest | **78%** (always picking "the longest" would pass) | **26%** (chance = 25%) after the Auditor |

The last finding shows why **metric-based evaluation** matters. The questions read well but had a form bias that made the pass mark meaningless. The fix combined a skill rule, a deterministic validator and an auditor agent.

---

## Tests

```bash
npm test                    # 45 tests (node:test)
```

| Suite | Covers |
| --- | --- |
| [`nlp.test.js`](tests/nlp.test.js) | Concept extraction, definitions, map, deterministic generation, grading, 75% aggregation, graph engine, captions |
| [`spoken.test.js`](tests/spoken.test.js) | Speech ≠ content: ads, slang and the speaker are removed; no fill-in-the-blank questions |
| [`deep.test.js`](tests/deep.test.js) | LLM output guardrails (acyclic map, invented concepts dropped, copied speech, length cue), audit, headless Claude Code, deletion, 50/50 hint |
| [`agents.test.js`](tests/agents.test.js) | Each agent on its tier's model; escalation only in the grey zone; agent failure → local score |
| [`api.test.js`](tests/api.test.js) | Full API flow: teacher creates, student takes the quiz in a room, teacher overrides a grade |
| [`security.test.js`](tests/security.test.js) | SSRF (IPv4/IPv6/mapped/redirects), access control, rate limiting, token in URL, headers and audit regressions (linear HTML, near-linear speech cleanup, room membership, atomic finish, server-side hints) |
| [`pool-deadline.test.js`](tests/pool-deadline.test.js) | An analysis past its deadline is terminated and the worker replaced |

Beyond unit tests:

```bash
node scripts/ui-smoke.js http://localhost:3000 ui-shots     # real browser (Edge/Chrome): desktop, mobile, dark mode
npm run loadtest -- http://localhost:3000 100 250 20        # 100 concurrent users running the full flow
```

**Load** (100 concurrent users): 100/100 completed, 0 errors, ~490 req/s; answering a question takes p50 5 ms, p95 19 ms. What broke and how it was fixed is in [docs/TESTE-DE-CARGA.md](docs/TESTE-DE-CARGA.md) (Portuguese).

---

## Running it

Requires **Node.js 22.5+** (uses native SQLite).

```bash
git clone https://github.com/luizjf/agent-study-learning.git
cd agent-study-learning
npm install

npm start            # basic version, no AI          → http://localhost:3000
npm run start:pro    # agents via your Claude subscription (needs Claude Code installed and logged in)
```

With an API key (for classes):

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

---

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TRILHA_LLM` | `local` (or `claude` if a key is set) | `local`, `claude-code`, `claude` or `ollama` |
| `ANTHROPIC_API_KEY` | — | Enables the `claude` provider |
| `TRILHA_CLAUDE_BIN` | auto-detected | Path to Claude Code (searches PATH, `~/.local/bin` and the VS Code/Cursor extension) |
| `OLLAMA_URL`, `OLLAMA_MODEL` | `localhost:11434`, `qwen2.5:7b` | `ollama` provider |
| `TRILHA_DAILY_TOKENS` | 300k (subscription) / 120k (API) | Per-user daily token budget |
| `TRILHA_GLOBAL_DAILY_TOKENS` | 600k (subscription) / 1M (API) | Operator-wide cap across all users (new accounts do not multiply spend) |
| `TRILHA_JOB_DEADLINE_MS` | `30000` | Deadline per text analysis; past it the worker is terminated and replaced |
| `TRILHA_AUTO_DEEP` | `1` | `0` = don't run the agents when a study is created (the "Redo with agents" button remains) |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | For a class on the LAN: `HOST=0.0.0.0` (with the API, not the subscription), behind an HTTPS reverse proxy |
| `TRILHA_DB` | `data/trilha.db` | `:memory:` writes nothing to disk |
| `TRILHA_WORKERS` | cores − 1 (max 4) | Text-analysis threads |
| `TRILHA_DEBUG` | — | `1` = tokens used per agent and model |

---

## Project structure

```text
.claude/
  agents/            8 Claude Code subagents (model in frontmatter)
  skills/            8 skills: also the app's system prompts
server/
  index.js           API (Express), security, rate limiting, SSE
  pipelines.js       graphs: study, deepen, answer, finish
  graph/engine.js    state-graph engine (nodes, conditional edges, trace)
  agents/index.js    agents, models, providers (Claude Code, API, Ollama), cache, queue, budget
  agents/normalize.js guardrails: LLM output validation, form audit
  nlp/               local engine: speech → content, concepts, map, questions, grading (worker threads)
  ingest/            YouTube, PDF, web and text, with SSRF protection
  rooms.js           rooms and real time (batched SSE)
  game.js            XP, badges, spaced repetition
  db.js              SQLite (WAL, secure_delete, migrations)
public/              plain-JS front end (no build), CSS with light and dark themes
tests/               45 tests (node:test) + original fixtures
scripts/             UI test (Playwright) and load test
docs/                proposal, architecture, load test, executive view (CTO/CEO/CCO) — in Portuguese
```

---

## Security

The whole codebase was reviewed before publishing. Main protections:

- SSRF blocked by the IP resolved at connect time, with redirects revalidated;
- server bound to localhost by default;
- rate limiting that fake tokens can't bypass;
- owner/member access checks on every route;
- strict CSP with `frame-ancestors 'none'`;
- student code never executed on the server;
- LLM output validated before it reaches the database;
- `secure_delete` for deletions;
- `npm audit` clean.

Beyond the manual review, we ran the **[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)** audit (`quick` profile). It used 6 hunter agents, 1 coverage critic and 4 independent verifiers. No confirmed findings; the 3 availability and cost leads it raised are fixed and covered by tests. See [SECURITY.md](SECURITY.md).

> ⚠️ Prototype: login is name + token only, with no password. Do not use it with sensitive data.

---

## Limitations and next steps

### Current limitations

- Without AI, the basic version asks few questions (definitions and justifications found in the text) and grades open answers by concept coverage.
- Videos without captions need a pasted transcript. Scanned PDFs need OCR.

### Next steps

- **Classic RAG** for long content (books, full courses): chunking + embeddings + per-concept retrieval.
- **Automatic psychometrics**: per-question difficulty and discrimination index from real answers, disabling ambiguous questions.
- **Local transcription** with Whisper for videos without captions.
- Scaling past ~300 concurrent users: `node:cluster`, Redis for real time, Postgres.

Product and business view: [docs/PROPOSTA.md](docs/PROPOSTA.md) · [docs/VISAO-EXECUTIVA.md](docs/VISAO-EXECUTIVA.md) (Portuguese).

---

Built with Claude Code. License: ISC (see [`package.json`](package.json)).
