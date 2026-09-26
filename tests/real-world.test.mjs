import test from "node:test";
import assert from "node:assert/strict";
import { inspectWorld } from "../src/core/world.mjs";
import { convertWorld } from "../src/core/convert.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = process.env.PSB_FIXTURE_WORLD;
test(
  "real opt-in fixture exposes distinct host and guest characters",
  { skip: !fixture },
  async () => {
    const result = await inspectWorld(fixture);
    assert.ok(result.players.length >= 2);
    assert.equal(result.players.filter((p) => p.isHost).length, 1);
    assert.ok(
      result.players.some((p) => !p.isHost && p.level > 0 && p.palCount > 0),
    );
    assert.equal(result.compatible, true);
  },
);

test(
  "real fixture converts to a renamed host, preserving original files and progression",
  { skip: !fixture },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "psb-convert-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const before = await inspectWorld(fixture);
    const original = await readFile(join(fixture, "Level.sav"));
    const guest = before.players.find((p) => !p.isHost && p.available);
    const result = await convertWorld({
      source: fixture,
      worldId: "ABCDEF0123456789ABCDEF0123456789",
      outputParent: dir,
      selectedUid: guest.uid,
      worldName: "Test World",
      characterName: "Test Guest",
      localDataMode: "supplied",
    });
    assert.ok(result?.worldPath);
    const after = await inspectWorld(result.worldPath);
    assert.equal(after.worldName, "Test World");
    const host = after.players.find((p) => p.isHost);
    assert.equal(host.name, "Test Guest");
    assert.equal(host.instance, guest.instance);
    assert.equal(host.exp, guest.exp);
    assert.equal(host.palCount, guest.palCount);
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(await readFile(join(fixture, "Level.sav")), original);
    assert.ok((await readFile(result.zipPath)).length > 100);
  },
);
