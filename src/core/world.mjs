import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { loadSave } from "./codec.mjs";
import {
  HOST,
  ZERO,
  characterRows,
  parameter,
  transferHost,
  playerFilename,
} from "./transform.mjs";
import { requireThat } from "./errors.mjs";

export function worldSummary(g) {
  const w = g.properties.worldSaveData?.value;
  requireThat(
    w &&
      Array.isArray(w.CharacterSaveParameterMap?.value) &&
      Array.isArray(w.GroupSaveDataMap?.value),
    "UNSUPPORTED_LAYOUT",
    "협동 월드 데이터가 아닙니다. Level.sav가 포함된 폴더를 선택해 주세요.",
  );
  const players = [],
    owned = {},
    counts = {};
  for (const e of characterRows(g)) {
    requireThat(
      e.value.RawData.value.object?.SaveParameter?.value,
      "UNSUPPORTED_LAYOUT",
      "일부 캐릭터를 읽을 수 없어 변환할 수 없습니다.",
    );
    const p = parameter(e);
    if (p.IsPlayer?.value) {
      const id = String(e.key.PlayerUId.value);
      requireThat(
        id !== ZERO && typeof p.NickName?.value === "string",
        "UNSUPPORTED_LAYOUT",
        "플레이어 식별 정보가 올바르지 않습니다.",
      );
      players.push({
        uid: id,
        instance: String(e.key.InstanceId.value),
        name: p.NickName.value,
        level:
          typeof p.Level?.value === "object"
            ? p.Level.value.value
            : p.Level?.value || 1,
        exp: String(p.Exp?.value || 0),
        isHost: id === HOST,
        palCount: 0,
      });
    } else {
      const owner = String(p.OwnerPlayerUId?.value || ZERO);
      owned[owner] = (owned[owner] || 0) + 1;
    }
  }
  requireThat(
    new Set(players.map((p) => p.uid)).size === players.length,
    "DUPLICATE_PLAYER",
    "같은 식별자를 가진 캐릭터가 여러 개여서 자동으로 변환할 수 없습니다.",
  );
  for (const player of players) player.palCount = owned[player.uid] || 0;
  for (const [key, data] of Object.entries(w)) {
    if (Array.isArray(data.value)) counts[key] = data.value.length;
    else if (Array.isArray(data.value?.values))
      counts[key] = data.value.values.length;
  }
  return { players, owned, counts, baseCount: counts.BaseCampSaveData || 0 };
}

export async function inspectWorld(path, progress = () => {}) {
  progress("월드와 캐릭터 데이터를 읽고 있습니다.", 15);
  const level = await loadSave(join(path, "Level.sav"));
  const summary = worldSummary(level.g);
  requireThat(
    summary.players.some((p) => p.isHost),
    "NOT_COOP",
    "기존 방장 캐릭터가 없는 월드입니다. 첫 버전은 로컬 협동 월드만 지원합니다.",
  );
  requireThat(
    level.g.properties.Version?.value === 100,
    "UNSUPPORTED_VERSION",
    "이 세이브 버전은 아직 변환 대상으로 검증되지 않았습니다.",
  );
  transferHost(level.g.properties, HOST); // Validate the known binary layouts without altering identities.
  const meta = await loadSave(join(path, "LevelMeta.sav"));
  const md = meta.g.properties.SaveData?.value;
  requireThat(
    typeof md?.WorldName?.value === "string",
    "INVALID_METADATA",
    "월드 이름 정보를 읽지 못했습니다.",
  );
  const playerFiles = await readdir(join(path, "Players"));
  for (let i = 0; i < summary.players.length; i++) {
    const p = summary.players[i];
    const file = playerFiles.find(
      (n) => n.toUpperCase() === playerFilename(p.uid).toUpperCase(),
    );
    p.available = Boolean(file);
    if (file) {
      const data = (await loadSave(join(path, "Players", file))).g.properties
        .SaveData?.value;
      requireThat(
        String(data?.PlayerUId?.value) === p.uid &&
          String(data?.IndividualId?.value.InstanceId?.value) === p.instance &&
          String(data?.IndividualId?.value.PlayerUId?.value) === p.uid,
        "PLAYER_MISMATCH",
        `${p.name}의 캐릭터 파일과 월드 정보가 일치하지 않습니다. 같은 시점에 저장된 월드 폴더를 받아 주세요.`,
      );
    }
    progress(
      `캐릭터를 확인하고 있습니다. (${i + 1}/${summary.players.length})`,
      45 + Math.round((40 * (i + 1)) / summary.players.length),
    );
  }
  requireThat(
    summary.players.find((p) => p.isHost).available,
    "MISSING_HOST",
    "기존 방장 캐릭터 파일이 없습니다. Players 폴더 전체를 받아 주세요.",
  );
  let hasLocalData = true;
  try {
    await access(join(path, "LocalData.sav"));
  } catch {
    hasLocalData = false;
  }
  return {
    ...summary,
    worldName: md.WorldName.value,
    day: md.InGameDay?.value || 0,
    format: level.format,
    compatible: true,
    hasLocalData,
  };
}
