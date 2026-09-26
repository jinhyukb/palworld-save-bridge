import { UUID } from "../../vendor/palworld-save-toolkit/js/gvas.js";
import { requireThat } from "./errors.mjs";
import { binaryOwnershipPlan } from "./opaque.mjs";

export const HOST = "00000000-0000-0000-0000-000000000001";
export const ZERO = "00000000-0000-0000-0000-000000000000";

export function uid(value) {
  const hex = String(value).replaceAll("-", "").toLowerCase();
  requireThat(
    /^[0-9a-f]{32}$/.test(hex),
    "BAD_UID",
    "캐릭터 식별자가 올바르지 않습니다.",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function playerFilename(value) {
  return uid(value).replaceAll("-", "").toUpperCase() + ".sav";
}

export function transferHost(tree, selectedUid) {
  const selected = uid(selectedUid);
  requireThat(selected !== ZERO, "BAD_UID", "플레이어 캐릭터를 선택해 주세요.");
  const counts = {
    references: 0,
    buildings: 0,
    assignments: 0,
    otherOwners: 0,
  };
  const binaryPlan = binaryOwnershipPlan(tree, selected);
  const flip = (value) =>
    selected === HOST
      ? value
      : value === HOST
        ? selected
        : value === selected
          ? HOST
          : value;
  function visit(value, path) {
    if (value instanceof UUID) {
      const original = String(value),
        next = flip(original);
      if (next !== original) {
        counts.references++;
        return UUID.fromString(next);
      }
      return value;
    }
    if (value instanceof Uint8Array) {
      for (const offset of binaryPlan.get(path) || []) {
        const before = String(new UUID(value.slice(offset, offset + 16))),
          after = flip(before);
        if (before !== after) {
          value = value.slice();
          value.set(UUID.fromString(after).rawBytes, offset);
          counts[
            path.includes("WorkAssignMap")
              ? "assignments"
              : path.endsWith("/Model/value/RawData/value/values")
                ? "buildings"
                : "otherOwners"
          ]++;
        }
      }
      return value;
    }
    if (value && typeof value === "object")
      for (const key of Object.keys(value))
        value[key] = visit(value[key], `${path}/${key}`);
    return value;
  }
  visit(tree, "");
  return counts;
}

export function validateOpaqueReferences(tree, selectedUid) {
  binaryOwnershipPlan(tree, uid(selectedUid));
}

export function cleanName(value, fallback, kind = "character") {
  requireThat(
    value === undefined || typeof value === "string",
    "BAD_NAME",
    "이름은 문자열로 입력해 주세요.",
  );
  const name = value?.trim() || fallback;
  requireThat(
    typeof name === "string" &&
      name.trim().length > 0 &&
      // eslint-disable-next-line no-control-regex -- explicitly reject control characters in display names
      !/[\x00-\x1f\x7f]/.test(name),
    "BAD_NAME",
    "이름에 줄바꿈이나 제어 문자를 사용할 수 없습니다.",
  );
  requireThat(
    [...name].length <= (kind === "world" ? 64 : 32),
    "BAD_NAME",
    kind === "world"
      ? "월드명은 64자 이내로 입력해 주세요."
      : "캐릭터명은 32자 이내로 입력해 주세요.",
  );
  return name;
}

export function characterRows(gvas) {
  return (
    gvas.properties.worldSaveData?.value.CharacterSaveParameterMap?.value || []
  );
}

export function parameter(entry) {
  return entry.value.RawData.value.object.SaveParameter.value;
}

export function renamePlayer(gvas, playerUid, newName) {
  const updates = [];
  const set = (path) => {
    const object = path.slice(0, -1).reduce((o, k) => o[k], gvas.properties),
      key = path.at(-1);
    updates.push({ path, original: object[key] });
    object[key] = newName;
  };
  for (const [index, entry] of characterRows(gvas).entries()) {
    const p = parameter(entry);
    if (p.IsPlayer?.value && String(entry.key.PlayerUId.value) === playerUid)
      set([
        "worldSaveData",
        "value",
        "CharacterSaveParameterMap",
        "value",
        index,
        "value",
        "RawData",
        "value",
        "object",
        "SaveParameter",
        "value",
        "NickName",
        "value",
      ]);
  }
  for (const [
    i,
    group,
  ] of gvas.properties.worldSaveData.value.GroupSaveDataMap.value.entries()) {
    const raw = group.value.RawData.value;
    const prefix = [
      "worldSaveData",
      "value",
      "GroupSaveDataMap",
      "value",
      i,
      "value",
      "RawData",
      "value",
    ];
    for (const [j, player] of (raw.guild?.tail.players || []).entries()) {
      if (String(player.player_uid) === playerUid)
        set([
          ...prefix,
          "guild",
          "tail",
          "players",
          j,
          "player_info",
          "player_name",
        ]);
    }
    if (raw.independent && String(raw.independent.player_uid) === playerUid)
      set([...prefix, "independent", "player_info", "player_name"]);
  }
  return updates;
}

export function restoreEdits(gvas, edits) {
  for (const edit of edits) {
    const object = edit.path
      .slice(0, -1)
      .reduce((o, k) => o[k], gvas.properties);
    object[edit.path.at(-1)] = edit.original;
  }
}
