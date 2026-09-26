import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, rejectLinks } from "./files.mjs";
import { UserError } from "./errors.mjs";

const exec = promisify(execFile);
export async function gameRunning() {
  if (process.platform !== "win32")
    throw new UserError(
      "WINDOWS_ONLY",
      "게임 적용은 Windows에서만 지원합니다.",
    );
  try {
    const { stdout } = await exec(
      "tasklist.exe",
      ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq Pal*"],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    return /"(?:Palworld(?:-Win64-Shipping|-WinGDK-Shipping)?|PalServer(?:-Win64-Shipping)?)\.exe"/i.test(
      stdout,
    );
  } catch {
    throw new UserError(
      "PROCESS_CHECK",
      "게임 실행 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  }
}

export async function accounts(gameRoot, worldId) {
  if (!(await exists(gameRoot))) return [];
  await rejectLinks(gameRoot);
  let active = null;
  if (process.platform === "win32") {
    try {
      const { stdout } = await exec(
        "reg.exe",
        [
          "query",
          "HKCU\\Software\\Valve\\Steam\\ActiveProcess",
          "/v",
          "ActiveUser",
        ],
        { windowsHide: true, timeout: 5000 },
      );
      const value = stdout.match(
        /ActiveUser\s+REG_DWORD\s+(0x[0-9a-f]+)/i,
      )?.[1];
      if (value) active = (76561197960265728n + BigInt(value)).toString();
    } catch {
      /* Account IDs remain usable without a running Steam client. */
    }
  }
  const result = [];
  for (const e of await readdir(gameRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || !/^\d{17}$/.test(e.name))
      continue;
    const target = worldId ? join(gameRoot, e.name, worldId) : null;
    let localData = null;
    if (target && (await exists(join(target, "LocalData.sav")))) {
      const path = join(target, "LocalData.sav");
      await rejectLinks(path);
      localData = { updatedAt: (await stat(path)).mtime.toISOString() };
    }
    const hasWorld = target ? await exists(target) : false;
    let existingWorldName = null;
    if (hasWorld && (await exists(join(target, "LevelMeta.sav")))) {
      try {
        const { loadSave } = await import("./codec.mjs");
        existingWorldName =
          (await loadSave(join(target, "LevelMeta.sav"))).g.properties.SaveData
            ?.value.WorldName?.value || null;
      } catch {
        /* A damaged old world may still be backed up and replaced explicitly. */
      }
    }
    result.push({
      id: e.name,
      active: e.name === active,
      hasWorld,
      targetPath: target,
      existingWorldName,
      localData,
    });
  }
  return result.sort(
    (a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id),
  );
}
