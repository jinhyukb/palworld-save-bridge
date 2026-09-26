import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, relative, isAbsolute, parse, sep } from "node:path";
import { requireThat } from "./errors.mjs";

export const hashBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function exists(path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

export function within(root, child) {
  const r = relative(resolve(root), resolve(child));
  return r !== "" && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
}

export async function rejectLinks(path) {
  const full = resolve(path),
    root = parse(full).root;
  let current = root;
  for (const segment of full.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!(await exists(current))) break;
    requireThat(
      !(await fs.lstat(current)).isSymbolicLink(),
      "LINK",
      "링크나 연결된 폴더에는 세이브를 적용할 수 없습니다. 실제 폴더를 선택해 주세요.",
    );
  }
}

export async function treeManifest(root) {
  const result = {};
  let files = 0;
  await rejectLinks(root);
  async function walk(dir, prefix) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      requireThat(
        !e.isSymbolicLink(),
        "LINK",
        "세이브 또는 백업 폴더에 링크가 있어 작업을 중단했습니다.",
      );
      const key = prefix + e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), key + "/");
      else {
        requireThat(
          e.isFile() && ++files <= 50000,
          "FILE_LIMIT",
          "파일 수 또는 파일 종류가 지원 범위를 넘습니다.",
        );
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(join(dir, e.name)))
          hash.update(bytes);
        result[key] = hash.digest("hex");
      }
    }
  }
  await walk(root, "");
  return result;
}

export function sameManifest(a, b) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

export async function verifyTree(root, expected) {
  requireThat(
    sameManifest(await treeManifest(root), expected),
    "HASH_MISMATCH",
    "파일 검증에 실패했습니다. 파일이 변경되었거나 완전히 복사되지 않았습니다.",
  );
}

export async function writeJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await fs.open(temporary, "wx");
  try {
    await file.writeFile(JSON.stringify(value, null, 2), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temporary, path);
}
