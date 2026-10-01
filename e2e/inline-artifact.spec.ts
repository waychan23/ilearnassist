import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Inline artifact placement, end to end: a marker in the reply puts the diagram, figure or
 * file card at the exact prose position — between the sentences around it — instead of
 * above the message. The ordering math has unit tests (`utils/inlineArtifacts`); what only
 * a browser can show is the actual visual order and the streaming transitions.
 */

const FLOW = "flowchart TD\n  A[开始] --> B[结束]";

/** A small valid plot spec. */
const PLOT_SPEC = {
  x: { domain: [-2, 2] },
  y: { domain: [-2, 4] },
  grid: true,
  elements: [{ kind: "function", expr: "x^2", from: -2, to: 2 }],
};

async function freshSession(page: Page): Promise<void> {
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

/** Vertical order: the two sentences and the card, by bounding box. */
async function verticalOrder(
  page: Page,
  cardTestId: string
): Promise<{ before: number; card: number; after: number }> {
  const beforeText = page.getByText("引用前的文字。", { exact: true });
  const card = page.getByTestId(cardTestId).last();
  const afterText = page.getByText("引用后的文字。", { exact: true });
  const [b, c, a] = await Promise.all([
    beforeText.boundingBox(),
    card.boundingBox(),
    afterText.boundingBox(),
  ]);
  return { before: b!.y + b!.height, card: c!.y, after: a!.y + a!.height };
}

test("a diagram marker puts the card between the two prose parts, also after reload", async ({
  page,
  request,
}) => {
  await freshSession(page);
  await scriptLlm(request, {
    turns: [
      {
        content:
          "引用前的文字。\n\n如下图：\n\n[[artifact:diagram/auth-flow]]\n\n引用后的文字。",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "auth flow", source: FLOW, summary: "认证流程" },
          },
        ],
      },
      { content: "完成。" },
    ],
  });

  await send(page, "画图");
  await expect(page.getByTestId("diagram-card").last()).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("diagram-card").last().getByTestId("mermaid")
  ).toHaveAttribute("data-render-state", "ready", { timeout: 20_000 });

  const order = await verticalOrder(page, "diagram-card");
  expect(order.before).toBeLessThanOrEqual(order.card);
  expect(order.card).toBeLessThan(order.after);

  // Positioning is persisted with the content, not re-derived on load.
  await page.reload();
  const reloaded = await verticalOrder(page, "diagram-card");
  expect(reloaded.before).toBeLessThanOrEqual(reloaded.card);
  expect(reloaded.card).toBeLessThan(reloaded.after);
});

/** A plot/file marker puts the card between the two prose parts. */
async function markerBetweenSentences(
  page: Page,
  request: APIRequestContext,
  args: {
    kind: "plot" | "file";
    cardTestId: string;
    toolName: string;
    handle: string;
    callArgs: Record<string, unknown>;
  }
): Promise<void> {
  const marker = `[[artifact:${args.kind}/${args.handle}]]`;
  await scriptLlm(request, {
    turns: [
      {
        content: `引用前的文字。\n\n${marker}\n\n引用后的文字。`,
        toolCalls: [{ id: `call_${args.kind}`, name: args.toolName, args: args.callArgs }],
      },
      { content: "完成。" },
    ],
  });

  await send(page, "做一个");
  await expect(page.getByTestId(args.cardTestId).last()).toBeVisible({ timeout: 20_000 });

  const order = await verticalOrder(page, args.cardTestId);
  expect(order.before).toBeLessThanOrEqual(order.card);
  expect(order.card).toBeLessThan(order.after);
}

test("a plot marker places the card at the prose position", async ({ page, request }) => {
  await freshSession(page);
  await markerBetweenSentences(page, request, {
    kind: "plot",
    cardTestId: "plot-card",
    toolName: "ila_plot",
    handle: "parabola",
    callArgs: { name: "parabola", spec: PLOT_SPEC, summary: "抛物线" },
  });
});

test("a file marker places the card at the prose position", async ({ page, request }) => {
  await freshSession(page);
  await markerBetweenSentences(page, request, {
    kind: "file",
    cardTestId: "file-card",
    toolName: "write_file",
    handle: "src/main.rs",
    callArgs: { path: "src/main.rs", content: "fn main() {\n}\n" },
  });
});

test("a marker shows a pending slot before the tool runs", async ({ page, request }) => {
  await freshSession(page);
  await scriptLlm(request, {
    turns: [
      {
        content: "引用前的文字。\n\n[[artifact:diagram/auth-flow]]\n\n引用后的文字。",
        holdMs: 400,
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "auth flow", source: FLOW, summary: "认证流程" },
          },
        ],
      },
      { content: "完成。" },
    ],
  });

  await send(page, "画图");
  await expect(page.getByTestId("artifact-pending")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("diagram-card").last()).toBeVisible({ timeout: 20_000 });
});

test("a marker with no call becomes a dangling slot once the turn settles", async ({
  page,
  request,
}) => {
  await freshSession(page);
  await scriptLlm(request, {
    turns: [
      {
        content: "引用前的文字。\n\n[[artifact:diagram/ghost]]\n\n引用后的文字。",
      },
    ],
  });

  await send(page, "画图");
  await expect(page.getByTestId("artifact-dangling")).toBeVisible({ timeout: 20_000 });
  // The prose around the missing card is still on screen.
  await expect(page.getByText("引用前的文字。", { exact: true })).toBeVisible();
  await expect(page.getByText("引用后的文字。", { exact: true })).toBeVisible();
});

test("a marker whose artifact fails keeps the failure card in place", async ({
  page,
  request,
}) => {
  await freshSession(page);
  await scriptLlm(request, {
    turns: [
      {
        content: "引用前的文字。\n\n[[artifact:diagram/empty]]\n\n引用后的文字。",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "empty", source: "   ", summary: "空" },
          },
        ],
      },
      { content: "完成。" },
    ],
  });

  await send(page, "画空图");
  await expect(page.getByTestId("diagram-failure")).toBeVisible({ timeout: 20_000 });

  const order = await verticalOrder(page, "diagram-card");
  expect(order.before).toBeLessThanOrEqual(order.card);
  expect(order.card).toBeLessThan(order.after);
});
