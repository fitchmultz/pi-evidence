import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist/evidence.js");
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function exec(file, args, options = {}) {
  return spawnSync(file, args, {
    encoding: "utf8",
    timeout: 15_000,
    ...options,
  });
}

function git(root, ...args) {
  const result = exec("git", args, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(name, manifest) {
  const base = mkdtempSync(join(tmpdir(), "pi-evidence-test-"));
  roots.push(base);
  const root = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Evidence Test");
  git(root, "config", "user.email", "evidence@example.test");
  writeFileSync(join(root, "evidence.json"), `${JSON.stringify({ repo: `test/${name}`, ...manifest }, null, 2)}\n`);
  writeFileSync(join(root, "tracked.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "candidate");
  const sha = git(root, "rev-parse", "HEAD");
  return { root, home, sha, repo: `test/${name}` };
}

function evidence(fixture, ...args) {
  return exec(process.execPath, [cli, ...args], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home },
  });
}

function bundle(fixture, sha = fixture.sha) {
  return join(fixture.home, ".pi", "evidence", ...fixture.repo.split("/"), sha);
}

function runs(fixture) {
  const directory = join(bundle(fixture), "runs");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

test("run, approve, check, append, and stale lifecycle", () => {
  const candidate = fixture("happy", {
    gates: [
      {
        id: "echo",
        cmd: `node -e "process.stdout.write('out'); process.stderr.write('err')"`,
        timeout: 5,
      },
    ],
    approvals: ["reviewer"],
  });

  let result = evidence(candidate, "check", candidate.sha);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^STALE /);

  result = evidence(candidate, "run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "out");
  assert.match(result.stderr, /err/);

  const [record] = runs(candidate);
  assert.equal(record.sha, candidate.sha);
  assert.match(record.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(record.gateDefinitions, [
    {
      id: "echo",
      cmd: `node -e "process.stdout.write('out'); process.stderr.write('err')"`,
      timeout: 5,
    },
  ]);
  assert.equal(record.results[0].stdout, "out");
  assert.equal(record.results[0].stderr, "err");
  assert.equal(record.status, "passed");

  result = evidence(candidate, "check", candidate.sha);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RED .*missing approvals: reviewer/);

  result = evidence(candidate, "approve", candidate.sha, "--as", "other");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /role is not required/);

  result = evidence(candidate, "approve", candidate.sha, "--as", "reviewer");
  assert.equal(result.status, 0, result.stderr);
  result = evidence(candidate, "approve", candidate.sha, "--as", "reviewer");
  assert.equal(result.status, 0, result.stderr);

  result = evidence(candidate, "check", candidate.sha);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^GREEN /);
  assert.equal(readFileSync(join(bundle(candidate), "approvals.jsonl"), "utf8").trim().split("\n").length, 2);

  result = evidence(candidate, "run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runs(candidate).length, 2);

  writeFileSync(join(candidate.root, "tracked.txt"), "new head\n");
  git(candidate.root, "add", "tracked.txt");
  git(candidate.root, "commit", "-qm", "move head");
  result = evidence(candidate, "check", candidate.sha);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^STALE .*HEAD is /);
});

test("all gates run and a failed gate makes evidence red", () => {
  const candidate = fixture("failure", {
    gates: [
      { id: "fail", cmd: `node -e "process.exit(7)"`, timeout: 5 },
      { id: "after", cmd: `node -e "process.stdout.write('still-ran')"`, timeout: 5 },
    ],
    approvals: [],
  });

  const run = evidence(candidate, "run");
  assert.equal(run.status, 1, run.stderr);
  const [record] = runs(candidate);
  assert.equal(record.results.length, 2);
  assert.equal(record.results[0].exitCode, 7);
  assert.equal(record.results[1].stdout, "still-ran");
  assert.equal(record.status, "failed");

  const check = evidence(candidate, "check", candidate.sha);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^RED /);
});

test("timeout kills a gate and records the timeout", () => {
  const candidate = fixture("timeout", {
    gates: [{ id: "slow", cmd: `node -e "setTimeout(() => {}, 5000)"`, timeout: 1 }],
    approvals: [],
  });

  const run = evidence(candidate, "run");
  assert.equal(run.status, 1, run.stderr);
  const [record] = runs(candidate);
  assert.equal(record.results[0].timedOut, true);
  assert.equal(record.status, "failed");
});

test("run refuses dirty worktrees and invalid manifests", () => {
  const candidate = fixture("refusal", {
    gates: [{ id: "ok", cmd: `node -e "process.exit(0)"`, timeout: 5 }],
    approvals: [],
  });

  writeFileSync(join(candidate.root, "untracked.txt"), "dirty\n");
  let result = evidence(candidate, "run");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /worktree must be clean/);

  rmSync(join(candidate.root, "untracked.txt"));
  const manifest = JSON.parse(readFileSync(join(candidate.root, "evidence.json"), "utf8"));
  manifest.extra = true;
  writeFileSync(join(candidate.root, "evidence.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  result = evidence(candidate, "run");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must contain exactly/);
});

test("a gate that changes tracked source makes the run red", () => {
  const candidate = fixture("mutation", {
    gates: [
      {
        id: "mutate",
        cmd: `node -e "require('node:fs').writeFileSync('tracked.txt', 'changed')"`,
        timeout: 5,
      },
    ],
    approvals: [],
  });

  const run = evidence(candidate, "run");
  assert.equal(run.status, 1, run.stderr);
  const [record] = runs(candidate);
  assert.equal(record.results[0].exitCode, 0);
  assert.equal(record.source.cleanAfter, false);
  assert.equal(record.status, "failed");

  const check = evidence(candidate, "check", candidate.sha);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^RED /);
});

test("corrupt completed bundle data fails closed as stale", () => {
  const candidate = fixture("corrupt", {
    gates: [{ id: "ok", cmd: `node -e "process.exit(0)"`, timeout: 5 }],
    approvals: [],
  });
  assert.equal(evidence(candidate, "run").status, 0);
  writeFileSync(join(bundle(candidate), "runs", "corrupt.json"), "not-json\n");

  const check = evidence(candidate, "check", candidate.sha);
  assert.equal(check.status, 2);
  assert.match(check.stdout, /^STALE /);
});
