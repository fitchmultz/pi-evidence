# Examples

- [`evidence.json`](evidence.json): multi-gate manifest with two approval
  roles. Gates run sequentially in manifest order from the repository root.
- [`release.sh`](release.sh): release script that refuses to ship without
  `GREEN` evidence for the exact HEAD.
- [`pre-push`](pre-push): Git hook that blocks `git push` unless HEAD has
  green evidence. Copy to `.git/hooks/pre-push` and `chmod +x` it.
