const $ = (id) => document.getElementById(id);
const bridge = window.bridge;
let appState,
  summary = null,
  selected = null,
  converted = null,
  screen = "import",
  previousScreen = "import",
  running = false;
let progressValue = 0;
const formatNumber = (value) => Number(value).toLocaleString("ko-KR");

async function call(promise) {
  const response = await promise;
  if (!response.ok)
    throw Object.assign(new Error(response.error.message), {
      code: response.error.code,
    });
  return response.value;
}
function showError(error) {
  $("error-title").textContent =
    error.code === "CANCELLED" ? "작업을 취소했습니다" : "확인이 필요합니다";
  $("error-text").textContent =
    error.message +
    (error.code && error.code !== "CANCELLED" ? ` (${error.code})` : "");
  $("error").hidden = false;
  $("error").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function showScreen(name) {
  screen = name;
  for (const node of document.querySelectorAll(".screen"))
    node.hidden = node.id !== name + "-screen";
  $("stepper").hidden = ["history", "help"].includes(name);
  const stage = name === "configure" ? 2 : name === "result" ? 3 : 1;
  for (const node of document.querySelectorAll("[data-step]")) {
    node.classList.toggle("active", Number(node.dataset.step) === stage);
    node.classList.toggle("done", Number(node.dataset.step) < stage);
  }
  window.scrollTo({ top: 0 });
}
async function task(title, operation, cancellable = true) {
  if (running) return;
  running = true;
  progressValue = 0;
  $("error").hidden = true;
  $("progress-title").textContent = title;
  $("progress-message").textContent = "잠시만 기다려 주세요.";
  $("progress-bar").value = 0;
  $("progress-percent").textContent = "0%";
  $("cancel-job").hidden = !cancellable;
  $("cancel-job").disabled = false;
  $("progress-dialog").showModal();
  try {
    return await operation();
  } catch (error) {
    showError(error);
  } finally {
    running = false;
    $("progress-dialog").close();
  }
}
bridge.onProgress(({ message, percent }) => {
  progressValue = Math.max(progressValue, Math.min(100, Number(percent) || 0));
  $("progress-message").textContent = message;
  $("progress-bar").value = progressValue;
  $("progress-percent").textContent = `${progressValue}%`;
});
$("progress-dialog").addEventListener("cancel", (event) =>
  event.preventDefault(),
);
$("cancel-job").addEventListener("click", async () => {
  $("cancel-job").disabled = true;
  await bridge.cancel();
});
$("dismiss-error").onclick = () => {
  $("error").hidden = true;
};

async function receive(importer) {
  const imported = await task("월드 파일을 확인하고 있어요.", () =>
    call(importer()),
  );
  if (!imported) return;
  summary = null;
  selected = null;
  converted = null;
  showScreen("import");
  $("world-picker").hidden = imported.candidates.length === 1;
  $("world-candidates").replaceChildren();
  if (imported.candidates.length === 1)
    await chooseWorld(imported.candidates[0].id);
  else
    for (const world of imported.candidates) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = world.label;
      button.onclick = () => chooseWorld(world.id);
      $("world-candidates").append(button);
    }
}
async function pick(kind) {
  try {
    const path = await call(bridge.pickInput(kind));
    if (path) await receive(() => bridge.importPath(path));
  } catch (e) {
    showError(e);
  }
}
$("pick-folder").onclick = () => pick("folder");
$("pick-zip").onclick = () => pick("zip");
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());
const zone = $("drop-zone");
zone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!running) zone.classList.add("dragging");
});
zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
zone.addEventListener("drop", (event) => {
  event.preventDefault();
  zone.classList.remove("dragging");
  if (!running && event.dataTransfer.files.length)
    receive(() => bridge.dropFile(event.dataTransfer.files[0]));
});

async function chooseWorld(id) {
  const data = await task("캐릭터와 월드를 읽고 있어요.", () =>
    call(bridge.selectWorld(id)),
  );
  if (!data) return;
  summary = data;
  selected = null;
  $("source-world").textContent = data.worldName;
  $("world-stats").textContent =
    `${data.players.length}명의 캐릭터 · 거점 ${data.baseCount}개`;
  $("world-name").value = "";
  $("world-name").placeholder = data.worldName;
  $("character-name").value = "";
  $("character-name").placeholder = "캐릭터 선택 후 입력";
  $("character-name").disabled = true;
  $("player-list").replaceChildren();
  for (const player of data.players) {
    const label = document.createElement("label");
    label.className = "player-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "player";
    radio.value = player.uid;
    radio.disabled = !player.available;
    radio.setAttribute(
      "aria-label",
      `${player.name}, 레벨 ${player.level}${player.isHost ? ", 기존 방장" : ""}`,
    );
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = [...player.name][0] || "P";
    const text = document.createElement("div"),
      name = document.createElement("strong"),
      stats = document.createElement("p");
    name.textContent = player.name;
    stats.textContent = player.available
      ? `레벨 ${player.level} · 소유 팰 ${formatNumber(player.palCount)}마리`
      : "캐릭터 세이브 파일이 없습니다";
    text.append(name, stats);
    label.append(radio, avatar, text);
    if (player.isHost) {
      const tag = document.createElement("span");
      tag.className = "host-tag";
      tag.textContent = "기존 방장";
      label.append(tag);
    }
    radio.onchange = () => {
      selected = player;
      $("character-name").disabled = false;
      $("character-name").placeholder = player.name;
      $("character-name").value = "";
      preview();
    };
    $("player-list").append(label);
  }
  const map = $("map-choice");
  map.replaceChildren(
    new Option(
      data.hasLocalData
        ? "받은 폴더의 지도 기록 유지"
        : "받은 지도 기록 없음 — 새로 시작",
      "supplied",
    ),
    new Option("새 지도 기록으로 시작", "none"),
  );
  for (const account of data.accounts.filter((a) => a.localData))
    map.add(
      new Option(
        `내 PC의 지도 기록 · ${account.id}${account.active ? " (현재 계정)" : ""}`,
        account.id,
      ),
    );
  $("output-path").textContent = appState.outputParent;
  preview();
  updateMapHelp();
  showScreen("configure");
}
function preview() {
  if (!summary) return;
  $("before-world").textContent = summary.worldName;
  $("after-world").textContent =
    $("world-name").value.trim() || summary.worldName;
  $("before-character").textContent = selected
    ? selected.name
    : "캐릭터를 선택해 주세요";
  $("after-character").textContent = selected
    ? $("character-name").value.trim() || selected.name
    : "—";
  $("preserved-summary").textContent = selected
    ? `레벨 ${selected.level} · 소유 팰 ${formatNumber(selected.palCount)}마리\n진행 상황과 월드의 거점 ${summary.baseCount}개를 유지합니다.`
    : "선택한 캐릭터의 진행 상황을 유지합니다.";
  $("convert").disabled = !selected;
}
function updateMapHelp() {
  const choice = $("map-choice").value;
  $("map-help").textContent =
    choice === "supplied"
      ? "받은 지도 기록은 기존 방장의 기록일 수 있습니다. 본인 기록이 있다면 선택할 수 있어요."
      : choice === "none"
        ? "캐릭터 진행 상황은 유지하고, 이 PC의 지도 표시 등 로컬 기록은 새로 시작합니다."
        : "선택한 지도 파일이 본인이 플레이한 같은 월드의 기록인지 확인해 주세요.";
}
$("world-name").oninput = preview;
$("character-name").oninput = preview;
$("map-choice").onchange = updateMapHelp;
$("pick-output").onclick = async () => {
  try {
    appState.outputParent = await call(bridge.pickOutput());
    $("output-path").textContent = appState.outputParent;
  } catch (e) {
    showError(e);
  }
};
$("pick-local").onclick = async () => {
  const file = await task("지도 기록을 확인하고 있어요.", () =>
    call(bridge.pickLocal()),
  );
  if (file) {
    if (!$("map-choice").querySelector("option[value=file]"))
      $("map-choice").add(new Option("직접 선택한 내 LocalData.sav", "file"));
    $("map-choice").value = "file";
    updateMapHelp();
  }
};
$("convert").onclick = async () => {
  if (!selected) return;
  const choice = $("map-choice").value;
  const value = await task("내 캐릭터로 이어 할 월드를 만들고 있어요.", () =>
    call(
      bridge.convert({
        selectedUid: selected.uid,
        worldName: $("world-name").value,
        characterName: $("character-name").value,
        localDataMode: ["supplied", "none"].includes(choice) ? choice : "own",
        mapAccountId: choice,
      }),
    ),
  );
  if (!value) return;
  converted = value;
  $("result-world").textContent = value.report.worldName;
  $("result-character").textContent = value.report.characterName;
  $("result-stats").textContent =
    `레벨 ${value.report.selectedLevel} · 소유 팰 ${formatNumber(value.report.selectedPalCount)}마리`;
  $("result-path").textContent = value.root;
  $("apply-status").hidden = true;
  $("replace-confirm").checked = false;
  const accounts = $("account-choice");
  accounts.replaceChildren(new Option("적용할 Steam 계정을 선택하세요", ""));
  for (const account of value.accounts)
    accounts.add(
      new Option(
        `${account.id}${account.active ? " · 현재 Steam 계정" : ""}`,
        account.id,
      ),
    );
  if (!value.accounts.length)
    accounts.replaceChildren(new Option("세이브 계정을 찾지 못했습니다", ""));
  accountChanged();
  showScreen("result");
};
function accountChanged() {
  const account = converted?.accounts.find(
    (a) => a.id === $("account-choice").value,
  );
  $("replace-confirm").checked = false;
  $("replace-label").hidden = !account?.hasWorld;
  $("account-note").textContent = !account
    ? "Steam에서 게임을 한 번 실행한 계정을 선택해 주세요."
    : account.hasWorld
      ? `기존 월드 ‘${account.existingWorldName || "이름을 읽을 수 없음"}’을 백업 후 교체합니다. 대상: ${account.targetPath}`
      : `이 계정에 새 월드로 추가됩니다. 대상: ${account.targetPath}`;
  $("apply").disabled = !account || account.hasWorld;
}
$("account-choice").onchange = accountChanged;
$("replace-confirm").onchange = () => {
  const account = converted?.accounts.find(
    (a) => a.id === $("account-choice").value,
  );
  $("apply").disabled =
    !account || (account.hasWorld && !$("replace-confirm").checked);
};
$("apply").onclick = async () => {
  const value = await task(
    "기존 월드를 백업하고 적용하고 있어요.",
    () =>
      call(
        bridge.apply({
          accountId: $("account-choice").value,
          replace: $("replace-confirm").checked,
        }),
      ),
    false,
  );
  if (value) {
    $("apply-status").textContent =
      `적용했습니다. 게임 시작에서 ‘${converted.report.worldName}’ 월드를 선택하세요.`;
    $("apply-status").hidden = false;
    $("apply").disabled = true;
    $("account-choice").disabled = true;
    $("replace-confirm").disabled = true;
  }
};
$("open-result").onclick = () => call(bridge.open("result")).catch(showError);

async function showHistory() {
  try {
    const history = await call(bridge.history());
    const list = $("history-list");
    list.replaceChildren();
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "아직 적용한 월드가 없습니다. 게임에 적용하면 복구 기록이 여기에 표시됩니다.";
      list.append(empty);
    }
    for (const record of history) {
      const row = document.createElement("div");
      row.className = "panel history-item";
      const body = document.createElement("div"),
        title = document.createElement("h2"),
        subtitle = document.createElement("p");
      title.textContent = record.label || "월드";
      const status =
        record.status === "pending"
          ? "중단된 작업 · 복구 필요"
          : record.status === "restored"
            ? "이전 상태로 복구됨"
            : record.status === "failed"
              ? "적용 실패 · 기존 상태 유지"
              : record.kind === "restore"
                ? "복구 전 진행 상황 보관"
                : "게임 적용 완료";
      subtitle.textContent = `${new Date(record.createdAt).toLocaleString("ko-KR")} · ${record.accountId} · ${status}`;
      body.append(title, subtitle);
      const buttons = document.createElement("div");
      buttons.className = "history-actions";
      if (record.backupPath) {
        const open = document.createElement("button");
        open.className = "text-button";
        open.textContent = "백업 열기";
        open.onclick = () =>
          call(bridge.open("history", record.id)).catch(showError);
        buttons.append(open);
      }
      if (
        record.status === "pending" ||
        (record.kind === "apply" && record.status === "complete")
      ) {
        const restore = document.createElement("button");
        restore.className = "secondary restore-button";
        restore.textContent =
          record.status === "pending" ? "중단된 작업 복구" : "이전 상태로 복구";
        restore.onclick = () => confirmRestore(record);
        buttons.append(restore);
      }
      row.append(body, buttons);
      list.append(row);
    }
    showScreen("history");
  } catch (e) {
    showError(e);
  }
}
let pendingRestore = null;
function confirmRestore(record) {
  pendingRestore = record;
  $("confirm-message").textContent =
    `‘${record.label}’ 월드를 적용하기 전 상태로 되돌립니다. 현재 플레이 기록은 별도 백업으로 보관합니다. Palworld를 종료한 상태에서 진행해 주세요.`;
  $("confirm-dialog").showModal();
}
$("confirm-cancel").onclick = () => {
  pendingRestore = null;
  $("confirm-dialog").close();
};
$("confirm-ok").onclick = async () => {
  const record = pendingRestore;
  pendingRestore = null;
  $("confirm-dialog").close();
  if (!record) return;
  const value = await task(
    "현재 기록을 보관하고 이전 상태를 복구하고 있어요.",
    () => call(bridge.restore(record.id)),
    false,
  );
  if (value) await showHistory();
};
function home() {
  if (running) return;
  summary = null;
  selected = null;
  converted = null;
  $("world-picker").hidden = true;
  $("account-choice").disabled = false;
  $("replace-confirm").disabled = false;
  $("error").hidden = true;
  showScreen("import");
}
$("home-link").onclick = home;
$("change-input").onclick = home;
$("new-conversion").onclick = home;
$("history-link").onclick = () => {
  if (!running) {
    if (!["history", "help"].includes(screen)) previousScreen = screen;
    showHistory();
  }
};
$("help-link").onclick = () => {
  if (!running) {
    if (!["history", "help"].includes(screen)) previousScreen = screen;
    showScreen("help");
  }
};
$("back-from-history").onclick = () => showScreen(previousScreen);
$("back-from-help").onclick = () => showScreen(previousScreen);
$("open-backups").onclick = () => call(bridge.open("backups")).catch(showError);
$("open-logs").onclick = () => call(bridge.open("logs")).catch(showError);
call(bridge.state())
  .then((value) => {
    appState = value;
    $("version").textContent = "v" + value.version;
    if (value.history.some((r) => r.status === "pending")) showHistory();
  })
  .catch(showError);
