import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { closeProcessSession, getProcessTmuxClient, openSshSession, subscribeProcessTmuxClients, writeProcessBytes } from "./remote";
import { createSessionProfile, type SerialEvent } from "./types";

afterEach(async () => {
  await closeProcessSession("tmux-test");
  clearMocks();
  delete window.__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe("SSH tmux transport integration", () => {
  it("preserves shell bytes before and after control mode and cleans up the client", async () => {
    vi.useFakeTimers();
    const events: SerialEvent[] = [];
    const changed = vi.fn();
    const unsubscribe = subscribeProcessTmuxClients(changed);
    await openSshSession("tmux-test", createSessionProfile(undefined, "ssh"), (event) => events.push(event));
    await vi.advanceTimersByTimeAsync(500);
    const client = getProcessTmuxClient("tmux-test")!;
    expect(client).toBeDefined();
    events.length = 0;
    client.feed(new Uint8Array([255, 0, 13]));
    client.feed(new TextEncoder().encode("\x1bP1000p%begin 1 1 0\n%end 1 1 0\n%exit\n\x1b\\$ "));
    const bytes = events.flatMap((event) => event.type === "data" ? event.bytes : []);
    expect(bytes).toEqual([255, 0, 13, 36, 32]);
    expect(client.getSnapshot().active).toBe(false);
    await closeProcessSession("tmux-test");
    expect(getProcessTmuxClient("tmux-test")).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("disposes tmux when the process reports a terminal error", async () => {
    let channel: { onmessage: (event: SerialEvent) => void } | undefined;
    mockIPC((command, args) => {
      if (command === "open_ssh_session") {
        channel = (args as unknown as { onEvent: typeof channel }).onEvent;
      }
    });
    const events: SerialEvent[] = [];
    await openSshSession("tmux-test", createSessionProfile(undefined, "ssh"), (event) => events.push(event));
    const client = getProcessTmuxClient("tmux-test")!;
    client.feed(new TextEncoder().encode("\x1bP1000p"));
    channel!.onmessage({ type: "error", sessionId: "tmux-test", code: "PROCESS_EXITED", message: "exited", recoverable: false });
    expect(getProcessTmuxClient("tmux-test")).toBeUndefined();
    expect(client.getSnapshot().active).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "PROCESS_EXITED" });
  });

  it("removes clients after failed connection attempts", async () => {
    mockIPC((command) => {
      if (command === "open_ssh_session") throw new Error("SSH unavailable");
    });
    await expect(openSshSession("tmux-test", createSessionProfile(undefined, "ssh"), () => undefined)).rejects.toThrow("SSH unavailable");
    expect(getProcessTmuxClient("tmux-test")).toBeUndefined();
  });

  it("keeps ordinary SSH input byte-exact", async () => {
    const writes: number[][] = [];
    mockIPC((command, args) => {
      if (command === "write_process_bytes") {
        const bytes = (args as { request: { bytes: number[] } }).request.bytes;
        writes.push(bytes);
        return bytes.length;
      }
    });
    await openSshSession("tmux-test", createSessionProfile(undefined, "ssh"), () => undefined);
    expect(await writeProcessBytes("tmux-test", new Uint8Array([0, 255, 13]))).toBe(3);
    expect(writes).toEqual([[0, 255, 13]]);
  });
});
