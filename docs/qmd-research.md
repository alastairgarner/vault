# QMD upstream findings

Research target: published `@tobilu/qmd@2.8.3`; upstream `main` was commit
`86d2365d17fc682e491c2c53d1e4a884aee8682a`. Main documentation can describe APIs
newer than the published package; the implementation/tests use the installed
package's public SDK and declarations, not private internals.

## Integration and licence

- [Upstream source and README](https://github.com/tobi/qmd/tree/86d2365d17fc682e491c2c53d1e4a884aee8682a).
- [MIT licence](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/LICENSE): retain its notice when distributing QMD. Model weights have separate terms; MIT for the code does not license the models.
- Public Node/Bun SDK: `createStore({ dbPath, config: { collections } })`,
  `searchLex` (BM25, no model), `searchVector`, hybrid `search`, `update`,
  `embed`, retrieval, collection/status APIs, and `close`.
- Explicit `dbPath` and inline configuration avoid modifying the user's global
  QMD collections. `update` scans files and returns indexing/embedding counts;
  `embed` is separate. The published lexical SDK returns document bodies;
  public `extractSnippet` supplies compact excerpts without a second search engine.
- CLI equivalents: `collection add`, `update`, `embed`, `search`, `vsearch`,
  `query`, plus structured `--json` output. No subprocess CLI wrapper is needed.

## Transports

Upstream `qmd mcp` defaults to stdio. `qmd mcp --http` is a long-lived,
localhost-default, stateless Streamable HTTP server at `/mcp`; upstream also
documents direct query/metadata and health endpoints. Origin/Host screening
protects against some browser/DNS-rebinding attacks, **not authentication**.
Model contexts are reused by a long-lived server and released after idle periods.
We use neither upstream MCP nor its HTTP transport: this prototype exposes
safe authoritative file access and SDK-backed search through the official
TypeScript MCP SDK, with stdio and opt-in stateless Streamable HTTP transports.
The local Docker configuration publishes its HTTP port on loopback only.
V2 now requires manually configured bearer tokens for HTTP MCP requests;
registered clients can read/search and edit existing supported notes throughout
the allowed root; new notes are restricted to lowercase root-relative `ai/` or `meetings/`
with existing parent directories, for both HTTP and stdio. See
[authentication setup](authentication.md). Stdio remains local-process access.

## ARM64 and resources

- QMD requires Node >=22. Its package advertises `sqlite-vec-linux-arm64`;
  node-llama-cpp also publishes Linux ARM64 native packages. This is evidence
  of platform support, not proof of working Pi Docker deployment/performance.
- [node-llama-cpp build guidance](https://node-llama-cpp.withcat.ai/guide/building-from-source):
  supported platforms can use prebuilt binaries; unsupported/incompatible
  combinations may fall back to compiling llama.cpp with CMake/toolchain needs.
  better-sqlite3 and other native dependencies also need compatible binaries
  or a working native build environment. The local tests ran on Linux x86_64,
  not ARM64.
- Upstream model estimates: embeddinggemma 300M Q8 ~300 MB; Qwen3 reranker
  0.6B Q8 ~640 MB; query expansion 1.7B Q4 ~1.1 GB. Roughly 2 GB of weights
  is not a RAM estimate: contexts, parallelism, native runtime, SQLite/indexes
  and filesystem cache add memory, and CPU-only latency must be measured.
- Semantic/vector/hybrid use can auto-download weights from Hugging Face to
  QMD's model cache. This prototype never calls those APIs; tests download no
  models. Install-time native binary downloads are distinct from model downloads.
- Do not promise useful semantic performance on a Raspberry Pi yet. Before
  deciding Pi vs stronger tailnet host, benchmark the actual RAM/model/collection
  combination and review model licences. Hardware topology remains a user decision.

## Dependency caveats

QMD's TypeScript peer range is currently `^5.9.3`; the requested latest stable
TypeScript is `7.0.2`. Application type checking and real integration tests
pass, but the upstream peer warning remains visible.

The initial pnpm audit reports **2 critical, 6 high, 1 moderate** advisories
in the transitive QMD dependency graph, including simple-git/argv-parser
(command execution protections), QMD's separate MCP server SDK (HTTP limits,
client isolation, bearer-token validation), and its pinned Zod version
(collection-validation resource exhaustion). Our direct MCP SDK/Zod are separate;
this prototype does not invoke QMD HTTP, Git-management or model-build APIs at
runtime. This is not a clean security audit or proof that every advisory is
unreachable. No automatic forced upgrades/overrides were applied. Review patched
upstream versions and reachable code paths before shared/network deployment;
re-run `pnpm audit` because advisories change over time.
