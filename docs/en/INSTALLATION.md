# Installation (Windows + OpenCode)

🌐 **English** | [Español](../INSTALACION.md)

A step-by-step guide. At the end you'll be able to ask the agent about the status of
the repos without leaving the editor.

Estimated time: 20 minutes, most of it waiting on downloads.

---

## 1. Requirements

### Node.js 20 or higher

```powershell
node --version
```

If you don't have it: https://nodejs.org (pick the LTS version).

### pnpm

```powershell
npm install -g pnpm
pnpm --version
```

### Ollama + the embedding model

Ollama is what converts the documentation text into numbers so it can be searched
by meaning. It runs **locally**: nothing that is indexed leaves your machine.

**1. Install Ollama.** With winget, from PowerShell:

```powershell
winget install --id Ollama.Ollama
```

Or by downloading the installer from https://ollama.com/download — it makes no
difference.

> **Open a new terminal after installing.** The installer adds Ollama to the PATH,
> but terminals that were already open keep the old PATH and will tell you
> `ollama: command not found`. It is not an installation error: close and open
> again.

**2. Download the model** (only once; it is multilingual and weighs about 1 GB, so
it can take a while):

```powershell
ollama pull bge-m3
```

**3. Verify** that everything is in place:

```powershell
ollama list
```

You should see `bge-m3:latest` in the list.

Ollama starts on its own with Windows. If at some point it doesn't respond, open a
terminal and leave `ollama serve` running.

---

## 2. Install the server

```powershell
cd C:\path\where\you\want
git clone <repo-url> repo-rag-mcp
cd repo-rag-mcp
pnpm install
pnpm build
```

> `pnpm install` compiles a native component (`better-sqlite3`). If you see a
> warning like *"Ignored build scripts"*, run `pnpm rebuild better-sqlite3` and
> that's it. Visual Studio isn't needed: it downloads an already-compiled binary.

---

## 3. Generate the GitHub token

The server needs a token to read the repos. **Read-only**: even if someone asked
it to, the server has no function that writes.

1. Go to https://github.com/settings/personal-access-tokens/new
   (Settings → Developer settings → Personal access tokens → **Fine-grained tokens**)
2. **Token name**: `repo-rag-mcp`
3. **Expiration**: 90 days (write down the date, you'll have to renew it)
4. **Resource owner**: your organization
5. **Repository access** → *Only select repositories* → pick only the repos you
   want to query
6. **Permissions** → *Repository permissions*, set to **Read-only**:

   | Permission | Value | What for |
   |---|---|---|
   | Contents | Read-only | Read the README and the rest of the documentation |
   | Metadata | Read-only | Repo data (mandatory, enabled automatically) |
   | Pull requests | Read-only | Count open PRs |
   | Issues | Read-only | Count open issues |

   **Don't enable anything under Write.**

7. **Generate token** and copy the value. GitHub shows it only once.

> If the token belongs to an organization, it may be left pending approval by an
> administrator. Until they approve it, calls will return permission errors.

---

## 4. Configure the server

### 4.1 The `.env` file

Copy the example and edit it:

```powershell
copy .env.example .env
notepad .env
```

Paste the token:

```
GITHUB_TOKEN=github_pat_whatyoucopied
```

The rest of the variables already have default values that work. **Don't share or
upload this file**: `.gitignore` already excludes it.

### 4.2 The `repos.json` file

This one is versioned: it has no secrets, it only says which repos to watch.

```json
{
  "org": "organization-name",
  "defaultDocs": ["README.md", "CLAUDE.md", "TRACKER.md", "NEGOCIO.md", "docs/**"],
  "repos": [
    {
      "alias": "turnos",
      "repo": "sistema-turnos",
      "description": "Online appointments for procedures"
    }
  ]
}
```

- `alias` is the short name you'll use when asking ("the turnos one"). Lowercase
  and hyphens.
- `repo` is the exact name on GitHub.
- `docs` is optional per repo: if a project keeps its documentation elsewhere, put
  it there and it overrides the general list.

---

## 5. First indexing run

```powershell
pnpm reindex
```

Expected output:

```
Indexing 4 repositories with bge-m3...
  OK    example-org/sistema-turnos: 3 files, 27 chunks
  OK    example-org/trámites: 2 files, 14 chunks
  ...
Index up to date.
```

The first time it takes longer because Ollama loads the model into memory.

To reindex a single project:

```powershell
pnpm reindex turnos
```

---

## 6. Connect the server to OpenCode

Open (or create) the OpenCode configuration file and add the server:

```json
{
  "mcp": {
    "repos-rag": {
      "type": "local",
      "command": ["node", "C:/full/path/repo-rag-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

Details that matter:

- Use the **absolute path** to `dist/index.js`.
- Forward slashes `/`, or double backslashes `\\`. A single `\` breaks the JSON.
- It has to point to `dist/`, not `src/` (that's why you ran `pnpm build`).
- There is no need to pass environment variables: the server reads its own `.env`.

Restart OpenCode and ask it something like *"list the projects for me"*.

---

## 7. If something fails

### "Cannot reach Ollama at http://localhost:11434"

Ollama isn't running. Open a terminal and leave:

```powershell
ollama serve
```

### "Ollama does not have the model bge-m3"

```powershell
ollama pull bge-m3
```

### "Not found on GitHub: org/repo"

Three possible causes, in order of likelihood:

1. The name in `repos.json` doesn't exactly match the one on GitHub (check
   capitalization and hyphens).
2. The token doesn't include that repo under *Repository access*.
3. The token hasn't yet been approved by an organization administrator.

### "GitHub rejected the token (401)"

The token was copied wrong, expired or was revoked. Generate a new one and update
`.env`.

### "The GitHub token is not allowed to read..."

It's missing a permission. Go back to step 3 and check that Contents, Metadata,
Pull requests and Issues are all four set to Read-only.

### "GitHub rate limit hit"

You asked for too much in a short time. The message says at what time the quota is
released. It usually happens with `refresh_index` without arguments over many
repos: reindex one at a time.

### "The documentation index is empty"

You haven't run `pnpm reindex` yet, or the index was deleted. Run it.

### The agent answers with old information

The index is a **snapshot**, not a mirror. If the documentation changed, run
`pnpm reindex` (or ask the agent to use `refresh_index`). The status of commits and
PRs, on the other hand, is always live and never gets old.

### The server doesn't show up in OpenCode

Try starting it by hand to see the error:

```powershell
node dist/index.js
```

It should print `repo-rag MCP server running on stdio — ...`. If it prints
something else, that is the real problem. Stop it with `Ctrl+C`.
