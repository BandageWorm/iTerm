import { Channel, invoke } from "@tauri-apps/api/core";
import { TmuxClient } from "./tmux";
import { appendLineEnding, isTauriRuntime } from "./serial";
import type {
  AdbDeviceDescriptor,
  ExternalToolStatus,
  LineEnding,
  LogMode,
  SerialEvent,
  SessionProfile,
  SshConfigHost,
} from "./types";

const mockTimers = new Map<string, number[]>();
const tmuxClients = new Map<string, TmuxClient>();
const tmuxListeners = new Set<() => void>();

export function getProcessTmuxClient(sessionId: string): TmuxClient | undefined {
  return tmuxClients.get(sessionId);
}

export function subscribeProcessTmuxClients(listener: () => void): () => void {
  tmuxListeners.add(listener);
  return () => { tmuxListeners.delete(listener); };
}

function removeTmuxClient(sessionId: string): void {
  tmuxClients.get(sessionId)?.dispose();
  if (tmuxClients.delete(sessionId)) {
    for (const listener of tmuxListeners) listener();
  }
}

function processEvents(
  sessionId: string,
  onEvent: (event: SerialEvent) => void,
): (event: SerialEvent) => void {
  removeTmuxClient(sessionId);
  let receivedAtMs = Date.now();
  let sequence = 0;
  const client = new TmuxClient({
    send: async (command) => {
      await writeRawProcessBytes(sessionId, new TextEncoder().encode(command));
    },
    onData: (bytes) => onEvent({
      type: "data", sessionId, sequence: ++sequence, receivedAtMs,
      bytes: Array.from(bytes),
    }),
    // The controller retains protocol/command errors in its UI snapshot.
    onError: () => undefined,
  });
  tmuxClients.set(sessionId, client);
  for (const listener of tmuxListeners) listener();
  return (event) => {
    // Ignore late events from a connection replaced during reconnect.
    if (tmuxClients.get(sessionId) !== client) return;
    if (event.type === "data") {
      receivedAtMs = event.receivedAtMs;
      client.feed(new Uint8Array(event.bytes));
    } else {
      if ((event.type === "state" &&
          ["disconnected", "error", "deviceLost"].includes(event.state)) ||
          (event.type === "error" && !event.recoverable)) {
        removeTmuxClient(sessionId);
      }
      onEvent(event);
    }
  };
}

export async function listExternalTools(): Promise<ExternalToolStatus[]> {
  if (isTauriRuntime()) {
    return invoke<ExternalToolStatus[]>("list_external_tools");
  }
  return [
    {
      id: "ssh",
      label: "OpenSSH 客户端",
      available: true,
      version: "OpenSSH mock",
      installHint: "请安装系统 OpenSSH Client。",
    },
    {
      id: "adb",
      label: "Android Platform Tools",
      available: true,
      version: "Android Debug Bridge mock",
      installHint: "请安装 Android SDK Platform Tools。",
    },
  ];
}

export async function listSshConfigHosts(): Promise<SshConfigHost[]> {
  if (isTauriRuntime()) {
    return invoke<SshConfigHost[]>("list_ssh_config_hosts");
  }
  return [
    {
      alias: "apple-lab",
      hostName: "192.168.1.42",
      user: "developer",
      port: 22,
      identityFiles: ["~/.ssh/id_ed25519"],
      source: "~/.ssh/config",
    },
    {
      alias: "production",
      hostName: "prod.example.com",
      user: "deploy",
      port: 22,
      identityFiles: ["~/.ssh/production"],
      proxyJump: "bastion",
      source: "~/.ssh/config",
    },
  ];
}

export async function listAdbDevices(): Promise<AdbDeviceDescriptor[]> {
  if (isTauriRuntime()) {
    return invoke<AdbDeviceDescriptor[]>("list_adb_devices");
  }
  return [
    {
      id: "emulator-5554",
      state: "device",
      product: "sdk_gphone64_arm64",
      model: "Pixel 8 API 35",
      device: "emu64a",
      transportId: "1",
    },
    {
      id: "R58M1234ABC",
      state: "unauthorized",
      model: "Android Device",
      transportId: "2",
    },
  ];
}

export async function openSshSession(
  sessionId: string,
  profile: SessionProfile,
  onEvent: (event: SerialEvent) => void,
): Promise<void> {
  onEvent = processEvents(sessionId, onEvent);
  if (isTauriRuntime()) {
    const channel = new Channel<SerialEvent>();
    channel.onmessage = onEvent;
    await invoke("open_ssh_session", {
      request: {
        sessionId,
        host: profile.ssh.host,
        port: profile.ssh.port,
        username: profile.ssh.username,
        authMode: profile.ssh.authMode,
        privateKeyPath: profile.ssh.privateKeyPath,
        strictHostKeyChecking: profile.ssh.strictHostKeyChecking,
        keepAliveSeconds: profile.ssh.keepAliveSeconds,
        termType: profile.terminal.termType,
      },
      onEvent: channel,
    }).catch((error: unknown) => {
      removeTmuxClient(sessionId);
      throw error;
    });
    return;
  }

  const timers = [
    window.setTimeout(
      () =>
        onEvent({
          type: "state",
          sessionId,
          state: "connected",
          message: "Mock SSH connected",
        }),
      150,
    ),
    window.setTimeout(
      () =>
        onEvent({
          type: "data",
          sessionId,
          sequence: 1,
          receivedAtMs: Date.now(),
          bytes: Array.from(
            new TextEncoder().encode(
              `\u001b[32mSSH connected\u001b[0m ${profile.ssh.username ? `${profile.ssh.username}@` : ""}${profile.ssh.host}\r\n$ `,
            ),
          ),
        }),
      300,
    ),
  ];
  mockTimers.set(sessionId, timers);
}

export async function openAdbSession(
  sessionId: string,
  profile: SessionProfile,
  onEvent: (event: SerialEvent) => void,
): Promise<void> {
  onEvent = processEvents(sessionId, onEvent);
  if (isTauriRuntime()) {
    const channel = new Channel<SerialEvent>();
    channel.onmessage = onEvent;
    await invoke("open_adb_session", {
      request: {
        sessionId,
        deviceId: profile.adb.deviceId,
        shell: profile.adb.shell,
      },
      onEvent: channel,
    }).catch((error: unknown) => {
      removeTmuxClient(sessionId);
      throw error;
    });
    return;
  }

  const timers = [
    window.setTimeout(
      () =>
        onEvent({
          type: "state",
          sessionId,
          state: "connected",
          message: "Mock ADB Shell connected",
        }),
      120,
    ),
    window.setTimeout(
      () =>
        onEvent({
          type: "data",
          sessionId,
          sequence: 1,
          receivedAtMs: Date.now(),
          bytes: Array.from(
            new TextEncoder().encode(
              `Android Debug Bridge shell\r\n${profile.adb.deviceId}:/ $ `,
            ),
          ),
        }),
      260,
    ),
  ];
  mockTimers.set(sessionId, timers);
}

export async function closeProcessSession(sessionId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("close_process_session", { sessionId });
    removeTmuxClient(sessionId);
    return;
  }
  for (const timer of mockTimers.get(sessionId) ?? []) {
    window.clearTimeout(timer);
  }
  mockTimers.delete(sessionId);
  removeTmuxClient(sessionId);
}

async function writeRawProcessBytes(
  sessionId: string,
  bytes: Uint8Array,
): Promise<number> {
  if (isTauriRuntime()) {
    return invoke<number>("write_process_bytes", {
      request: { sessionId, bytes: Array.from(bytes) },
    });
  }
  return bytes.length;
}

export async function writeProcessBytes(
  sessionId: string,
  bytes: Uint8Array,
  paneId?: string,
): Promise<number> {
  const client = tmuxClients.get(sessionId);
  if (client?.getSnapshot().active) {
    await client.input(bytes, paneId);
    return bytes.length;
  }
  if (paneId) throw new Error("tmux control mode is no longer active");
  return writeRawProcessBytes(sessionId, bytes);
}

export async function resizeProcessSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const client = tmuxClients.get(sessionId);
  if (client?.getSnapshot().active) {
    await client.resize(cols, rows);
    return;
  }
  if (isTauriRuntime()) {
    await invoke("resize_process_session", { sessionId, cols, rows });
  }
}

export async function writeProcessText(
  sessionId: string,
  text: string,
  lineEnding: LineEnding = "none",
  paneId?: string,
): Promise<number> {
  return writeProcessBytes(
    sessionId,
    new TextEncoder().encode(appendLineEnding(text, lineEnding)),
    paneId,
  );
}

export async function startProcessLog(
  sessionId: string,
  sessionName: string,
  mode: LogMode,
  encoding: string,
  append: boolean,
  maxFileSizeMiB: number,
  rotateCount: number,
  path?: string,
): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("start_process_log", {
      request: {
        sessionId,
        sessionName,
        mode,
        encoding,
        append,
        maxFileSizeMiB,
        rotateCount,
        path,
      },
    });
  }
  return `/mock/logs/${sessionName.replaceAll("/", "_")}.log`;
}

export async function setProcessLogPaused(
  sessionId: string,
  paused: boolean,
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("set_process_log_paused", { sessionId, paused });
  }
}

export async function stopProcessLog(sessionId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("stop_process_log", { sessionId });
  }
}
