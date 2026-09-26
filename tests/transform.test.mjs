import test from "node:test";
import assert from "node:assert/strict";
import { UUID } from "../vendor/palworld-save-toolkit/js/gvas.js";
import {
  transferHost,
  cleanName,
  validateOpaqueReferences,
} from "../src/core/transform.mjs";

const host = "00000000-0000-0000-0000-000000000001";
const guest = "12345678-0000-0000-0000-000000000000";
const id = (value) => UUID.fromString(value);
test("moves guest ownership and host ownership together without changing items or opaque bytes", () => {
  const untouched = Uint8Array.from([
    ...id("99999999-2222-3333-4444-555555555555").rawBytes,
    99,
  ]);
  const tree = {
    player: id(guest),
    oldHost: id(host),
    inventory: { amount: 17 },
    opaque: untouched.slice(),
  };
  transferHost(tree, guest);
  assert.equal(String(tree.player), host);
  assert.equal(String(tree.oldHost), guest);
  assert.deepEqual(tree.inventory, { amount: 17 });
  assert.deepEqual(tree.opaque, untouched);
});

test("only the documented build owner slot changes, not lookalike byte sequences", () => {
  const bytes = new Uint8Array(261);
  bytes.set(id(guest).rawBytes, 200);
  bytes.set(id(host).rawBytes, 80);
  const tree = { Model: { value: { RawData: { value: { values: bytes } } } } };
  transferHost(tree, guest);
  const changed = tree.Model.value.RawData.value.values;
  assert.equal(String(new UUID(changed.slice(200, 216))), host);
  assert.deepEqual(changed.slice(80, 96), id(host).rawBytes);
  transferHost(tree, guest);
  assert.deepEqual(tree.Model.value.RawData.value.values, bytes);
});

test("unknown owner locations and unknown model layouts fail closed", () => {
  assert.throws(
    () => validateOpaqueReferences({ futureData: id(guest).rawBytes }, guest),
    { code: "UNSUPPORTED_REFERENCE" },
  );
  assert.throws(
    () => validateOpaqueReferences({ futureData: id(host).rawBytes }, guest),
    { code: "UNSUPPORTED_REFERENCE" },
  );
  assert.throws(
    () =>
      transferHost(
        {
          Model: {
            value: { RawData: { value: { values: new Uint8Array(262) } } },
          },
        },
        guest,
      ),
    { code: "UNSUPPORTED_LAYOUT" },
  );
  const model = new Uint8Array(261);
  model.set(id(host).rawBytes, 245);
  assert.throws(
    () =>
      transferHost(
        { Model: { value: { RawData: { value: { values: model } } } } },
        guest,
      ),
    { code: "UNSUPPORTED_REFERENCE" },
  );
});

test("item booth sellers move with their character without changing money counts", () => {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const text = (s) => Buffer.concat([u32(s.length + 1), Buffer.from(s + "\0")]);
  const item = (name, count) =>
    Buffer.concat([text(name), Buffer.alloc(32), u32(count)]);
  const product = item("TestItem", 5),
    cost = item("Money", 1);
  const raw = Uint8Array.from(
    Buffer.concat([
      Buffer.alloc(36),
      Buffer.from(id(guest).rawBytes),
      u32(1),
      product,
      cost,
      Buffer.from(id(host).rawBytes),
      Buffer.alloc(20),
    ]),
  );
  const entry = {
    MapObjectId: { value: "ItemBooth" },
    ConcreteModel: { value: { RawData: { value: { values: raw } } } },
  };
  const tree = {
    worldSaveData: {
      value: { MapObjectSaveData: { value: { values: [entry] } } },
    },
  };
  const sellerOffset = 56 + product.length + cost.length;
  transferHost(tree, guest);
  const changed = entry.ConcreteModel.value.RawData.value.values;
  assert.equal(String(new UUID(changed.slice(36, 52))), host);
  assert.equal(
    String(new UUID(changed.slice(sellerOffset, sellerOffset + 16))),
    guest,
  );
  assert.deepEqual(
    changed.slice(56, sellerOffset),
    raw.slice(56, sellerOffset),
  );
  transferHost(tree, guest);
  assert.deepEqual(entry.ConcreteModel.value.RawData.value.values, raw);
});

test("blank names preserve originals and invalid display names are rejected", () => {
  assert.equal(cleanName("   ", "Original"), "Original");
  assert.equal(cleanName(" 새 이름 ", "Original"), "새 이름");
  assert.throws(() => cleanName("line\nbreak", "Original"), {
    code: "BAD_NAME",
  });
  assert.throws(() => cleanName("a".repeat(33), "Original"), {
    code: "BAD_NAME",
  });
});
