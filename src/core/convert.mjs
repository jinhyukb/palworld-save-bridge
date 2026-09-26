import { mkdir, writeFile, copyFile, readdir, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { loadSave, parseRaw, encodeContainer, PROPS } from "./codec.mjs";
import { inspectWorld, worldSummary } from "./world.mjs";
import {
  HOST,
  uid,
  playerFilename,
  cleanName,
  transferHost,
  validateOpaqueReferences,
  renamePlayer,
  restoreEdits,
} from "./transform.mjs";
import {
  treeManifest,
  sameManifest,
  exists,
  writeJson,
  hashBytes,
} from "./files.mjs";
import { WORLD_ID, assertSeparateOutput } from "./input.mjs";
import { requireThat } from "./errors.mjs";

async function saveVerified(path, raw) {
  await writeFile(path, encodeContainer(raw), { flag: "wx" });
  const reread = await loadSave(path);
  requireThat(
    reread.raw.equals(Buffer.from(raw)),
    "OUTPUT_INVALID",
    "변환 파일을 다시 읽는 검사에 실패했습니다.",
  );
  return reread;
}

export async function convertWorld(options, progress = () => {}) {
  const { source, outputParent, worldId } = options;
  requireThat(
    WORLD_ID.test(worldId),
    "BAD_WORLD_ID",
    "월드 식별자가 올바르지 않습니다.",
  );
  await assertSeparateOutput(outputParent, source);
  const initialFiles = await treeManifest(source);
  const before = await inspectWorld(source, progress);
  const selectedUid = uid(options.selectedUid);
  const selected = before.players.find(
    (p) => p.uid === selectedUid && p.available,
  );
  requireThat(selected, "NO_PLAYER", "변환할 캐릭터를 선택해 주세요.");
  const newWorldName = cleanName(options.worldName, before.worldName, "world");
  const newCharacterName = cleanName(options.characterName, selected.name);
  requireThat(
    ["supplied", "own", "none"].includes(options.localDataMode),
    "BAD_MAP",
    "지도 기록 옵션을 선택해 주세요.",
  );
  const runId = randomUUID(),
    stage = join(outputParent, ".psb-converting-" + runId);
  await mkdir(join(stage, worldId, "Players"), { recursive: true });
  const worldPath = join(stage, worldId);
  progress("캐릭터와 팰의 소유권을 연결하고 있습니다.", 35);
  const level = await loadSave(join(source, "Level.sav"));
  validateOpaqueReferences(level.g.properties, selectedUid);
  const changes = transferHost(level.g.properties, selectedUid);
  const nameEdits = renamePlayer(level.g, HOST, newCharacterName);
  const levelRaw = Buffer.from(level.g.write(PROPS));
  const reverse = parseRaw(levelRaw);
  restoreEdits(reverse, nameEdits);
  transferHost(reverse.properties, selectedUid);
  requireThat(
    Buffer.from(reverse.write(PROPS)).equals(level.raw),
    "LOSSY_CONVERSION",
    "변경 내용을 되돌렸을 때 원본과 일치하지 않아 결과를 저장하지 않았습니다.",
  );
  const rewritten = await saveVerified(join(worldPath, "Level.sav"), levelRaw);
  const after = worldSummary(rewritten.g);
  const hostAfter = after.players.find((p) => p.isHost);
  requireThat(
    hostAfter.instance === selected.instance &&
      hostAfter.exp === selected.exp &&
      hostAfter.palCount === selected.palCount &&
      JSON.stringify(before.counts) === JSON.stringify(after.counts),
    "PROGRESSION_CHANGED",
    "캐릭터 진행 정보 보존 검사에 실패했습니다.",
  );
  progress("캐릭터 파일과 표시 이름을 저장하고 있습니다.", 62);
  for (const filename of await readdir(join(source, "Players"))) {
    if (!/^[a-f0-9]{32}\.sav$/i.test(filename)) continue;
    const oldUid = uid(filename.slice(0, -4));
    const nextUid =
      selectedUid === HOST
        ? oldUid
        : oldUid === HOST
          ? selectedUid
          : oldUid === selectedUid
            ? HOST
            : oldUid;
    const p = await loadSave(join(source, "Players", filename));
    validateOpaqueReferences(p.g.properties, selectedUid);
    transferHost(p.g.properties, selectedUid);
    const raw = Buffer.from(p.g.write(PROPS));
    const inverted = parseRaw(raw);
    transferHost(inverted.properties, selectedUid);
    requireThat(
      Buffer.from(inverted.write(PROPS)).equals(p.raw),
      "LOSSY_CONVERSION",
      "캐릭터 파일 보존 검사에 실패했습니다.",
    );
    await saveVerified(
      join(worldPath, "Players", playerFilename(nextUid)),
      raw,
    );
  }
  const meta = await loadSave(join(source, "LevelMeta.sav"));
  const md = meta.g.properties.SaveData.value;
  const originals = {
    WorldName: md.WorldName.value,
    HostPlayerName: md.HostPlayerName?.value,
    HostPlayerLevel: md.HostPlayerLevel?.value,
  };
  requireThat(
    md.HostPlayerName && md.HostPlayerLevel,
    "INVALID_METADATA",
    "방장 표시 정보가 없는 메타데이터입니다.",
  );
  md.WorldName.value = newWorldName;
  md.HostPlayerName.value = newCharacterName;
  md.HostPlayerLevel.value = selected.level;
  const metadata = await saveVerified(
    join(worldPath, "LevelMeta.sav"),
    meta.g.write(PROPS),
  );
  for (const [k, v] of Object.entries(originals))
    metadata.g.properties.SaveData.value[k].value = v;
  requireThat(
    Buffer.from(metadata.g.write(PROPS)).equals(meta.raw),
    "LOSSY_CONVERSION",
    "월드 이름 정보 보존 검사에 실패했습니다.",
  );
  if (await exists(join(source, "WorldOption.sav")))
    await copyFile(
      join(source, "WorldOption.sav"),
      join(worldPath, "WorldOption.sav"),
    );
  let localDescription = "새 지도 기록으로 시작";
  const localFile =
    options.localDataMode === "own"
      ? options.localDataPath
      : options.localDataMode === "supplied" && before.hasLocalData
        ? join(source, "LocalData.sav")
        : null;
  if (localFile) {
    const local = await loadSave(localFile);
    requireThat(
      local.g.properties.SaveData?.struct_type === "PalLocalSaveData",
      "BAD_LOCAL_DATA",
      "LocalData.sav 지도 기록 파일을 선택해 주세요.",
    );
    await writeFile(join(worldPath, "LocalData.sav"), local.encoded, {
      flag: "wx",
    });
    localDescription =
      options.localDataMode === "own"
        ? "사용자가 선택한 본인 지도 기록"
        : "받은 폴더에 포함된 지도 기록 (기존 방장 기록일 수 있음)";
  } else
    requireThat(
      options.localDataMode !== "own",
      "BAD_LOCAL_DATA",
      "본인의 LocalData.sav 파일을 선택해 주세요.",
    );
  progress("원본 보존과 결과 파일을 검사하고 있습니다.", 80);
  requireThat(
    sameManifest(initialFiles, await treeManifest(source)),
    "SOURCE_CHANGED",
    "변환 중 원본 파일이 변경되었습니다. 다시 불러와 주세요.",
  );
  const manifest = await treeManifest(worldPath);
  const report = {
    schema: 1,
    appVersion: "0.1.0",
    worldId,
    createdAt: new Date().toISOString(),
    sourceFormat: before.format,
    outputFormat: "PlZ",
    originalWorldName: before.worldName,
    worldName: newWorldName,
    originalCharacterName: selected.name,
    characterName: newCharacterName,
    selectedLevel: selected.level,
    selectedPalCount: selected.palCount,
    baseCount: before.baseCount,
    counts: before.counts,
    changes,
    localDescription,
    manifest,
    originalLevelSha256: hashBytes(level.raw),
    checks: [
      "원본 미수정 확인",
      "이름 변경과 UID 교환의 역변환이 원본 바이트와 일치",
      "캐릭터 경험치·팰 연결·월드 기록 수 유지",
      "변환 파일 재읽기 및 손실 없는 재저장",
    ],
    gameplayVerified: false,
    formerHostReconnect:
      "기존 방장이 다시 참가하려면 별도 캐릭터 연결 작업이 필요합니다.",
  };
  await writeJson(join(stage, "verification.json"), report);
  const instructions = `Palworld Save Bridge — 변환 결과\n\n월드: ${newWorldName}\n캐릭터: ${newCharacterName} (레벨 ${selected.level})\n소유 팰 기록: ${selected.palCount}\n지도: ${localDescription}\n\n파일 검사를 통과했습니다. 실제 게임에서 입장·아이템·팰·거점을 확인해 주세요.\n앱의 '내 게임에 적용'을 사용하거나 아래 폴더를 Steam 계정 세이브 폴더로 복사하세요.\n월드 폴더: ${worldId}\nSteam 세이브 위치: %LOCALAPPDATA%\\Pal\\Saved\\SaveGames\\<Steam 계정 ID>\\\n\n원본은 변경하지 않았습니다. 이 복사본은 친구 월드와 자동 동기화되지 않습니다.\n기존 방장이 다시 참여하려면 별도 연결 작업이 필요합니다.\n캐릭터 생성 화면이 나오면 새 캐릭터를 만들지 말고 종료 후 원본을 보관해 주세요.\n`;
  await writeFile(join(stage, "읽어주세요.txt"), instructions, "utf8");
  const zip = new yazl.ZipFile();
  for (const name of Object.keys(manifest))
    zip.addFile(join(worldPath, name), worldId + "/" + name);
  const zipDone = pipeline(
    zip.outputStream,
    createWriteStream(join(stage, worldId + ".zip"), { flags: "wx" }),
  );
  zip.end();
  await zipDone;
  progress("결과를 정리하고 있습니다.", 95);
  const finalRoot = join(
    outputParent,
    "Palworld-Transfer-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      runId.slice(0, 6),
  );
  await rename(stage, finalRoot);
  progress("변환 완료", 100);
  return {
    id: runId,
    root: finalRoot,
    worldId,
    worldPath: join(finalRoot, worldId),
    zipPath: join(finalRoot, worldId + ".zip"),
    report,
  };
}
