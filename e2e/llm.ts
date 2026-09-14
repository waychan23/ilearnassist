import { expect, type APIRequestContext } from "@playwright/test";

/**
 * The scriptable fake LLM the Playwright harness starts (see `playwright.config.ts` and
 * `apps/server/test/helpers/fakeLlm.ts`). Shared by the specs that need the model to say
 * something specific: `chat.spec.ts` scripts a conversation, and `theme.spec.ts` needs a
 * reply containing code to check the code palette against.
 */

export const FAKE_LLM = `http://127.0.0.1:${process.env.ILA_FAKE_LLM_PORT ?? 3898}`;

/**
 * Discard anything a previous test scripted, and queue the turns for the next one.
 * `matches` body-keys non-streaming replies (the auto-titler and the thread classifier both
 * POST those): first entry whose `includes` substring is in the request body wins.
 */
export async function scriptLlm(
  request: APIRequestContext,
  body: {
    turns: unknown[];
    title?: string;
    matches?: Array<{ includes: string; content: string }>;
  },
): Promise<void> {
  await request.post(`${FAKE_LLM}/__reset`);
  const res = await request.post(`${FAKE_LLM}/__script`, { data: body });
  expect(res.ok()).toBe(true);
}
