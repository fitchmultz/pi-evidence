#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";
const FORMAT_VERSION = 1;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const NAME = /^[A-Za-z0-9._-]+$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_FILE = /^(\d{12})\.json$/;

type Status = "GREEN" | "RED" | "STALE";
type Gate = { id: string; cmd: string; timeout: number };
type Manifest = { repo: string; gates: Gate[]; approvals: string[] };
type GateResult = Gate & {
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
};
type RunRecord = {
  version: 1;
  type: "run";
  repo: string;
  sha: string;
  manifestDigest: string;
  gateDefinitions: Gate[];
  sequence: number;
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  toolVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  results: GateResult[];
  source: {
    headBefore: string;
    headAfter: string | null;
    cleanBefore: true;
    cleanAfter: boolean | null;
  };
  status: "passed" | "failed";
  runnerError: string | null;
};

type Approval = {
  version: 1;
  repo: string;
  sha: string;
  manifestDigest: string;
  role: string;
  approvedAt: string;
};

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  evidence run",
    "  evidence check <sha>",
    "  evidence approve <sha> --as <role>",
    "  evidence --version",
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CliError(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

function parseGate(value: unknown, label: string): Gate {
  if (!isObject(value)) throw new CliError(`${label} must be an object`);
  exactKeys(value, ["id", "cmd", "timeout"], label);
  if (typeof value.id !== "string" || !NAME.test(value.id)) {
    throw new CliError(`${label}.id is invalid`);
  }
  if (typeof value.cmd !== "string" || value.cmd.trim() === "") {
    throw new CliError(`${label}.cmd must be a non-empty string`);
  }
  if (
    typeof value.timeout !== "number" ||
    !Number.isSafeInteger(value.timeout) ||
    value.timeout < 1 ||
    value.timeout > MAX_TIMEOUT_SECONDS
  ) {
    throw new CliError(`${label}.timeout must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return { id: value.id, cmd: value.cmd, timeout: value.timeout };
}

function parseManifest(text: string, label: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${label} is not valid JSON: ${message(error)}`);
  }
  if (!isObject(value)) throw new CliError(`${label} must be an object`);
  exactKeys(value, ["repo", "gates", "approvals"], label);

  if (typeof value.repo !== "string") throw new CliError(`${label}.repo must be a string`);
  const segments = value.repo.split("/");
  if (segments.some((segment) => !NAME.test(segment) || segment === "." || segment === "..")) {
    throw new CliError(`${label}.repo is invalid`);
  }
  if (!Array.isArray(value.gates) || value.gates.length === 0) {
    throw new CliError(`${label}.gates must be a non-empty array`);
  }
  const gates = value.gates.map((gate, index) => parseGate(gate, `${label}.gates[${index}]`));
  if (new Set(gates.map((gate) => gate.id)).size !== gates.length) {
    throw new CliError(`${label}.gates IDs must be unique`);
  }
  if (!Array.isArray(value.approvals)) throw new CliError(`${label}.approvals must be an array`);
  const approvals = value.approvals.map((role, index) => {
    if (typeof role !== "string" || !NAME.test(role)) {
      throw new CliError(`${label}.approvals[${index}] is invalid`);
    }
    return role;
  });
  if (new Set(approvals).size !== approvals.length) {
    throw new CliError(`${label}.approvals must be unique`);
  }
  return { repo: value.repo, gates, approvals };
}

function canonical(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

function pretty(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function digest(manifest: Manifest): string {
  return `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function git(cwd: string | undefined, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new CliError(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new CliError((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trimEnd();
}

function repositoryRoot(): string {
  return git(undefined, ["rev-parse", "--show-toplevel"]);
}

function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]);
}

function clean(root: string): boolean {
  return git(root, ["status", "--porcelain", "--untracked-files=all"]) === "";
}

async function workingManifest(root: string): Promise<Manifest> {
  return parseManifest(await readFile(join(root, "evidence.json"), "utf8"), "evidence.json");
}

function committedManifest(root: string, sha: string): Manifest {
  return parseManifest(git(root, ["show", `${sha}:evidence.json`]), `evidence.json at ${sha}`);
}

function validateSha(value: string | undefined): string {
  if (!value || !SHA.test(value)) throw new CliError("sha must be a full lowercase Git object ID", 64);
  return value;
}

function candidateDir(manifest: Manifest, sha: string): string {
  return join(homedir(), ".pi", "evidence", ...manifest.repo.split("/"), sha);
}

function isErrno(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

async function ensureBundle(manifest: Manifest, sha: string): Promise<string> {
  const directory = candidateDir(manifest, sha);
  await mkdir(join(directory, "runs"), { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, "manifest.json");
  try {
    await writeFile(manifestPath, pretty(manifest), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    const stored = parseManifest(await readFile(manifestPath, "utf8"), "bundle manifest.json");
    if (digest(stored) !== digest(manifest)) {
      throw new CliError(`bundle manifest conflicts with evidence.json at ${sha}`);
    }
  }
  return directory;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The command may already have exited.
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateTimedOutGroup(child: ChildProcess): Promise<string | null> {
  killGroup(child, "SIGTERM");
  for (let elapsed = 0; elapsed < 500; elapsed += 25) {
    await wait(25);
    if (!groupAlive(child)) return null;
  }
  killGroup(child, "SIGKILL");
  for (let elapsed = 0; elapsed < 500; elapsed += 25) {
    await wait(25);
    if (!groupAlive(child)) return null;
  }
  return "timed-out process group did not terminate";
}

async function runGate(gate: Gate, root: string): Promise<GateResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  let spawnError: string | null = null;
  let termination: Promise<string | null> | undefined;
  let child: ChildProcess;

  try {
    child = spawn(gate.cmd, {
      cwd: root,
      shell: true,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      ...gate,
      startedAt,
      durationMs: Date.now() - started,
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: message(error),
      stdout: "",
      stderr: "",
    };
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    process.stderr.write(chunk);
  });
  child.once("error", (error) => {
    spawnError = error.message;
  });

  const forward = (signal: NodeJS.Signals) => {
    killGroup(child, signal);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.kill(process.pid, signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  const timeout = setTimeout(() => {
    timedOut = true;
    termination = terminateTimedOutGroup(child);
  }, gate.timeout * 1000);

  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, closeSignal) => resolve([code, closeSignal]));
  });
  clearTimeout(timeout);
  if (termination) {
    const terminationError = await termination;
    if (terminationError) spawnError ??= terminationError;
  }
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);

  return {
    ...gate,
    startedAt,
    durationMs: Date.now() - started,
    exitCode,
    signal,
    timedOut,
    spawnError,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function gatePassed(result: GateResult): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    result.spawnError === null
  );
}

function sequenceFromName(name: string): number {
  const match = RUN_FILE.exec(name);
  const sequence = Number(match?.[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new CliError(`invalid run filename: ${name}`);
  }
  return sequence;
}

async function nextSequence(directory: string): Promise<number> {
  let latest = 0;
  for (const entry of await readdir(join(directory, "runs"), { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw new CliError(`invalid run file: ${entry.name}`);
    latest = Math.max(latest, sequenceFromName(entry.name));
  }
  if (latest >= 999_999_999_999) throw new CliError("run sequence is exhausted");
  return latest + 1;
}

async function publishRun(
  directory: string,
  pending: Omit<RunRecord, "sequence">,
): Promise<RunRecord> {
  let sequence = await nextSequence(directory);
  while (sequence <= 999_999_999_999) {
    const record: RunRecord = { ...pending, sequence };
    const temporary = join(directory, "runs", `.${record.runId}-${randomUUID()}.tmp`);
    const destination = join(directory, "runs", `${String(sequence).padStart(12, "0")}.json`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, destination);
      await unlink(temporary).catch(() => undefined);
      return record;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (isErrno(error, "EEXIST")) {
        sequence += 1;
        continue;
      }
      throw error;
    }
  }
  throw new CliError("run sequence is exhausted");
}

async function run(): Promise<number> {
  const root = repositoryRoot();
  const manifest = await workingManifest(root);
  const sha = head(root);
  if (!SHA.test(sha)) throw new CliError(`unsupported Git object ID: ${sha}`);
  const committed = committedManifest(root, sha);
  if (canonical(committed) !== canonical(manifest)) {
    throw new CliError("working evidence.json differs from the committed manifest");
  }
  if (!clean(root)) throw new CliError("worktree must be clean before running evidence");

  const directory = await ensureBundle(manifest, sha);
  const started = Date.now();
  const results: GateResult[] = [];
  for (const gate of manifest.gates) {
    console.error(`==> ${gate.id}`);
    results.push(await runGate(gate, root));
  }

  let headAfter: string | null = null;
  let cleanAfter: boolean | null = null;
  let runnerError: string | null = null;
  try {
    headAfter = head(root);
    cleanAfter = clean(root);
  } catch (error) {
    runnerError = message(error);
  }

  const passed =
    results.every(gatePassed) &&
    headAfter === sha &&
    cleanAfter === true &&
    runnerError === null;
  const completedAt = new Date().toISOString();
  const pending: Omit<RunRecord, "sequence"> = {
    version: FORMAT_VERSION,
    type: "run",
    repo: manifest.repo,
    sha,
    manifestDigest: digest(manifest),
    gateDefinitions: manifest.gates,
    runId: randomUUID(),
    startedAt: new Date(started).toISOString(),
    completedAt,
    durationMs: Date.now() - started,
    toolVersion: VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    results,
    source: {
      headBefore: sha,
      headAfter,
      cleanBefore: true,
      cleanAfter,
    },
    status: passed ? "passed" : "failed",
    runnerError,
  };
  const record = await publishRun(directory, pending);
  console.error(`${passed ? "PASS" : "FAIL"} ${sha} (${record.runId})`);
  if (runnerError) return 2;
  return passed ? 0 : 1;
}

function parseRun(value: unknown, manifest: Manifest, sha: string, sequence: number): RunRecord {
  if (!isObject(value) || value.version !== FORMAT_VERSION || value.type !== "run") {
    throw new CliError("bundle contains an invalid run record");
  }
  if (
    value.repo !== manifest.repo ||
    value.sha !== sha ||
    value.sequence !== sequence ||
    value.manifestDigest !== digest(manifest) ||
    JSON.stringify(value.gateDefinitions) !== JSON.stringify(manifest.gates)
  ) {
    throw new CliError("bundle run does not match the candidate manifest");
  }
  if (!Array.isArray(value.results) || value.results.length !== manifest.gates.length) {
    throw new CliError("bundle run is missing required gate evidence");
  }
  const results: GateResult[] = [];
  for (let index = 0; index < manifest.gates.length; index += 1) {
    const definition = manifest.gates[index];
    const result = value.results[index];
    if (!definition || !isObject(result)) {
      throw new CliError("bundle run is missing required gate evidence");
    }
    if (result.id !== definition.id || result.cmd !== definition.cmd || result.timeout !== definition.timeout) {
      throw new CliError("bundle gate result does not match the candidate manifest");
    }
    if (
      typeof result.startedAt !== "string" ||
      typeof result.durationMs !== "number" ||
      !(typeof result.exitCode === "number" || result.exitCode === null) ||
      !(typeof result.signal === "string" || result.signal === null) ||
      typeof result.timedOut !== "boolean" ||
      !(typeof result.spawnError === "string" || result.spawnError === null) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new CliError("bundle contains an invalid gate result");
    }
    results.push(result as GateResult);
  }
  if (
    typeof value.runId !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    typeof value.durationMs !== "number" ||
    typeof value.toolVersion !== "string" ||
    typeof value.nodeVersion !== "string" ||
    typeof value.platform !== "string" ||
    !isObject(value.source) ||
    value.source.headBefore !== sha ||
    !(typeof value.source.headAfter === "string" || value.source.headAfter === null) ||
    value.source.cleanBefore !== true ||
    !(typeof value.source.cleanAfter === "boolean" || value.source.cleanAfter === null) ||
    !(value.status === "passed" || value.status === "failed") ||
    !(typeof value.runnerError === "string" || value.runnerError === null)
  ) {
    throw new CliError("bundle contains an invalid run record");
  }
  const expectedPassed =
    results.every(gatePassed) &&
    value.source.headAfter === sha &&
    value.source.cleanAfter === true &&
    value.runnerError === null;
  if (value.status !== (expectedPassed ? "passed" : "failed")) {
    throw new CliError("bundle run status does not match its results");
  }
  return value as RunRecord;
}

async function latestRun(directory: string, manifest: Manifest, sha: string): Promise<RunRecord | null> {
  let latest: RunRecord | null = null;
  for (const entry of await readdir(join(directory, "runs"), { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw new CliError(`invalid run file: ${entry.name}`);
    const sequence = sequenceFromName(entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, "runs", entry.name), "utf8"));
    } catch (error) {
      throw new CliError(`cannot read run ${entry.name}: ${message(error)}`);
    }
    const record = parseRun(value, manifest, sha, sequence);
    if (!latest || record.sequence > latest.sequence) latest = record;
  }
  return latest;
}

function parseApproval(value: unknown, manifest: Manifest, sha: string): Approval {
  if (!isObject(value)) throw new CliError("bundle contains an invalid approval record");
  exactKeys(
    value,
    ["version", "repo", "sha", "manifestDigest", "role", "approvedAt"],
    "approval record",
  );
  if (
    value.version !== FORMAT_VERSION ||
    value.repo !== manifest.repo ||
    value.sha !== sha ||
    value.manifestDigest !== digest(manifest) ||
    typeof value.role !== "string" ||
    typeof value.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(value.approvedAt))
  ) {
    throw new CliError("bundle contains an invalid approval record");
  }
  return value as Approval;
}

async function approvals(directory: string, manifest: Manifest, sha: string): Promise<Approval[]> {
  let text: string;
  try {
    text = await readFile(join(directory, "approvals.jsonl"), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return parseApproval(JSON.parse(line), manifest, sha);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`cannot parse approval record: ${message(error)}`);
      }
    });
}

function printStatus(status: Status, sha: string, detail: string): number {
  console.log(`${status} ${sha} ${detail.replaceAll("\n", " ")}`);
  return status === "GREEN" ? 0 : status === "RED" ? 1 : 2;
}

async function check(sha: string): Promise<number> {
  try {
    const root = repositoryRoot();
    const current = head(root);
    if (current !== sha) return printStatus("STALE", sha, `HEAD is ${current}`);
    if (!clean(root)) return printStatus("STALE", sha, "worktree is dirty");
    const manifest = committedManifest(root, sha);
    const directory = candidateDir(manifest, sha);
    const stored = parseManifest(
      await readFile(join(directory, "manifest.json"), "utf8"),
      "bundle manifest.json",
    );
    if (digest(stored) !== digest(manifest)) {
      return printStatus("STALE", sha, "bundle manifest conflicts with candidate");
    }
    const record = await latestRun(directory, manifest, sha);
    if (!record) return printStatus("STALE", sha, "required gate evidence is missing");
    const approved = new Set((await approvals(directory, manifest, sha)).map((entry) => entry.role));
    if (record.status === "failed") return printStatus("RED", sha, `run ${record.runId} failed`);
    const missing = manifest.approvals.filter((role) => !approved.has(role));
    if (missing.length > 0) return printStatus("RED", sha, `missing approvals: ${missing.join(",")}`);
    return printStatus("GREEN", sha, `run ${record.runId} passed`);
  } catch (error) {
    return printStatus("STALE", sha, message(error));
  }
}

async function approve(sha: string, role: string): Promise<number> {
  if (!NAME.test(role)) throw new CliError("role is invalid", 64);
  const root = repositoryRoot();
  const current = head(root);
  if (current !== sha) throw new CliError(`HEAD is ${current}, not ${sha}`);
  const manifest = committedManifest(root, sha);
  if (!manifest.approvals.includes(role)) {
    throw new CliError(`role is not required by evidence.json: ${role}`);
  }
  const directory = await ensureBundle(manifest, sha);
  const record: Approval = {
    version: FORMAT_VERSION,
    repo: manifest.repo,
    sha,
    manifestDigest: digest(manifest),
    role,
    approvedAt: new Date().toISOString(),
  };
  await appendFile(join(directory, "approvals.jsonl"), `${JSON.stringify(record)}\n`, {
    flag: "a",
    mode: 0o600,
  });
  console.log(`APPROVED ${sha} as ${role}`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage());
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (args.length === 1 && args[0] === "run") return run();
  if (args.length === 2 && args[0] === "check") return check(validateSha(args[1]));
  if (args.length === 4 && args[0] === "approve" && args[2] === "--as") {
    return approve(validateSha(args[1]), args[3] ?? "");
  }
  throw new CliError(usage(), 64);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${message(error)}`);
    process.exitCode = error instanceof CliError ? error.exitCode : 2;
  });
