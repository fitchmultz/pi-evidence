# evidence v1 specification

`evidence` is a local, exact-head gate runner. Its only claim is: the gates and
required role approvals recorded for this exact Git commit are current and
passing.

## Tracked manifest

Each repository commits an `evidence.json` file at its root:

```json
{
  "repo": "fitchmultz/pi-evidence",
  "gates": [
    { "id": "test", "cmd": "npm test", "timeout": 300 }
  ],
  "approvals": ["maintainer"]
}
```

The manifest deliberately has no SHA field. A Git commit cannot contain its own
object ID. `run` resolves the current clean HEAD and stamps that SHA into the
immutable evidence record. The tracked manifest remains the durable,
diff-reviewed gate contract.

The schema is intentionally small:

- `repo`: required storage namespace. It is one or more `/`-separated segments;
  each segment contains only letters, digits, `.`, `_`, or `-`, and no segment
  is `.` or `..`.
- `gates`: required non-empty array. Each item has exactly:
  - `id`: unique non-empty identifier containing letters, digits, `.`, `_`, or
    `-`.
  - `cmd`: non-empty shell command string.
  - `timeout`: required integer timeout in **seconds**, from 1 through 2,147,483
    (the platform timer limit). There is no default; every gate must declare one.
- `approvals`: required array of unique role names using the same character set
  as gate IDs. It may be empty.
- Unknown fields are rejected.

The manifest committed at a candidate SHA is that candidate's definition. A
normalized copy and its SHA-256 digest are stored with the local bundle. A run
record also embeds the digest and exact gate definitions it executed. Changing
gates requires a new commit and therefore produces a new candidate SHA.

## Repository discovery and source state

Commands run inside a Git worktree. The repository root comes from
`git rev-parse --show-toplevel`; commands may be invoked from any directory in
the worktree.

`run` reads `<root>/evidence.json` and refuses before executing a gate unless:

1. the manifest is valid;
2. the working manifest equals the copy committed at current HEAD after
   normalization; and
3. `git status --porcelain --untracked-files=all` is empty.

The clean-tree rule prevents uncommitted files from influencing an exact-commit
claim. Ignored build artifacts remain the repository owner's responsibility.
The runner records HEAD before running and checks both HEAD and tree cleanliness
after all gates. A moved HEAD or changed tree makes the run red even if every
command exited zero.

`check` and `approve` load the manifest committed at the requested SHA with Git,
so a newer working-tree manifest cannot silently redefine an older candidate.

## Commands

### `evidence run`

Resolves current HEAD, then runs manifest gates sequentially in manifest order,
with the repository root as the working directory. Commands execute through the
platform shell and inherit the caller's environment. The runner mirrors output
to the terminal while capturing stdout and stderr separately as UTF-8 text.

A timeout terminates the command and records a failed gate. Spawn errors,
signals, timeouts, and non-zero exits are failures. All gates are attempted so a
completed run contains one result for every required gate.

Each result records the exact gate definition and outcome:

```json
{
  "id": "test",
  "cmd": "npm test",
  "timeout": 300,
  "startedAt": "2025-01-01T00:00:00.000Z",
  "durationMs": 1234,
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "stdout": "...",
  "stderr": "..."
}
```

A run record also contains format version, repository, resolved SHA, normalized
manifest SHA-256 digest, an exact `gateDefinitions` snapshot, run ID, start/end
times, tool/Node/platform versions, final source-state check, and overall
`passed` or `failed` status. This makes each run self-describing when a later
commit changes the manifest.

Exit status is `0` when the run passed, `1` when a gate or final source-state
check failed, and `2` for usage, manifest, Git, bundle, or other runner errors.
No partial runner error is reported as passing evidence.

### `evidence check <sha>`

Loads the candidate manifest committed at `<sha>`, its local bundle, and current
repository HEAD. It prints exactly one status line beginning with:

- `GREEN`: HEAD equals `<sha>`, the newest completed run for the exact manifest
  contains every required gate and passed, and every required approval role has
  at least one record.
- `RED`: HEAD equals `<sha>` and the newest exact-manifest run is complete but
  failed, or required approvals are absent.
- `STALE`: current HEAD differs from `<sha>`, the candidate manifest or bundle
  is absent/conflicting/corrupt, or no completed exact-manifest run contains
  every required gate.

A present failed gate is red; a required gate with no result is stale. Older
failed runs remain in the bundle but do not override the newest completed
exact-manifest run.

The machine-readable status contract is:

| Status | Exit code |
| --- | ---: |
| `GREEN` | `0` |
| `RED` | `1` |
| `STALE` | `2` |

For a well-formed invocation, failure to prove current evidence fails closed as
`STALE`. Invalid CLI usage exits `64` and does not print a status line.

“HEAD moved past SHA” means any inequality, including another branch or detached
commit. V1 does not infer ancestry.

### `evidence approve <sha> --as <role>`

Loads the committed candidate manifest, requires current HEAD to equal `<sha>`,
requires `<role>` to appear in `manifest.approvals`, and appends one approval
record:

```json
{
  "version": 1,
  "repo": "fitchmultz/pi-evidence",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "manifestDigest": "sha256:...",
  "role": "maintainer",
  "approvedAt": "2025-01-01T00:00:00.000Z"
}
```

Repeated approvals are allowed and retained. There is no revoke command in v1.
Approval asserts a role; it does not authenticate a person or sign the record.
Exit status is `0` on append and `2` for manifest, Git, role, or bundle errors;
invalid CLI usage exits `64`.

## Bundle layout

Bundles live under the user's home directory:

```text
~/.pi/evidence/<repo>/<sha>/
  manifest.json
  runs/
    <timestamp>-<random>.json
  approvals.jsonl
```

`<repo>` preserves its validated path segments. `manifest.json` is created once
and must match the manifest committed at the candidate SHA. Every run gets a
unique file created without replacement. Each approval is one line appended to
`approvals.jsonl`.

The CLI never rewrites or deletes a completed record. A process interrupted
before publishing a complete run may leave a temporary file; checks ignore
temporary files. “Append-only” is a CLI behavior, not tamper resistance: anyone
who can edit the local filesystem can alter evidence.

## Security and operational limits

Gate commands are trusted repository configuration and can execute arbitrary
code with the caller's permissions. Captured output may contain secrets; the
runner neither redacts nor uploads it. The caller owns command safety and output
hygiene.

V1 targets supported Node.js LTS releases on macOS and Linux. It stores evidence
only on the current machine and makes no durability promise beyond the local
filesystem.

## Explicit non-goals for v1

- Server or daemon
- UI or web dashboard
- Cross-machine sync or shared storage
- Findings-diff optimization
- Scheduling or background execution
- Gate-type plugins
- Cryptographic signing, identity authentication, or tamper-proof storage
- A Pi extension
