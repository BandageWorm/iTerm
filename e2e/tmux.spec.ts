import { expect, test } from "@playwright/test";

test("tmux control mode renders windows and panes, routes input, and returns to SSH", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const randomUUID = crypto.randomUUID.bind(crypto);
    const state = window as unknown as { generatedIds: string[] };
    state.generatedIds = [];
    crypto.randomUUID = () => { const id = randomUUID(); state.generatedIds.push(id); return id; };
    localStorage.clear();
    localStorage.setItem("iterm.preferences.v1", JSON.stringify({ locale: "en-US" }));
  });
  await page.goto("/");
  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.locator(".session-dialog");
  await dialog.getByLabel("Session name").fill("tmux test");
  await dialog.getByLabel("Protocol").selectOption("ssh");
  await dialog.getByRole("navigation").getByRole("button", { name: "SSH", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Host", exact: true }).fill("example.test");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected");
  await expect(page.locator(".statusbar")).toContainText(/RX [1-9]/);
  // Exercise the real remote adapter and UI with deterministic control replies.
  // No tmux test hooks or fixtures are included in the shipped application.
  await page.evaluate(async () => {
    const remotePath = "/src/lib/remote.ts";
    const mockPath = "/node_modules/@tauri-apps/api/mocks.js";
    const remote = await import(remotePath);
    const { mockIPC } = await import(mockPath);
    const ids = (window as unknown as { generatedIds: string[] }).generatedIds;
    const client = ids.map((id) => remote.getProcessTmuxClient(id)).find(Boolean);
    if (!client) throw new Error("SSH tmux client was not created");
    const state = window as unknown as { tmuxCommands: string[] };
    state.tmuxCommands = [];
    let guard = 10;
    let currentWindow = 0;
    let windows = 1;
    let split = false;
    let cols = 80;
    let rows = 24;
    const feed = (text: string) => client.feed(new TextEncoder().encode(text));
    const metadata = () => Array.from({ length: windows }, (_, window) => {
      const panes = window === 0 && split ? 2 : 1;
      return Array.from({ length: panes }, (_, pane) => [
        "$0", "test", `@${window}`, window, `shell-${window}`, cols, rows,
        Number(currentWindow === window), `%${window * 2 + pane}`, "shell",
        panes === 2 ? Math.floor((cols - 1) / 2) : cols, rows, pane * Math.ceil(cols / 2), 0, Number(pane === 0), 0, 1, 0, 1,
      ].join("\t")).join("\n");
    }).join("\n");
    mockIPC((command: string, args: { request?: { bytes: number[] } }) => {
      if (command.startsWith("list_")) return [];
      if (command !== "write_process_bytes") return;
      const bytes = args.request!.bytes;
      const text = new TextDecoder().decode(new Uint8Array(bytes));
      state.tmuxCommands.push(text);
      setTimeout(() => {
        for (const part of text.trim().split(" ; ")) {
        const id = guard++;
        let body = "";
        if (part.startsWith("refresh-client -C")) {
          [cols, rows] = part.trim().split(" ").at(-1)!.split(",").map(Number);
        }
        if (part.startsWith("new-window")) { currentWindow = windows++; }
        if (part.startsWith("select-window")) currentWindow = Number(/@(\d+)/.exec(part)![1]);
        if (part.startsWith("split-window")) split = true;
        if (part.startsWith("list-panes")) body = `${metadata()}\n`;
        if (part.startsWith("display-message")) body = "0,1,0,1,0,0,0,0,0,0,0,0\n";
        if (part.startsWith("capture-pane")) body = "remote shell ready\n$ \n";
        feed(`%begin 1 ${id} 1\n${body}%end 1 ${id} 1\n`);
        if (part.startsWith("detach-client")) feed("%exit\n\x1b\\$ ");
        }
      }, 0);
      return bytes.length;
    });
    feed("\x1bP1000p%begin 1 1 0\n%end 1 1 0\n%session-changed $0 test\n");
  });
  const workspace = page.getByRole("region", { name: "tmux workspace" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "0: shell-0" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tmux-pane:visible")).toHaveCount(1);
  await expect(page.locator(".tmux-terminal:visible .xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.locator(".tmux-terminal:visible textarea").pressSequentially("echo hello");
  await expect.poll(() => page.evaluate(() => (window as unknown as { tmuxCommands: string[] }).tmuxCommands.some((command) => command.startsWith("send-keys -H -t %0 65")))).toBe(true);
  await page.keyboard.insertText("你好");
  await expect.poll(() => page.evaluate(() => (window as unknown as { tmuxCommands: string[] }).tmuxCommands.some((command) => command.includes("e4 bd a0 e5 a5 bd")))).toBe(true);
  const terminalNode = await page.locator(".tmux-terminal:visible .xterm").elementHandle();
  await page.keyboard.press("Control+=");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("iterm.profiles.v1") ?? "[]")[0]?.terminal.fontSize)).toBe(15);
  expect(await terminalNode!.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("Control+f");
  await expect(page.getByLabel("Find terminal content")).toHaveCount(1);
  await expect(page.getByLabel("Find terminal content")).toBeFocused();
  // 查找输入必须使用应用皮肤，而不是宿主原生的白色输入框。
  await expect(page.locator(".tmux-search")).toHaveCSS("border-radius", "5px");
  await expect(page.locator(".tmux-search")).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  // 查找输入不得压住窗格标签。
  const searchBox = await page.locator(".tmux-search").boundingBox();
  const labelBox = await page
    .locator(".tmux-pane:visible .tmux-pane-label")
    .first()
    .boundingBox();
  expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(labelBox!.x);
  await page.getByLabel("Find terminal content").press("Escape");
  await expect(page.getByLabel("Find terminal content")).toHaveCount(0);
  await expect(page.locator(".tmux-terminal:visible textarea")).toBeFocused();
  await workspace.getByRole("button", { name: "Split tmux pane side by side" }).click();
  await expect(page.locator(".tmux-pane:visible")).toHaveCount(2);
  await workspace.getByRole("button", { name: "New tmux window", exact: true }).click();
  await expect(workspace.getByRole("tab", { name: "1: shell-1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tmux-pane:visible")).toHaveCount(1);
  await workspace.getByRole("tab", { name: "0: shell-0" }).click();
  await expect(page.locator(".tmux-pane:visible")).toHaveCount(2);
  await expect(workspace.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("tmux-workspace.png") });
  await workspace.getByRole("button", { name: "Detach tmux and return to shell" }).click();
  await expect(workspace).toBeHidden();
  await expect(page.getByRole("region", { name: "tmux test terminal", exact: true })).toBeVisible();
});
