const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  session: electronSession,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { Worker } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "psb",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const portableRoot =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  (app.isPackaged
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, "../.."));
const stateRoot =
  process.env.PSB_TEST_STATE_ROOT ||
  path.join(portableRoot, "Palworld Save Bridge Data");
app.setPath("userData", path.join(stateRoot, "desktop"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window,
    activeWorker = null,
    critical = false,
    busy = false,
    session = null,
    result = null;
  let outputParent = path.join(stateRoot, "results");
  const gameRoot =
    process.env.PSB_TEST_GAME_ROOT ||
    path.join(
      process.env.LOCALAPPDATA || app.getPath("home"),
      "Pal",
      "Saved",
      "SaveGames",
    );
  const UI_URL = "psb://app/index.html";
  const uiRoot = path.join(__dirname, "ui");
  let platform, install, files, input;
  const notify = (message, percent) => {
    if (window && !window.isDestroyed())
      window.webContents.send("psb:progress", { message, percent });
  };
  const env = () => ({
    gameRoot,
    stateRoot,
    isGameRunning: platform.gameRunning,
    progress: notify,
  });

  async function log(error) {
    try {
      await fs.mkdir(path.join(stateRoot, "logs"), { recursive: true });
      await fs.appendFile(
        path.join(stateRoot, "logs", "app.log"),
        new Date().toISOString() +
          " " +
          (error.stack || error.detail || error.message) +
          "\n",
      );
    } catch {
      /* A disk error must still reach the UI. */
    }
  }

  function runWorker(action, args) {
    return new Promise((resolve, reject) => {
      const workerPath = path
        .join(__dirname, "job.mjs")
        .replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
      const worker = new Worker(pathToFileURL(workerPath), {
        workerData: { action, args },
        resourceLimits: { maxOldGenerationSizeMb: 1536 },
      });
      activeWorker = worker;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (activeWorker === worker) activeWorker = null;
        worker.terminate();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () =>
          finish(
            Object.assign(
              new Error(
                "처리 시간이 너무 오래 걸려 중단했습니다. 현재 월드 폴더만 다시 선택해 주세요.",
              ),
              { code: "TIMEOUT" },
            ),
          ),
        10 * 60 * 1000,
      );
      worker.on("message", (data) => {
        if (data.type === "progress") notify(data.message, data.percent);
        if (data.type === "result") finish(null, data.result);
        if (data.type === "error")
          finish(Object.assign(new Error(data.error.message), data.error));
      });
      worker.on("error", (error) =>
        finish(
          Object.assign(
            new Error(
              "파일 처리가 중단되었습니다. 지원 용량을 넘었거나 파일을 읽을 수 없습니다.",
            ),
            { code: "WORKER_FAILED", detail: error.stack },
          ),
        ),
      );
      worker.on("exit", () => {
        if (!settled)
          finish(
            Object.assign(
              new Error("작업을 취소했습니다. 원본은 변경되지 않았습니다."),
              { code: "CANCELLED" },
            ),
          );
      });
    });
  }

  async function ensureSession() {
    if (!session?.snapshot || !session.summary)
      throw Object.assign(new Error("먼저 월드를 불러와 주세요."), {
        code: "NO_SESSION",
      });
  }

  async function state() {
    return {
      version: app.getVersion(),
      outputParent,
      stateRoot,
      accounts: await platform.accounts(
        gameRoot,
        result?.worldId || session?.worldId,
      ),
      history: await install.listHistory(env()),
    };
  }

  const actions = {
    state,
    async pickInput({ kind }) {
      const response = await dialog.showOpenDialog(
        window,
        kind === "folder"
          ? {
              title: "방장에게 받은 월드 폴더 선택",
              properties: ["openDirectory"],
            }
          : {
              title: "받은 ZIP 선택",
              properties: ["openFile"],
              filters: [{ name: "ZIP 압축 파일", extensions: ["zip"] }],
            },
      );
      return response.canceled ? null : response.filePaths[0];
    },
    async import({ path: selected }) {
      if (typeof selected !== "string" || !selected || selected.length > 32700)
        throw new Error("Invalid input path");
      const workspace = path.join(stateRoot, "imports", randomUUID());
      await fs.mkdir(workspace, { recursive: true });
      const candidates = await runWorker("import", {
        input: selected,
        workspace,
      });
      session = {
        workspace,
        input: selected,
        candidates: candidates.map((c) => ({ ...c, id: randomUUID() })),
      };
      result = null;
      return {
        candidates: session.candidates.map(({ id, label }) => ({ id, label })),
      };
    },
    async selectWorld({ candidateId }) {
      const candidate = session?.candidates.find((c) => c.id === candidateId);
      if (!candidate) throw new Error("Invalid world selection");
      const snapshot = path.join(session.workspace, "snapshot-" + randomUUID());
      const original = await fs.realpath(candidate.path);
      const summary = await runWorker("inspect", {
        source: candidate.path,
        snapshot,
      });
      Object.assign(session, {
        snapshot,
        summary,
        worldId: candidate.worldId,
        original,
        localPath: null,
      });
      return {
        ...summary,
        worldId: candidate.worldId,
        accounts: await platform.accounts(gameRoot, candidate.worldId),
      };
    },
    async pickOutput() {
      const response = await dialog.showOpenDialog(window, {
        title: "변환 결과를 저장할 위치",
        defaultPath: outputParent,
        properties: ["openDirectory", "createDirectory"],
      });
      if (!response.canceled) {
        outputParent = response.filePaths[0];
        await files.writeJson(path.join(stateRoot, "preferences.json"), {
          outputParent,
        });
      }
      return outputParent;
    },
    async pickLocal() {
      await ensureSession();
      const response = await dialog.showOpenDialog(window, {
        title: "본인의 LocalData.sav 선택",
        properties: ["openFile"],
        filters: [{ name: "Palworld 로컬 기록", extensions: ["sav"] }],
      });
      if (response.canceled) return null;
      await runWorker("local", { path: response.filePaths[0] });
      const snapshot = path.join(
        session.workspace,
        "local-" + randomUUID() + ".sav",
      );
      await fs.copyFile(response.filePaths[0], snapshot);
      session.localPath = snapshot;
      return path.basename(response.filePaths[0]);
    },
    async convert(options) {
      await ensureSession();
      await input.assertSeparateOutputCanonical(outputParent, session.original);
      let localDataPath = null;
      if (options.localDataMode === "own") {
        if (options.mapAccountId === "file") localDataPath = session.localPath;
        else {
          const account = (
            await platform.accounts(gameRoot, session.worldId)
          ).find((a) => a.id === options.mapAccountId && a.localData);
          if (!account)
            throw Object.assign(new Error("본인 지도 기록을 선택해 주세요."), {
              code: "BAD_LOCAL_DATA",
            });
          localDataPath = path.join(
            gameRoot,
            account.id,
            session.worldId,
            "LocalData.sav",
          );
        }
      }
      result = await runWorker("convert", {
        source: session.snapshot,
        outputParent,
        worldId: session.worldId,
        selectedUid: options.selectedUid,
        characterName: options.characterName,
        worldName: options.worldName,
        localDataMode: options.localDataMode,
        localDataPath,
      });
      return {
        ...result,
        accounts: await platform.accounts(gameRoot, result.worldId),
      };
    },
    async apply({ accountId, replace }) {
      if (!result)
        throw Object.assign(new Error("먼저 변환을 완료해 주세요."), {
          code: "NO_RESULT",
        });
      critical = true;
      try {
        return await install.applyResult({ result, accountId, replace }, env());
      } finally {
        critical = false;
      }
    },
    history: () => install.listHistory(env()),
    async restore({ id }) {
      critical = true;
      try {
        return await install.restoreBackup(id, env());
      } finally {
        critical = false;
      }
    },
    async open({ kind, id }) {
      let target;
      if (kind === "result" && result) target = result.root;
      if (kind === "output") target = outputParent;
      if (kind === "backups") target = path.join(stateRoot, "backups");
      if (kind === "logs") target = path.join(stateRoot, "logs");
      if (kind === "history") {
        const record = (await install.listHistory(env())).find(
          (r) => r.id === id,
        );
        if (record?.backupPath) target = record.backupPath;
      }
      if (!target || !(await files.exists(target)))
        throw Object.assign(new Error("아직 생성되지 않은 폴더입니다."), {
          code: "NO_FOLDER",
        });
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    },
    async cancel() {
      if (activeWorker && !critical) await activeWorker.terminate();
      return true;
    },
  };

  app
    .whenReady()
    .then(async () => {
      [platform, install, files, input] = await Promise.all([
        import("./core/platform.mjs"),
        import("./core/install.mjs"),
        import("./core/files.mjs"),
        import("./core/input.mjs"),
      ]);
      await fs.mkdir(stateRoot, { recursive: true });
      try {
        const pref = JSON.parse(
          await fs.readFile(path.join(stateRoot, "preferences.json"), "utf8"),
        );
        if (
          typeof pref.outputParent === "string" &&
          (await files.exists(pref.outputParent))
        )
          outputParent = pref.outputParent;
      } catch {
        /* First launch has no preferences. */
      }
      await fs.mkdir(outputParent, { recursive: true });
      protocol.handle("psb", (request) => {
        const url = new URL(request.url);
        const allowed = new Set(["/index.html", "/styles.css", "/renderer.js"]);
        if (url.hostname !== "app" || !allowed.has(url.pathname))
          return new Response("Not found", { status: 404 });
        return net.fetch(
          pathToFileURL(path.join(uiRoot, url.pathname.slice(1))).toString(),
        );
      });
      electronSession.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      electronSession.defaultSession.setPermissionCheckHandler(() => false);
      electronSession.defaultSession.webRequest.onBeforeRequest(
        (details, callback) =>
          callback({ cancel: /^(?:https?|wss?):/i.test(details.url) }),
      );
      window = new BrowserWindow({
        width: 1160,
        height: 850,
        minWidth: 900,
        minHeight: 700,
        backgroundColor: "#f6f6f0",
        icon: path.join(__dirname, "../assets/icon.ico"),
        show: false,
        title: "Palworld Save Bridge",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("close", (event) => {
        if (critical) {
          event.preventDefault();
          notify("적용 또는 복구가 끝난 뒤 창을 닫을 수 있습니다.", 85);
        } else activeWorker?.terminate();
      });
      window.once("ready-to-show", () => window.show());
      ipcMain.handle("psb:action", async (event, action, args = {}) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame?.url !== UI_URL ||
          !Object.hasOwn(actions, action)
        )
          return {
            ok: false,
            error: { code: "DENIED", message: "허용되지 않은 요청입니다." },
          };
        const exclusive = !["state", "history", "open", "cancel"].includes(
          action,
        );
        if (exclusive && busy)
          return {
            ok: false,
            error: {
              code: "BUSY",
              message: "진행 중인 작업이 끝난 뒤 다시 시도해 주세요.",
            },
          };
        if (exclusive) busy = true;
        try {
          return { ok: true, value: await actions[action](args || {}) };
        } catch (error) {
          await log(error);
          return {
            ok: false,
            error: {
              code: error.code || "FAILED",
              message: error.code
                ? error.message
                : "작업을 완료하지 못했습니다. 파일 상태와 저장 공간을 확인해 주세요.",
            },
          };
        } finally {
          if (exclusive) busy = false;
        }
      });
      await window.loadURL(UI_URL);
    })
    .catch(async (error) => {
      await log(error);
      dialog.showErrorBox(
        "Palworld Save Bridge",
        "프로그램을 시작하지 못했습니다. 쓰기 가능한 폴더에서 다시 실행해 주세요.\n" +
          error.message,
      );
      app.quit();
    });
  app.on("second-instance", () => {
    window?.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
}
