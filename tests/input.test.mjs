import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorlds,
  safeArchivePath,
  snapshotWorld,
  extractZip,
  assertSeparateOutput,
  assertSeparateOutputCanonical,
} from "../src/core/input.mjs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";

test("finds the current nested world without offering historical backups", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "psb-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = join(dir, "received", "A".repeat(32));
  for (const p of [world, join(world, "backup", "world", "2026")]) {
    await mkdir(join(p, "Players"), { recursive: true });
    await writeFile(join(p, "Level.sav"), "fixture");
    await writeFile(join(p, "LevelMeta.sav"), "fixture");
  }
  const result = await discoverWorlds(dir);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, world);
  assert.equal(result[0].worldId, "A".repeat(32));
});

test("rejects dangerous archive paths and incomplete received worlds", async (t) => {
  for (const name of [
    "../Level.sav",
    "/Level.sav",
    "C:/Level.sav",
    "a\\..\\Level.sav",
    "world/NUL.sav",
    "a./Level.sav",
  ])
    assert.throws(() => safeArchivePath(name), { code: "UNSAFE_ZIP" });
  const dir = await mkdtemp(join(tmpdir(), "psb-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Level.sav"), "fixture");
  await assert.rejects(discoverWorlds(dir), { code: "MISSING_FILES" });
});

test("ZIP import handles nested directories and snapshots only the current save", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "psb-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zip = new yazl.ZipFile(),
    zipPath = join(dir, "received.zip");
  const done = pipeline(zip.outputStream, createWriteStream(zipPath));
  const prefix = "received/" + "C".repeat(32) + "/";
  for (const name of [
    "Level.sav",
    "LevelMeta.sav",
    "Players/" + "0".repeat(31) + "1.sav",
    "backup/world/old/Level.sav",
  ])
    zip.addBuffer(Buffer.from("fixture"), prefix + name);
  zip.end();
  await done;
  const extracted = join(dir, "extracted");
  await extractZip(zipPath, extracted);
  const worlds = await discoverWorlds(extracted);
  assert.equal(worlds.length, 1);
  const snapshot = join(dir, "snapshot");
  await snapshotWorld(worlds[0].path, snapshot);
  const entries = await import("node:fs/promises").then((fs) =>
    fs.readdir(snapshot),
  );
  assert.deepEqual(entries.sort(), ["Level.sav", "LevelMeta.sav", "Players"]);
});

test("output may be the source parent but cannot be inside the source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "psb-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "world");
  await mkdir(join(source, "child"), { recursive: true });
  await assert.doesNotReject(assertSeparateOutput(dir, source));
  await assert.rejects(assertSeparateOutput(source, source), {
    code: "OUTPUT_IN_SOURCE",
  });
  await assert.rejects(assertSeparateOutput(join(source, "child"), source), {
    code: "OUTPUT_IN_SOURCE",
  });
  await rm(source, { recursive: true });
  await assert.doesNotReject(assertSeparateOutputCanonical(dir, source));
});
