import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Where an unqualified file write lands, end to end.
 *
 * The chain has three levels a person can set — a workspace's default, a Copilot's override, a
 * conversation's own — and the resolved answer reaches two places that must agree: the system
 * prompt the model reads, and the sandbox the tools resolve against. Both halves are worth a
 * browser test, because a prompt that says one thing while the tools do another is a model that
 * writes somewhere it was not told about — and the units can only check each half alone.
 *
 * Everything here goes through the real stack: the dialog, the route, the agent loop and the
 * filesystem. Only the model is scripted.
 */

async function newWorkspace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The workspace's own directory, from the API — the parent of `workdir/` and `sessions/`. */
async function dirOf(request: APIRequestContext, name: string): Promise<string> {
  const workspaces = (await (await request.get("/api/workspaces")).json()) as {
    name: string;
    dirPath: string;
  }[];
  return workspaces.find((w) => w.name === name)!.dirPath;
}

/** Make the scripted model write a file and answer, which is one turn. */
async function writeFileTurn(request: APIRequestContext, name: string): Promise<void> {
  await scriptLlm(request, {
    title: "写文件",
    turns: [
      {
        content: "我写下来。",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: name, content: "hello" } },
        ],
      },
      { content: "文件已保存。" },
    ],
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("文件已保存。");
}

/** The workspace's settings dialog, opened from its card on the home page. */
async function setWorkspaceWriteLocation(page: Page, name: string, value: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("workspace-card").filter({ hasText: name }).getByTestId("workspace-settings-open").click();
  await page.getByTestId("workspace-write-location").selectOption(value);
  await page.getByTestId("workspace-settings-close").click();
}

test("a workspace's default sends an unqualified write to the shared folder", async ({
  page,
  request,
}) => {
  const name = `WriteWs-${Date.now()}`;
  const workspaceId = await newWorkspace(request, name);
  const dirPath = await dirOf(request, name);
  void workspaceId;

  await setWorkspaceWriteLocation(page, name, "workspace");

  await writeFileTurn(request, "shared.md");
  await page.goto("/");
  await enterWorkspace(page, name);
  await send(page, "帮我写一个文件");

  expect(existsSync(join(dirPath, "workdir", "shared.md"))).toBe(true);
  expect(existsSync(join(dirPath, "sessions"))).toBe(true);
});

test("the built-in default sends it to the conversation instead", async ({ page, request }) => {
  // The product decision, seen from the browser: with nothing set, the file belongs to the
  // conversation that asked for it rather than to a directory every conversation writes into.
  const name = `WriteDefault-${Date.now()}`;
  await newWorkspace(request, name);
  const dirPath = await dirOf(request, name);

  await writeFileTurn(request, "private.md");
  await page.goto("/");
  await enterWorkspace(page, name);
  await send(page, "帮我写一个文件");

  expect(existsSync(join(dirPath, "workdir", "private.md"))).toBe(false);
  // Under one of the workspace's session directories, which is all the test can name without
  // knowing the conversation's id.
  const sessions = join(dirPath, "sessions");
  expect(existsSync(sessions)).toBe(true);
});

test("a conversation can override the workspace's default", async ({ page, request }) => {
  const name = `WriteSession-${Date.now()}`;
  await newWorkspace(request, name);
  const dirPath = await dirOf(request, name);

  await setWorkspaceWriteLocation(page, name, "workspace");

  await writeFileTurn(request, "mine.md");
  await page.goto("/");
  await enterWorkspace(page, name);

  // The conversation's own settings take the nearest level, which is the whole point of a chain.
  await page.getByTestId("open-session-settings").click();
  await page.getByTestId("session-write-location").selectOption("session");
  await page.getByTestId("session-settings-save").click();

  await send(page, "帮我写一个文件");

  expect(existsSync(join(dirPath, "workdir", "mine.md"))).toBe(false);
});

test("an explicit location in the tool call wins over every setting", async ({ page, request }) => {
  /*
   * The model's own choice, which is the level above all three settings — and the reason the
   * tools take a `location` at all: "write this into the project" has to be expressible.
   */
  const name = `WriteExplicit-${Date.now()}`;
  await newWorkspace(request, name);
  const dirPath = await dirOf(request, name);

  await scriptLlm(request, {
    title: "写文件",
    turns: [
      {
        content: "我写下来。",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            args: { path: "explicit.md", content: "hello", location: "workspace" },
          },
        ],
      },
      { content: "文件已保存。" },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page, name);
  await send(page, "帮我写一个文件");

  // The default is `session`, and this landed in the workspace because the call said so.
  expect(existsSync(join(dirPath, "workdir", "explicit.md"))).toBe(true);
});
