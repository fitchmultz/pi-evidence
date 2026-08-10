# pi-evidence

`evidence` records whether the gates and required approvals for the current
exact Git commit passed. Local release and promotion scripts consume three
states: `GREEN`, `RED`, and `STALE`.

## Install

Download a GitHub release tarball, then install it locally:

```sh
gh release download v0.1.0 -R fitchmultz/pi-evidence -p 'pi-evidence-*.tgz'
npm install --global ./pi-evidence-0.1.0.tgz
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

## Use

```sh
evidence run
evidence approve "$(git rev-parse HEAD)" --as maintainer
evidence check "$(git rev-parse HEAD)"
```

`run` refuses a dirty worktree. Bundles are appended under
`~/.pi/evidence/<repo>/<sha>/`. `check` also reports `STALE` while the worktree
is dirty, so a release script cannot ship untested local changes.

`check` prints one status line and returns:

| Status | Exit code | Meaning |
| --- | ---: | --- |
| `GREEN` | 0 | Clean exact HEAD has a passing complete run and all approvals. |
| `RED` | 1 | The latest complete run failed or approvals are missing. |
| `STALE` | 2 | HEAD moved, the tree is dirty, or exact evidence is absent/conflicting. |

See [SPEC.md](SPEC.md) for the full v1 contract and explicit non-goals.

## Develop

```sh
npm ci
npm test
```
