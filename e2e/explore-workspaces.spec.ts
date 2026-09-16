import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Referencing a workspace, end to end: the user opens one, and the agent can then read inside it.
 *
 * The pure pieces are unit-tested beside this — the resolver in `workspaceScope.test.ts`, the
 * widening in `readable-sources.test.ts`, the tool in `tools/explore.test.ts`. What only a
 * browser and a real turn can show is that the three are **wired together**: that the click
 * writes a setting the turn then reads, that the tool reaches the *other* workspace's folder,
 * and that the model was actually offered it.
 *
 * Every assertion about what the model received is made against the fake LLM's recorded request
 * bodies rather than against a reply, which is the only way to see it — a scripted reply says
 * nothing about what it was sent.
 */

async function seedWorkspace(
  request: APIRequestContext,
  name: string,
  files: Array<[string, string]>
): Promise<{ id: string; workdirPath: string }> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const created = (await res.json()) as { id: string; workdirPath: string };
  for (const [file, body] of files) writeFileSync(join(created.workdirPath, file), body);
  return created;
}

/** Everything the fake LLM was sent, as one string — the only window onto a turn's inputs. */
async function sentToModel(request: APIRequestContext): Promise<string> {
  return JSON.stringify(await (await request.get(`${FAKE_LLM}/__requests`)).json());
}

test("a referenced workspace becomes readable, and the model is told so", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const here = `Explore-${stamp}`;
  const there = `ExploreThere-${stamp}`;

  await seedWorkspace(request, here, [["local.md", "本工作区的内容"]]);
  const granted = await seedWorkspace(request, there, [
    ["跨工作区笔记.md", "另一个工作区的秘密内容"],
  ]);
  // A conversation inside the granted workspace too, so `sessions` has something to find.
  const sibling = await request.post(`/api/workspaces/${granted.id}/sessions`, {
    data: { title: `B 的会话-${stamp}` },
  });
  expect(sibling.status()).toBe(201);

  // The model lists the granted workspace's files, then answers.
  await scriptLlm(request, {
    title: "跨工作区",
    turns: [
      {
        content: "我看一下。",
        toolCalls: [
          {
            id: "call_x1",
            name: "ila_explore",
            args: { kind: "files", workspaceId: granted.id },
          },
        ],
      },
      { content: "看到了。" },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page, here);

  // Reference the other workspace the way the user would.
  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type(`@${there}`);
  await page.getByTestId("mention-option").filter({ hasText: there }).click();
  await expect(page.getByTestId("composer-scope").getByTestId("scope-chip")).toHaveCount(1);

  await page.getByTestId("composer-input").type("那个工作区里有什么？");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("看到了。");

  // Three claims, and each is a different part of the wiring.
  await expect
    .poll(() => sentToModel(request), { timeout: 15000 })
    // 1. The tool was *offered* — which is the grant being read on the turn path.
    .toContain("ila_explore");
  const sent = await sentToModel(request);
  // 2. The prompt named the workspace, so the model knows what it may look at.
  expect(sent).toContain(there);
  // 3. The tool actually reached inside it: the listing it returned is in the next request,
  //    and it is a file that exists only in the *other* workspace.
  expect(sent).toContain("跨工作区笔记.md");
});

test("without a reference, nothing outside this conversation is reachable", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const here = `NoRef-${stamp}`;
  const there = `NoRefThere-${stamp}`;

  await seedWorkspace(request, here, [["local.md", "本工作区的内容"]]);
  await seedWorkspace(request, there, [["跨工作区笔记.md", "另一个工作区的秘密内容"]]);

  await scriptLlm(request, { title: "没有引用", turns: [{ content: "好。" }] });
  await page.goto("/");
  await enterWorkspace(page, here);

  await page.getByTestId("composer-input").fill("这里有什么？");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("好。");

  // The default is what matters most here: an ordinary conversation is offered no cross-workspace
  // tool at all, so there is nothing for a model to reach with even if it tried.
  await expect.poll(() => sentToModel(request), { timeout: 15000 }).toContain("好");
  const sent = await sentToModel(request);
  expect(sent).not.toContain("ila_explore");
  expect(sent).not.toContain(there);
});
