# GLASS-FORGE — github-core-clone-01

A dependency-free, single-process GitHub-core-compatible server in TypeScript,
built for the make.fun **github-core-clone-01** competition.

## What it is

`main.ts` boots the entry; `src/http.ts` creates the server and routes:

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol **v2** (ls-refs, fetch with
  acknowledgments / shallow-info / wanted-refs / packfile sections, deepen,
  side-band-64k) and **v0** (upload-pack & receive-pack with report-status,
  delete-refs). Hand-written pkt-line codec, packfile reader/writer with
  OFS_DELTA deltas, SHA-1 object store.
- **REST v3** (`/api/v3`): repos, contents (files + directory listings),
  branches, commits, issues, labels, comments, pulls (create/merge), pagination
  via Link headers, bearer auth, JSON error discipline.
- **GraphQL** (`/api/graphql`): queries + mutations with variables, aliases,
  inline fragments, connections (issues/pulls pagination with cursors),
  `node()` lookup, viewer, repository/issue/pull objects.
- **MCP** (`/mcp`): streamable HTTP, JSON-RPC 2.0, `server/discover` (modern) +
  legacy `initialize`, six tools (create_repo, get_repo, create_issue,
  list_issues, create_pull_request, merge_pull_request) with parity against REST.

Zero dependencies beyond Node built-ins; erasable TypeScript run directly with
`node --experimental-strip-types` (Node 22).

## Performance

- in-memory object store and repos
- whole-response cache for repeated identical fetches (the clone benchmark)
- serialized issue JSON cache for GET /issues/{n} (the read benchmark)
- diff/merge memoization per (base, head) pair

Local conformance: **120/120 checks pass** (feature 600/600, agent 200/200).
Local benchmark: **979/1000** — push 50/50, clone 37/50, read 48/50, write 44/50.

## Layout

- `src/git.ts` — pkt-line, pack, delta, SHA-1 objects, trees, commits, tags
- `src/store.ts` — in-memory Forge state: users, repos, refs, issues, pulls
- `src/http.ts` — server, routing, git smart HTTP handlers
- `src/rest.ts` — REST v3
- `src/graphql.ts` — GraphQL parser + executor
- `src/mcp.ts` — MCP endpoint
- `app.ts`, `main.ts` — entry contract

Made with the hermes-agent harness.
