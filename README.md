# aicatlog

An agent-first CLI and Bun SDK for environment, harness and Skills resources.
Discover a capability, inspect its contract, retrieve one source topic and perform
the selected operation. JSON manifests provide navigation; session-managed tgrep
workers provide full-text search.

Built with Bun, TypeScript, the pinned Incur source and a minimal Vercel Skills fork.
Supports TOON/JSON, progressive help, schemas, structured input, SDK and Fetch/OpenAPI.
No MCP or permanent HTTP service. This is an initial development release.

## Build and install

```sh
bun install --filter aicatlog
bun run check
bun tools/build.ts --tgrep-source /path/to/tgrep
bun tools/install.ts --release dist/aicatlog-0.2.0-darwin-arm64
# Inspect the exact returned plan; use the built executable to apply it.
dist/aicatlog apply --plan /path/to/prepared-plan.json
```

Use the release directory matching your platform. Build also creates
`dist/aicatlog-sdk.tgz` with Bun. The native backend source/version is declared in
`vendor-manifest.json`; it is built with Cargo and assembled into the Bun release.
The installation plan exposes both `aicatlog` and standalone `tgrep` in
`~/.local/bin` (override with `--bin`), pointing into the versioned release under
`~/.local/share/aicatlog` (override with `--prefix`). Put the selected bin directory
on `PATH` to use `tgrep --help` directly. Updates move both owned links together;
an existing executable or link outside this installation's release layout is a
conflict and is not overwritten. Both executable artifacts must be present and
match the release manifest before a plan is prepared.
Atomic source mutation currently supports macOS/Linux and needs a state directory
on the same filesystem as its targets. `--state` selects that directory.

## Use a configured corpus

```sh
aicatlog --registry ./aicatlog-manifest.json catalog
aicatlog --registry ./aicatlog-manifest.json list --limit 5 --json
aicatlog --registry ./aicatlog-manifest.json get project:usage --json
aicatlog --registry ./aicatlog-manifest.json context inspect project:guide --json
aicatlog --registry ./aicatlog-manifest.json read project:usage --section discover
aicatlog apply --schema --json
```

A repository can start with `harness bootstrap --repo <path>`; add `--adopt` to
preserve existing root contracts. Bootstrap prepares a plan. The default user
registry is `~/.agents/aicatlog/registry-manifest.json`; create or import it before
using unqualified discovery. No machine-specific profile is bundled.

For context navigation, declare `document_role` and `context_format` in a resource
manifest: `context_index` / `llms-txt-v2` for a canonical `llms.txt` index, or
`prompt_context` / `markdown` for a context leaf. `context inspect` returns headings,
line selectors and inert references with the current source digest. Select one
heading with `read --section`; links are never automatically fetched or expanded.
The `*.llms.txt` leaf suffix is a local convention, not an upstream format rule.

See [SPEC.md](SPEC.md) and [focused usage](docs/usage.txt) for operation contracts,
index freshness and recovery. This repository uses its own foundation and manifest.
