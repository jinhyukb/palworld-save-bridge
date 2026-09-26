import {
  readdir,
  lstat,
  mkdir,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { requireThat } from "./errors.mjs";

const OMIT = new Set(["backup", "backups", "__macosx", ".git", "node_modules"]);
export const WORLD_ID = /^[0-9a-f]{32}$/i;
export const PLAYER_FILE = /^[0-9a-f]{32}\.sav$/i;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;

export async function discoverWorlds(root) {
  const result = [];
  let visited = 0;
  async function visit(dir, depth) {
    requireThat(
      ++visited <= 10000,
      "TOO_MANY_FILES",
      "폴더가 너무 큽니다. 받은 월드 폴더만 선택해 주세요.",
    );
    const info = await lstat(dir);
    requireThat(
      !info.isSymbolicLink(),
      "LINK",
      "바로가기나 링크 대신 실제 월드 폴더를 선택해 주세요.",
    );
    requireThat(
      info.isDirectory(),
      "NOT_FOLDER",
      "월드 폴더 또는 ZIP 파일을 선택해 주세요.",
    );
    const entries = await readdir(dir, { withFileTypes: true });
    const names = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    if (names.has("level.sav")) {
      const missing = ["LevelMeta.sav", "Players"].filter(
        (n) => !names.has(n.toLowerCase()),
      );
      requireThat(
        !missing.length,
        "MISSING_FILES",
        `${basename(dir)}: ${missing.join(", ")}이(가) 없습니다. 방장에게 월드 폴더 전체를 받아 주세요.`,
      );
      result.push({
        path: dir,
        worldId: WORLD_ID.test(basename(dir))
          ? basename(dir).toUpperCase()
          : randomUUID().replaceAll("-", "").toUpperCase(),
        label: basename(dir),
      });
      return;
    }
    if (depth >= 8) return;
    for (const e of entries) {
      if (
        e.isDirectory() &&
        !e.isSymbolicLink() &&
        !OMIT.has(e.name.toLowerCase())
      )
        await visit(join(dir, e.name), depth + 1);
    }
  }
  await visit(resolve(root), 0);
  requireThat(
    result.length <= 100,
    "TOO_MANY_WORLDS",
    "월드가 너무 많습니다. 변환할 월드가 있는 폴더만 선택해 주세요.",
  );
  return result;
}

export function safeArchivePath(name) {
  requireThat(
    typeof name === "string" &&
      name.length < 1024 &&
      // eslint-disable-next-line no-control-regex -- explicitly reject control characters in paths
      !/[\\:\x00-\x1f]/.test(name) &&
      !name.startsWith("/"),
    "UNSAFE_ZIP",
    "ZIP에 안전하지 않은 파일 경로가 있습니다.",
  );
  const parts = name.split("/");
  requireThat(
    !parts.some(
      (p) =>
        p === ".." ||
        p === "." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    ),
    "UNSAFE_ZIP",
    "ZIP에 사용할 수 없는 파일 경로가 있습니다.",
  );
  return parts;
}

export async function extractZip(zipPath, destination) {
  await mkdir(destination, { recursive: false });
  const zip = await new Promise((ok, no) =>
    yauzl.open(
      zipPath,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (err, value) => (err ? no(err) : ok(value)),
    ),
  );
  let count = 0,
    total = 0;
  const seen = new Set();
  await new Promise((ok, no) => {
    let ended = false;
    const fail = (error) => {
      if (!ended) {
        ended = true;
        zip.close();
        no(error);
      }
    };
    zip.on("error", fail);
    zip.on("end", () => {
      ended = true;
      ok();
    });
    zip.on("entry", async (entry) => {
      try {
        requireThat(
          ++count <= 30000,
          "ZIP_LIMIT",
          "ZIP 파일 수가 너무 많습니다. 현재 월드만 압축해 주세요.",
        );
        const parts = safeArchivePath(entry.fileName);
        const key = entry.fileName.toLowerCase();
        requireThat(
          !seen.has(key),
          "UNSAFE_ZIP",
          "ZIP에 중복된 파일 이름이 있습니다.",
        );
        seen.add(key);
        requireThat(
          ((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000,
          "UNSAFE_ZIP",
          "ZIP의 링크 파일은 지원하지 않습니다.",
        );
        requireThat(
          !(entry.generalPurposeBitFlag & 1),
          "ENCRYPTED_ZIP",
          "암호가 설정된 ZIP은 먼저 압축을 풀어 주세요.",
        );
        if (parts.some((p) => OMIT.has(p.toLowerCase()))) {
          zip.readEntry();
          return;
        }
        requireThat(
          entry.uncompressedSize <= MAX_FILE &&
            (total += entry.uncompressedSize) <= MAX_TOTAL,
          "ZIP_LIMIT",
          "ZIP 용량이 지원 범위를 넘습니다. 현재 월드 폴더만 선택해 주세요.",
        );
        const file = join(destination, ...parts);
        if (entry.fileName.endsWith("/"))
          await mkdir(file, { recursive: true });
        else if (/\.sav$/i.test(file)) {
          await mkdir(resolve(file, ".."), { recursive: true });
          const stream = await new Promise((yes, reject) =>
            zip.openReadStream(entry, (err, s) => (err ? reject(err) : yes(s))),
          );
          await pipeline(stream, createWriteStream(file, { flags: "wx" }));
        }
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

export async function snapshotWorld(source, destination) {
  const files = [];
  const top = await readdir(source, { withFileTypes: true });
  for (const name of [
    "Level.sav",
    "LevelMeta.sav",
    "WorldOption.sav",
    "LocalData.sav",
  ]) {
    const found = top.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (found) files.push([join(source, found.name), name]);
  }
  const players = top.find((e) => e.name.toLowerCase() === "players");
  requireThat(
    players && players.isDirectory() && !players.isSymbolicLink(),
    "MISSING_FILES",
    "Players 폴더가 없습니다.",
  );
  for (const e of await readdir(join(source, players.name), {
    withFileTypes: true,
  })) {
    if (PLAYER_FILE.test(e.name))
      files.push([
        join(source, players.name, e.name),
        "Players/" + e.name.toUpperCase().replace(".SAV", ".sav"),
      ]);
  }
  requireThat(
    files.some(([, n]) => n.startsWith("Players/")),
    "MISSING_FILES",
    "Players 폴더에 캐릭터 세이브가 없습니다.",
  );
  requireThat(
    files.length <= 1004,
    "TOO_MANY_PLAYERS",
    "지원 가능한 캐릭터 수를 초과했습니다.",
  );
  await mkdir(join(destination, "Players"), { recursive: true });
  let total = 0;
  for (const [file, name] of files) {
    const info = await lstat(file);
    requireThat(
      info.isFile() && !info.isSymbolicLink(),
      "LINK",
      "세이브에는 일반 파일만 사용할 수 있습니다.",
    );
    requireThat(
      info.size <= MAX_FILE && (total += info.size) <= MAX_TOTAL,
      "SAVE_TOO_LARGE",
      "세이브 용량이 지원 범위를 넘습니다.",
    );
    const data = await readFile(file);
    const after = await lstat(file);
    requireThat(
      info.size === after.size &&
        info.mtimeMs === after.mtimeMs &&
        data.length === info.size,
      "SOURCE_CHANGED",
      "읽는 동안 세이브가 변경됐습니다. 게임을 종료하고 다시 선택해 주세요.",
    );
    await writeFile(join(destination, name), data, { flag: "wx" });
  }
  return destination;
}

export async function assertSeparateOutput(output, source) {
  return assertSeparateOutputCanonical(output, await realpath(source));
}

export async function assertSeparateOutputCanonical(output, canonicalSource) {
  const parent = await realpath(output);
  const rel = relative(canonicalSource, parent);
  requireThat(
    rel !== "" &&
      (rel === ".." ||
        rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
        isAbsolute(rel)),
    "OUTPUT_IN_SOURCE",
    "원본 폴더 밖의 결과 저장 위치를 선택해 주세요.",
  );
}
