import { expect, test, type Locator, type Page } from "@playwright/test";

async function openFreshApp(
  page: Page,
  locale: "zh-CN" | "en-US" = "zh-CN",
  options: { path?: string; preferences?: Record<string, unknown> } = {},
) {
  await page.addInitScript(
    ({ initialLocale, preferences }) => {
      if (sessionStorage.getItem("iterm.e2e.initialized") === "true") return;
      sessionStorage.setItem("iterm.e2e.initialized", "true");
      localStorage.clear();
      if (initialLocale === "en-US" || preferences) {
        localStorage.setItem(
          "iterm.preferences.v1",
          JSON.stringify({ locale: initialLocale, ...preferences }),
        );
      }
    },
    { initialLocale: locale, preferences: options.preferences },
  );
  await page.goto(options.path ?? "/");
}

async function readTxBytes(page: Page): Promise<number> {
  const text = await page.locator(".statusbar").innerText();
  const match = /TX\s*([\d.]+)\s*([KM]?B)/.exec(text);
  if (!match) return 0;
  const scale = match[2] === "KB" ? 1024 : match[2] === "MB" ? 1_048_576 : 1;
  return Number(match[1]) * scale;
}

test("切换语言并浏览完整会话设置", async ({ page }) => {
  await openFreshApp(page);

  await expect(page.getByLabel("iTerm")).toBeVisible();
  await expect(page.locator(".app-menubar")).toHaveCSS(
    "backdrop-filter",
    "none",
  );
  await expect(page.getByText("会话管理器", { exact: true })).toBeVisible();
  await page.getByTitle("应用设置").click();

  const settings = page.getByRole("dialog", { name: "应用设置" });
  await expect(settings).toBeVisible();
  await settings
    .locator("label")
    .filter({ hasText: "界面语言" })
    .locator("select")
    .selectOption("en-US");
  await settings.getByRole("button", { name: "保存应用设置" }).click();

  await expect(
    page.getByRole("button", { name: "Session", exact: true }),
  ).toBeVisible();
  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();

  const session = page.getByRole("dialog", {
    name: "Serial Session Settings",
  });
  await expect(session).toBeVisible();

  const categories = session.getByRole("navigation", {
    name: "Settings categories",
  });
  for (const pageName of ["Terminal", "Window", "Logging", "Triggers"]) {
    await categories.getByRole("button", { name: pageName, exact: true }).click();
    await expect(
      session.getByRole("heading", { name: pageName, exact: true }),
    ).toBeVisible();
  }
});

test("发现本机 SSH 配置并填入连接别名", async ({ page }) => {
  await openFreshApp(page, "en-US");
  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();

  const session = page.locator(".session-dialog");
  await session.getByLabel("Protocol").selectOption("ssh");
  await session
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "SSH", exact: true })
    .click();

  await expect(session.getByText("Local SSH Hosts")).toBeVisible();
  await expect(session.getByText("apple-lab", { exact: true })).toBeVisible();
  await expect(session.getByText("Key configured").first()).toBeVisible();
  await session.getByRole("button", { name: "Fill" }).first().click();

  await expect(
    session.getByRole("textbox", { name: "Host", exact: true }),
  ).toHaveValue("apple-lab");
  await expect(
    session.getByRole("textbox", { name: "Username", exact: true }),
  ).toHaveValue("developer");
  await session.getByRole("button", { name: "Cancel" }).click();
});

test("连接串口并操作工作区菜单", async ({ page }) => {
  await openFreshApp(page, "en-US");

  await expect(page.getByText("Available Devices", { exact: true })).toBeVisible();
  await expect(page.getByText("CP2102 USB to UART", { exact: true })).toBeVisible();
  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();

  const session = page.getByRole("dialog", {
    name: "Serial Session Settings",
  });
  await session.getByLabel("Session name").fill("E2E Serial");
  await session.getByRole("button", { name: "Save & Connect" }).click();

  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });
  await expect(
    page.getByRole("region", { name: "Sender pane" }),
  ).toBeVisible();

  const terminal = page.getByRole("region", {
    name: "E2E Serial terminal",
  });
  await terminal.click();
  await page.keyboard.press("Control+Shift+K");
  const commandInput = page.getByLabel("Command input");
  await commandInput.fill("help");
  await commandInput.press("Enter");
  await expect(
    page.locator(".terminal-history-list code").filter({ hasText: "help" }),
  ).toBeVisible();

  await terminal.click();
  await page.keyboard.press("Control+=");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const profiles = JSON.parse(
          localStorage.getItem("iterm.profiles.v1") ?? "[]",
        ) as Array<{ terminal?: { fontSize?: number } }>;
        return profiles[0]?.terminal?.fontSize;
      }),
    )
    .toBe(15);

  await terminal.click({ button: "right", position: { x: 220, y: 120 } });
  const contextMenu = page.getByRole("menu", { name: "Terminal actions" });
  await expect(contextMenu).toBeVisible();
  await expect(
    contextMenu.getByRole("menuitem", { name: /Paste/ }),
  ).toBeEnabled();
  await expect(
    contextMenu.getByRole("menuitem", { name: /Copy/ }),
  ).toBeDisabled();
  await contextMenu.getByRole("menuitem", { name: /Select All/ }).click();
  await expect(contextMenu).toBeHidden();

  await page.getByRole("button", { name: "Mode", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Hex Receive" })
    .click();
  await expect(
    page.getByRole("region", { name: "Hex receive view" }),
  ).toBeVisible();

  await page.getByLabel("Tab list").click();
  await expect(
    page.getByRole("menuitem", { name: /E2E Serial.*Current/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Sender Pane" })
    .click();
  await expect(
    page.getByRole("region", { name: "Sender pane" }),
  ).toBeHidden();

  await page.getByRole("button", { name: "Mode", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Text Receive" })
    .click();
  await page.locator('.menu-actions button[title="Search"]').click();
  await expect(page.getByLabel("Find terminal content")).toBeVisible();
});

test("清除本地应用数据并恢复默认设置", async ({ page }) => {
  await openFreshApp(page, "en-US");
  await expect(
    page.getByText("CP2102 USB to UART", { exact: true }),
  ).toBeVisible();
  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  await page
    .getByRole("dialog", { name: "Serial Session Settings" })
    .getByRole("button", { name: "Save & Connect" })
    .click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected");

  await page.getByTitle("Application settings").click();

  const settings = page.getByRole("dialog", {
    name: "Application Settings",
  });
  page.once("dialog", (dialog) => dialog.accept());
  await settings
    .getByRole("button", { name: "Clear local application data" })
    .click();

  await expect(page.getByText("会话管理器", { exact: true })).toBeVisible();
  await expect(page.locator(".session-tab")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => localStorage.getItem("iterm.preferences.v1") ?? "",
      ),
    )
    .not.toContain('"locale":"en-US"');
});

test("常用命令栏支持新增、右键编辑、收藏、发送与收起", async ({ page }) => {
  await openFreshApp(page, "en-US");

  const bar = page.getByRole("toolbar", { name: "Quick command bar" });
  await expect(bar).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Quick command bar" }),
  ).toHaveCount(1);

  await bar.getByRole("button", { name: "New quick command" }).click();
  const createDialog = page.getByRole("dialog", {
    name: "New quick command",
  });
  // 新增入口在最右侧，浮层不得被窗口右缘裁掉
  const editorBox = await createDialog.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await createDialog.getByLabel("Name", { exact: true }).fill("List files");
  await createDialog.getByLabel("Content", { exact: true }).fill("ls -l");
  await createDialog.getByRole("button", { name: "Save" }).click();

  const command = bar.getByRole("button", { name: "List files", exact: true });
  await expect(command).toBeVisible();
  await expect(command).toHaveAttribute("aria-disabled", "true");

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const session = page.getByRole("dialog", { name: "Serial Session Settings" });
  await session.getByLabel("Session name").fill("Quick Bar");
  await session.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });
  await expect(command).not.toHaveAttribute("aria-disabled", "true");

  await expect(page.locator(".statusbar")).toContainText("TX 0 B");
  await command.click();
  await expect(page.locator(".statusbar")).not.toContainText("TX 0 B");
  await expect(page.locator(".terminal-history-entry")).toHaveCount(0);

  await command.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Quick command actions" });
  await expect(actions).toBeVisible();
  await actions.getByRole("menuitem", { name: "Edit…" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit quick command" });
  await editDialog.getByLabel("Name", { exact: true }).fill("List directory");
  await editDialog.getByRole("button", { name: "Save" }).click();
  await expect(
    bar.getByRole("button", { name: "List directory", exact: true }),
  ).toBeVisible();

  const terminal = page.getByRole("region", { name: "Quick Bar terminal" });
  await terminal.click();
  await page.keyboard.press("Control+Shift+K");
  const commandInput = page.getByLabel("Command input");
  await commandInput.fill("help");
  await commandInput.press("Enter");

  const historyEntry = page.locator(".terminal-history-entry").first();
  await expect(historyEntry.locator("code")).toHaveText("help");
  await historyEntry
    .getByRole("button", { name: "Save as quick command", exact: true })
    .click();
  await expect(
    bar.getByRole("button", { name: "help", exact: true }),
  ).toBeVisible();
  await expect(
    historyEntry.getByRole("button", {
      name: "Saved as quick command",
      exact: true,
    }),
  ).toBeDisabled();

  const viewMenu = () => page.getByRole("button", { name: "View", exact: true });
  await viewMenu().click();
  await page.getByRole("menuitemcheckbox", { name: "Sender Pane" }).click();
  await expect(page.getByRole("region", { name: "Sender pane" })).toBeHidden();
  await expect(bar).toBeVisible();

  await page
    .getByRole("button", { name: "Quick command bar toggle" })
    .click();
  await expect(bar).toBeHidden();
  await viewMenu().click();
  await page.getByRole("menuitemcheckbox", { name: "Sender Pane" }).click();
  await expect(page.getByRole("region", { name: "Sender pane" })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("toolbar", { name: "Quick command bar" }),
  ).toBeHidden();
});

test("常用命令栏跨会话常驻并在无连接时禁用", async ({ page }) => {
  await openFreshApp(page, "en-US");

  const bar = page.getByRole("toolbar", { name: "Quick command bar" });
  await bar.getByRole("button", { name: "New quick command" }).click();
  const createDialog = page.getByRole("dialog", {
    name: "New quick command",
  });
  await createDialog.getByLabel("Content", { exact: true }).fill("df -h");
  await createDialog.getByRole("button", { name: "Save" }).click();

  const command = bar.getByRole("button", { name: "df -h", exact: true });
  await expect(command).toBeVisible();
  await expect(command).toHaveAttribute("aria-disabled", "true");

  // 未连接会话时命令按钮不可发送，但右键菜单必须仍然可用。
  // force 只是为了绕过 Playwright 对 aria-disabled 的动作检查，事件仍由浏览器真实派发。
  await command.click({ button: "right", force: true });
  const actions = page.getByRole("menu", { name: "Quick command actions" });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("menuitem", { name: "Send" })).toBeDisabled();
  await actions.getByRole("menuitem", { name: "Edit…" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit quick command" });
  await editDialog.getByLabel("Name", { exact: true }).fill("Disk space");
  await editDialog.getByRole("button", { name: "Save" }).click();
  await expect(
    bar.getByRole("button", { name: "Disk space", exact: true }),
  ).toBeVisible();

  for (const name of ["Split A", "Split B"]) {
    await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
    const session = page.getByRole("dialog", {
      name: "Serial Session Settings",
    });
    await session.getByLabel("Session name").fill(name);
    await session.getByRole("button", { name: "Save & Connect" }).click();
    await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
      timeout: 5_000,
    });
  }

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Split Left/Right" })
    .click();
  await expect(page.locator(".terminal-stack.split-horizontal")).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Quick command bar" }),
  ).toHaveCount(1);
  await expect(bar).toBeVisible();
});

test("分屏下查找栏全局唯一且 Ctrl+F 不触发宿主查找", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      terminalShortcutLog: Array<{ key: string; prevented: boolean }>;
    };
    state.terminalShortcutLog = [];
    window.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      const handled =
        (event.ctrlKey && !event.shiftKey && key === "f") ||
        (event.ctrlKey && event.shiftKey && ["c", "v", "k"].includes(key));
      if (handled) {
        state.terminalShortcutLog.push({
          key,
          prevented: event.defaultPrevented,
        });
      }
    });
  });
  await openFreshApp(page, "en-US");

  for (const name of ["Search A", "Search B"]) {
    await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
    const dialog = page.getByRole("dialog", { name: "Serial Session Settings" });
    await dialog.getByLabel("Session name").fill(name);
    await dialog.getByRole("button", { name: "Save & Connect" }).click();
    await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
      timeout: 5_000,
    });
  }

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Split Left/Right" })
    .click();
  await expect(page.locator(".terminal-stack.split-horizontal")).toBeVisible();

  const paneA = page.getByRole("region", { name: "Search A terminal" });
  const paneB = page.getByRole("region", { name: "Search B terminal" });
  const searchInput = page.getByLabel("Find terminal content");

  await paneA.click({ position: { x: 160, y: 120 } });
  await page.keyboard.press("Control+Shift+C");
  await page.keyboard.press("Control+Shift+V");
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByLabel("Command input")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+f");
  await expect(searchInput).toHaveCount(1);
  await expect(paneA.getByLabel("Find terminal content")).toBeVisible();

  const shortcutLog = await page.evaluate(
    () =>
      (
        window as unknown as {
          terminalShortcutLog: Array<{ key: string; prevented: boolean }>;
        }
      ).terminalShortcutLog,
  );
  for (const key of ["c", "v", "k", "f"]) {
    expect(
      shortcutLog.some((entry) => entry.key === key && entry.prevented),
    ).toBe(true);
  }

  await paneB.click({ position: { x: 160, y: 120 } });
  await page.keyboard.press("Control+f");
  await expect(searchInput).toHaveCount(1);
  await expect(paneB.getByLabel("Find terminal content")).toBeVisible();
  await expect(paneA.getByLabel("Find terminal content")).toBeHidden();
  await expect(searchInput).toBeFocused();
  await searchInput.fill("setprop");
  await expect(searchInput).toHaveValue("setprop");

  await page.keyboard.press("Escape");
  await expect(searchInput).toHaveCount(0);
  await paneA.click({ position: { x: 160, y: 120 } });
  await expect(searchInput).toHaveCount(0);
});

test("查看菜单可以隐藏与恢复历史命令栏", async ({ page }) => {
  await openFreshApp(page, "en-US");

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.getByRole("dialog", { name: "Serial Session Settings" });
  await dialog.getByLabel("Session name").fill("History Dock");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });

  const dock = page.locator(".terminal-history-dock");
  const viewMenu = () => page.getByRole("button", { name: "View", exact: true });
  const menuItem = () =>
    page.getByRole("menuitemcheckbox", { name: "Command History Bar" });
  const hostBox = () =>
    page.getByRole("region", { name: "History Dock terminal" })
      .locator(".terminal-host")
      .boundingBox();

  await expect(dock).toBeVisible();
  const widthWithDock = (await hostBox())?.width ?? 0;

  await viewMenu().click();
  await expect(menuItem()).toHaveAttribute("aria-checked", "true");
  await menuItem().click();
  await expect(dock).toBeHidden();
  await expect
    .poll(async () => (await hostBox())?.width ?? 0)
    .toBeGreaterThan(widthWithDock);

  await viewMenu().click();
  await expect(menuItem()).toHaveAttribute("aria-checked", "false");
  await menuItem().click();
  await expect(dock).toBeVisible();
  await expect
    .poll(async () => (await hostBox())?.width ?? 0)
    .toBe(widthWithDock);
});

test("查看菜单提供常用命令栏开关并与状态栏同步", async ({ page }) => {
  await openFreshApp(page, "en-US");

  const bar = page.getByRole("toolbar", { name: "Quick command bar" });
  const toggle = page.getByRole("button", {
    name: "Quick command bar toggle",
  });
  const viewMenu = () => page.getByRole("button", { name: "View", exact: true });
  const menuItem = () =>
    page.getByRole("menuitemcheckbox", { name: "Quick Command Bar" });

  await expect(bar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await viewMenu().click();
  await expect(menuItem()).toHaveAttribute("aria-checked", "true");
  await menuItem().click();
  await expect(bar).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await viewMenu().click();
  await expect(menuItem()).toHaveAttribute("aria-checked", "false");
  await menuItem().click();
  await expect(bar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("输入行位于面板底部时联想浮层紧贴其上方", async ({ page }) => {
  await openFreshApp(page, "en-US", { path: "/?mockScrollback=1" });

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.getByRole("dialog", { name: "Serial Session Settings" });
  await dialog.getByLabel("Session name").fill("Completion");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });

  const terminal = page.getByRole("region", { name: "Completion terminal" });
  // 等 mock 夹具把面板填满，光标随之落到末行。
  await page.waitForTimeout(1_500);
  await terminal.click();
  await page.keyboard.press("Control+Shift+K");
  const commandInput = page.getByLabel("Command input");
  await commandInput.fill("ifconfig");
  await commandInput.press("Enter");
  await page.keyboard.press("Escape");
  await terminal.click();
  await page.keyboard.type("ifc");

  const popup = page.locator(".terminal-inline-completion");
  await expect(popup).toBeVisible();
  // 输入行在最后一行：浮层必须贴在它上方，而不是被夹到面板顶部。
  await expect(popup).toHaveAttribute("data-placement", "above");
  const popupBox = await popup.boundingBox();
  const hostBox = await terminal.locator(".terminal-host").boundingBox();
  const screenBox = await terminal.locator(".xterm-screen").boundingBox();
  expect(popupBox).not.toBeNull();
  expect(hostBox).not.toBeNull();
  expect(screenBox).not.toBeNull();
  const popupBottom = popupBox!.y + popupBox!.height;
  const screenBottom = screenBox!.y + screenBox!.height;
  // 下边缘紧贴末行上方：与屏幕底边只差一到两行，而不是跑到面板另一端。
  expect(popupBottom).toBeGreaterThan(screenBottom - 60);
  expect(popupBottom).toBeLessThanOrEqual(screenBottom);
  expect(popupBox!.y).toBeGreaterThan(hostBox!.y + hostBox!.height * 0.5);
});

async function seedCommandHistory(
  page: Page,
  terminal: Locator,
  commands: string[] = ["ifconfig"],
) {
  await terminal.click();
  await page.keyboard.press("Control+Shift+K");
  const commandInput = page.getByLabel("Command input");
  for (const command of commands) {
    await commandInput.fill(command);
    await commandInput.press("Enter");
  }
  await page.keyboard.press("Escape");
  await terminal.click();
}

test("串口会话的 Tab 始终透传给设备", async ({ page }) => {
  await openFreshApp(page, "en-US");

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.getByRole("dialog", { name: "Serial Session Settings" });
  await dialog.getByLabel("Session name").fill("Tab Gate");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });

  const terminal = page.getByRole("region", { name: "Tab Gate terminal" });
  await seedCommandHistory(page, terminal);
  await terminal.click();
  await page.keyboard.type("ifc");

  const popup = page.locator(".terminal-inline-completion");
  const query = popup.locator(".terminal-inline-completion-query");
  await expect(popup).toBeVisible();
  await expect(query).toHaveText("ifc");

  const txBeforeTab = await readTxBytes(page);
  await page.keyboard.press("Tab");
  // 只发出一个制表符：联想没有替用户补齐 "onfig"。
  await expect.poll(() => readTxBytes(page)).toBe(txBeforeTab + 1);
  // 浮层让开，shell/设备随后打印的补全列表不会被压住。
  await expect(popup).toBeHidden();
});

test("Tab 永远交给会话，选中候选后用回车补全", async ({ page }) => {
  await openFreshApp(page, "en-US", {
    preferences: { defaultProtocol: "ssh" },
  });

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.getByRole("dialog", { name: "SSH Session Settings" });
  await dialog.getByLabel("Session name").fill("Tab Shell");
  const pages = dialog.getByRole("navigation", {
    name: "Settings categories",
  });
  await pages.getByRole("button", { name: "SSH", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Host", exact: true })
    .fill("192.168.1.42");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });

  const terminal = page.getByRole("region", { name: "Tab Shell terminal" });
  // 历史里的 "i" 与输入完全一致，会排在被补全候选之前。
  await seedCommandHistory(page, terminal, ["i", "ifconfig"]);
  await terminal.click();
  await page.keyboard.type("i");

  const popup = page.locator(".terminal-inline-completion");
  const query = popup.locator(".terminal-inline-completion-query");
  const options = popup.getByRole("option");
  await expect(popup).toBeVisible();
  await expect(query).toHaveText("i");
  // 补不出任何字符的首项不可被键盘选中。
  await expect(options.first()).toContainText("i");
  await expect(options.first()).toHaveAttribute("aria-disabled", "true");

  // Tab 交给会话，并收起浮层让会话输出可见。
  await page.keyboard.press("Tab");
  await expect(popup).toBeHidden();

  // 继续输入后浮层才回来；此时可选中候选，但 Tab 依旧不改写输入行。
  await page.keyboard.type("f");
  await expect(popup).toBeVisible();
  await expect(query).toHaveText("if");
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(popup).toBeHidden();

  // 回车才是联想的接受键：只把剩余字符发给会话，随后收起浮层。
  await page.keyboard.type("c");
  await expect(query).toHaveText("ifc");
  await page.keyboard.press("ArrowDown");
  const txBeforeAccept = await readTxBytes(page);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => readTxBytes(page))
    .toBeGreaterThan(txBeforeAccept);
  await expect(popup).toBeHidden();
});

test("右键快捷复制粘贴按开关分流", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFreshApp(page, "en-US");

  await page.getByTitle("Application settings").click();
  const settings = page.getByRole("dialog", {
    name: "Application Settings",
  });
  await settings
    .locator(".field-row")
    .filter({ hasText: "Right-click copy and paste" })
    .locator('input[type="checkbox"]')
    .check();
  await settings
    .getByRole("button", { name: "Save application settings" })
    .click();
  await expect(settings).toBeHidden();

  await page.getByTitle("New session (Ctrl/⌘+N)").first().click();
  const dialog = page.getByRole("dialog", { name: "Serial Session Settings" });
  await dialog.getByLabel("Session name").fill("Right Click");
  await dialog.getByRole("button", { name: "Save & Connect" }).click();
  await expect(page.locator(".statusbar strong")).toHaveText("Connected", {
    timeout: 5_000,
  });

  const terminal = page.getByRole("region", { name: "Right Click terminal" });
  const menu = page.getByRole("menu", { name: "Terminal actions" });
  const point = { x: 200, y: 120 };

  // Shift + 右键始终打开菜单：先用全选建立选区。
  await terminal.click({ button: "right", position: point, modifiers: ["Shift"] });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /Select All/ }).click();

  // 有选区时右键直接复制，不弹菜单，并清除选区。
  await terminal.click({ button: "right", position: point });
  await expect(menu).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .not.toBe("");

  await terminal.click({ button: "right", position: point, modifiers: ["Shift"] });
  await expect(menu.getByRole("menuitem", { name: /Copy/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  // 无选区时右键粘贴，内容进入命令历史。
  await page.evaluate(() => navigator.clipboard.writeText("reboot"));
  const txBytes = async () => {
    const text = await page.locator(".statusbar").innerText();
    const match = /TX\s*([\d.]+)\s*([KM]?B)/.exec(text);
    if (!match) return 0;
    const scale = match[2] === "KB" ? 1024 : match[2] === "MB" ? 1_048_576 : 1;
    return Number(match[1]) * scale;
  };
  const txBeforePaste = await txBytes();
  await terminal.click({ button: "right", position: point });
  // 粘贴走异步剪贴板读取，先确认字节确实发出，再按回车结束这条命令。
  await expect.poll(txBytes).toBeGreaterThan(txBeforePaste);
  await expect(menu).toBeHidden();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => localStorage.getItem("iterm.command-history.v1") ?? "",
      ),
    )
    .toContain("reboot");
  await expect(
    page.locator(".terminal-history-list code").filter({ hasText: "reboot" }),
  ).toBeVisible();
});
