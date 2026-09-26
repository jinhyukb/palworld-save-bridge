import test from "node:test";
import assert from "node:assert/strict";
import { UUID } from "../vendor/palworld-save-toolkit/js/gvas.js";
import { transferHost, HOST } from "../src/core/transform.mjs";

const GUEST = "12345678-0000-0000-0000-000000000000";
const uuid = (text) => UUID.fromString(text);
function droppedFixture() {
  const raw = new Uint8Array(88),
    model = new Uint8Array(261);
  const modelId = uuid("11111111-2222-3333-4444-555555555555"),
    concreteId = uuid("22222222-2222-3333-4444-555555555555"),
    storedId = uuid("33333333-2222-3333-4444-555555555555");
  raw.set(concreteId.rawBytes, 0);
  raw.set(modelId.rawBytes, 16);
  raw.set(storedId.rawBytes, 36);
  raw.set(uuid(HOST).rawBytes, 68);
  model.set(modelId.rawBytes, 0);
  model.set(concreteId.rawBytes, 16);
  const versions = Buffer.alloc(44);
  versions.writeUInt32LE(2);
  versions.set(uuid("de000b38-ced7-4949-992d-df9769c3c1c0").rawBytes, 4);
  versions.writeUInt32LE(1, 20);
  versions.set(uuid("636f6bc2-d5c4-4ed9-993a-c408419e8b62").rawBytes, 24);
  versions.writeUInt32LE(3, 40);
  const storage = {
    ID: { value: { ID: { value: storedId } } },
    LostPlayerUId: { value: uuid(HOST) },
    InstanceId: { value: { PlayerUId: { value: uuid(HOST) } } },
  };
  const entry = {
    MapObjectId: { value: "DroppedCharacter" },
    Model: { value: { RawData: { value: { values: model } } } },
    ConcreteModel: {
      value: {
        RawData: { value: { values: raw } },
        CustomVersionData: { value: { values: Uint8Array.from(versions) } },
      },
    },
  };
  const records = [storage];
  const tree = {
    worldSaveData: {
      value: {
        MapObjectSaveData: { value: { values: [entry] } },
        CharacterParameterStorageSaveData: {
          value: {
            StoredParameterInfoSaveData: { value: { values: records } },
          },
        },
      },
    },
  };
  return { tree, entry, raw, model, records, storage };
}

test("constrained dropped-character ownership follows its named storage relation", () => {
  const fixture = droppedFixture(),
    original = fixture.raw.slice();
  transferHost(fixture.tree, GUEST);
  assert.equal(String(fixture.storage.LostPlayerUId.value), GUEST);
  assert.equal(
    String(
      new UUID(
        fixture.entry.ConcreteModel.value.RawData.value.values.slice(68, 84),
      ),
    ),
    GUEST,
  );
  transferHost(fixture.tree, GUEST);
  assert.deepEqual(
    fixture.entry.ConcreteModel.value.RawData.value.values,
    original,
  );
});

test("dropped-character profile rejects every broken relationship or unexplained owner", () => {
  const mutations = [
    (f) => {
      f.storage.LostPlayerUId.value = uuid(GUEST);
    },
    (f) => {
      f.storage.InstanceId.value.PlayerUId.value = uuid(GUEST);
    },
    (f) => {
      f.records.length = 0;
    },
    (f) => {
      f.records.push(f.storage);
    },
    (f) => {
      f.model[0] ^= 4;
    },
    (f) => {
      f.raw[32] = 1;
    },
    (f) => {
      f.raw[84] = 1;
    },
    (f) => {
      f.entry.ConcreteModel.value.CustomVersionData.value.values[40] = 4;
    },
    (f) => {
      f.raw.set(uuid(HOST).rawBytes, 52);
    },
    (f) => {
      f.entry.ConcreteModel.value.RawData.value.values = new Uint8Array(89);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = droppedFixture();
    mutate(f);
    assert.throws(
      () => transferHost(f.tree, GUEST),
      (error) =>
        ["UNSUPPORTED_LAYOUT", "UNSUPPORTED_REFERENCE"].includes(error.code),
      `mutation ${index}`,
    );
  }
});
