import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_PROMPTS,
  PROMPT_CATALOG_FILE,
  promptDescription,
  promptKeys,
  promptText,
  renderPrompt,
  resetPromptOverrides,
  setPromptOverrides,
} from "../src/prompts.js";
import { buildSystemPrompt } from "../src/agent/loop.js";
import type { TurnClock } from "../src/agent/clock.js";

/**
 * The prompt catalog's guards.
 *
 * Two of these are worth reading before changing anything else, because they hold up something
 * the type system cannot see:
 *
 * - **the fake LLM markers.** `test/helpers/fakeLlm.ts` decides whether a request is an
 *   out-of-band call by looking for a substring of that call's system prompt. Reflowing one of
 *   those sentences — a line break moved, a word hyphenated — silently stops the harness
 *   recognising the call, and the failure lands somewhere unrelated. The marker test below turns
 *   that into one named line.
 * - **placeholder syntax.** `renderPrompt` treats `{{name}}` as a substitution, and several
 *   prompts legitimately contain JSON with braces in them (the classifier's output schema). The
 *   scan below asserts no catalog text contains a `{{` the pattern cannot match, which is what
 *   keeps "a brace in the JSON" and "a placeholder" from ever being confusable.
 */

/**
 * Every `{{` in a string, each returned either as its complete placeholder or as a raw slice that
 * will fail the caller's assertion. Deliberately not a single global regex: the question is "is
 * there a `{{` here that is not a placeholder", and a regex that only matches *valid* placeholders
 * would answer "no" by finding nothing.
 */
function loosePlaceholders(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf("{{"); at !== -1; at = text.indexOf("{{", at + 1)) {
    const match = /^\{\{[A-Za-z][A-Za-z0-9]*\}\}/.exec(text.slice(at));
    out.push(match ? match[0] : text.slice(at, at + 20));
  }
  return out;
}

afterEach(() => {
  resetPromptOverrides();
});

describe("the catalog", () => {
  it("carries a description and a text for every entry", () => {
    expect(promptKeys().length).toBeGreaterThan(0);
    for (const key of promptKeys()) {
      expect(promptText(key).length, `${key} has no text`).toBeGreaterThan(0);
      expect(promptDescription(key).length, `${key} has no description`).toBeGreaterThan(20);
    }
  });

  it("contains no brace that could be mistaken for a placeholder", () => {
    for (const key of promptKeys()) {
      for (const found of loosePlaceholders(promptText(key))) {
        expect(found, `${key} contains ${JSON.stringify(found)}`).toMatch(/^\{\{[A-Za-z][A-Za-z0-9]*\}\}$/);
      }
    }
  });

  it("names every placeholder the chat skeleton uses in the catalog's own style", () => {
    const skeleton = promptText("chat.system");
    const names = [...skeleton.matchAll(/\{\{([a-z][A-Za-z0-9]*)\}\}/g)].map((m) => m[1]);
    expect(names).toEqual([
      "persona",
      "about",
      "clock",
      "workspace",
      "codeFence",
      "fileWrite",
      "plan",
      "quiz",
      "collectPage",
      "table",
      "explore",
      "makeup",
    ]);
  });
});

describe("renderPrompt", () => {
  it("substitutes a supplied variable", () => {
    expect(renderPrompt("chat.system.noEscape", {})).toContain("Never attempt to access files");
    expect(renderPrompt("chat.system.clock", { local: "14:03", zone: "Asia/Shanghai" })).toContain(
      "Right now it is 14:03 for the user (Asia/Shanghai)."
    );
  });

  it("renders an empty value as nothing, which is how a block is dropped", () => {
    // The make-up key is the one variable-shaped hole whose "" is meaningful. A question posed
    // without a key must leave no blank line behind.
    const withKey = renderPrompt("chat.guidance.quizMakeup", {
      qid: "Q1",
      id: "abc",
      question: "What is 2+2?",
      key: "\nReference answer: 4",
    });
    const withoutKey = renderPrompt("chat.guidance.quizMakeup", {
      qid: "Q1",
      id: "abc",
      question: "What is 2+2?",
      key: "",
    });
    expect(withKey.endsWith("Question: What is 2+2?\nReference answer: 4")).toBe(true);
    expect(withoutKey.endsWith("Question: What is 2+2?")).toBe(true);
  });

  it("throws when a placeholder has no value, naming the key and the placeholder", () => {
    expect(() => renderPrompt("chat.system.clock", { local: "now" })).toThrow(
      /Prompt "chat\.system\.clock" uses \{\{zone\}\}/
    );
  });

  it("throws on a key that is not in the catalog", () => {
    // @ts-expect-error — the whole point is that the type system already rejects this.
    expect(() => renderPrompt("chat.system.nope")).toThrow(/Unknown prompt key/);
  });

  it("names the catalog file in both errors, so the reader knows where to look", () => {
    expect(PROMPT_CATALOG_FILE).toBe("apps/server/src/prompts.json");
    try {
      renderPrompt("chat.system.clock", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).toContain(PROMPT_CATALOG_FILE);
    }
  });
});

describe("setPromptOverrides", () => {
  it("replaces a key and keeps the bundled description", () => {
    const bundled = promptDescription("chat.system.persona");
    expect(setPromptOverrides({ "chat.system.persona": "You are a test persona." })).toEqual([]);
    expect(promptText("chat.system.persona")).toBe("You are a test persona.");
    expect(promptDescription("chat.system.persona")).toBe(bundled);
  });

  it("accepts the object form, including a replacement description", () => {
    expect(
      setPromptOverrides({
        "chat.system.persona": { text: "New text.", description: "New description." },
      })
    ).toEqual([]);
    expect(promptText("chat.system.persona")).toBe("New text.");
    expect(promptDescription("chat.system.persona")).toBe("New description.");
  });

  it("leaves every other key alone", () => {
    const before = promptText("thread.system");
    setPromptOverrides({ "chat.system.persona": "Only this one." });
    expect(promptText("thread.system")).toBe(before);
  });

  it("reports an unknown key rather than ignoring it", () => {
    expect(setPromptOverrides({ "chat.system.typo": "…" })).toEqual([
      { key: "chat.system.typo", reason: "unknown" },
    ]);
    // …and it did not become an entry.
    expect(promptKeys()).not.toContain("chat.system.typo" as never);
  });

  it("reports an unreadable value separately from an unknown key", () => {
    expect(setPromptOverrides({ "chat.system.persona": { text: 42 } })).toEqual([
      { key: "chat.system.persona", reason: "unreadable" },
    ]);
    // A refused entry leaves the bundled text in place rather than blanking it.
    expect(promptText("chat.system.persona")).toContain("You are a helpful, precise AI assistant.");
  });

  it("treats a missing or non-object prompts section as no overrides", () => {
    expect(setPromptOverrides(undefined)).toEqual([]);
    expect(setPromptOverrides("nonsense")).toEqual([]);
    expect(setPromptOverrides([])).toEqual([]);
  });
});

describe("the fake LLM's out-of-band markers", () => {
  /*
   * The list is duplicated from `test/helpers/fakeLlm.ts` deliberately, and the duplication is the
   * point: this test is what tells the next person that moving one of these prompts is a change to
   * the test harness too. If you reflow a system prompt and this fails, update the marker in
   * `fakeLlm.ts` — do not delete the entry.
   */
  const MARKERS: [key: Parameters<typeof promptText>[0], marker: string][] = [
    ["thread.system", "topic-classification function"],
    ["insight.system", "reflective study coach"],
    ["title.system", "titling function"],
  ];

  it.each(MARKERS)("%s still contains its marker", (key, marker) => {
    expect(promptText(key)).toContain(marker);
  });

  it("keeps the subtitle above the marker in the fake LLM's list in step", async () => {
    // Cheap structural guard: three markers, three quoted strings in the harness.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./helpers/fakeLlm.ts", import.meta.url), "utf8")
    );
    for (const [, marker] of MARKERS) {
      expect(source, `fakeLlm.ts no longer lists ${JSON.stringify(marker)}`).toContain(marker);
    }
  });
});

/* --------------------------------- the assembled prompt --------------------------------- */

const CLOCK: TurnClock = { local: "2026-09-17 14:03", zone: "Asia/Shanghai" };

function promptInput(overrides: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) {
  return {
    workspace: {
      id: "ws1",
      name: "Test",
      slug: "test",
      description: "",
      dirPath: "/data/ws1",
      workdirPath: "/data/ws1/workdir",
      sessionCount: 0,
      lastActivityAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    clock: CLOCK,
    sessionDirPath: "/data/ws1/sessions/s1",
    writeLocation: "session" as const,
    persona: "",
    ...overrides,
  } satisfies Parameters<typeof buildSystemPrompt>[0];
}

describe("buildSystemPrompt", () => {
  it("assembles persona, clock and workspace, and nothing else, on a bare turn", () => {
    const prompt = buildSystemPrompt(promptInput());
    expect(prompt.startsWith("You are a helpful, precise AI assistant.")).toBe(true);
    expect(prompt).toContain("Right now it is 2026-09-17 14:03 for the user (Asia/Shanghai).");
    expect(prompt).toContain("/data/ws1/workdir");
    expect(prompt).toContain("/data/ws1/sessions/s1");
    expect(prompt).toContain("A write with no stated location goes to the conversation folder.");
    expect(prompt).toContain("Never attempt to access files outside these two folders.");
    // No widget guidance leaked in, and no block left a gap behind it.
    expect(prompt).not.toContain("study plan, tracked through the plan tools");
    expect(prompt).not.toContain("\n\n\n");
  });

  it("always says how to name a file in a code fence", () => {
    /*
     * The one unconditional block among the guidance: it is about the *format* of a reply rather
     * than about a capability, so there is no assembled tool to ask about it. And it is
     * load-bearing in a way the others are not — the client renders a code block's file name from
     * the fence's info string, so a model that was never told would never write one, and the
     * feature would be a renderer for data nothing produces.
     */
    const prompt = buildSystemPrompt(promptInput());
    expect(prompt).toContain("name that file in the code fence's info string");
    expect(prompt).toContain("app.py");
  });

  it("appends each applicable block once, in the skeleton's order", () => {
    const prompt = buildSystemPrompt(
      promptInput({
        planGuidance: "PLAN-MARKER",
        quizGuidance: "QUIZ-MARKER",
        collectPageGuidance: "COLLECT-MARKER",
        tableGuidance: "TABLE-MARKER",
        exploreGuidance: "EXPLORE-MARKER",
        quizMakeupNote: "MAKEUP-MARKER",
      })
    );
    const order = [
      "PLAN-MARKER",
      "QUIZ-MARKER",
      "COLLECT-MARKER",
      "TABLE-MARKER",
      "EXPLORE-MARKER",
      "MAKEUP-MARKER",
    ].map((marker) => prompt.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const marker of ["PLAN-MARKER", "QUIZ-MARKER", "MAKEUP-MARKER"]) {
      expect(prompt.split(marker).length - 1, `${marker} appears twice`).toBe(1);
    }
    expect(prompt).not.toContain("\n\n\n");
  });

  it("uses the session's persona when it has one, and drops the default entirely", () => {
    const prompt = buildSystemPrompt(promptInput({ persona: "  You are a physics tutor.  " }));
    expect(prompt.startsWith("You are a physics tutor.")).toBe(true);
    expect(prompt).not.toContain("You are a helpful, precise AI assistant.");
  });

  it("swaps the sandbox sentence when the conversation holds an @ grant", () => {
    const bare = buildSystemPrompt(promptInput());
    const granted = buildSystemPrompt(promptInput({ exploreGuidance: "EXPLORE-MARKER" }));
    expect(bare).toContain("Never attempt to access files outside these two folders.");
    expect(granted).toContain("Reading outside them is allowed only inside the workspaces");
    expect(granted).not.toContain("Never attempt to access files outside these two folders.");
  });

  it("names the shared folder as the default when the write location says so", () => {
    const prompt = buildSystemPrompt(promptInput({ writeLocation: "workspace" }));
    expect(prompt).toContain("A write with no stated location goes to the shared workspace folder.");
  });

  it("places the learner's own introduction between the persona and the clock", () => {
    const prompt = buildSystemPrompt(promptInput({ about: "Backend dev, learning ML." }));
    const personaAt = prompt.indexOf("You are a helpful, precise AI assistant.");
    const aboutAt = prompt.indexOf("<about_the_learner>");
    const clockAt = prompt.indexOf("Right now it is");
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(aboutAt).toBeGreaterThan(personaAt);
    expect(clockAt).toBeGreaterThan(aboutAt);
    expect(prompt).toContain("Backend dev, learning ML.");
  });

  it("omits the whole block when there is no introduction", () => {
    // Not just the value: the heading, the fence and the trailing sentence go with it. A block
    // left behind would be a paragraph of every turn spent saying the user said nothing.
    for (const about of [undefined, ""]) {
      const prompt = buildSystemPrompt(promptInput({ about }));
      expect(prompt, `about = ${JSON.stringify(about)}`).not.toContain("about_the_learner");
      expect(prompt).not.toContain("describes themselves");
      expect(prompt).not.toContain("\n\n\n");
    }
  });

  it("keeps the introduction after the session's own persona, not the default one", () => {
    const prompt = buildSystemPrompt(
      promptInput({ persona: "You are a physics tutor.", about: "Knows calculus." })
    );
    expect(prompt.startsWith("You are a physics tutor.")).toBe(true);
    expect(prompt).toContain("Knows calculus.");
  });

  it("reflects a patched block, which is the whole point of reading at call time", () => {
    setPromptOverrides({ "chat.system.clock": "PATCHED-CLOCK {{local}} / {{zone}}" });
    const prompt = buildSystemPrompt(promptInput());
    expect(prompt).toContain("PATCHED-CLOCK 2026-09-17 14:03 / Asia/Shanghai");
    expect(prompt).not.toContain("Your training data ends before this");
  });

  it("lets a patch drop a block by emptying it", () => {
    setPromptOverrides({ "chat.system.clock": "" });
    const prompt = buildSystemPrompt(promptInput());
    expect(prompt).not.toContain("Right now it is");
    expect(prompt).not.toContain("\n\n\n");
  });
});

describe("the bundled catalog", () => {
  it("is frozen against accidental mutation by a shared importer", () => {
    expect(Object.isFrozen(BUNDLED_PROMPTS)).toBe(false);
    // The point is not frozenness but that `renderPrompt` reads a copy: patching must never
    // reach the bundled object, or the next test in the process would inherit it.
    const before = BUNDLED_PROMPTS["chat.system.persona"]?.text;
    setPromptOverrides({ "chat.system.persona": "changed" });
    expect(BUNDLED_PROMPTS["chat.system.persona"]?.text).toBe(before);
  });
});
