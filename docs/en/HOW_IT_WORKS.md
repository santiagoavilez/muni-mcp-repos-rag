# How it works

🌐 **English** | [Español](../COMO_FUNCIONA.md)

An explanation of what the server does, when it uses each tool and what to expect
from each answer. You don't need to know anything about embeddings to read this.

If what you're after is understanding the underlying concepts —what RAG is, what
an embedding is, why an MCP and not the GitHub API— that is in
[`CONCEPTS.md`](CONCEPTS.md).

---

## The idea in one paragraph

The server doesn't answer questions: it **gathers information and hands it to the
model**, which is the one that writes the answer. It gives the agent nine tools
and a description of when each one is worth using. The agent chooses.

---

## The two sources of information

This is the distinction that explains almost all of the system's behavior.

### Live status

Commits, pull requests, issues, the content of a file. They are queried from
GitHub at that moment, every time.

- **Always up to date**, to the second.
- Takes a bit longer (it has to go over the network).
- Never needs to reindex anything.

### Documentation search (RAG)

Questions about what the projects *do*: how something works, what was decided,
what is missing. They are answered by searching a local copy of the documentation.

- It answers by **meaning**, not by exact words: "how do residents get into the
  system?" finds the section about authentication with a national ID number (DNI),
  even if it doesn't say "get in" anywhere.
- It is instant (it doesn't go out to the network).
- **It's a snapshot, not a mirror**: it reflects the documentation as it was the
  last time it was indexed.

Rule of thumb: *what happened?* is live. *How does it work?* is documentation
search.

---

## The nine tools

### `list_projects`

Lists all the configured repos with their description, when they were last touched
and whether they are indexed.

> "What projects do you have?" · "list the repos for me"

It is also what the agent uses when you name a project from memory and it needs to
find out which repository you mean.

### `get_project_status`

Current state of a project: main branch, latest commit (who, when, what), how many
PRs and how many issues are open. Live.

> "How is the turnos one doing?" · "how many open PRs does trámites have?"

### `get_recent_commits`

The latest commits, raw: short sha, author, date and message. Live. By default it
brings 10.

> "What was done this week on the portal?" · "who has been working on
> trámites?"

It is useful for putting together an activity summary by hand. It doesn't read the
documentation.

### `search_project_docs`

The documentation search. It returns the most relevant fragments, each with the
repo, file and branch it came from, so the agent can cite where it got each thing.

It uses **two searchers at once** and combines the results:

- **By meaning**: it understands what the question is about. You ask "how do
  residents get in" and it finds the authentication section even if it doesn't say
  "get in".
- **By exact word**: it finds the term exactly as written. "BILLING", a case
  number, the name of a class.

Each one covers the other's blind spot. The first doesn't know how to search for
proper names; the second doesn't understand paraphrases. That's why **it helps to
include in the question any literal terms you know** — they make the search much
more precise.

Each result says how it was found: `both` means the exact words are in the text,
which is a much stronger signal than merely resembling it in meaning.

> "How do residents authenticate?" · "which project handles SMS notifications?" ·
> "what does the turnos tracker say about reports?"

It can be narrowed to one project, or to one branch, or search everything at once.
If it finds nothing, it says so explicitly instead of making something up: either
the documentation doesn't cover the topic, or the index is old.

### `refresh_index`

Rebuilds the search index: it re-reads the documents from GitHub, cuts them into
pieces and processes them locally.

> "Update the index" · "reindex turnos"

It is the only tool that writes anything, and it writes **only on your machine**.
Reindexing everything can take several minutes; a single project, seconds.

### `get_project_summary`

An executive summary in a single call: the live status plus the beginning of the
README. Designed so you don't have to chain two or three tools.

> "Tell me how the portal is doing" · "summarize trámites"

It doesn't use the index, so it is never out of date.

### `list_branches`

Lists a repo's branches with their latest activity and whether their documentation
is indexed.

> "Which branch is the BILLING task on?" · "what branches are there in
> trámites?"

It is useful because all the other tools look at the main branch unless told
otherwise. If the work hasn't been merged yet, this is the one that finds it.

### `get_file_content`

Brings a whole file, uncut.

> "Show me the complete TRACKER of turnos" · "read me the portal's NEGOCIO.md"

When you ask for *a file by its name*, this one goes. When you ask about *a topic*,
`search_project_docs` goes, which searches all the files without you having to
guess which one it is in.

### `compare_status`

The live status of several projects in a single call, ordered by most recent
activity. If you don't pass repos, it compares them all.

> "How are all the projects doing?" · "which one moved last?"

It is `get_project_status` repeated, but without chaining one call per repo. A repo
that fails is reported as such and doesn't take down the rest of the listing.

---

## From question to tool

| What you ask | What it triggers |
|---|---|
| "What projects are there?" | `list_projects` |
| "How is turnos doing?" | `get_project_summary` |
| "How many open PRs does the portal have?" | `get_project_status` |
| "What was done this week?" | `get_recent_commits` |
| "How do residents authenticate?" | `search_project_docs` |
| "Which project sends SMS?" | `search_project_docs` (across all repos) |
| "Show me the TRACKER of turnos" | `get_file_content` |
| "Which branch is X on?" | `list_branches` |
| "Update the documentation" | `refresh_index` |
| "How are all the projects doing?" | `compare_status` |

---

## Branches: production, replica and work in progress

Our repos follow a convention: **`main` is production** and **`dev` is the
replica**. The index covers both, plus any branch with activity in the last 30
days.

This matters because **the documentation of work in progress lives on the branch
where the work is happening**, and doesn't reach `main` until it is merged. If the
index only looked at `main`, everything half-finished would be invisible — exactly
what one most wants to ask about.

That's why each search result says **on which branches** it appears:

- Appears on `main` → it is in production.
- Appears on `main` and `dev` → the same on both.
- Appears **only** on a feature branch → it is work in progress, not yet in
  production.

When a text is identical across several branches it is shown **only once**, listing
all the branches where it is. Without that, a repo with six active branches would
fill the results with six copies of the same thing.

---

## When the index is updated

Indexing means reading the documentation from GitHub and processing it locally. It
costs time and machine work, so it doesn't happen on every question. It happens at
three moments:

1. **When the server starts**, on its own. Every repo whose index is more than 12
   hours old is updated in the background. That threshold can be changed, or
   disabled.
2. **When you ask for it**, with `refresh_index`.
3. Outside the agent, by running `pnpm reindex` by hand.

Point 1 runs **without blocking startup**: the tools already answer —from the old
index— while the update goes on behind the scenes. It is on purpose: a server that
answers with yesterday's index is far better than one that leaves you waiting for
it to finish indexing.

The practical consequence that remains: if someone rewrote a README ten minutes
ago, `search_project_docs` may keep answering with the previous version until the
next update. When in doubt, ask the agent to reindex that repo and ask again. The
status of commits, PRs and issues does **not** have this problem: it is always
live.

---

## What this server does NOT do

- **It doesn't write anything to GitHub.** It doesn't create or close issues,
  comment, approve PRs or push. It's not a setting that can be changed: those
  functions don't exist in the code.
- **It doesn't read the source code.** The index only takes documentation in
  markdown. If you ask how a function is implemented, the server doesn't have it.
- **It doesn't replace looking at the repo.** For fine detail —the exact diff of a
  commit, the discussion on a PR, a configuration file— opening GitHub is still
  better.
- **It doesn't make things up.** When the search finds nothing relevant it says so,
  and when a repo doesn't respond it reports it instead of silently omitting it.
- **It doesn't send your documentation anywhere.** Text processing is local, with
  Ollama on your machine. The only thing that goes out to the internet is read
  queries to the GitHub API.
