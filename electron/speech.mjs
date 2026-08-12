import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

const SRC = path.join(__dirname, "resources", isWin ? "speech-helper.ps1" : "speech-helper.swift");
const BIN = app.isPackaged
  ? path.join(process.resourcesPath, isWin ? "speech-helper.ps1" : "speech-helper")
  : path.join(__dirname, "resources", isWin ? "speech-helper.ps1" : "speech-helper");

let child = null;

function ensureBuilt() {
  if (app.isPackaged || isWin) return;
  const stale = !existsSync(BIN) || statSync(BIN).mtimeMs < statSync(SRC).mtimeMs;
  if (!stale) return;
  execFileSync("swiftc", ["-O", SRC, "-o", BIN], { stdio: "pipe", timeout: 120_000 });
}

export function startSpeech(win) {
  stopSpeech();
  ensureBuilt();
  let proc;
  if (isWin) {
    proc = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", BIN], { stdio: ["ignore", "pipe", "pipe"] });
  } else {
    proc = spawn(BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
  }
  child = proc;

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        if (!win.isDestroyed()) win.webContents.send("speech:transcript", JSON.parse(line));
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  });
  proc.on("close", (code) => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code });
  });
  proc.on("error", () => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code: 1 });
  });
}

export function stopSpeech() {
  if (!child) return;
  try {
    if (isWin) {
      child.kill();
    } else {
      child.kill("SIGTERM");
    }
  } catch {}
  child = null;
}
