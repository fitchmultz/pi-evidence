# pi-evidence

`evidence` answers the one question a release script actually needs answered:
**did the gates and required approvals pass for the exact commit being
shipped?** It records gate runs per Git SHA and reports `GREEN`, `RED`, or
`STALE` with matching exit codes.

## Why

"Tests passed" is usually a claim about the past: some commit, some tree
state, some version of the test command. Between then and the release, a file
changed, a commit landed, or the tests never re-ran. A release script that
trusts the claim ships untested code.

`evidence run` binds a passing run to the exact clean HEAD it ran on, plus the
gate definitions committed at that HEAD. `evidence check <sha>` prints `GREEN`
only when nothing has drifted: same commit, clean worktree, same gate
manifest, every gate passed, every required approval recorded. Anything else
fails closed as `RED` or `STALE`.

Use it when:

- a local release or promotion script needs a machine-checkable gate and CI is
  not in the loop;
- an AI agent ships code and "I ran the tests" should be verifiable per
  commit, not taken on trust;
- one or more roles must sign off before shipping and you want that recorded
  against the exact SHA.

It is deliberately local and boring: no server, no daemon, no signing. See
[SPEC.md](SPEC.md) for the exact contract and non-goals.

## Install

Download the latest GitHub release tarball, then install it globally:

```sh
gh release download -R fitchmultz/pi-evidence -p 'pi-evidence-*.tgz'
npm install --global ./pi-evidence-*.tgz
```

The package is released on GitHub only. It is not published to npm.

## Configure

Commit `evidence.json` at the repository root:

```json
{
  "repo": "owner/repository",
  "gates": [
    { "id": "test", "cmd": "npm test", "timeout": 300 }
  ],
  "approvals": ["maintainer"]
}
```

Timeouts are required and measured in seconds. Gate commands are trusted and
run sequentially through the shell from the repository root.

## Example

A full pass, from a clean worktree:

```console
$ evidence run
==> test
... test output ...
PASS 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20 (0f8a…-uuid)

$ evidence approve "$(git rev-parse HEAD)" --as maintainer
APPROVED 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20 as maintainer

$ evidence check "$(git rev-parse HEAD)"
GREEN 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20 run 0f8a…-uuid passed
```

Any drift after that collapses to `STALE`:

```console
$ echo tweak >> src/evidence.ts
$ evidence check "$(git rev-parse HEAD)"
STALE 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20 worktree is dirty

$ git commit -am tweak && evidence check 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20
STALE 4f60b0d5e1c6a3f9b2d84a7c0e5f1b9d3a6c8e20 HEAD is 9b1c44f2…
```

The new commit has no evidence of its own until `evidence run` runs again.

### Gating a release script

```sh
#!/bin/sh
set -eu
sha="$(git rev-parse HEAD)"
evidence check "$sha"   # exits 1 on RED, 2 on STALE; set -e stops the release
npm pack
gh release create "v$(node -p 'require("./package.json").version')" ./*.tgz
```

`run` refuses a dirty worktree, and `check` reports `STALE` while the worktree
is dirty, so the script cannot ship untested local changes.

### Status contract

`check` prints one status line and returns:

| Status | Exit code | Meaning |
| --- | ---: | --- |
| `GREEN` | 0 | Clean exact HEAD has a passing complete run and all approvals. |
| `RED` | 1 | The latest complete run failed or approvals are missing. |
| `STALE` | 2 | HEAD moved, the tree is dirty, or exact evidence is absent/conflicting. |

Bundles are appended under `~/.pi/evidence/<repo>/<sha>/` and are never
rewritten.

## Develop

```sh
npm ci
npm test
```
