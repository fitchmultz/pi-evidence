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

function fixture(name, manifest, rootName = "repo") {
  const base = mkdtempSync(join(tmpdir(), "pi-evidence-test-"));
  roots.push(base);
  const root = join(base, rootName);
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

function evidenceWithEnv(fixture, extraEnv, ...args) {
  return exec(process.execPath, [cli, ...args], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home, ...extraEnv },
  });
}

function evidence(fixture, ...args) {
  return evidenceWithEnv(fixture, {}, ...args);
}

function bundle(fixture, sha = fixture.sha) {
  return join(fixture.home, ".pi", "evidence", ...fixture.repo.split("/"), sha);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "linux") {
    const state = /\) ([A-Z]) /.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1];
    if (state === "Z") return false;
  }
  return true;
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
  assert.equal(record.sequence, 1);
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

  writeFileSync(join(candidate.root, "untracked.txt"), "dirty\n");
  result = evidence(candidate, "check", candidate.sha);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^STALE .*worktree is dirty/);
  rmSync(join(candidate.root, "untracked.txt"));

  result = evidence(candidate, "run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readdirSync(join(bundle(candidate), "runs")).filter((name) => name.endsWith(".json")).sort(),
    ["000000000001.json", "000000000002.json"],
  );
  assert.deepEqual(runs(candidate).map((entry) => entry.sequence), [1, 2]);

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

test("timeout kills the full gate process group", () => {
  const candidate = fixture("timeout", {
    gates: [{ id: "slow", cmd: `node stubborn.cjs "$HOME/stubborn.pid"`, timeout: 1 }],
    approvals: [],
  });
  writeFileSync(
    join(candidate.root, "stubborn.cjs"),
    [
      `const { spawn } = require("node:child_process");`,
      `const { writeFileSync } = require("node:fs");`,
      `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `writeFileSync(process.argv[2], String(child.pid));`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"),
  );
  git(candidate.root, "add", "stubborn.cjs");
  git(candidate.root, "commit", "--amend", "--no-edit", "-q");
  candidate.sha = git(candidate.root, "rev-parse", "HEAD");

  const run = evidence(candidate, "run");
  assert.equal(run.status, 1, run.stderr);
  const [record] = runs(candidate);
  assert.equal(record.results[0].timedOut, true);
  assert.equal(record.status, "failed");
  const childPid = Number(readFileSync(join(candidate.home, "stubborn.pid"), "utf8"));
  assert.equal(processIsRunning(childPid), false, `timed-out descendant ${childPid} is still alive`);
});

test("timeout returns when an escaped descendant holds output pipes", () => {
  const candidate = fixture("escaped-timeout", {
    gates: [{ id: "escape", cmd: `node escape.cjs "$HOME/escaped.pid"`, timeout: 1 }],
    approvals: [],
  });
  writeFileSync(
    join(candidate.root, "escape.cjs"),
    [
      `const { spawn } = require("node:child_process");`,
      `const { writeFileSync } = require("node:fs");`,
      `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });`,
      `writeFileSync(process.argv[2], String(child.pid));`,
      `child.unref();`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"),
  );
  git(candidate.root, "add", "escape.cjs");
  git(candidate.root, "commit", "--amend", "--no-edit", "-q");
  candidate.sha = git(candidate.root, "rev-parse", "HEAD");

  const started = Date.now();
  const run = evidence(candidate, "run");
  const escapedPid = Number(readFileSync(join(candidate.home, "escaped.pid"), "utf8"));
  try {
    assert.equal(run.status, 1, run.stderr);
    assert.ok(Date.now() - started < 5_000, "timed-out gate waited on escaped output pipes");
    assert.equal(runs(candidate)[0].results[0].timedOut, true);
  } finally {
    try {
      process.kill(escapedPid, "SIGKILL");
    } catch {
      // The escaped child may already have exited.
    }
  }
});

test("a successful gate is not delayed by a background pipe holder", () => {
  const candidate = fixture("background", {
    gates: [
      {
        id: "background",
        cmd: `sleep 60 & echo $! > "$HOME/background.pid"; echo done; exit 0`,
        timeout: 5,
      },
    ],
    approvals: [],
  });

  const started = Date.now();
  const run = evidence(candidate, "run");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 3_000, "successful gate waited for its timeout");
  const [record] = runs(candidate);
  assert.equal(record.results[0].exitCode, 0);
  assert.equal(record.results[0].timedOut, false);
  assert.match(record.results[0].stdout, /done/);
  const backgroundPid = Number(readFileSync(join(candidate.home, "background.pid"), "utf8"));
  assert.equal(processIsRunning(backgroundPid), false, `background process ${backgroundPid} is still alive`);
});

test("repository roots preserve trailing spaces", () => {
  const candidate = fixture(
    "space-root",
    {
      gates: [{ id: "ok", cmd: `node -e "process.exit(0)"`, timeout: 5 }],
      approvals: [],
    },
    "repo ",
  );
  assert.equal(evidence(candidate, "run").status, 0);
  assert.equal(evidence(candidate, "check", candidate.sha).status, 0);
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
  assert.equal(check.status, 2);
  assert.match(check.stdout, /^STALE .*worktree is dirty/);
});

test("monotonic append order makes a later failure authoritative", () => {
  const candidate = fixture("ordering", {
    gates: [
      {
        id: "conditional",
        cmd: `node -e "process.exit(process.env.EVIDENCE_TEST_FAIL ? 9 : 0)"`,
        timeout: 5,
      },
    ],
    approvals: [],
  });
  assert.equal(evidence(candidate, "run").status, 0);
  const firstPath = join(bundle(candidate), "runs", "000000000001.json");
  const first = JSON.parse(readFileSync(firstPath, "utf8"));
  first.completedAt = "2999-01-01T00:00:00.000Z";
  writeFileSync(firstPath, `${JSON.stringify(first, null, 2)}\n`);

  assert.equal(evidenceWithEnv(candidate, { EVIDENCE_TEST_FAIL: "1" }, "run").status, 1);
  assert.deepEqual(runs(candidate).map((entry) => entry.sequence), [1, 2]);
  const check = evidence(candidate, "check", candidate.sha);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^RED /);
});

test("corrupt completed bundle data fails closed as stale", () => {
  const candidate = fixture("corrupt", {
    gates: [{ id: "ok", cmd: `node -e "process.stdout.write('ran')"`, timeout: 5 }],
    approvals: [],
  });
  assert.equal(evidence(candidate, "run").status, 0);
  writeFileSync(join(bundle(candidate), "runs", "000000000002.json"), "not-json\n");
  const rerun = evidence(candidate, "run");
  assert.equal(rerun.status, 2);
  assert.equal(rerun.stdout, "");
  assert.doesNotMatch(rerun.stderr, /==> ok/);

  const check = evidence(candidate, "check", candidate.sha);
  assert.equal(check.status, 2);
  assert.match(check.stdout, /^STALE /);
});
