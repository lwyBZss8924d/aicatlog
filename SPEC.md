# aicatlog interface specification

aicatlog is an agent-first CLI and SDK for environment, harness and Skills resources.
Metadata and manifests locate capabilities. A tgrep provider searches selected
corpora. Exact reads return the current source and its digest. Programmatic traversal,
filtering and pagination keep unrelated content out of model context.

The CLI uses Incur with TOON by default, JSON on request, complete result envelopes,
field selection and command schemas. `--input` accepts JSON, `@file` or stdin.
CLI, SDK and Fetch share operations. Fetch exposes OpenAPI but no MCP endpoint;
the library does not start an HTTP service.

Core contracts are `aicatlog.registry.v1`, `aicatlog.resource.v1`,
`aicatlog.plan.v1`, `aicatlog.receipt.v1` and `aicatlog.profile.v1`.
Qualified IDs distinguish duplicate names. The desired-state registry is independent
of generated structural indexes, content indexes and execution receipts.

Discovery commands are catalog, list, find, get and read. Index commands check,
refresh, start, status and stop registered corpora. Skills operations install,
update, remove, normalize and sync selected resources. Harness bootstrap/check and
manifest operations consume portable profiles. Env inspect/help routes to exact
registered runtime tools. Registry import/check migrates existing desired state.

Source-changing operations produce plans. `apply --plan <file>` checks the selected
source and destination preconditions and never broadens the plan. Backups and a
receipt support recovery. Cache refresh and explicitly configured index workers
are runtime effects, not edits to source or desired state.

tgrep workers are scoped to canonical roots and corpus policies, listen on loopback,
and use per-session leases with a default 15-minute idle expiry. Healthy or complete
indexing does not prove current freshness. `--fresh` searches live files; exact
reads always use source files. Failures, missing data and unmeasured metrics are
reported explicitly.

The foundation profile is language-neutral. Project contracts, resource manifests,
work specs and templates live under workspace/harness-config; lightweight commands
live under workspace/harness-tooling. Existing repositories are adopted through a
conflict-visible plan. Toolchains, Hooks and Self-Goal integrations are optional.

Validation includes actual resource navigation, source-owned changes and projections,
bootstrap, interrupted-operation recovery and new-session continuation. Performance
reports include indexing cost and distinguish indexed queries from live scans.
