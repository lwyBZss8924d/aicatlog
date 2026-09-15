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

Context inspection uses `context inspect <id>` through the same CLI, SDK and Fetch
operation. Manifests declare `document_role: context_index` with
`context_format: llms-txt-v2`, or `document_role: prompt_context` with
`context_format: markdown`. Either field can identify its matching pair. Other
resource roles remain valid metadata. Only the canonical basename `llms.txt` is an
undeclared format fallback; a `*.llms.txt` leaf needs an explicit declaration.
Inspection reads current source within registered roots and returns its digest,
line ranges, title, optional blockquote summary, headings, inert inline Markdown
references and diagnostics. It never reads or fetches referenced targets.

The bounded scanner recognizes top-level ATX and Setext headings, fenced code and
inline links with balanced or escaped destinations. It is not a full CommonMark
renderer; reference-style links, HTML blocks and headings nested inside containers
are outside its navigation contract. Index validation accepts H1-only input and
an optional BOM; H2 file lists may use Markdown bullets or ordered list markers.
Duplicate index labels and malformed file-list content are errors, while repeated
Markdown leaf headings are preserved. `read --section` accepts a unique heading
label or slug, or the explicit `heading:<line>` selector returned by inspection.
Ambiguous headings fail with choices. Selectors describe the returned source digest
and may change after edits. Explicit topic mappings and BEGIN_TOPIC reads retain
priority. The Optional index section has no automatic filtering behavior.

Registry `settings.resource_aliases` maps explicit retired locators directly to
existing canonical qualified IDs. Resolution returns the canonical resource and
alias provenance without creating resource rows or native Skill files. Exact real
IDs win; registry checks diagnose shadowing, dangling targets, cycles, alias chains,
unqualified targets and duplicate target rows. Invalid aliases cannot resolve.
Catalog aliases do not define native Skill invocation names or client precedence.

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
