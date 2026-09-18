import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AppDb } from "../db.js";
import { captureWebPage, type PageCache } from "../webCapture.js";
import type { UserLayout } from "../paths.js";
import { renderPrompt } from "../prompts.js";

/**
 * `ila_collect_page` — keeping a page the agent read, as a **source**.
 *
 * `web_fetch` stays a pure read: it hands back text and forgets it, which is right for the
 * dozens of pages a search-and-sk skim touches and wrong for the one the conversation then
 * builds on. This is the second half, and the separation is the feature — the requirement asks
 * for "only the pages finally confirmed relevant to the conversation", and the only thing that
 * can confirm relevance is the model that read them. So it has to *ask*, deliberately, once per
 * page worth keeping.
 *
 * A captured page is a source like any other: it gets an id, it can be referenced with `@`, it
 * shows in the browser, and the parse pipeline's text is stored in the one `parsed/` tree. What
 * makes it a page is `storage: "web"` plus its `url` and the model's `summary` — the one thing
 * the bytes cannot say.
 *
 * ### Why a per-turn cache
 *
 * A model that fetches a page and then decides to keep it has already paid for those bytes. The
 * cache is keyed by the *final* URL of a fetch this turn, so collecting what was just read
 * costs no second request — and a page the model never fetched is fetched once, here, through
 * the same guard.
 */

export interface CollectPageContext {
  db: AppDb;
  user: UserLayout;
  userId: string;
  /** The conversation this page belongs to — a captured page is held by the turn that kept it. */
  sessionId: string;
  /** The workspace it is in, so the page is readable from that workspace's other conversations. */
  workspaceId: string;
}

export type { PageCache };

/**
 * Appended to the system prompt on any turn where `ila_collect_page` is in the tool set.
 *
 * Model input, so deliberately English and untranslated, the same discipline `planGuidance`
 * and `quizGuidance` follow. **It exists because nothing else in the prompt mentions the
 * tool.** The description below is a *restriction* — "do this only for pages this conversation
 * is actually about" — and a model that was never told to keep anything reads a restriction as
 * "usually do not", so an implemented feature behaved as if it were not there. Telling the
 * model when to keep is the whole of the fix; the tool, the wiring and the storage were already
 * right, which is why this is a prompt string and not a code path.
 *
 * The conditionals are `buildTools`'s, not this entry's: `routes.ts` appends it by asking
 * whether the tool survived assembly, so a Copilot restricted to a list without it is never
 * given guidance for a call it could not make.
 *
 * The guidance lives in the catalog (`chat.guidance.collectPage`) so it can be tuned without a
 * rebuild.
 *
 * A function rather than a constant, and that is load-bearing: the catalog is patched by the
 * process entry point (`<dataRoot>/config.patch.json`), which runs *after* every module has been
 * evaluated. A module-level constant would be the bundled text forever, so a tuned prompt would
 * silently do nothing.
 */
export function collectPageGuidance(): string {
  return renderPrompt("chat.guidance.collectPage");
}

/**
 * `cache` is supplied by `buildTools` rather than by the caller: it is the *turn's* cache, and
 * the turn is what `buildTools` assembles. Requiring it here would make every caller build one
 * — and two callers building two caches is a page downloaded twice, silently.
 */
export function buildCollectPageTool(ctx: CollectPageContext & { cache: PageCache }) {
  return tool(
    async ({ url, summary }) => {
      const row = await captureWebPage(ctx.db, {
        user: ctx.user,
        userId: ctx.userId,
        owner: { kind: "session", id: ctx.sessionId },
        workspaceId: ctx.workspaceId,
        url,
        summary,
        cache: ctx.cache,
      });

      return (
        `Kept "${row.title}" (id ${row.id}). ` +
        `It is now part of this conversation: it can be read with read_document, listed in the ` +
        `library, and referenced again without fetching it a second time.`
      );
    },
    {
      name: "ila_collect_page",
      description:
        "Keep a web page you have read, so the conversation can refer to it later. The page " +
        "is fetched (or reused if you already fetched it this turn), its readable text is " +
        `stored, and you give it a one-line summary of what it says — the summary is what ` +
        "everything else will be shown. Do this only for pages this conversation is actually " +
        "about; a page you merely skimmed should stay a web_fetch.",
      schema: z.object({
        url: z.string().describe("The absolute http(s) URL of the page to keep."),
        summary: z
          .string()
          .min(1)
          .max(300)
          .describe(
            "One line, in the conversation's language, saying what this page is and why it " +
              "matters here. This is what the source list shows."
          ),
      }),
    }
  );
}
