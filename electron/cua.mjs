import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const isWin = process.platform === "win32";

const INSTALLED_DRIVER = isWin
  ? "C:\\Program Files\\CuaDriver\\cua-driver.exe"
  : "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = isWin
  ? path.join(app.getPath("temp"), "cua-driver.sock")
  : path.join(app.getPath("home"), "Library/Caches/cua-driver/cua-driver.sock");
const HOST_BUNDLE_ID = "com.openmausbot.app";

let embeddedHost = null;
let connection = null;

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, isWin ? "cua-driver.exe" : "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function startEmbedded(binary) {
  const { EmbeddedCuaDriverHost } = await import("@trycua/cua-driver/embedded");
  embeddedHost = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const conn = await embeddedHost.start();
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
  };
}

export async function startCua() {
  const binary = resolveDriverBinary();
  if (!binary) {
    connection = { mode: "unavailable", reason: "cua-driver binary not found" };
    return connection;
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";

  if (wantEmbedded) {
    try {
      connection = await startEmbedded(binary);
    } catch (err) {
      connection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (await socketAlive(STANDALONE_SOCKET)) {
    connection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: {},
    };
  } else {
    connection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve`",
    };
  }

  fs.writeFileSync(
    path.join(app.getPath("userData"), "cua-connection.json"),
    JSON.stringify(connection, null, 2),
  );
  return connection;
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (embeddedHost) {
    try {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
    } catch {}
    embeddedHost = null;
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connection);
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
}
