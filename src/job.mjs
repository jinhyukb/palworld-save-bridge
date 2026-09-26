import { parentPort, workerData } from "node:worker_threads";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorlds, extractZip, snapshotWorld } from "./core/input.mjs";
import { inspectWorld } from "./core/world.mjs";
import { convertWorld } from "./core/convert.mjs";
import { loadSave } from "./core/codec.mjs";
import { requireThat } from "./core/errors.mjs";

const progress = (message, percent) =>
  parentPort.postMessage({ type: "progress", message, percent });
try {
  const { action, args } = workerData;
  let result;
  if (action === "import") {
    progress("받은 파일에서 월드를 찾고 있습니다.", 10);
    const info = await lstat(args.input);
    requireThat(
      !info.isSymbolicLink(),
      "LINK",
      "바로가기 대신 실제 폴더나 ZIP을 선택해 주세요.",
    );
    let root = args.input;
    if (info.isFile()) {
      requireThat(
        /\.zip$/i.test(args.input),
        "BAD_INPUT",
        "월드 폴더 전체 또는 ZIP 파일을 선택해 주세요.",
      );
      root = join(args.workspace, "extracted");
      await extractZip(args.input, root);
    }
    result = await discoverWorlds(root);
    requireThat(
      result.length > 0,
      "NO_WORLD",
      "Level.sav가 들어 있는 월드를 찾지 못했습니다. 방장에게 받은 폴더 전체를 선택해 주세요.",
    );
  } else if (action === "inspect") {
    await snapshotWorld(args.source, args.snapshot);
    result = await inspectWorld(args.snapshot, progress);
  } else if (action === "convert") result = await convertWorld(args, progress);
  else if (action === "local") {
    const data = await loadSave(args.path);
    requireThat(
      data.g.properties.SaveData?.struct_type === "PalLocalSaveData",
      "BAD_LOCAL_DATA",
      "LocalData.sav 지도 기록 파일을 선택해 주세요.",
    );
    result = true;
  } else throw new Error("Unknown worker action");
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: {
      code: error.code || "READ_FAILED",
      message:
        error.name === "UserError"
          ? error.message
          : "파일을 처리하지 못했습니다. 파일 상태, 접근 권한과 저장 공간을 확인해 주세요.",
      detail: error.stack,
    },
  });
}
