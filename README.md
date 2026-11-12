# Vault

Your Obsidian Markdown vault for AI agents, exposed through one MCP server.

Repository: [alastairgarner/vault](https://github.com/alastairgarner/vault).
The MCP server identifies itself as `vault`; client-side connection labels can also
use Vault. Existing tool names and deployment identifiers are unchanged.

## Intent

Plain Markdown files are authoritative. Reuse [QMD](https://github.com/tobi/qmd) for keyword and semantic search rather than building a search engine. Combine retrieval and safe file editing behind one endpoint accessible to agents on the trusted home LAN and Tailscale network.

Target deployment: Docker on a Raspberry Pi; assess ARM64 support and model resource requirements before promising local semantic-search performance. A stronger tailnet host is an option, not a settled decision.

## Proposed first slice

- Discover allowed directories and list notes.
- Search via QMD; return compact excerpts and references.
- Read authoritative files or sections directly from disk.
- Create Markdown notes without overwriting existing files.
- Edit using unique exact old-text/new-text replacements and expected content hashes.
- Move or rename notes, updating Obsidian wiki and Markdown links to them.
- Enforce allowed-root boundaries, including symlink/traversal protection.
- Serialize writes per file, verify hashes inside that critical section, and use safe atomic replacement.
- Refresh the derived search index after writes and expose pending/stale indexing explicitly.
- Offer stdio for local development and Streamable HTTP for shared access.

V2 requires a named bearer token for every HTTP MCP request. Administrators manually configure token hashes in a private JSON file; all registered clients can read/search, edit and move existing notes throughout the allowed root, but can create new notes only inside lowercase root-relative `ai/` or `meetings/`. Keep access on the trusted LAN/tailnet and use HTTPS through Traefik. See [authentication setup](docs/authentication.md).

## Not settled

Target topology is Raspberry Pi Docker behind the existing Traefik reverse proxy and private DNS, accessible from the trusted LAN/tailnet. V2 token authentication is implemented locally. Semantic models, refresh scaling, and deployment hardening remain open; only local fixture Docker testing is currently authorized/performed.

## Out of scope initially

Kanban UI, task orchestration, repository synchronisation, notifications, and a bespoke vector database/search engine. Tasks and specs can initially be ordinary Markdown conventions.

## Local prototype

TypeScript **7.0.2** (registry `latest` when checked), pnpm **12.14.0**, Node.js **22+**. MCP servers are fully supported by the official TypeScript SDK. Linux with `/proc/self/fd` is currently required for descriptor-anchored filesystem containment.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# Local fixtures only; never point these commands at your real vault.
mkdir -p .local/notes/ai
pnpm dev "$PWD/.local/notes" "$PWD/.local/state"
# Or: pnpm build && pnpm start "$PWD/.local/notes" "$PWD/.local/state"
```

The entrypoint speaks MCP over **stdio**, not an interactive shell. For an MCP client, use command `node` with args `["/absolute/project/dist/src/main.js", "/absolute/fixture-notes", "/absolute/private-state"]` after `pnpm build`. Do not use a package-manager wrapper as the MCP command: its progress output may pollute protocol stdout.

- `src/main.ts`: stdio entrypoint; `src/server.ts`: validated MCP tool definitions.
- `src/http-main.ts` / `src/http.ts`: authenticated Streamable HTTP entrypoint and transport lifecycle.
- `src/auth.ts` / `src/token-hash.ts`: manual hash-only credential config, bearer validation, and stdin-only hashing helper.
- `src/brain.ts`: thin QMD SDK integration and serialized operations.
- `src/files.ts`: contained Markdown access and atomic publication; `src/images.ts`: bounded base64/image-signature validation.
- `src/errors.ts`: unknown-error handling; `test/brain.test.ts`: fixture-only integration/safety tests, including a compiled stdio client/server round trip.
- `dist/`: generated JavaScript; never edit or commit it. Source imports intentionally use `.js` for Node ESM after compilation.

Tools: `brain_status`, `note_list`, `note_read`, `note_create`, `note_edit`, `note_move`, `attachment_create`, `brain_refresh`, `note_search`; in external assets mode also `attachment_list` and `attachment_delete`.

- `src/links.ts`: Obsidian-style link parsing, resolution and rewrite planning for `note_move`.

### Image attachments

`attachment_create` is separate from Markdown editing, available over HTTP and stdio
with the same client permissions. Pass `{ path, base64 }`, for example
`{ "path": "ai/attachments/photo.png", "base64": "<canonical padded base64>" }`.
No data URL, whitespace, remote URL fetching or local source-file path is accepted.

- PNG (`.png`), JPEG (`.jpg`/`.jpeg`), GIF (`.gif`) and WebP (`.webp`) only.
  Lowercase extension must match the binary signature; SVG, video and arbitrary
  extensions are rejected. Maximum decoded size is **1 MiB** (base64 input at most
  **1,398,104 characters**), within the existing HTTP request-body limit.
- Creation is strictly inside lowercase root-relative `ai/attachments/`, including
  existing subdirectories. An administrator must create that real writable directory
  beforehand; the tool cannot create directories. Traversal, hidden components,
  symlink parents and absolute paths are rejected. Publication uses the same
  descriptor-anchored, synced, atomic no-clobber path as note creation, mode `0600`.
  Existing files, symlinks and hardlinks are never replaced.
- Returns `path`, SHA-256 `hash`, `bytes`, `mimeType` and `committed: true`.
  Use `note_edit` separately to insert `![[ai/attachments/photo.png]]` into a note.
  Uploading does not modify any note or refresh the index: images are not listed,
  read, edited or indexed by the Markdown tools. There is no attachment overwrite,
  delete or binary retrieval tool. On an ambiguous I/O failure, publication may
  already have committed; retrying the same path cannot clobber it, but verification
  of an existing image requires external filesystem access.
- **External assets mode** (optional): set both `ASSETS_ROOT` and `ASSETS_BASE_URL`
  to store images outside the vault, e.g. a directory served read-only by Caddy and
  never synced. `path` is then relative to `ASSETS_ROOT` (any non-hidden contained
  path, e.g. `project/shot.png`), missing parent folders are created (mode `0700`),
  and the vault collection budgets don't apply. The response adds `url`
  (`ASSETS_BASE_URL` + per-segment percent-encoded path) and `markdown`
  (`![name](url)`). Insert that into a note with `note_edit`; `![[...]]` wiki embeds
  won't resolve. An existing path fails with `Asset already exists`; choose another
  name. The tool description and `brain_status.attachments` report the active mode.
  The assets root must already exist, contain no symlinks and be disjoint from
  `NOTES_ROOT` and `STATE_DIR`. It gets its own `.brain-writer.lock`. Anyone who can
  reach the file server can read these images; it has no auth.
- **`attachment_list`** (assets mode only): images under the assets root, sorted, with
  `url`, `bytes`, SHA-256 `hash` and `referencedBy` (vault notes containing the URL,
  bare, percent-encoded or in `<...>`; query/fragment ignored). Optional `prefix`,
  `offset`, `limit` (max 200). Images added externally (e.g. `scp`) are listed even
  above the 1 MiB upload cap. Each call scans every note and hashes the page's images.
- **`attachment_delete`** (assets mode only): `{ path, expectedHash }`. Refused while any
  note references the image, or if any note is unreadable (its references can't be
  checked). Removes only the image file, then any parent folders left empty. No
  rename/move tool: delete, re-upload and edit the note instead.
- Validation identifies format signatures, **not** full image decodability, pixel
  dimensions, safe metadata or absence of malware. Files are not decoded, resized,
  stripped or re-encoded; embedded payloads/metadata can remain. External shell
  access and Obsidian rendering are outside MCP enforcement. No dependency added.

### Moving and renaming notes

`note_move` moves or renames one existing Markdown note and updates links to it,
like Obsidian's "Automatically update internal links". Pass
`{ path, newPath, expectedHash, dryRun? }`, using the `hash` from `note_read`.
`dryRun: true` returns the planned link changes and writes nothing.

- **Scope:** source and destination may be anywhere in the allowed root, like
  `note_edit`. The `ai/`/`meetings/` restriction applies only to *new* content;
  a move keeps existing content, and renumbering project tickets elsewhere in the
  vault is the main use case. Path rules match the other note tools (contained,
  non-hidden, `.md`, no symlink parents). Destination names also reject
  characters Obsidian refuses or cannot link: `* " \ < > : | ? # ^ [ ]`.
- **Never overwrites:** an existing destination, or one differing only by case
  (which would collide on macOS/Windows sync peers), is refused. Missing
  destination folders are created inside the root (mode `0700`) and removed again
  if the move fails.
- **Order:** inside the single write queue, the server checks the source hash,
  reads every note, plans all rewrites and checks collection budgets before
  writing. It then publishes the destination with no-clobber, re-checks the
  source hash and deletes it (rolling the destination back on conflict), then
  rewrites each linking note under its own hash guard. A linking note changed
  since planning is reported as `conflict` and left untouched; edit it with
  `note_edit`. This is ordered and reported, not a multi-file transaction.
  The index refreshes afterwards, so `note_list`/`note_search` show the new path.
- **Response:** `links` lists every changed file with each old → new link and
  `status` (`planned`, `updated`, `conflict` or `failed`); `unreadable` lists
  notes that could not be scanned (for example non-UTF-8 or multi-link files);
  `warnings` flags links that matched several notes by name.

Link handling follows Obsidian's help pages, its public plugin API
(`getFirstLinkpathDest`, `fileToLinktext`, `renameFile`) and reported behaviour.
Obsidian is closed source and was not run against these fixtures, so treat
unusual cases as best-effort:

- Recognises `[[note]]`, `[[folder/note]]`, `[[note.md]]`, `![[embeds]]`,
  `#heading`, `#^block`, `|display text`, table-escaped `\|`, and wiki links in
  frontmatter properties. Markdown links `[text](path.md)` /
  `[text](path)` with `%20` encoding, `<angle brackets>` and titles. External URLs,
  same-note `#anchors`, fenced code blocks and inline code are ignored.
- Resolution mirrors Obsidian: case-insensitive; for wiki links the exact vault
  path, then relative to the linking note; Markdown links try the relative path
  first (CommonMark). Then the shallowest note whose path ends with the link.
- Only links whose target would change are rewritten. A folder move leaves a
  unique `[[note]]` untouched; a rename changes `[[old]]` to `[[new]]`. Headings,
  blocks, embeds, display text and `.md` presence are preserved, except that
  display text equal to the old note name follows the rename, as Obsidian does.
- Rewritten links use the vault's **New link format** from `.obsidian/app.json`
  (the only hidden file read, read-only, max 64 KiB; default "shortest").
  Markdown links that were real relative or vault paths keep that form so they
  work outside Obsidian. Every generated link is checked to resolve to its target,
  falling back to the full vault path.
- The moved note's own relative links are fixed, and links elsewhere that would
  silently switch to the moved note (it now shares their name) are qualified.
- Not handled: folder moves, attachments, reference-style links
  (`[x]: path.md`), HTML links, and plugin-specific link syntaxes.

### Reversible defaults and limits

- One explicitly configured root; UTF-8, non-hidden `.md` files, max 1 MiB each. Symlinks and multi-link files cannot be read; directory symlinks are not traversed. No delete or directory-management tools; `note_move` (below) is the only tool that removes a path or creates directories.
- **Creation only:** every MCP client (HTTP and stdio) can create new notes strictly inside lowercase root-relative `ai/` or `meetings/`, including existing subdirectories. The parent directory must already exist; neither these directories nor subdirectories are created by note tools. `ai-other/`, `AI/`, `Meetings/`, absolute/traversal paths and symlink parents are rejected. Reading/searching and editing existing supported notes elsewhere remain allowed. This is enforced in the shared application creation path, not a client prompt or token scope.
- Note tools only publish `.md` notes; the separate `attachment_create` tool publishes the limited image formats described above. No tool uploads video, creates arbitrary file extensions or directories, or installs `node_modules`/code packages. Markdown content is unrestricted (including code, scripts or embedded data); existing directories named `node_modules` are not specially banned, and supported Markdown there remains accessible under the same rules. This is not content filtering or a sandbox for external shell/filesystem access. Internally the server does create temporary publication files and a root writer-lock directory, and maintains snapshot directories/database files in separate private state.
- **Shared Obsidian/Syncthing vault:** keep the whole vault mounted as the notes root and private state separate. No new environment, auth or Compose setting is needed for this policy. An administrator must ensure real writable `ai/` and `meetings/` directories (and `ai/attachments/` for image uploads, plus any desired subdirectories) exists in the vault before creation can work; the server does not provision it. Syncthing/external editors do not participate in the write queue/locks; the concurrent external-write limits below still apply.
- Markdown is authoritative. State must be outside the notes root (and not its ancestor), private to this process/user, and trusted. The state directory contains copies of note text as well as QMD's disposable database: treat both as sensitive, not backups.
- QMD SDK `2.8.3`, using `searchLex`/BM25 only. No bespoke search, vector database, automatic model downloads at runtime, or task orchestration. Dependency installation includes native packages and may fetch/build native runtimes.
- Refresh copies validated files into a disposable snapshot and calls QMD `update`. Runs synchronously after each successful Markdown write and before each search; no watcher or background queue. Refresh streams one file at a time rather than retaining the whole collection in memory. This full scan is intentionally a small-fixture default, not a vault-scale performance promise.
- Freshness is `pending`, `snapshot`, or `stale`. `snapshot` means a successful scan, **not** a transactionally consistent filesystem snapshot or proof against later external changes. External changes are not continuously monitored. Refresh failure leaves explicit stale status; a committed write stays committed, and cached search results may remain stale/partial.
- All operations use one serial queue, stronger than per-file serialization. Edits check the full-file SHA-256 inside that queue. Each old text must occur once in the original file; replacements cannot overlap. Creates publish with an atomic no-clobber link; edits use same-directory rename after syncing the temporary file. New/replaced files have mode `0600`.
- Exclusive root/state lock directories prevent multiple prototype instances from writing the same root. After a crash, manually remove `.brain-writer.lock` in the root and `writer.lock` in state **only after confirming no server is running**. Keep the root exclusive to this writer during edits: unrelated editors do not participate in the queue/locks, so concurrent external writes are not a cross-process compare-and-swap guarantee. No protection is claimed against privileged filesystem mutation/mount changes. I/O failure after publication can have an ambiguous acknowledgement; re-read before retrying.
- HTTP requires a valid `AUTH_CONFIG` file; there is no unauthenticated mode. Config changes require restart. Stdio retains its local OS-user/process trust boundary. No Pi deployment or vault integration has been performed. QMD dependency audit findings remain outstanding; see [research notes](docs/qmd-research.md).
- QMD currently declares a TypeScript `^5.9.3` peer dependency. pnpm reports the mismatch with TypeScript 7; our strict source/test type-check and integration suite pass with 7.0.2. `skipLibCheck` skips dependency declaration internals, not application type checking. No override silently hides that warning. pnpm may also offer QMD agent skills: they are not required or approved by this project.

## Resource limits and overload behaviour

Security-review fixes bound compact search output and admitted work. Defaults are deliberately conservative and reversible; they are **not** a Pi performance/capacity guarantee.

- Search titles are at most **256 UTF-16 code units**, excerpts **400**. `titleTruncated` identifies shortened titles; references are never shortened. Search data has a **32 KiB UTF-8 JSON budget**, with `resultsTruncated: true` when whole trailing hits are omitted. The MCP tool result, including both text and structured copies, has a **128 KiB safety ceiling** (JSON-RPC's request ID/envelope is separate). These are display limits only: authoritative Markdown is unchanged.
- One operation executes at a time. The pending-operation limit includes **running + waiting** work, for HTTP **and stdio**. Overflow is refused before admission with an MCP tool error (`Server busy…`); rejected writes are never queued to run later. HTTP additionally limits simultaneous requests, returning **503 + Retry-After: 1** without queuing overflow. Retry busy requests with backoff; for an ambiguous write failure/disconnect, re-read the file before retrying.
- HTTP slots include request-body reading and response backpressure. TCP connections and requests per socket are also bounded. `/health` bypasses the expensive-work admission gate (but still shares the TCP connection cap and Host/Origin checks). Body/socket inactivity limits are 30 seconds, header timeout 10 seconds; each socket handles at most 100 requests.
- Collection capacity is checked **inside the serialized operation before creating/replacing Markdown or creating images**. The shared write budget counts non-hidden Markdown throughout the root plus supported image extensions under `ai/attachments/`; unrelated existing vault images are not included. Images also count toward filesystem scan-entry limits. Budget failures leave files untouched. Refresh still indexes/checks Markdown only; external images exceeding upload budgets block subsequent writes, not Markdown search. External Markdown exceeding scan/count/byte budgets makes refresh explicitly `stale`; repair externally or raise the relevant limit and restart. Reads of known supported notes remain possible. Limits do not delete files.

Both entrypoints accept these validated positive-integer environment overrides (Markdown bytes are UTF-8 source bytes; image bytes are decoded binary bytes):

| Variable | Default | Scope |
| --- | --- | --- |
| `MAX_PENDING_OPERATIONS` | `8` | Running + waiting Brain operations |
| `MAX_HTTP_REQUESTS` | `8` | Simultaneous admitted HTTP MCP requests |
| `MAX_HTTP_CONNECTIONS` | `32` | TCP sockets, including idle/slow clients |
| `MAX_COLLECTION_FILES` | `10000` | Markdown files + supported images under `ai/attachments/` (pre-write) |
| `MAX_COLLECTION_BYTES` | `67108864` | Markdown source + those image bytes (64 MiB, pre-write) |
| `MAX_SCAN_ENTRIES` | `20000` | Files/directories encountered, including skipped/hidden entries |
| `MAX_SCAN_DEPTH` | `32` | Directory nesting below the root |

Paths are capped at 1024 UTF-8 bytes; each Markdown file remains capped at 1 MiB. Directory iteration is streamed and depth-bounded. `brain_status` reports configured limits and the running/waiting operation count. Environment changes require restart; Compose overrides belong under the service's `environment` section. Invalid limits prevent startup, and validated hard ceilings prevent accidentally disabling bounds with zero/infinity. Increase limits only after measuring actual memory/latency.

Local Compose additionally applies **768 MiB RAM (no extra swap), 1 CPU, 128 PIDs, a 64 MiB `/tmp` tmpfs, and a 384 MiB V8 old-space ceiling**. Shutdown grace is 60 seconds. These settings constrain the container, not Docker image/build size or persistent-volume disk usage. Preserve them when preparing future Traefik deployment configuration. Monitor cache/volume growth and use host quotas if a hard disk budget is needed; indexes remain disposable.

An already-started filesystem/QMD operation is **not** blindly cancelled on a request deadline or disconnect: it may still commit and must drain before shutdown. Native work can exceed the shutdown grace; forced termination/OOM can still require manual lock recovery. Counts/cgroups reduce availability risk, not eliminate DoS or establish an execution-time SLA. Dependency advisories and the TLS/private-network deployment prerequisites remain outstanding.

Regression tests reproduce million-character headings through real authenticated HTTP, check UTF-8/escaping byte budgets, saturate admission with real partial requests, verify disconnect recovery, reject queued/over-budget writes without publication, and check external-overflow stale recovery. The Docker test repeats the heading exploit and file budget under the actual cgroup limits, while retaining auth/revocation/index-rebuild checks.

## Adding authentication tokens

HTTP clients each need a token. **The client stores the original token; the application config stores only its SHA-256 hash.** All registered tokens share the same note policy: read/search, edit and move existing notes throughout the allowed root; create only inside lowercase root-relative `ai/` or `meetings/`.

1. **Generate a token locally** and save it in that MCP client's private secret configuration:

   ```sh
   openssl rand -hex 32
   ```

   Generate a different token per client. Do not paste tokens into chat, Git, URLs, or command-line arguments.

2. **Hash the token**, without echoing it or placing its value in shell history. Run from the project root using Bash:

   ```bash
   pnpm build
   unset TOKEN
   read -rsp 'Paste client token: ' TOKEN; printf '\n'
   printf '%s' "$TOKEN" | node dist/src/token-hash.js
   unset TOKEN
   ```

   This prints only the hash. Keep the original token in the client, not on the server.

3. **Create the application's private config on first setup** (these commands preserve an existing config):

   ```sh
   mkdir -p .local/config
   chmod 700 .local/config
   [ -e .local/config/auth.json ] || cp config/auth.example.json .local/config/auth.json
   chmod 600 .local/config/auth.json
   ```

   Edit `.local/config/auth.json` and replace the placeholder with the hash printed above:

   ```json
   {
     "version": 1,
     "tokens": [
       { "name": "my-agent", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256_HASH" }
     ]
   }
   ```

   For additional clients, **append another object to `tokens`**, preserving existing entries. Each name and hash must be unique. The placeholder is intentionally invalid: replace it before starting. Names use letters/numbers/underscores/hyphens, starting with a letter or number (maximum 64 characters).

   Compose mounts `.local/config` read-only at `/config` and sets `AUTH_CONFIG=/config/auth.json`. The container's UID/GID 1000 must be able to read it; adjust ownership/security labels if necessary. `.local/` is excluded from Git and Docker builds. For a non-Docker HTTP process, set `AUTH_CONFIG` to the absolute config-file path.

4. **Start the application, or restart it after changing tokens:**

   ```sh
   docker compose up --build -d   # first start / rebuild
   docker compose restart brain  # after editing an existing token config
   ```

   Config is read only at startup. **Adding/removing an entry has no effect until restart.** To revoke a client, remove its entry and restart; to rotate, add a fresh token, switch the client, then remove the old entry and restart again. Missing/invalid config prevents startup.

5. **Configure the client to send the original token on every MCP request:**

   ```http
   Authorization: Bearer <original-token-not-the-hash>
   ```

   The client's exact configuration format varies; it must support custom authorization headers. Use HTTPS through Traefik for remote clients. Plain HTTP is only for local loopback testing or the private proxy-to-container hop. Stdio does not use these HTTP tokens; `/health` remains unauthenticated liveness only.

See [the authentication guide](docs/authentication.md) for configuration limits, rotation details, and a TypeScript client example.

## Local Docker / remote MCP transport

```sh
# First prepare .local/config/auth.json with your named token hashes:
# see docs/authentication.md (the example's placeholder is intentionally invalid).
# Builds/tests TypeScript in the image; starts fixture-only named volumes.
docker compose up --build -d
# Connect a Streamable HTTP MCP client WITH an Authorization: Bearer header to:
# http://127.0.0.1:8181/mcp
docker compose logs brain
docker compose down             # preserves fixture notes + disposable state

# Repeatable black-box test: build image, connect real MCP clients,
# exercise authentication/safe writes/QMD search, revoke a token, restart,
# erase cache, verify rebuild.
docker compose build
pnpm test:docker                # requires Docker; cleans up its own containers/volumes
```

The default `pnpm test` suite skips the Docker test unless `DOCKER_SMOKE=1` is set. The opt-in Docker test uses temporary, uniquely named volumes, checks writes independently on disk, and removes only those test resources. It was verified on Linux **amd64**, not Raspberry Pi ARM64. The image currently includes QMD's optional native/GPU packages (~1.6 GB locally); no semantic weights are downloaded. Image slimming/ARM64 verification remain follow-up work.

`compose.yaml` publishes **localhost only**, runs as UID/GID 1000, uses a read-only container filesystem, drops Linux capabilities, and keeps notes/cache in separate named volumes. Use only fixture volumes for now. A required private `.local/config` directory is mounted read-only for auth (hashes only). Bind-mounted directories need appropriate ownership and host security labels; do not mount the real vault without explicit approval. No Traefik, DNS, router, or Tailscale settings were modified.

HTTP settings (`pnpm dev:http` or `pnpm start:http` after building):

| Environment variable | Meaning |
| --- | --- |
| `NOTES_ROOT`, `STATE_DIR` | Required disjoint Markdown root and disposable private state directory |
| `AUTH_CONFIG` | Required path to versioned hash-only token JSON; image defaults to `/config/auth.json`. Missing/invalid config prevents startup; loaded once, restart after edits. The old unauthenticated flag no longer enables access. |
| `HTTP_HOST` | `127.0.0.1` outside Docker; image defaults to `0.0.0.0` **inside** the container |
| `PORT` | Container/server port, default `3000` |
| `HTTP_ALLOWED_HOSTS` | Comma-separated hostnames **without ports**; default `localhost,127.0.0.1,[::1]`. Add the future Traefik DNS name explicitly; keep loopback for health checks. Never derived from forwarded headers. |
| `ASSETS_ROOT`, `ASSETS_BASE_URL` | Optional, set both or neither (also read by stdio). Absolute existing directory for `attachment_create`, and the absolute `http(s)` URL that serves it (no credentials, query or fragment). Unset keeps images under vault `ai/attachments/`. See [image attachments](#image-attachments). |
| `HTTP_ALLOWED_ORIGINS` | Exact allowed browser origins; empty by default rejects all requests carrying `Origin`. Native MCP clients need no Origin. No permissive CORS is enabled. |

`POST /mcp` uses the official SDK's stateless Streamable HTTP with JSON responses, one SDK server/transport per request, and **one shared Brain/write queue**. There are no server-side MCP sessions, event replay, or long-lived GET/SSE streams (authenticated `GET`/`DELETE /mcp` return 405; unauthenticated `/mcp` requests return 401). `GET /health` is unauthenticated process liveness, not index freshness; use `brain_status` for freshness. Request bodies are capped at 4 MiB, with 30-second request-body/10-second header timeouts. SIGTERM stops admission, drains active requests, and releases root/state locks. Abrupt termination still requires manual lock recovery.

For future Traefik integration, use the existing `websecure` / `myresolver` label convention and an internal port of `3000`, with **no published application port**. Traefik would preserve Host for e.g. `brain.rpi.${DOMAIN}` and terminate TLS. That deployment configuration is not applied here. Named-token authentication is implemented, not OAuth; private DNS alone is not access control.

## Implementation handoff

Inspect upstream QMD documentation and package APIs first. Prefer a thin adapter over QMD internals or a second search implementation. Build a small tested vertical slice, document assumptions and setup, and report material decisions needing user input. Use fixtures, not the user's actual vault; do not deploy, publish, create remote repositories, or change Tailscale configuration without permission.
