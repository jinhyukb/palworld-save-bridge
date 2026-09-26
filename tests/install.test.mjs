import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyResult,
  restoreBackup,
  listHistory,
} from "../src/core/install.mjs";
import { treeManifest } from "../src/core/files.mjs";

const accountId = "76561198000000001",
  worldId = "A".repeat(32);
async function setup(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "psb-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gameRoot = join(root, "SaveGames"),
    stateRoot = join(root, "state"),
    worldPath = join(root, "result");
  const target = join(gameRoot, accountId, worldId);
  await fs.mkdir(join(target, "Players"), { recursive: true });
  await fs.mkdir(worldPath);
  await fs.writeFile(join(target, "Level.sav"), "ORIGINAL WORLD");
  await fs.writeFile(join(target, "old-only.txt"), "RESTORE ME");
  await fs.writeFile(join(worldPath, "Level.sav"), "CONVERTED WORLD");
  await fs.writeFile(join(worldPath, "new-only.txt"), "NEW FILE");
  const other = join(gameRoot, accountId, "B".repeat(32));
  await fs.mkdir(other);
  await fs.writeFile(join(other, "Level.sav"), "OTHER WORLD");
  const manifest = await treeManifest(worldPath);
  return {
    root,
    target,
    other,
    result: {
      worldPath,
      worldId,
      report: { worldName: "Sample", characterName: "Guest", manifest },
    },
    env: { gameRoot, stateRoot, isGameRunning: async () => false },
  };
}

test("apply backs up exactly and restore preserves newer progress without touching another world", async (t) => {
  const s = await setup(t);
  const original = await treeManifest(s.target);
  const applied = await applyResult(
    { result: s.result, accountId, replace: true },
    s.env,
  );
  assert.equal(
    await fs.readFile(join(s.target, "Level.sav"), "utf8"),
    "CONVERTED WORLD",
  );
  assert.deepEqual(await treeManifest(applied.backupPath), original);
  await fs.writeFile(join(s.target, "Level.sav"), "NEW PROGRESS");
  const restored = await restoreBackup(applied.id, s.env);
  assert.deepEqual(await treeManifest(s.target), original);
  assert.equal(
    await fs.readFile(join(restored.savedProgressPath, "Level.sav"), "utf8"),
    "NEW PROGRESS",
  );
  assert.equal(
    await fs.readFile(join(s.other, "Level.sav"), "utf8"),
    "OTHER WORLD",
  );
});

test("running game and unconfirmed overwrite both leave the original untouched", async (t) => {
  const s = await setup(t),
    original = await treeManifest(s.target);
  await assert.rejects(
    applyResult(
      { result: s.result, accountId, replace: true },
      { ...s.env, isGameRunning: async () => true },
    ),
    { code: "GAME_RUNNING" },
  );
  await assert.rejects(
    applyResult({ result: s.result, accountId, replace: false }, s.env),
    { code: "CONFIRM_REPLACE" },
  );
  assert.deepEqual(await treeManifest(s.target), original);
});

test("tampered conversion is rejected before any replacement", async (t) => {
  const s = await setup(t),
    original = await treeManifest(s.target);
  await fs.writeFile(join(s.result.worldPath, "Level.sav"), "TAMPERED");
  await assert.rejects(
    applyResult({ result: s.result, accountId, replace: true }, s.env),
    { code: "HASH_MISMATCH" },
  );
  assert.deepEqual(await treeManifest(s.target), original);
});

test("a failed directory commit rolls back the original world", async (t) => {
  const s = await setup(t),
    original = await treeManifest(s.target);
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (from.includes(".psb-stage-"))
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    applyResult(
      { result: s.result, accountId, replace: true },
      { ...s.env, io },
    ),
    { code: "APPLY_FAILED" },
  );
  assert.deepEqual(await treeManifest(s.target), original);
});

test("a corrupted backup cannot replace later progress", async (t) => {
  const s = await setup(t);
  const applied = await applyResult(
    { result: s.result, accountId, replace: true },
    s.env,
  );
  await fs.writeFile(join(applied.backupPath, "Level.sav"), "BROKEN BACKUP");
  const before = await treeManifest(s.target);
  await assert.rejects(restoreBackup(applied.id, s.env), {
    code: "HASH_MISMATCH",
  });
  assert.deepEqual(await treeManifest(s.target), before);
});

test("restore of a newly added world removes it while preserving its progress", async (t) => {
  const s = await setup(t);
  await fs.rm(s.target, { recursive: true });
  const applied = await applyResult(
    { result: s.result, accountId, replace: false },
    s.env,
  );
  await fs.writeFile(join(s.target, "Level.sav"), "LATER");
  const restored = await restoreBackup(applied.id, s.env);
  await assert.rejects(fs.stat(s.target), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(join(restored.savedProgressPath, "Level.sav"), "utf8"),
    "LATER",
  );
});

test("an interrupted restore can recover its own prior state from persistent history", async (t) => {
  const s = await setup(t);
  const applied = await applyResult(
    { result: s.result, accountId, replace: true },
    s.env,
  );
  await fs.writeFile(join(s.target, "Level.sav"), "PROGRESS BEFORE RESTORE");
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (from.includes(".psb-stage-") || from.includes(".psb-previous-"))
        throw Object.assign(new Error("simulated interrupted restore"), {
          code: "EIO",
        });
      return fs.rename(from, to);
    },
  };
  await assert.rejects(restoreBackup(applied.id, { ...s.env, io }), {
    code: "RECOVERY_NEEDED",
  });
  const pending = (await listHistory(s.env)).find(
    (r) => r.kind === "restore" && r.status === "pending",
  );
  assert.ok(pending);
  await restoreBackup(pending.id, s.env);
  assert.equal(
    await fs.readFile(join(s.target, "Level.sav"), "utf8"),
    "PROGRESS BEFORE RESTORE",
  );
  await restoreBackup(applied.id, s.env);
  assert.equal(
    await fs.readFile(join(s.target, "Level.sav"), "utf8"),
    "ORIGINAL WORLD",
  );
});
