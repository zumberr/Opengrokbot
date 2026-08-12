import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, utilityProcess } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
const { autoUpdater } = electronUpdater;

let updateState = {
  phase: app.isPackaged ? "idle" : "unavailable",
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  message: app.isPackaged
    ? "Buscando actualizaciones de GitHub…"
    : "Las actualizaciones están disponibles en la aplicación instalada.",
};

function publishUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:state", updateState);
  }
  return updateState;
}

function friendlyUpdateError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|latest\.yml|release/i.test(message)) return "Todavía no hay una actualización publicada.";
  if (/network|internet|connect|timeout|ENOTFOUND/i.test(message)) return "No se pudo conectar con GitHub. Inténtalo de nuevo.";
  return "No se pudo comprobar la actualización. Inténtalo de nuevo.";
}

let updaterConfigured = false;
function configureUpdater() {
  if (updaterConfigured || !app.isPackaged) return;
  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ phase: "checking", message: "Buscando una nueva versión…" }));
  autoUpdater.on("update-available", (info) => publishUpdateState({
    phase: "available",
    availableVersion: info.version,
    percent: null,
    message: `OpenMausBot ${info.version} está disponible.`,
  }));
  autoUpdater.on("update-not-available", () => publishUpdateState({
    phase: "up-to-date",
    availableVersion: null,
    percent: null,
    message: "Ya tienes la versión más reciente.",
  }));
  autoUpdater.on("download-progress", (progress) => publishUpdateState({
    phase: "downloading",
    percent: Math.max(0, Math.min(100, progress.percent)),
    message: `Descargando actualización… ${Math.round(progress.percent)}%`,
  }));
  autoUpdater.on("update-downloaded", (info) => publishUpdateState({
    phase: "downloaded",
    availableVersion: info.version,
    percent: 100,
    message: "Descarga completa. Preparando la instalación…",
  }));
  autoUpdater.on("error", (error) => publishUpdateState({
    phase: "error",
    percent: null,
    message: friendlyUpdateError(error),
  }));
}

async function checkForAppUpdate() {
  if (!app.isPackaged) return updateState;
  configureUpdater();
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateState({ phase: "error", message: friendlyUpdateError(error) });
  }
  return updateState;
}

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
let cuaCleanedUp = false;
let cleanupPromise = null;

function cleanupEmbeddedServices() {
  if (cuaCleanedUp) return Promise.resolve();
  if (cleanupPromise) return cleanupPromise;
  try {
    serverProc?.kill();
  } catch {}
  cleanupPromise = stopCua().finally(() => {
    cuaCleanedUp = true;
  });
  return cleanupPromise;
}
async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(port),
    },
    stdio: "inherit",
  });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "openmausbot" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen OpenMausBot — if it keeps happening, restart your computer.</p></div></body>`,
  );

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app. Screen Recording has no
// programmatic request — the first desktopCapturer call prompts.
ipcMain.handle("perm:status", () => {
  if (process.platform !== "darwin") return { mic: "granted", screen: "granted" };
  return {
    mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
    screen: systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown",
  };
});
ipcMain.handle("perm:request-mic", async () => {
  if (process.platform !== "darwin") return true;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});
const PERM_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, "perm-helper")
  : path.join(__dirname, "resources", "perm-helper");
ipcMain.handle("perm:request-screen", async () => {
  if (process.platform !== "darwin") return "granted";
  await new Promise((resolve) => {
    execFile(PERM_HELPER, ["request"], { timeout: 15_000 }, () => resolve());
  });
  return systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown";
});

ipcMain.handle("update:get-state", () => updateState);
ipcMain.handle("update:check", () => checkForAppUpdate());
let updateInstallPromise = null;
ipcMain.handle("update:install", async () => {
  if (!app.isPackaged) return updateState;
  if (updateInstallPromise) return updateInstallPromise;
  updateInstallPromise = (async () => {
    try {
      configureUpdater();
      if (updateState.phase !== "available" && updateState.phase !== "downloaded") {
        await checkForAppUpdate();
      }
      if (updateState.phase === "available") await autoUpdater.downloadUpdate();
      if (updateState.phase !== "downloaded") return updateState;
      publishUpdateState({ phase: "installing", message: "Instalando y reiniciando OpenMausBot…" });
      await cleanupEmbeddedServices();
      autoUpdater.quitAndInstall(true, true);
      return updateState;
    } catch (error) {
      return publishUpdateState({ phase: "error", percent: null, message: friendlyUpdateError(error) });
    } finally {
      updateInstallPromise = null;
    }
  })();
  return updateInstallPromise;
});

ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (process.platform === "darwin") {
    const panes = {
      mic: "Privacy_Microphone",
      screen: "Privacy_ScreenCapture",
      speech: "Privacy_SpeechRecognition",
    };
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
    );
  } else {
    return shell.openExternal("ms-settings:privacy");
  }
});

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  registerCuaIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  if (app.isPackaged) serverReady = await startServerPackaged();
  createWindow();
  configureUpdater();
  setTimeout(() => void checkForAppUpdate(), 2500).unref();
  setInterval(() => void checkForAppUpdate(), 6 * 60 * 60 * 1000).unref();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  cleanupEmbeddedServices().finally(() => app.quit());
});
