# aicatlog

Codex owns the implementation, maintenance, validation and continued improvement of
this repository. The operator has delegated routine development and synchronization
to this repository's configured GitHub remote. Complete useful work autonomously;
ask only for a decision that changes the authorized outcome or external scope.

## Product objective

Let an agent discover an environment or harness capability, inspect its contract,
retrieve only relevant context, and perform the intended task through one predictable
CLI and programmatic interface. Measure completed tasks and the cost of reaching
them. A shorter prompt, another index or a successful process is not sufficient proof.

## Source and navigation

- `SPEC.md` owns product and interface expectations.
- `src/` owns the shared engine, Incur commands and SDK/Fetch interface.
- `vendor/skills/` is the minimal upstream Skills fork; keep its patch set small.
- `docs/*-manifest.json` indexes focused `.txt` guidance.
- `profiles/` owns portable foundation templates and resource profiles.
- Per-user registries and runtime state belong outside this public repository.

Keep root AGENTS/SKILL/SPEC formats valid. Supporting guidance uses a JSON metadata
line and plain text with stable topic markers where sections help retrieval. Small
documents need no extra hierarchy. Preserve upstream source formats in vendor trees.

## Engineering

Use Bun and TypeScript. Define command inputs and outputs once and reuse them in
CLI, SDK and Fetch. Keep metadata navigation, full-text search and source reading
distinct. Use Incur's TOON, JSON, schemas and progressive help; no MCP surface.

Treat a registry as desired state, an index as a rebuildable projection, and receipts
as observed results. Read current source for exact content. A background index is
eventually consistent; use a live scan for current absence or edit validation.

Inspect Git before editing and preserve other work. Use argument arrays for child
processes. Source mutations require an explicit operation plan; applying it cannot
widen targets. Optional status, logging and cost reporting must not stop useful work.
Run discriminating tests for changed behavior and required checks once they are
ready. Avoid generic governance layers and repeated verification without new facts.

Source owners retain their execution boundaries. Local projections, model-backed
evaluations, provider authentication and remote publication are distinct effects.
Do not copy credentials, private raw sessions, machine-specific state or undisclosed
project material into this public repository. Use synthetic examples and fixtures.

## Delivery

Use `bun run check` and the installed/compiled entrypoint checks for affected behavior.
Commit useful slices, attach machine-readable PoUW under `refs/notes/commits`, verify
the note and final Git state, and synchronize the intended public source to origin.
Keep exact task/session evidence in the private operator report; public source and
notes must not expose private environment paths or raw trajectories.

Checkpoints record completed work, active assumptions, changed files, tests, unresolved
issues and the next useful action. Keep paused external Goals paused. Background
workers have explicit identities and leases; release only workers this tool owns.

<!-- aicatlog:begin -->
Use aicatlog with ./aicatlog-manifest.json for project resource navigation.
Validate the selected scope with aicatlog harness check --repo .
<!-- aicatlog:end -->
