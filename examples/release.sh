#!/bin/sh
# Release only a commit with green evidence: exits 1 on RED, 2 on STALE.
set -eu
sha="$(git rev-parse HEAD)"
evidence check "$sha"
npm pack
gh release create "v$(node -p 'require("./package.json").version')" ./*.tgz
