// Binary ownership profiles. Sources and the two explicitly inferred, constrained
// profiles are documented in docs/SAVE_FORMAT_SUPPORT.md. Never blanket-replace
// GUID-shaped bytes: the host UID is also a common numeric zero/one sequence.
import { UUID } from "../../vendor/palworld-save-toolkit/js/gvas.js";
import { requireThat } from "./errors.mjs";

const HOST = "00000000-0000-0000-0000-000000000001";
const VERSION_GUID = "de000b38-ced7-4949-992d-df9769c3c1c0";
const MODEL_VERSION_GUID = "636f6bc2-d5c4-4ed9-993a-c408419e8b62";
const ZERO = "00000000-0000-0000-0000-000000000000";
const atPath = (tree, path) =>
  path
    .split("/")
    .filter(Boolean)
    .reduce((o, key) => o?.[key], tree);
const uuidAt = (bytes, offset) =>
  String(new UUID(bytes.slice(offset, offset + 16)));
function supported(condition) {
  requireThat(
    condition,
    "UNSUPPORTED_LAYOUT",
    "소유권을 안전하게 해석할 수 없는 세이브 구조입니다. 원본은 변경되지 않았습니다.",
  );
}

class Cursor {
  constructor(bytes) {
    this.b = Buffer.from(bytes);
    this.pos = 0;
    this.owners = [];
  }
  skip(n) {
    supported(
      Number.isSafeInteger(n) && n >= 0 && this.pos + n <= this.b.length,
    );
    const old = this.pos;
    this.pos += n;
    return old;
  }
  u8() {
    return this.b.readUInt8(this.skip(1));
  }
  u32() {
    return this.b.readUInt32LE(this.skip(4));
  }
  i32() {
    return this.b.readInt32LE(this.skip(4));
  }
  count() {
    const n = this.u32();
    supported(n <= 100000);
    return n;
  }
  guid(owner = false) {
    const p = this.skip(16);
    if (owner) this.owners.push(p);
    return uuidAt(this.b, p);
  }
  text() {
    const n = this.i32();
    supported(Math.abs(n) <= 65536);
    const size = n < 0 ? -2 * n : n,
      p = this.skip(size);
    if (!size) return "";
    supported(
      this.b[p + size - 1] === 0 && (n >= 0 || this.b[p + size - 2] === 0),
    );
    return this.b
      .subarray(p, p + size - (n < 0 ? 2 : 1))
      .toString(n < 0 ? "utf16le" : "utf8");
  }
  bool() {
    supported(this.u32() <= 1);
  }
  zero(n) {
    const p = this.skip(n);
    supported(this.b.subarray(p, p + n).every((v) => v === 0));
  }
  end() {
    supported(this.pos === this.b.length);
    return { owners: this.owners, safe: [[0, this.b.length]] };
  }
}

function versionEntries(bytes) {
  const r = new Cursor(bytes),
    n = r.count();
  supported(n <= 32 && bytes.length === 4 + n * 20);
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const guid = r.guid();
    supported(!entries.has(guid));
    entries.set(guid, r.i32());
  }
  r.end();
  return entries;
}

function profile(tree, path, bytes) {
  const r = new Cursor(bytes);
  if (path.endsWith("/CustomVersionData/value/values")) {
    const versions = versionEntries(bytes);
    supported(
      versions.size === 2 &&
        versions.get(VERSION_GUID) === 1 &&
        versions.get(ZERO) === 1,
    );
    return { owners: [], safe: [[0, bytes.length]] };
  }
  if (path.endsWith("/Model/value/RawData/value/values")) {
    supported(bytes.length === 261);
    // Modern schema ends at 241. Its 20-byte opaque tail is never exempted.
    return { owners: [200], safe: [[0, 241]] };
  }
  if (
    /\/WorkAssignMap\/value\/\d+\/value\/RawData\/value\/values$/.test(path)
  ) {
    r.guid();
    r.i32();
    r.u8();
    r.guid(true);
    r.guid();
    r.u8();
    r.bool();
    r.zero(4);
    const owner = atPath(tree, path.slice(0, path.indexOf("/WorkAssignMap/")));
    if (
      owner?.WorkableType?.value.value ===
      "EPalWorkableType::Progress_MultiType"
    ) {
      r.skip(3);
      r.zero(4);
    }
    return r.end();
  }
  if (path.endsWith("/ConcreteModel/value/RawData/value/values")) {
    const entry = atPath(tree, path.slice(0, path.indexOf("/ConcreteModel/")));
    if (entry?.MapObjectId?.value === "ItemBooth") {
      r.guid();
      r.guid();
      r.zero(4);
      r.guid(true);
      const n = r.count();
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 2; j++) {
          r.text();
          r.guid();
          r.guid();
          r.i32();
        }
        r.guid(true);
      }
      r.zero(20);
      return r.end();
    }
    if (entry?.MapObjectId?.value === "DroppedCharacter") {
      supported(bytes.length === 88);
      const versions = versionEntries(
        entry.ConcreteModel.value.CustomVersionData.value.values,
      );
      supported(
        versions.size === 2 &&
          versions.get(VERSION_GUID) === 1 &&
          versions.get(MODEL_VERSION_GUID) === 3,
      );
      const model = entry.Model.value.RawData.value.values;
      supported(
        model.length === 261 &&
          uuidAt(bytes, 0) === uuidAt(model, 16) &&
          uuidAt(bytes, 16) === uuidAt(model, 0),
      );
      r.skip(32);
      r.zero(4);
      const storedId = r.guid();
      r.skip(16);
      const owner = r.guid(true);
      r.zero(4);
      r.end();
      const records =
        tree.worldSaveData?.value.CharacterParameterStorageSaveData?.value
          .StoredParameterInfoSaveData?.value.values || [];
      const matches = records.filter(
        (item) => String(item.ID?.value.ID?.value) === storedId,
      );
      supported(
        matches.length === 1 &&
          String(matches[0].LostPlayerUId?.value) === owner &&
          String(matches[0].InstanceId?.value.PlayerUId?.value) === owner,
      );
      // Bytes 52..67 remain unexplained. They are not exempted from reference checks.
      return {
        owners: [68],
        safe: [
          [0, 52],
          [84, 88],
        ],
      };
    }
    return null;
  }
  const moduleMatch = path.match(
    /^(.*\/ConcreteModel\/value\/ModuleMap\/value\/\d+)\/value\/RawData\/value\/values$/,
  );
  if (moduleMatch) {
    const type = atPath(tree, moduleMatch[1])?.key;
    if (type === "EPalMapObjectConcreteModelModuleType::ItemContainer") {
      r.guid();
      const count = r.count();
      for (let i = 0; i < count; i++) {
        r.u8();
        r.skip(r.count() * 4);
      }
      r.skip(r.count());
      r.bool();
      r.u8();
      r.zero(4);
      return r.end();
    }
    if (type === "EPalMapObjectConcreteModelModuleType::PasswordLock") {
      r.u8();
      r.text();
      const n = r.count();
      for (let i = 0; i < n; i++) {
        r.guid(true);
        r.i32();
        r.bool();
      }
      supported([0, 4].includes(bytes.length - r.pos));
      r.zero(bytes.length - r.pos);
      return r.end();
    }
    return null;
  }
  if (
    /\/FoliageGridSaveDataMap\/value\/\d+\/value\/ModelMap\/value\/\d+\/value\/RawData\/value\/values$/.test(
      path,
    )
  ) {
    r.text();
    r.u8();
    r.skip(24);
    r.zero(4);
    return r.end();
  }
  if (
    /\/ItemContainerSaveData\/value\/\d+\/value\/Slots\/value\/values\/\d+\/RawData\/value\/values$/.test(
      path,
    )
  ) {
    // Restricted composite of the modern item prefix and legacy permission suffix.
    const index = r.i32(),
      count = r.i32();
    supported(index >= 0 && count >= 0);
    const staticId = r.text();
    r.guid();
    r.guid();
    supported(
      r.count() === 0 &&
        r.count() === 0 &&
        r.count() === 1 &&
        r.text() === staticId,
    );
    r.zero(4);
    r.zero(4);
    return r.end();
  }
  const workMatch = path.match(
    /^(.*\/WorkSaveData\/value\/values\/\d+)\/RawData\/value\/values$/,
  );
  if (workMatch) {
    const kind = atPath(tree, workMatch[1])?.WorkableType?.value.value;
    if (
      ![
        "EPalWorkableType::Repair",
        "EPalWorkableType::ReviveCharacter",
      ].includes(kind)
    )
      return null;
    r.guid();
    r.skip(112);
    r.guid();
    r.guid();
    r.guid();
    r.u8();
    r.skip(r.count() * 48);
    r.u8();
    r.text();
    r.u8();
    r.u8();
    r.bool();
    r.bool();
    r.bool();
    if (kind === "EPalWorkableType::Repair") r.skip(4);
    else {
      r.guid(true);
      r.guid();
    }
    const transform = r.u8();
    supported(transform === 2);
    r.guid();
    r.zero(8);
    return r.end();
  }
  return null;
}

export function binaryOwnershipPlan(tree, selectedUid) {
  const plan = new Map();
  const identities =
    selectedUid === HOST
      ? []
      : [HOST, selectedUid].map((s) =>
          Buffer.from(UUID.fromString(s).rawBytes),
        );
  function visit(value, path) {
    if (value instanceof UUID) return;
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      const hits = identities.flatMap((needle) => {
        const offsets = [];
        for (
          let at = bytes.indexOf(needle);
          at >= 0;
          at = bytes.indexOf(needle, at + 1)
        )
          offsets.push(at);
        return offsets;
      });
      // Always check model layouts; validate other opaque profiles when either
      // swapped identity occurs. Unknown blocks without these identities stay opaque.
      const concreteType = path.endsWith(
        "/ConcreteModel/value/RawData/value/values",
      )
        ? atPath(tree, path.slice(0, path.indexOf("/ConcreteModel/")))
            ?.MapObjectId?.value
        : null;
      if (
        !hits.length &&
        !path.endsWith("/Model/value/RawData/value/values") &&
        !["DroppedCharacter", "ItemBooth"].includes(concreteType)
      )
        return;
      let decoded;
      try {
        decoded = profile(tree, path, value);
      } catch (error) {
        error.schemaPath = path;
        throw error;
      }
      for (const at of hits) {
        requireThat(
          decoded &&
            (decoded.owners.includes(at) ||
              decoded.safe.some(([a, b]) => at >= a && at + 16 <= b)),
          "UNSUPPORTED_REFERENCE",
          "아직 해석하지 못하는 데이터에 방장 또는 캐릭터 연결이 있습니다. 이 세이브는 안전하게 변환할 수 없습니다.",
        );
      }
      if (decoded?.owners.length) plan.set(path, decoded.owners);
      return;
    }
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        visit(child, path + "/" + key);
  }
  visit(tree, "");
  return plan;
}
