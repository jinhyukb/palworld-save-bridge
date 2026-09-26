import * as fs from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { WORLD_ID } from "./input.mjs";
import {
  exists,
  rejectLinks,
  treeManifest,
  verifyTree,
  writeJson,
  within,
} from "./files.mjs";
import { requireThat, UserError } from "./errors.mjs";

const RECORD_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function requireClosed(env) {
  requireThat(
    typeof env.isGameRunning === "function" && !(await env.isGameRunning()),
    "GAME_RUNNING",
    "Palworld를 완전히 종료한 뒤 다시 시도해 주세요.",
  );
}

async function paths(accountId, worldId, env) {
  requireThat(
    /^\d{17}$/.test(accountId) && WORLD_ID.test(worldId),
    "BAD_TARGET",
    "Steam 계정 또는 월드 식별자가 올바르지 않습니다.",
  );
  const account = join(resolve(env.gameRoot), accountId),
    target = join(account, worldId);
  requireThat(
    within(env.gameRoot, target),
    "BAD_TARGET",
    "허용되지 않은 세이브 위치입니다.",
  );
  await rejectLinks(target);
  await rejectLinks(env.stateRoot);
  requireThat(
    (await exists(account)) && (await fs.stat(account)).isDirectory(),
    "NO_ACCOUNT",
    "선택한 Steam 계정의 세이브 폴더가 없습니다. 게임을 한 번 실행한 뒤 다시 시도해 주세요.",
  );
  await fs.mkdir(join(env.stateRoot, "history"), { recursive: true });
  return { account, target };
}

async function lockWorld(account, worldId) {
  const path = join(account, ".psb-lock-" + worldId),
    nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fs.open(path, "wx");
      await fd.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await fd.close();
      return async () => {
        try {
          const value = JSON.parse(await fs.readFile(path, "utf8"));
          if (value.nonce === nonce) await fs.unlink(path);
        } catch {
          /* Do not remove a lock we cannot identify. */
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await rejectLinks(path);
      let prior;
      try {
        prior = JSON.parse(await fs.readFile(path, "utf8"));
      } catch {
        throw new UserError(
          "LOCKED",
          "다른 적용 작업이 진행 중이거나 잠금 파일을 읽을 수 없습니다.",
        );
      }
      let alive = true;
      try {
        process.kill(prior.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
      requireThat(
        !alive,
        "LOCKED",
        "이 월드에 다른 적용 또는 복구 작업이 진행 중입니다.",
      );
      await fs.unlink(path);
    }
  }
  throw new UserError("LOCKED", "세이브 잠금을 획득하지 못했습니다.");
}

async function removeManaged(path, account) {
  requireThat(
    within(account, path) && basename(path).startsWith(".psb-"),
    "BAD_CLEANUP",
    "정리 경로 검증에 실패했습니다.",
  );
  await rejectLinks(path);
  if (await exists(path)) {
    await treeManifest(path);
    await fs.rm(path, { recursive: true, force: false });
  }
}

export async function listHistory(env) {
  const root = join(env.stateRoot, "history");
  if (!(await exists(root))) return [];
  await rejectLinks(root);
  const result = [];
  for (const name of await fs.readdir(root)) {
    if (!name.endsWith(".json") || !RECORD_ID.test(name.slice(0, -5))) continue;
    const file = join(root, name);
    await rejectLinks(file);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        value.schema === 1 &&
        value.id === name.slice(0, -5) &&
        value.gameRoot === resolve(env.gameRoot)
      )
        result.push(value);
    } catch {
      /* Incomplete temporary files are never history entries. */
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function replaceWorld(
  {
    incoming,
    manifest,
    accountId,
    worldId,
    kind,
    sourceRecordId,
    recoveryChain = [],
    label,
  },
  env,
) {
  const io = env.io || fs;
  await requireClosed(env);
  const { account, target } = await paths(accountId, worldId, env);
  const unlock = await lockWorld(account, worldId);
  const id = randomUUID(),
    historyFile = join(env.stateRoot, "history", id + ".json");
  const backupRoot = join(env.stateRoot, "backups", id),
    backupPath = join(backupRoot, "before");
  const stage = join(account, ".psb-stage-" + id),
    parked = join(account, ".psb-previous-" + id),
    failed = join(account, ".psb-failed-" + id);
  let record;
  try {
    const pending = (await listHistory(env)).filter(
      (r) =>
        r.accountId === accountId &&
        r.worldId === worldId &&
        r.status === "pending" &&
        !recoveryChain.includes(r.id),
    );
    requireThat(
      !pending.length,
      "PENDING_RECOVERY",
      "중단된 작업이 있습니다. 백업 기록에서 이전 상태를 먼저 복구해 주세요.",
    );
    if (incoming) {
      await rejectLinks(incoming);
      await verifyTree(incoming, manifest);
    }
    const hadTarget = await exists(target);
    if (kind === "apply" && hadTarget)
      requireThat(
        env.replaceConfirmed,
        "CONFIRM_REPLACE",
        "같은 월드가 이미 있습니다. 기존 월드 교체를 확인해 주세요.",
      );
    const beforeManifest = hadTarget ? await treeManifest(target) : null;
    await fs.mkdir(backupRoot, { recursive: true });
    env.progress?.("기존 월드를 백업하고 검사하고 있습니다.", 25);
    if (hadTarget) {
      await fs.cp(target, backupPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await verifyTree(backupPath, beforeManifest);
    }
    if (incoming) {
      await fs.cp(incoming, stage, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await verifyTree(stage, manifest);
    }
    await requireClosed(env);
    if (hadTarget) await verifyTree(target, beforeManifest);
    else
      requireThat(
        !(await exists(target)),
        "TARGET_CHANGED",
        "작업 중 같은 월드가 생성되었습니다. 다시 시도해 주세요.",
      );
    record = {
      schema: 1,
      id,
      kind,
      sourceRecordId: sourceRecordId || null,
      createdAt: new Date().toISOString(),
      status: "pending",
      gameRoot: resolve(env.gameRoot),
      accountId,
      worldId,
      label,
      hadTarget,
      beforeManifest,
      afterManifest: manifest,
      backupPath: hadTarget ? backupPath : null,
    };
    await writeJson(historyFile, record); // Durable recovery information precedes every target mutation.
    env.progress?.("검증된 세이브를 적용하고 있습니다.", 75);
    let parkedOriginal = false,
      installedIncoming = false;
    try {
      if (hadTarget) {
        await io.rename(target, parked);
        parkedOriginal = true;
      }
      if (incoming) {
        await io.rename(stage, target);
        installedIncoming = true;
        await verifyTree(target, manifest);
      } else
        requireThat(
          !(await exists(target)),
          "RESTORE_FAILED",
          "추가된 월드를 제거하지 못했습니다.",
        );
      record.status = "complete";
      await writeJson(historyFile, record);
    } catch (error) {
      try {
        if (installedIncoming && (await exists(target)))
          await io.rename(target, failed);
        if (parkedOriginal) await io.rename(parked, target);
        if (hadTarget) await verifyTree(target, beforeManifest);
        else
          requireThat(
            !(await exists(target)),
            "ROLLBACK_FAILED",
            "원래 상태 복원에 실패했습니다.",
          );
        record.status = "failed";
        record.error = String(error.message);
        await writeJson(historyFile, record);
      } catch (rollbackError) {
        record.status = "pending";
        record.error = String(rollbackError.message);
        await writeJson(historyFile, record);
        throw new UserError(
          "RECOVERY_NEEDED",
          "적용이 중단되어 복구가 필요합니다. 백업 기록에서 이전 상태로 복구해 주세요. 원본 백업은 보관되어 있습니다.",
        );
      }
      throw new UserError(
        "APPLY_FAILED",
        "적용하지 못해 기존 월드로 되돌렸습니다. 파일 사용 여부와 저장 공간을 확인해 주세요.",
      );
    }
    if (hadTarget) {
      try {
        await removeManaged(parked, account);
      } catch {
        record.cleanupPending = parked;
        await writeJson(historyFile, record);
      }
    }
    env.progress?.("완료", 100);
    return { ...record, target, savedProgressPath: record.backupPath };
  } finally {
    await unlock();
  }
}

export async function applyResult({ result, accountId, replace }, env) {
  requireThat(
    result?.report?.manifest && result.worldPath,
    "NO_RESULT",
    "먼저 변환을 완료해 주세요.",
  );
  return replaceWorld(
    {
      incoming: result.worldPath,
      manifest: result.report.manifest,
      accountId,
      worldId: result.worldId,
      kind: "apply",
      label: result.report.worldName,
    },
    { ...env, replaceConfirmed: replace === true },
  );
}

export async function restoreBackup(id, env) {
  requireThat(
    RECORD_ID.test(id),
    "BAD_HISTORY",
    "올바른 백업 기록을 선택해 주세요.",
  );
  const history = await listHistory(env);
  const record = history.find((r) => r.id === id);
  requireThat(
    record &&
      (record.status === "pending" ||
        (record.kind === "apply" && record.status === "complete")),
    "BAD_HISTORY",
    "복구 가능한 적용 기록이 아닙니다.",
  );
  const recoveryChain = [];
  for (
    let current = record;
    current && !recoveryChain.includes(current.id);
    current = history.find((r) => r.id === current.sourceRecordId)
  )
    recoveryChain.push(current.id);
  const expected = join(env.stateRoot, "backups", id, "before");
  if (record.hadTarget) {
    requireThat(
      resolve(record.backupPath) === resolve(expected),
      "BAD_BACKUP",
      "백업 경로 검증에 실패했습니다.",
    );
    await verifyTree(expected, record.beforeManifest);
  }
  const restored = await replaceWorld(
    {
      incoming: record.hadTarget ? expected : null,
      manifest: record.beforeManifest,
      accountId: record.accountId,
      worldId: record.worldId,
      kind: "restore",
      sourceRecordId: id,
      recoveryChain,
      label: record.label,
    },
    env,
  );
  record.status = "restored";
  record.restoredBy = restored.id;
  await writeJson(join(env.stateRoot, "history", id + ".json"), record);
  return restored;
}
