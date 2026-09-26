import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import assert from "node:assert/strict";
import yazl from "yazl";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const qaRoot =
  process.env.PSB_QA_ROOT || (await mkdtemp(join(tmpdir(), "psb-ui-")));
await mkdir(qaRoot, { recursive: true });
const testRoot = await mkdtemp(join(qaRoot, "run-"));
const fixture = process.env.PSB_FIXTURE_WORLD;
const gameRoot = join(testRoot, "SaveGames"),
  account = "76561198000000001";
await mkdir(join(gameRoot, account), { recursive: true });
const launch = {
  args: [appRoot],
  env: {
    ...process.env,
    PSB_TEST_STATE_ROOT: join(testRoot, "state"),
    PSB_TEST_GAME_ROOT: gameRoot,
  },
  timeout: 45000,
};
if (process.env.PSB_EXECUTABLE) {
  launch.executablePath = process.env.PSB_EXECUTABLE;
  launch.args = [];
}
const app = await electron.launch(launch);
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#pick-folder", { timeout: 30000 });
  await page.screenshot({ path: join(qaRoot, "home.png"), fullPage: true });
  assert.equal(await page.title(), "Palworld Save Bridge");
  await page.locator("#history-link").click();
  await page.locator(".empty-state").waitFor();
  await page.locator("#back-from-history").click();
  await page.locator("#help-link").click();
  await page.locator("#help-screen").waitFor({ state: "visible" });
  await page.locator("#back-from-help").click();
  // Stub only the native OS file picker. All app IPC, parsing and UI remain real.
  const missing = join(testRoot, "missing");
  await mkdir(missing);
  await writeFile(join(missing, "Level.sav"), "invalid");
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [chosen],
    });
  }, missing);
  await page.locator("#pick-folder").click();
  await page.locator("#error").waitFor({ state: "visible", timeout: 30000 });
  assert.match(
    await page.locator("#error-text").textContent(),
    /LevelMeta|Players/,
  );
  await page.locator("#dismiss-error").click();
  if (fixture) {
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [chosen],
      });
    }, fixture);
    await page.locator("#pick-folder").click();
    await page
      .locator("#configure-screen")
      .waitFor({ state: "visible", timeout: 120000 });
    const players = page.locator(".player-card");
    assert.ok((await players.count()) >= 2);
    assert.equal(await page.locator("#convert").isDisabled(), true);
    await players
      .filter({ hasNot: page.locator(".host-tag") })
      .first()
      .locator("input")
      .check();
    await page.locator("#world-name").fill("UI Test World");
    await page.locator("#character-name").fill("UI Test Guest");
    assert.equal(
      await page.locator("#after-world").textContent(),
      "UI Test World",
    );
    await page.screenshot({
      path: join(qaRoot, "configure.png"),
      fullPage: true,
    });
    await page.locator("#convert").click();
    await page
      .locator("#result-screen")
      .waitFor({ state: "visible", timeout: 240000 });
    assert.equal(
      await page.locator("#result-world").textContent(),
      "UI Test World",
    );
    assert.equal(
      await page.locator("#result-character").textContent(),
      "UI Test Guest",
    );
    await page.screenshot({ path: join(qaRoot, "result.png"), fullPage: true });
    await page.locator("#account-choice").selectOption(account);
    await page.locator("#apply").click();
    await page
      .locator("#apply-status")
      .waitFor({ state: "visible", timeout: 60000 });
    await page.locator("#history-link").click();
    await page.locator(".restore-button").click();
    await page.locator("#confirm-ok").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#progress-dialog").open &&
        document
          .querySelector("#history-list")
          .textContent.includes("이전 상태로 복구됨"),
      { timeout: 60000 },
    );
    await page.screenshot({
      path: join(qaRoot, "restore.png"),
      fullPage: true,
    });
    const zipPath = join(testRoot, "received.zip"),
      zip = new yazl.ZipFile();
    const zipped = pipeline(zip.outputStream, createWriteStream(zipPath));
    const prefix = `received/${basename(fixture)}/`;
    for (const name of [
      "Level.sav",
      "LevelMeta.sav",
      "WorldOption.sav",
      "LocalData.sav",
    ]) {
      zip.addFile(join(fixture, name), prefix + name);
    }
    for (const name of await readdir(join(fixture, "Players"))) {
      if (/^[0-9a-f]{32}\.sav$/i.test(name))
        zip.addFile(join(fixture, "Players", name), prefix + "Players/" + name);
    }
    zip.end();
    await zipped;
    await page.locator("#home-link").click();
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [chosen],
      });
    }, zipPath);
    await page.locator("#pick-zip").click();
    await page
      .locator("#configure-screen")
      .waitFor({ state: "visible", timeout: 120000 });
    assert.ok((await page.locator(".player-card").count()) >= 2);
  }
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    executable: process.env.PSB_EXECUTABLE || "development Electron",
    fixtureTested: Boolean(fixture),
    isolatedGameRoot: gameRoot,
    checks: [
      "home",
      "history empty state",
      "help",
      "missing files error",
      ...(fixture
        ? [
            "folder import",
            "explicit character selection",
            "name preview",
            "conversion",
            "apply to isolated account",
            "restore preserving current save",
            "nested ZIP import",
          ]
        : []),
    ],
    pageErrors: errors,
  };
  await writeFile(
    join(qaRoot, "ui-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
