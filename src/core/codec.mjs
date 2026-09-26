import { readFile, stat } from "node:fs/promises";
import { inflateSync, deflateSync } from "node:zlib";
import { decompress as ooz } from "../../vendor/palworld-save-toolkit/ooz-wasm/index.js";
import {
  GvasFile,
  PALWORLD_TYPE_HINTS,
} from "../../vendor/palworld-save-toolkit/js/gvas.js";
import { LEVEL_CUSTOM_PROPERTIES } from "../../vendor/palworld-save-toolkit/js/paldata.js";
import { groups } from "../../vendor/palworld-save-toolkit/js/palgroups.js";
import { requireThat, UserError } from "./errors.mjs";

export const PROPS = {
  ...LEVEL_CUSTOM_PROPERTIES,
  ".worldSaveData.GroupSaveDataMap": groups,
};
const MAX_RAW = 256 * 1024 * 1024;
const MAX_PACKED = 128 * 1024 * 1024;

export function decodeContainer(bytes) {
  requireThat(
    bytes.length >= 12 && bytes.length <= MAX_PACKED,
    "CORRUPT_SAVE",
    "세이브 파일 크기가 올바르지 않습니다.",
  );
  let b = Buffer.from(bytes);
  if (b.subarray(8, 11).toString() === "CNK") {
    requireThat(b.length >= 24, "CORRUPT_SAVE", "세이브 헤더가 손상됐습니다.");
    b = b.subarray(12);
  }
  const size = b.readUInt32LE(0),
    packedSize = b.readUInt32LE(4),
    magic = b.subarray(8, 11).toString(),
    type = b[11];
  requireThat(
    size > 0 && size <= MAX_RAW,
    "SAVE_TOO_LARGE",
    "압축 해제 후 256 MiB 이하의 월드만 지원합니다.",
  );
  requireThat(
    ["PlM", "PlZ"].includes(magic) && [0x31, 0x32].includes(type),
    "UNSUPPORTED_FORMAT",
    "지원하지 않는 세이브 압축 형식입니다.",
  );
  let raw;
  try {
    if (magic === "PlM") {
      requireThat(
        type === 0x31 && b.length - 12 === packedSize,
        "CORRUPT_SAVE",
        "세이브 압축 정보가 일치하지 않습니다.",
      );
      raw = Buffer.from(ooz(b.subarray(12), size));
    } else {
      if (type === 0x31)
        requireThat(
          b.length - 12 === packedSize,
          "CORRUPT_SAVE",
          "세이브 압축 정보가 일치하지 않습니다.",
        );
      raw = inflateSync(b.subarray(12), { maxOutputLength: MAX_RAW });
      if (type === 0x32) {
        requireThat(
          raw.length === packedSize,
          "CORRUPT_SAVE",
          "세이브 압축 정보가 일치하지 않습니다.",
        );
        raw = inflateSync(raw, { maxOutputLength: MAX_RAW });
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "CORRUPT_SAVE",
      "압축을 해제할 수 없습니다. 파일이 온전한지 확인해 주세요.",
    );
  }
  requireThat(
    raw.length === size,
    "CORRUPT_SAVE",
    "세이브의 압축 해제 크기가 일치하지 않습니다.",
  );
  return { raw, format: magic, type };
}

export function encodeContainer(raw) {
  const data = Buffer.from(raw),
    packed = deflateSync(data);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(data.length);
  header.writeUInt32LE(packed.length, 4);
  header.write("PlZ", 8);
  header[11] = 0x31;
  return Buffer.concat([header, packed]);
}

export function parseRaw(raw) {
  try {
    const g = GvasFile.read(new Uint8Array(raw), PALWORLD_TYPE_HINTS, PROPS);
    requireThat(
      !g.warnings.some((w) => w.includes("failed to decode")),
      "UNSUPPORTED_LAYOUT",
      "캐릭터 또는 길드 데이터 형식을 완전히 읽지 못했습니다. 이 세이브는 아직 지원하지 않습니다.",
    );
    requireThat(
      g.trailer.length === 4 && g.trailer.every((v) => v === 0),
      "UNSUPPORTED_LAYOUT",
      "세이브 끝부분에 지원하지 않는 데이터가 있습니다.",
    );
    return g;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "UNSUPPORTED_LAYOUT",
      "세이브를 읽을 수 없습니다. 손상된 파일이거나 아직 지원하지 않는 게임 버전입니다.",
    );
  }
}

export async function loadSave(path, verify = true) {
  requireThat(
    (await stat(path)).size <= MAX_PACKED,
    "SAVE_TOO_LARGE",
    "세이브 파일 크기가 지원 범위를 넘습니다.",
  );
  const encoded = await readFile(path);
  const { raw, format, type } = decodeContainer(encoded);
  if (verify) {
    const round = parseRaw(raw);
    requireThat(
      Buffer.from(round.write(PROPS)).equals(raw),
      "LOSSY_ROUNDTRIP",
      "원본을 손실 없이 다시 저장할 수 없어 변환을 중단했습니다.",
    );
  }
  return { g: parseRaw(raw), raw, format, type, encoded };
}
