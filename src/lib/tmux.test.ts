import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeTmuxOutput,
  MAX_TMUX_BLOCK_BYTES,
  MAX_TMUX_LINE_BYTES,
  MAX_TMUX_PANE_BYTES,
  TmuxClient,
} from "./tmux";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clients: TmuxClient[] = [];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function row(overrides: Record<number, string> = {}): string {
  const fields = [
    "$1", "work", "@2", "0", "shell", "80", "24", "1", "%3", "host",
    "80", "24", "0", "0", "1", "5", "2", "0", "1",
  ];
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return fields.join("\t");
}

function harness() {
  const send = vi.fn<(command: string) => Promise<void>>().mockResolvedValue(undefined);
  const data: number[] = [];
  const onError = vi.fn();
  const client = new TmuxClient({ send, onError, onData: (bytes) => data.push(...bytes) });
  clients.push(client);
  const feed = (text: string) => client.feed(encoder.encode(text));
  let id = 10;
  const respond = (body = "", error = false) => {
    id += 1;
    feed(`%begin 100 ${id} 1\n${body ? `${body}\n` : ""}%${error ? "error" : "end"} 100 ${id} 1\n`);
  };
  const start = async (rows = row(), captures = ["old screen"]) => {
    feed("\x1bP1000p%begin 100 1 0\n%end 100 1 0\n%session-changed $1 work\n");
    await flush();
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining("list-panes -s -F "));
    respond(rows);
    for (const capture of captures) {
      expect(send).toHaveBeenLastCalledWith(expect.stringContaining("capture-pane -p -e -C -S -2000 -t "));
      respond("5,2,0,1");
      respond(capture);
    }
    await flush();
  };
  const paneBytes = (paneId = "%3") => client.getSnapshot().panes.find((pane) => pane.id === paneId)!.receiveChunks.flatMap((chunk) => chunk.bytes);
  return { client, send, data, onError, feed, respond, start, paneBytes };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

describe("tmux control protocol", () => {
  it("preserves ordinary shell bytes and recognizes a DCS marker split at every position", async () => {
    const marker = encoder.encode("\x1bP1000p");
    for (let split = 1; split < marker.length; split += 1) {
      const h = harness();
      const raw = Uint8Array.from([0xff, 0, 0xe4, 0x1b, 0x5b, 0x31, 0x6d]);
      h.client.feed(raw);
      h.client.feed(marker.subarray(0, split));
      expect(h.client.getSnapshot().active).toBe(false);
      expect(h.data).toEqual(Array.from(raw));
      h.client.feed(marker.subarray(split));
      expect(h.client.getSnapshot().active).toBe(true);
      expect(h.data).toEqual(Array.from(raw));
      h.client.dispose();
    }
    await flush();
  });

  it("returns false marker prefixes verbatim and flushes an incomplete prefix on close", () => {
    const h = harness();
    h.feed("shell\x1bP100z\x1b");
    expect(decoder.decode(Uint8Array.from(h.data))).toBe("shell\x1bP100z");
    h.client.dispose();
    expect(decoder.decode(Uint8Array.from(h.data))).toBe("shell\x1bP100z\x1b");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps octal output byte-safe, including invalid and incomplete UTF-8", async () => {
    const h = harness();
    await h.start();
    const oldLength = h.paneBytes().length;
    const wire = encoder.encode("%output %3 \\000\\033[31m\\134\\377\n%extended-output %3 17 future : ");
    for (const byte of wire) h.client.feed(Uint8Array.of(byte));
    h.client.feed(Uint8Array.from([0xe4, 0xbd]));
    h.feed("\n%output %3 ");
    h.client.feed(Uint8Array.from([0xa0, 10]));
    expect(h.paneBytes().slice(oldLength)).toEqual([0, 27, 91, 51, 49, 109, 92, 255, 0xe4, 0xbd, 0xa0]);
    expect(h.data).toEqual([]);
    expect(Array.from(decodeTmuxOutput(encoder.encode("\\12\\400\\xyz")))).toEqual(Array.from(encoder.encode("\\12\\400\\xyz")));
  });

  it("never treats command output as an asynchronous notification", async () => {
    const h = harness();
    h.feed("\x1bP1000p%begin 100 1 0\n%end 100 1 0\n");
    await flush();
    h.respond(row());
    h.respond("5,2,0,1");
    h.respond("%output %3 this is captured text\n%exit\n%end 100 999 1");
    const text = decoder.decode(Uint8Array.from(h.paneBytes()));
    expect(text).toContain("%output %3 this is captured text\r\n%exit\r\n%end 100 999 1");
    expect(h.client.getSnapshot().active).toBe(true);
    expect(h.data).toEqual([]);
  });

  it("matches all guard identity fields and ignores the initial server command block", async () => {
    const h = harness();
    h.feed("\x1bP1000p");
    await flush();
    const sent = h.send.mock.calls.length;
    h.feed("%begin 100 1 0\ninitial output\n%end 100 1 0\n");
    expect(h.send).toHaveBeenCalledTimes(sent);
    h.feed(`%begin 100 8 1\n${row()}\n%end 101 8 1\n%end 100 8 0\n`);
    expect(h.client.getSnapshot().panes).toEqual([]);
    h.feed("%end 100 8 1\n");
    expect(h.client.getSnapshot().panes).toHaveLength(1);
    h.respond("5,2,0,1");
    h.respond();
  });

  it("reports command errors without displaying protocol output and can execute the next command", async () => {
    const h = harness();
    await h.start();
    const pending = h.client.newWindow();
    const assertion = expect(pending).rejects.toThrow("can't create window");
    h.respond("can't create window", true);
    await assertion;
    const input = h.client.input(encoder.encode("a"));
    expect(h.send).toHaveBeenLastCalledWith("send-keys -H -t %3 61\n");
    h.respond();
    await input;
    expect(h.data).toEqual([]);
  });

  it("restores raw shell traffic after %exit and a fragmented ST, and can attach again", async () => {
    const h = harness();
    await h.start();
    h.feed("%exit detached\r\n\x1b");
    expect(h.client.getSnapshot().active).toBe(false);
    h.feed("\\\r\n$ ");
    expect(decoder.decode(Uint8Array.from(h.data))).toBe("\r\n$ ");
    await h.start();
    expect(h.client.getSnapshot().panes[0].outputRevision).toBe(2);
  });

  it("initializes when detach and reattach happen before the first refresh microtask", async () => {
    const h = harness();
    h.feed("\x1bP1000p%exit\n\x1b\\\x1bP1000p%begin 100 1 0\n%end 100 1 0\n");
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenLastCalledWith(expect.stringContaining("list-panes -s"));
  });

  it("bounds unterminated lines, recovers on a newline, and caps retained pane data", async () => {
    const h = harness();
    await h.start();
    h.client.feed(new Uint8Array(MAX_TMUX_LINE_BYTES + 1).fill(65));
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("line exceeded"));
    h.feed("\n%output %3 valid\n");
    expect(decoder.decode(Uint8Array.from(h.paneBytes()))).toContain("valid");
    h.feed(`%output %3 ${"x".repeat(MAX_TMUX_PANE_BYTES + 1)}\n`);
    expect(h.paneBytes()).toHaveLength(MAX_TMUX_PANE_BYTES);
    expect(h.data).toEqual([]);
  });

  it("bounds command responses and resumes after the matching end guard", async () => {
    const h = harness();
    await h.start();
    const pending = h.client.newWindow();
    const assertion = expect(pending).rejects.toThrow("buffer limit");
    h.feed("%begin 100 800 1\n");
    const line = "x".repeat(64 * 1024);
    for (let size = 0; size <= MAX_TMUX_BLOCK_BYTES; size += line.length) h.feed(`${line}\n`);
    h.feed("%end 100 800 1\n");
    await assertion;
    expect(h.data).toEqual([]);
  });

  it("stalls after a timeout so a late guard cannot complete a different command", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.start();
    const pending = h.client.newWindow();
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    h.respond();
    await expect(h.client.newWindow()).rejects.toThrow("unresponsive");
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(h.client.getSnapshot().error).toContain("timed out");
    h.client.clearError();
    expect(h.client.getSnapshot().error).toBeUndefined();
  });
});

describe("tmux session controller", () => {
  it("loads only the attached session and maps native window/pane layout with escaped titles", async () => {
    const h = harness();
    const rows = [
      row({ 4: "build\\ room", 9: "host\\\twith\\\nnewline\\\\path", 10: "39" }),
      row({ 4: "build\\ room", 8: "%4", 9: "second", 10: "40", 12: "40", 14: "0" }),
      row({ 2: "@7", 3: "1", 4: "editor", 7: "0", 8: "%9" }),
    ].join("\n");
    await h.start(rows, ["one", "two", "three"]);
    const snapshot = h.client.getSnapshot();
    expect(h.send.mock.calls[0][0]).toContain("list-panes -s -F");
    expect(h.send.mock.calls[0][0]).not.toContain("list-panes -a");
    expect(snapshot).toMatchObject({ sessionId: "$1", sessionName: "work", activeWindowId: "@2" });
    expect(snapshot.windows).toMatchObject([{ id: "@2", name: "build room" }, { id: "@7", name: "editor" }]);
    expect(snapshot.panes[0]).toMatchObject({ title: "host\twith\nnewline\\path", width: 39, left: 0 });
    expect(snapshot.panes[1]).toMatchObject({ width: 40, left: 40, active: false });
    expect(h.client.getSnapshot()).toBe(snapshot);
    const unchangedPane = snapshot.panes[1];
    h.feed("%output %3 more\n");
    expect(h.client.getSnapshot().panes[1]).toBe(unchangedPane);
  });

  it("restores capture bytes and cursor without duplicating live output received after the end guard", async () => {
    const h = harness();
    h.feed("\x1bP1000p%begin 100 1 0\n%end 100 1 0\n%output %3 old duplicate\n");
    await flush();
    h.respond(row({ 17: "1", 18: "0" }));
    h.respond("5,2,1,0");
    h.feed("%output %3 before capture\n%begin 100 90 1\n\\033[31mhello\\\\033\\\\path\nsecond\n%end 100 90 1\n%output %3 fresh\n");
    const text = decoder.decode(Uint8Array.from(h.paneBytes()));
    expect(text).toBe("\x1b[0m\x1b[?1049h\x1b[H\x1b[31mhello\\033\\path\r\nsecond\x1b[3;6H\x1b[?25lfresh");
    expect(h.client.getSnapshot().panes[0].outputRevision).toBe(1);
  });

  it("encodes arbitrary input as hexadecimal and rejects unknown pane/window targets", async () => {
    const h = harness();
    await expect(h.client.input(Uint8Array.of(1))).rejects.toThrow("not active");
    h.feed("\x1bP1000p");
    await expect(h.client.input(Uint8Array.of(1))).rejects.toThrow("No active");
    h.client.dispose();
    const attached = harness();
    await attached.start();
    const pending = attached.client.input(encoder.encode("\n; kill-server\n'\\你好"));
    expect(attached.send.mock.calls.at(-1)![0]).toMatch(/^send-keys -H -t %3(?: [0-9a-f]{2})+\n$/);
    expect(attached.send.mock.calls.at(-1)![0]).toContain("0a 3b 20");
    attached.respond();
    await pending;
    const count = attached.send.mock.calls.length;
    await attached.client.input(new Uint8Array());
    await expect(attached.client.input(Uint8Array.of(1), "%3;kill-server")).rejects.toThrow("No active");
    await expect(attached.client.selectWindow("@2\nkill-server")).rejects.toThrow("Unknown");
    expect(attached.send).toHaveBeenCalledTimes(count);
  });

  it("splits long input into bounded send-keys commands without losing bytes", async () => {
    const h = harness();
    await h.start();
    const input = Uint8Array.from({ length: 700 }, (_, index) => index % 256);
    const pending = h.client.input(input);
    const sent: string[] = [];
    for (let chunk = 0; chunk < 3; chunk += 1) {
      sent.push(h.send.mock.calls.at(-1)![0]);
      h.respond();
      await flush();
    }
    await pending;
    const bytes = sent.flatMap((command) => command.trim().split(" ").slice(4).map((token) => parseInt(token, 16)));
    expect(bytes).toEqual(Array.from(input));
    expect(sent.every((command) => command.length < 1000)).toBe(true);
  });

  it("finishes an entire paste before sending a concurrently entered Return", async () => {
    const h = harness();
    await h.start();
    const paste = h.client.input(new Uint8Array(300).fill(65));
    const enter = h.client.input(Uint8Array.of(13));
    expect(h.send.mock.calls.at(-1)![0]).toMatch(/^send-keys -H -t %3(?: 41){256}\n$/);
    h.respond();
    await flush();
    expect(h.send.mock.calls.at(-1)![0]).toMatch(/^send-keys -H -t %3(?: 41){44}\n$/);
    h.respond();
    await flush();
    expect(h.send).toHaveBeenLastCalledWith("send-keys -H -t %3 0d\n");
    h.respond();
    await Promise.all([paste, enter]);
  });

  it("does not send the remainder of a paste into a later attachment on the same connection", async () => {
    const h = harness();
    await h.start();
    const paste = h.client.input(new Uint8Array(300).fill(65));
    const assertion = expect(paste).rejects.toThrow("connection changed");
    h.respond();
    h.feed("%exit\n\x1b\\\x1bP1000p%begin 100 1 0\n%end 100 1 0\n");
    await flush();
    await assertion;
    expect(h.send.mock.calls.filter(([command]) => command.startsWith("send-keys"))).toHaveLength(1);
  });

  it("restores cursor and terminal modes queried together with capture instead of stale metadata", async () => {
    const h = harness();
    h.feed("\x1bP1000p%begin 100 1 0\n%end 100 1 0\n");
    await flush();
    h.respond(row());
    expect(h.send).toHaveBeenLastCalledWith(expect.stringMatching(/^display-message .* ; capture-pane /));
    h.respond("12,6,1,0,1,1,0,1,0,0,1,1");
    h.respond("current screen");
    const screen = decoder.decode(Uint8Array.from(h.paneBytes()));
    expect(screen).toContain("\x1b[?1049h");
    expect(screen).toContain("\x1b[7;13H\x1b[?25l\x1b[?1h\x1b=");
    expect(screen).toContain("\x1b[?1002h");
    expect(screen).toContain("\x1b[?1006h\x1b[?2004h");
  });

  it("streams all output even when a render would only see the bounded final snapshot", async () => {
    const h = harness();
    await h.start();
    const output = vi.fn<(paneId: string, bytes: Uint8Array, revision: number) => void>();
    const unsubscribe = h.client.subscribeOutput(output);
    h.feed(`%output %3 ${"a".repeat(MAX_TMUX_PANE_BYTES)}\n%output %3 ${"b".repeat(MAX_TMUX_PANE_BYTES)}\n`);
    expect(output.mock.calls.reduce((sum, [, bytes]) => sum + bytes.length, 0)).toBe(MAX_TMUX_PANE_BYTES * 2);
    expect(output.mock.calls[0][2]).toBe(1);
    expect(h.paneBytes()).toHaveLength(MAX_TMUX_PANE_BYTES);
    unsubscribe();
    h.feed("%output %3 c\n");
    expect(output).toHaveBeenCalledTimes(2);
  });

  it("sends control-client dimensions and applies window/pane selection notifications", async () => {
    const h = harness();
    await h.start([row(), row({ 8: "%4", 14: "0" }), row({ 2: "@7", 3: "1", 7: "0", 8: "%8" })].join("\n"), ["a", "b", "c"]);
    const resize = h.client.resize(132, 43);
    expect(h.send).toHaveBeenLastCalledWith("refresh-client -C 132,43\n");
    h.respond();
    await resize;
    const calls = h.send.mock.calls.length;
    await h.client.resize(132, 43);
    expect(h.send).toHaveBeenCalledTimes(calls);
    h.feed("%window-pane-changed @2 %4\n%session-window-changed $1 @7\n");
    expect(h.client.getSnapshot().panes.find((pane) => pane.id === "%4")!.active).toBe(true);
    expect(h.client.getSnapshot().activeWindowId).toBe("@7");
    await flush();
    expect(h.send).toHaveBeenLastCalledWith(expect.stringContaining("list-panes -s"));
  });

  it("refreshes metadata after layout, rename, add and close notifications without recapturing existing panes", async () => {
    const h = harness();
    await h.start();
    h.feed("%layout-change @2 layout visible flags\n%window-renamed @2 renamed\n%window-add @8\n%window-close @8\n");
    await flush();
    const count = h.send.mock.calls.length;
    expect(h.send).toHaveBeenLastCalledWith(expect.stringContaining("list-panes -s"));
    h.respond(row({ 4: "renamed", 10: "40" }));
    await flush();
    expect(h.client.getSnapshot().windows[0].name).toBe("renamed");
    expect(h.client.getSnapshot().panes[0].width).toBe(40);
    expect(h.send).toHaveBeenCalledTimes(count);
  });

  it("detaches the client without stopping tmux and blocks writes that could reach the shell", async () => {
    const h = harness();
    await h.start();
    const detached = h.client.detach();
    expect(h.send).toHaveBeenLastCalledWith("detach-client\n");
    await expect(h.client.input(encoder.encode("rm"))).rejects.toThrow("detaching");
    h.respond();
    h.feed("%exit\n\x1b\\$ ");
    await detached;
    expect(decoder.decode(Uint8Array.from(h.data))).toBe("$ ");
    expect(h.send.mock.calls.every(([command]) => !command.includes("kill-"))).toBe(true);
  });

  it("reports failed initial queries through the background error callback", async () => {
    const h = harness();
    h.feed("\x1bP1000p%begin 100 1 0\n%end 100 1 0\n");
    await flush();
    h.respond("unknown command: list-panes", true);
    await flush();
    expect(h.onError).toHaveBeenCalledWith("unknown command: list-panes");
    expect(h.data).toEqual([]);
  });
});
