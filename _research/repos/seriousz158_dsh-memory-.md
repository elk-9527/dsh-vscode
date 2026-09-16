### REPO: seriousz158/dsh-memory  SUBDIR:   BRANCH: 
META default_branch=main stars=180 forks=3 pushed_at=2026-09-14T14:56:51Z created_at=2026-08-19T08:13:12Z license=MIT archived=False open_issues=7 homepage=
META description=
RELEASE v0.9.2 published=2026-09-01T08:16:34Z prerelease=False assets=1
RELEASE v0.9.1 published=2026-09-01T07:55:30Z prerelease=False assets=1
RELEASE v0.9.0 published=2026-09-01T07:51:07Z prerelease=False assets=1
COMMIT 335f6dc 2026-09-01T08:16:04Z :: Merge pull request #33 from seriousz158/fix/v0.9.2-fts-token-escaping
COMMIT c8d14ad 2026-09-01T08:13:30Z :: test: update public bundle version guard
COMMIT 1384c1b 2026-09-01T08:12:31Z :: fix: keep hyphenated searches on the FTS path
TREE FILECOUNT=96
--- FILES IN SCOPE (max 120) ---
F .github/ISSUE_TEMPLATE/bug.yml
F .github/ISSUE_TEMPLATE/feature.yml
F .github/dependabot.yml
F .github/pull_request_template.md
F .github/workflows/ci.yml
F .gitignore
F CHANGELOG.md
F CONTRIBUTING.md
F LICENSE
F README.md
F SECURITY.md
F docs/api.md
F docs/compatibility.md
F docs/installation.md
F docs/privacy-and-recovery.md
F docs/release-checklist.md
F examples/dsh/cordis.patch.yml.example
F examples/dsh/settings.yaml.example
F integrations/dsh/dsh-memory-backup
F integrations/dsh/dsh-memory-init
F integrations/dsh/dsh-memory-migrate
F integrations/dsh/dsh-memory-sync
F integrations/dsh/dsh-memory-sync.plist.example
F integrations/dsh/install.sh
F package-lock.json
F package.json
F packages/dsh-git-memory/client/client.js
F packages/dsh-git-memory/cordis.patch.yml
F packages/dsh-git-memory/lib/index.js
F packages/dsh-git-memory/lib/legacy-migration.js
F packages/dsh-git-memory/lib/memory-metadata.js
F packages/dsh-git-memory/lib/memory-tree.js
F packages/dsh-git-memory/lib/memory-usage.js
F packages/dsh-git-memory/lib/operation-lock.js
F packages/dsh-git-memory/lib/safe-clear.py
F packages/dsh-git-memory/lib/search-index.js
F packages/dsh-git-memory/lib/sync-apply.py
F packages/dsh-git-memory/lib/sync-transaction.js
F packages/dsh-memory-ui/LICENSE
F packages/dsh-memory-ui/lib/client.js
F packages/dsh-memory-ui/lib/index.js
F packages/dsh-memory-ui/package.json
F packages/dsh-memory/.npmignore
F packages/dsh-memory/LICENSE
F packages/dsh-memory/lib/index.js
F packages/dsh-memory/lib/legacy-migration.js
F packages/dsh-memory/lib/memory-metadata.js
F packages/dsh-memory/lib/memory-tree.js
F packages/dsh-memory/lib/memory-usage.js
F packages/dsh-memory/lib/operation-lock.js
F packages/dsh-memory/lib/safe-clear.py
F packages/dsh-memory/lib/search-index.js
F packages/dsh-memory/lib/sync-apply.py
F packages/dsh-memory/lib/sync-transaction.js
F packages/dsh-memory/package.json
F packages/dsh-memory/templates/.sync/.gitignore
F packages/dsh-memory/templates/README.md
F packages/dsh-memory/templates/scripts/filter_session.py
F tests/helpers/dsh-e2e-service.mjs
F tests/run-memory-tests.sh
F tests/test_dsh_memory_backup.sh
F tests/test_dsh_memory_context.mjs
F tests/test_dsh_memory_e2e_ui.py
F tests/test_dsh_memory_init.sh
F tests/test_dsh_memory_install.sh
F tests/test_dsh_memory_marketplace.mjs
F tests/test_dsh_memory_metadata.mjs
F tests/test_dsh_memory_migrate.sh
F tests/test_dsh_memory_migration_api.mjs
F tests/test_dsh_memory_operation_lock.mjs
F tests/test_dsh_memory_paths.mjs
F tests/test_dsh_memory_preview.mjs
F tests/test_dsh_memory_redaction.mjs
F tests/test_dsh_memory_repository.mjs
F tests/test_dsh_memory_retrieval_eval.mjs
F tests/test_dsh_memory_runtime.sh
F tests/test_dsh_memory_sync_batch.sh
F tests/test_dsh_memory_sync_chunks.sh
F tests/test_dsh_memory_sync_disabled.sh
F tests/test_dsh_memory_sync_dry_run.sh
F tests/test_dsh_memory_sync_env.sh
F tests/test_dsh_memory_sync_failures.py
F tests/test_dsh_memory_sync_lock.sh
F tests/test_dsh_memory_sync_no_change.sh
F tests/test_dsh_memory_sync_preview.sh
F tests/test_dsh_memory_sync_transaction.mjs
F tests/test_dsh_memory_sync_zstd_failure.sh
F tests/test_dsh_memory_tools.mjs
F tests/test_dsh_memory_ui_settings_row.sh
F tests/test_dsh_memory_usage.mjs
F tests/test_public_tree.sh
F tests/test_release_guards.sh
F tools/public-tree-check.mjs
F tools/secret-scan.mjs
F tools/secret-scan.sh
F tools/sync-marketplace-bundle.mjs
=== README FROM: https://raw.githubusercontent.com/seriousz158/dsh-memory/main/README.md (len=11333) ===
# dsh-memory

`dsh-memory` is a local, Git-backed long-term-memory plugin for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh).

It adds one persistent setting, a safe settings-page workflow for clearing memories, and an optional idle-session synchronizer. The host plugin injects memory guidance only when `memory.enabled` is true; the UI plugin lets a user inspect the repository state, toggle the setting, and clear learned memory through a deliberate two-step confirmation.

## What it does

- Stores durable memory in a local Git repository, not in this source repository or a hosted service.
- Registers the `memory` settings namespace immediately, so `memory.enabled` takes effect for the next model call without restarting DSH.
- Shows a long-term-memory row in DSH settings with repository status and a double-confirmation **Delete memory** action.
- Preserves a Git recovery point before clearing `summary.md`, `handbook/`, `rollouts/`, and `archive/`: a clean repository reuses its existing HEAD, while dirty target paths get a dedicated checkpoint commit; the next commit records the cleared state.
- Refuses unsafe repository layouts, symbolic-link escapes, non-repository roots, and path races during a clear operation.
- Can process only idle local session logs through an optional headless synchronizer. The synchronizer defaults to `workspace-write`, never silently installs DSH, and forwards only an allowlisted environment.

## Capabilities

This README describes stable user-facing behavior. Release-by-release
implementation details are intentionally kept out of this page; see
[CHANGELOG.md](CHANGELOG.md) and the [GitHub releases](https://github.com/seriousz158/dsh-memory/releases)
for historical changes.

### Local Git-backed memory

- Memory stays in a local Git repository. There is no hosted memory service or
  cloud vector database.
- Markdown records support front matter, namespaced ids, provenance, expiry
  projection, deterministic conflict handling, and legacy compatibility.
- `summary.md` is a short navigation snapshot; detailed knowledge belongs in
  `handbook/`, `rollouts/`, and `archive/`.

### Safe synchronization and recovery

- Optional idle-session sync runs in a private per-run workspace. The model can
  edit only the isolated copy; the host validates and writes the live Git
  repository.
- The host provides dry-run/preview/apply flows, operation locking, health
  checks, bounded batches, retry backoff, duplicate-id diagnostics, and
  metadata-only journals.
- Recovery/apply commits, rollback, backup export/import, and legacy migration
  keep changes auditable and reversible. Migration is available through the
  CLI/host API, not the settings UI.

### Read path

- When enabled, a bounded and explicitly untrusted `summary.md` snapshot is
  available to the model (12 KiB maximum).
- `memory.search()` and `memory.context()` provide local, bounded retrieval
  with source citations and usage-aware deterministic ordering. Retrieval is
  hybrid: a derived SQLite index (FTS5 trigram + CJK-bigram/word terms, stored
  at `.sync/search-index.sqlite` with restrictive permissions) is fused with
  lexical scoring and exact-substring precedence, and transparently falls back
  to a pure scan when the index is missing, stale, or corrupt.
- Read usage is stored as private metadata in `.sync/usage.json`; transcripts,
  prompts, credentials, and memory content are not written to journals.

### DSH settings integration

The settings UI provides the memory toggle, repository status, recent-sync
state, preview actions, rollback, and deliberate clear confirmation. It does
not expose the filesystem root or execute Git directly.

## Compatibility

`v0.9.2` keeps the DSH `0.1.0-rc.6` peer-compatibility range and has been
tested and locally integrated with a consistently pinned `0.1.0-rc.7` graph:

| Component | Supported version |
| --- | --- |
| DSH runtime peer range | `@deepseek-ai/dsh@^0.1.0-rc.6` (rc.6 and rc.7) |
| Recommended/tested runtime | `0.1.0-rc.7` |
| Clean-room development test graph | DSH client packages `0.1.0-rc.7` |
| Node.js | 22.x |
| Python | 3.11.x |
| Git | a local executable available on `PATH` |
| Operating system | macOS is the supported/tested integration target |

The package uses DSH's Cordis loader interfaces. The `rc.7` graph is the
reproducible development and integration baseline because the registry's `rc.6`
transitive peer graph cannot be installed by plain `npm ci`; this does not
change the host/UI packages' declared `rc.6` runtime peer range. DSH `rc.8` and
later releases are unverified until they pass this repository's test suite.

## Install

### DSH plugin bundle (recommended)

The repository root is also a public DSH bundle named `dsh-git-memory`. It
contains the host plugin, the settings-page client bundle, and its
`dsh.bundle` patch, so one install activates both halves:

```zsh
# GitHub source install (works before or without an npm publication)
dsh plugin --profile web add github:seriousz158/dsh-memory
```

This project is distributed through GitHub source installs and GitHub Releases.
It is not published to npm.

Restart the selected DSH profile after installing. The bundle does not include
any memory data, session logs, credentials, or the local `.dsh` directory.

### Source checkout (development / local integration)

Clone the repository and install its reproducible development/runtime dependencies:

```zsh
git clone https://github.com/seriousz158/dsh-memory.git
cd dsh-memory
# Use the pinned runtime that this v0.8.4 integration was tested with.
npm install --global @deepseek-ai/dsh@0.1.0-rc.7
dsh --version
npm ci --ignore-scripts
```

The two workspace implementation packages remain private; only the root
`dsh-git-memory` bundle is publishable. This keeps the internal host/UI package
names stable while avoiding the already-occupied unscoped `dsh-memory` npm
name.

Install the two local packages into your DSH profile. The installer defaults to
`~/.dsh`. If you use a non-default DSH or memory path, keep the same values in
the environment that installs, starts, validates, and synchronizes DSH:

```zsh
./integrations/dsh/install.sh

# Example for a non-default DSH home and memory repository:
export DSH_HOME="$HOME/.config/dsh"
export DSH_MEMORY_ROOT="$HOME/Documents/dsh-memory-data"
./integrations/dsh/install.sh
# Start DSH from this configured environment as well.
```

The installer creates only these DSH-profile links and the two required Cordis entries:

```text
<DSH_HOME>/profiles/node_modules/dsh-memory
<DSH_HOME>/profiles/node_modules/dsh-memory-ui
```

It also initializes a missing memory root as a private local Git repository. For an existing complete memory repository, it verifies the layout and restores owner-only permissions; it does **not** delete or rewrite learned memory, session history, credentials, other plugins, or unrelated `cordis.patch.yml` entries. See [installation details](docs/installation.md) before using a custom memory root.

Restart the DSH host after installation. In DSH Settings, find **长期记忆** and leave the switch on to enable recall for the next model call.

## Storage layout

By default the host uses:

```text
<DSH_HOME>/storages/memory
```

with `DSH_HOME` defaulting to `~/.dsh`. An operator can set
`DSH_MEMORY_ROOT` to a different local absolute path. It must be present for
the installer, every DSH host launch, explicit initializer run, and optional
synchronizer run; a one-time installation assignment does not configure future
LaunchAgent jobs. The web UI cannot submit or change a filesystem path.

The initialized repository contains:

```text
summary.md      short, stable navigation and preferences
handbook/       reusable knowledge
rollouts/       per-session extraction results
archive/        superseded entries
scripts/        transcript filter helper
.last-sync      optional synchronizer watermark
```

## Settings and API

The only persisted setting is:

```yaml
memory:
  enabled: true
```

The local UI talks only to the fixed `memory` remote service:

```text
memory.getSettings()
memory.setEnabled({ enabled: boolean })
memory.status()
memory.legacyRecords()
memory.migrateLegacy({ dryRun: boolean })
memory.clear({ confirmation: "DELETE_MEMORY" })
```

`status()` reports metadata such as `empty`, `dataFileCount`, `targetDirty`, and `recoverable`; it never returns the memory body. Full request/response contracts and stable error codes are in [docs/api.md](docs/api.md).

## Clear memory safely

The settings UI intentionally requires two acknowledgements:

1. Click **删除记忆**, read the affected paths, then click **继续**.
2. Enter exactly `删除记忆`, then click the final confirmation.

The clear operation is designed for recoverable day-to-day resets, not guaranteed privacy erasure. Before it changes any target memory path, it preserves a recovery point: for a clean repository this is the existing pre-clear HEAD, while dirty target paths are captured in a dedicated checkpoint commit. The clear commit is then created directly on that recovery point. The operation leaves `.git`, `README.md`, helper scripts, directory structure, and `.last-sync` intact so future sessions can learn again without reprocessing historical logs.

Use Git history inside the local memory repository to recover a checkpoint. For privacy-sensitive deletion requirements, remove relevant local backups and follow your organization's retention policy; Git history alone is not a secure-erasure mechanism.

## Optional idle-session sync

The optional synchronizer is separate from the settings UI:

```zsh
./integrations/dsh/dsh-memory-sync
```

It skips work when `memory.enabled` is `false`, and it skips active sessions. It needs a user-installed `dsh` executable (or an explicitly selected `DSH_BIN`), rather than invoking `npx --yes`. It defaults to `workspace-write`; wider privileges are never a repository default. The LaunchAgent template explicitly sets the default DSH and memory paths; edit both assignments before loading it when your installation is custom.

The session filter redacts common credential shapes and home-directory prefixes before a transcript reaches the memory-extraction model. This is defense in depth, not a promise that every secret format is detectable. Review [privacy and recovery](docs/privacy-and-recovery.md) before enabling unattended sync.

## Development

Run the full, local-only suite:

```zsh
npm ci --ignore-scripts
npm test
```

Tests use temporary Git repositories and synthetic fixtures. They must not require a DSH account, start Chrome, launch a LaunchAgent, read the current user's memory/session folders, or make a paid model request.

Before opening an issue or pull request, run:

```zsh
npm test
zsh tools/secret-scan.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release checklist](docs/release-checklist.md).

## Privacy promise

This repository contains code, tests, templates, and examples only. It must never contain any real DSH memory, session log, credential file, browser profile, or user-specific DSH configuration. If you believe sensitive data was committed, treat it as exposed, rotate affected credentials, and follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 seriousz158.

