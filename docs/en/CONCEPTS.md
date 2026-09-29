# Concepts: what each thing is and why it's worth it

🌐 **English** | [Español](../CONCEPTOS.md)

This document is written for someone who has **no** reason to know what an
embedding is. There is no code here. The idea is that by the end of reading it you
understand what we built, with which pieces, and above all **what concrete problem
it solves**.

If you want the reference for the tools one by one, that is in
[`HOW_IT_WORKS.md`](HOW_IT_WORKS.md). This is the "why".

---

## 1. The problem, before talking about technology

A development team's knowledge lives scattered across four places that don't talk
to each other:

| Where it lives | What's there |
|---|---|
| **The task tracker** | What needs to be done, who is doing it, which column it's in |
| **GitHub** | The code, the commits, the branches, the PRs |
| **The documentation** (the `.md` files inside each repo) | How each thing works, what was decided and why |
| **People's heads** | Everything else |

When someone asks *"where did the BILLING case generation work end up?"*, the
answer isn't in any of the four: it is **spread out**. There's a card in the task tracker, a branch on GitHub with half-finished work, and a markdown file on that
branch that explains the design. Putting the answer together means opening three
tabs and knowing beforehand where to look.

That "knowing beforehand where to look" is exactly what doesn't scale. It's what
makes asking the person who did it always faster than looking it up — and that's
why knowledge isn't shared: it's interrupted.

**What we built is the bridge.** An assistant that already knows where to look,
looks on its own, and answers citing where it got each thing.

---

## 2. What an MCP is

**MCP** (Model Context Protocol) is a standard for connecting **tools** to an AI
assistant.

The analogy that works is the **wall outlet**. Before there was a standard for
plugs, every appliance came with its own way of connecting to electricity. The
standard doesn't make the lamp shine better: it makes any lamp fit any wall.

MCP is that for AI. An "MCP server" is an adapter that says: *"I know how to talk
to this system, and I offer the assistant these concrete actions"*. The assistant
doesn't need to know anything about GitHub or our database: it just sees a list of
available actions with their description.

This project is an MCP server:

- **`repo-rag-mcp`** — the repositories: live status + search over the
  documentation. **Read-only.**

### What a "tool" is

A **tool** is a concrete action the assistant can execute. For example
`list_branches` ("list the branches of this repo") or `get_file_content` ("fetch this file").

The important detail, which surprises almost everyone: **the assistant chooses
which one to use by reading its description, the way it would read a manual.**
There is no `if` in the code saying "if the user asks X, call Y". That's why in
this project the tool descriptions are written so carefully: that is where it
explains when to use it, when *not* to, and which one it gets confused with. That
description **is** the routing logic.

---

## 3. What RAG is

**RAG** = *Retrieval-Augmented Generation*. In plain words: **search first, then
answer**.

A language model on its own, without RAG, is like a brilliant employee who studied
a great deal up to a certain date and then went on a trip. It knows a lot about
the world, but **knows nothing about our repos**. If you ask it about the organization's
appointment system, it will do the worst thing it can do: invent a plausible
answer, because its job is to produce text that sounds good.

RAG changes the mechanics in two steps:

1. **Search** for the documentation fragments that talk about what you asked.
2. **Hand them to the model** together with the question, and ask it to answer
   *using that*.

The model stops being the one that knows and becomes the one that **writes up**.
The truth comes from our documents. That's why the system can cite file and branch
in every answer, and why it can say "I found nothing about this" instead of making
things up.

> A phrase to remember: **RAG doesn't teach the model anything. It hands it the
> notes open to the right page.**

### Step 1 is the hard one

It sounds easy until you ask yourself: how does a machine know that the question
*"how do residents get into the system?"* is answered by a section titled
*"Authentication with DNI and tax key"*, if they don't share a single word?

That's where embeddings come in.

---

## 4. What an embedding is

An **embedding** is a way of converting a text into **coordinates of meaning**.

The analogy: imagine a giant map where each text occupies a position. Not a
geographic map — a map of *topics*. Everything that talks about authentication
lands in one zone; everything that talks about reports lands in another, far away.
Texts that say the same thing in different words land **close together**, because
what decides the position is the meaning, not the letters.

An embedding is a text's address on that map. Technically it is a long list of
numbers, but it's enough to understand it this way: **it is a position, and you
can measure distances between positions**.

So searching becomes geometry:

1. The position of the **question** on the map is calculated.
2. The documentation fragments **closest** to that position are looked up.
3. Those are the results.

That's why "how do residents get in" finds the authentication section: on the map
of meanings they are next to each other, even though in the dictionary they don't
touch.

The one that calculates those coordinates is a model specialized in that — we use
one called `bge-m3`, **running on the local machine**. We come back to this in
point 8, because it has an important consequence for the organization.

### Chunks: why the documentation is cut into pieces

An entire README doesn't have *one* meaning: it has ten. If we calculate a single
position for the whole file, it ends up at the average of all its topics — that is,
nowhere useful.

That's why each document is cut into **chunks** (fragments), respecting the titles
and subtitles the author already wrote. Each section is a unit of meaning and gets
its own position on the map.

It is the difference between indexing a whole book under "book" and indexing it by
chapter. When you search, it gives you back the chapter, not the library.

### The index: what it is and why it exists

Calculating a text's position takes time. Doing it for all the documentation of all
the repos at the moment someone asks would be unacceptably slow.

So it's done **once, in advance**, and saved in a local database (a file on your
machine). That is **the index**: the copy of the documentation with its coordinates
already calculated. Searching against the index is instant.

**Key consequence, and the one that confuses the most: the index is a snapshot, not
a mirror.** It reflects the documentation as it was the last time it was indexed.
If someone rewrote a README ten minutes ago, the search still answers with the
previous version.

That's why the server **reindexes itself on startup** —every repo whose index is
more than 12 hours old is updated in the background— and there is also a tool to
force it by hand. And that's why the live status (commits, PRs, issues) does **not**
go through the index: that is asked of GitHub at that moment, always.

> Rule of thumb: *"what happened?"* is live. *"How does it work?"* is index.

---

## 5. Why the search uses two engines at once

The search by meaning has a serious blind spot: **it doesn't know how to search for
proper names**. If you ask about `BILLING`, or a case number, or the exact
name of a class, the map of meanings doesn't help — those terms don't have
"meaning", they have **identity**.

For that there is the classic search by **exact word** (it's called BM25; it's the
age-old technique: it counts occurrences and weighs how rare each term is). That
one finds `BILLING` instantly, but it doesn't understand that "how do residents
get in" and "authentication" are the same thing.

Each one covers the other's blind spot, so **both run and the results are
combined**. This isn't theory: we measured it on real questions taken from a usage
conversation.

| | Found the correct document in the top 5 |
|---|---|
| Only by meaning | 4 out of 6 |
| Only by exact word | 3 out of 6 |
| **Both combined** | **4 out of 6, and much better ranked** |

The case that demonstrates it: the real BILLING question went from **position 146
to position 3**.

*(Honest caveat: it's 6 questions. The direction is clear, the precision of the
number is not. More real usage questions are needed to refine it — and that only
comes from using the system.)*

**From here comes a practical tip for whoever asks:** include in your question the
literal terms you know. "What does the BILLING documentation say about case
generation?" works much better than "how's the commerce thing going?", because it
gives material to both searchers.

### How they are combined (in one sentence)

A "closeness on the map" score and a "how many times the word appears" score are on
scales that can't be added — it's like averaging degrees Celsius with kilometers.
So the scores aren't added: **the positions in each ranking are added**. What came
out first in either of the two lists goes up. It's a standard technique and nothing
needs recalibrating when the model changes or the documentation grows.

---

## 6. About the word "topics"

A clarification, because it causes confusion: **"topic" is not a concept of this
server.** There are no configurable topics or categories that someone has to
maintain. The organization of the content comes on its own from the structure the
documents already have (titles and subtitles) and from the coordinates of meaning.

If the word came up in some conversation, it comes from somewhere else: the memory
system the assistant uses between sessions uses "topic" as a label to group notes
that evolve. It is a piece of the assistant, not of our repos.

---

## 7. Why an MCP and not "just let it use the GitHub API"

This is the right question and deserves a concrete answer. GitHub has a public API;
a modern assistant could, in principle, hit it directly. Four reasons why that
isn't enough:

**1. The API answers with raw data; we need answers.**
"How is the portal doing?" with the raw API is four or five chained calls (fetch
the repo, the default branch, the latest commit, the open PRs, the issues) and then
putting the puzzle together. Our `get_project_summary` is **one** call that returns
exactly that, already ordered. Fewer steps, fewer places to go wrong, faster and
cheaper answers.

**2. The API doesn't search by meaning. Full stop.**
GitHub has no way of answering "which project handles SMS notifications?" without
you already knowing which repo to look in. The entire RAG half of this system —the
map of meanings, the fragments, the hybrid search— **doesn't exist in GitHub**. It
is the part that adds real value and can't be replaced with API access.

**3. Read-only, guaranteed by construction.**
An assistant with a generic GitHub token can close an issue, approve a PR or push.
Not because anyone wants it to: because it picked the wrong tool at an ambiguous
moment. In our server **those functions simply don't exist in the code**. It is not
a setting that can be changed by accident nor a permission someone can touch:
there's nothing to call. The only thing it writes is the local index, on your
machine.

**4. Our conventions are built in.**
In our organization `main` is production and `dev` is the replica, and work in progress
lives on branches that never reach `main`. The server indexes those two branches
plus any branch with recent activity, and **each result says on which branches it
appears** — that is, whether it's already in production or still half-done work. An
assistant with raw API access looks at `main` and tells you the project doesn't
have that functionality. And it would be right, and it would be wrong.

To sum up: the API is a source. The MCP is a **source plus the judgment of how to
use it**, and that judgment is what today lives only in the team's heads.

---

## 8. What leaves the organization and what doesn't

Important for any conversation about internal data:

- **Text analysis is local.** The coordinates of meaning are calculated with a model
  that runs on the machine, not on an external service. The repos' documentation is
  **not sent to any AI provider** to be indexed.
- **The index is a local file.** There is no cloud database.
- **The only thing that goes out to the internet** is **read** queries to the GitHub
  API, with a token the team already has.
- **Nothing is written to GitHub.** Ever.

---

## 9. The limits, stated plainly

So that nobody gets a surprise:

- **The index can be old.** It refreshes itself on startup and can be forced, but in
  between it's a snapshot. The live status doesn't have this problem.
- **It doesn't read the source code**, only the documentation in markdown. If you
  ask how a function is implemented, the server doesn't have it.
- **The quality of the answers is the quality of the documentation.** This is the
  most important thing in the whole document: RAG doesn't create knowledge, it finds
  it. A repo without documentation doesn't become searchable by installing this. The
  good side is that it gives a direct and visible incentive to document: what gets
  written becomes searchable by the whole team that same night.
- **It doesn't replace looking at the repo.** For the exact diff of a commit or the
  discussion on a PR, GitHub is still better.
- **The assistant can pick the wrong tool.** It is less likely with well-written
  descriptions, but it happens. That's why every answer cites the file and the
  branch: it can be verified.

---

## In two sentences

We had the team's knowledge spread across three systems that don't talk to each
other, and the fastest way to get at it was to interrupt someone. Now there is an
assistant that knows where to look, looks on its own, answers citing the source, and
**can't break anything because it has nothing to write with**.
