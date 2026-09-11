---
name: siyuan
description: Search, read, and — only when asked — edit the user's local SiYuan (思源笔记) knowledge base through the mcp__siyuan__* tools. Use whenever a task may touch the user's own notes, notebooks, drafts or past writing.
---

# SiYuan notes (思源笔记)

The user's own knowledge base runs as a local SiYuan desktop app; the
`dsh-siyuan` plugin exposes it as the `siyuan` MCP server. Treat it as private
notebook material: read freely, write only on purpose.

## What is available

- Tools arrive as `mcp__siyuan__<tool>` — 29 aggregate tools (`search`,
  `document`, `block`, `outline`, `ref`, `attr`, `notebook`, `dailynote`, …).
  Pass the operation as `{"action": "...", ...}`.
- The bridge talks to SiYuan's own official MCP endpoint over loopback. Never
  read or edit `.sy` files, `siyuan.db`, or other workspace files on disk as a
  substitute — those are not a supported interface.
- The API token stays inside the bridge. Never print it, pass it as an argument,
  or paste it into a note or a reply.

## The connection

The tools stay listed even while SiYuan is closed: the bridge answers the MCP
handshake itself, and serves the live catalog, else this machine's cached one,
else the snapshot shipped with the package — so the list is never simply empty.
A snapshot entry can name a tool the running SiYuan does not have; an
`unknown tool` error means exactly that, not that the plugin is broken. Calls are the part
that needs the app — they report "SiYuan is not reachable" until it is open,
then work again on the very next call, with nothing restarted.

**Never start SiYuan on your own initiative.** It is the user's app, and opening
it as a side effect of the harness starting is not this bridge's business. If a
call reports it as unreachable, say so and ask the user to open it; run
`siyuan-ensure` (which does start it) only when they agree or ask for it.
`node node_modules/.bin/dsh-siyuan-bridge --doctor` prints the endpoint, where
the token came from, the active operation profile and the cached catalog —
without printing the token.

## Retrieval first

1. Derive a few narrow search terms from the request, the project, and any
   notebook or document the user names.
2. `mcp__siyuan__search` with `action: fulltext` (or `semantic`) — results carry
   the document path, a snippet and a block id.
3. Resolve names to ids when needed: `notebook` `action: list`, `document`
   `action: search_docs|list|get`.
4. Read only what matters: `block` `action: get_kramdown|get`, `outline`
   `action: get`, `ref` `action: backlinks|mentions`, `attr` `action: get`.

Quote what informs the answer — document path plus block id is enough for the
user to jump there. If nothing relevant turns up, say so instead of guessing at
what the user once wrote.

## Write only on request

- Write when the user asks for a change, or clearly asks for a note to be
  created, appended or corrected. Retrieval is never a licence to write back.
- State the target (notebook, document path or block id) and a one-line summary
  before the change, then report the resulting document or block id.
- Prefer surgical edits: `document` `action: create` for a new note, `block`
  `action: append|prepend|update` on a known block, `dailynote` only when the
  user wants today's note.
- Never create a work log, activity log or "agent session" note unless the user
  explicitly asks for one.

## Operation profile

The bridge enforces one of three levels on every call; an action outside the
active level is refused with a clear error rather than performed. The level is
re-read from the environment and the config file **on every call**, so a change
takes effect on the next call — the bridge does not have to be restarted, and
neither does the harness.

| Profile | Allowed |
|---|---|
| `readonly` | search and reads: documents, blocks, outlines, references, attributes, notebook list, system and workspace info |
| `authoring` (default) | the above plus document create and block insert/append/prepend/update, attribute set, daily-note append |
| `full` | the complete official surface, including delete, move, rename, notebook administration, file, SQL, import/export, history, repository, sync and network actions |

Change it in `~/.config/dsh-siyuan/config.json` (`{"profile": "readonly"}`) or
with the `SIYUAN_MCP_PROFILE` environment variable, which wins over the file: an
explicit environment statement is not something a stray key in a user config
file should be able to overrule. Do not raise the level on
your own initiative: ask the user, then make the change they asked for. Even at
`full`, name the target and purpose before a destructive, file, SQL, sync or
administrative call.
