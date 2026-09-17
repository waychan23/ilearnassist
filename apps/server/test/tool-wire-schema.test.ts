import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { ProviderDef } from "../src/config.js";
import { EXPLORE_KINDS, PLAN_TOOL_NAMES, QUERY_KINDS } from "@ilearnassist/shared";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Every tool's schema, as it goes out on the wire.
 *
 * This file exists because a tool shipped that could not be sent at all. `ila_query`'s parameters
 * were a `z.discriminatedUnion`, which converts to `{"anyOf": […], "type": null}` — and a strict
 * OpenAI-compatible endpoint refuses a function schema that is not `type: "object"`. The result
 * was a 400 on **every turn** in any conversation where the tool was available, whether or not it
 * was called, with a message about a JSON Schema rather than about anything a user did.
 *
 * Nothing caught it. The type system cannot see the conversion; the handler's own tests call
 * `invoke()` on a parsed object and never touch the request; and the fake LLM happily accepts any
 * schema, because it does not validate one. So the guard has to be here — one real chat turn,
 * then a look at the exact `tools` array the provider was sent. It is deliberately generic rather
 * than a test of `ila_query`: the next tool with a clever zod shape is the one this is for.
 */

let llm: FakeLlm;
let env: TestEnv;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
  env = await startTestServer({
    providers: [provider],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Wire schema");
});

/**
 * One ordinary turn, answered with **the request that carried the tool list**.
 *
 * Selected by `tools` rather than taken as the last one: the auto-titler also POSTs, right after
 * the turn, and its request is a plain completion with no tools at all. `at(-1)` silently returns
 * that one — which is how this file's first version asserted nothing about any tool.
 *
 * It is also scoped to *this* turn by the request count before it. A plain `find` returns the
 * file's first tool-carrying request, so a case that sends two turns and compares them would be
 * handed the same list twice and pass while asserting nothing — which is what made the two-turn
 * case below read as a failure.
 *
 * `workspaceScope`, when given, is stored on the conversation before the turn. That is the only
 * way `ila_explore` is assembled at all, so without it the tool would get *no* wire coverage —
 * which is precisely the hole this file exists to close.
 */
async function sendOneTurn(workspaceScope?: unknown): Promise<Record<string, unknown>> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  const session = await newSession(env, workspace.id);

  if (workspaceScope !== undefined) {
    const patched = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { workspaceScope } },
    });
    expect(patched.statusCode).toBe(200);
  }

  const before = llm.requests().length;
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/chat`,
    payload: { message: "你好" },
  });
  expect(res.statusCode).toBe(200);

  const request = llm.requests().slice(before).find((r) => Array.isArray(r.tools));
  expect(request, "a turn should have sent a tool list").toBeDefined();
  return request!;
}

interface WireTool {
  type?: string;
  function?: { name?: string; parameters?: Record<string, unknown> };
}

function sentTools(request: Record<string, unknown>): WireTool[] {
  const tools = request.tools;
  expect(Array.isArray(tools), "the turn should have sent a tool list").toBe(true);
  return tools as WireTool[];
}

describe("the tools a provider is sent", () => {
  it("gives every function an object-typed parameters schema", async () => {
    /*
     * The rule this whole file is for. `type` must be present and `"object"` — an absent or null
     * `type` is exactly what the endpoint rejected, and it is what a zod union, a `z.record`, or
     * a bare `z.array` at the top level produces.
     */
    const tools = sentTools(await sendOneTurn());
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const name = tool.function?.name ?? "(unnamed)";
      expect(tool.function?.parameters, name).toBeDefined();
      expect(tool.function?.parameters?.type, name).toBe("object");
      // And no `anyOf` at the top level, which is what a union looks like after conversion and
      // what turns into `type: null` when a validator has to pick a branch.
      expect(tool.function?.parameters, name).not.toHaveProperty("anyOf");
    }
  });

  it("sends the object-typed schema for ila_query in particular", async () => {
    // Named on purpose even though the case above covers every tool: this is the tool that
    // shipped broken, and a future reader deserves to find it by name. It is also the only tool
    // whose shape is a discriminated set of kinds, which is what made it the one at risk.
    const query = sentTools(await sendOneTurn()).find((t) => t.function?.name === "ila_query");
    expect(query, "ila_query should be offered in an ordinary conversation").toBeDefined();

    const parameters = query!.function!.parameters!;
    expect(parameters.type).toBe("object");
    const properties = parameters.properties as Record<string, { enum?: string[] }>;
    // The `kind` discriminator, still a real enum after the union was flattened.
    // Read from the shared list rather than restated: the point of the case is that the
    // discriminator survives as an enum, not that it has five or six members.
    expect(properties.kind?.enum).toEqual([...QUERY_KINDS]);
    expect(parameters.required).toEqual(["kind"]);
  });

  it("names every tool it offers, so a schema-less entry cannot hide", async () => {
    // A tool with no `function.name` would slip past both cases above under "(unnamed)".
    const tools = sentTools(await sendOneTurn());
    expect(tools.every((t) => typeof t.function?.name === "string" && t.function.name.length > 0)).toBe(
      true
    );
  });

  it("offers the plan tools in a conversation with no widget installed", async () => {
    /*
     * The `auto-install` mode's whole premise, asserted where the schemas are checked.
     *
     * Two things are load-bearing here at once. The feature: a plan must be makeable where nobody
     * installed the plan panel, or the capability can never introduce itself. And this file's own
     * rule — a tool assembled only under a condition gets **zero** wire coverage until a case sets
     * that condition up, which is the hole `sendOneTurn(workspaceScope?)` exists to close. These
     * three are the ones most at risk of the trap below, because `planTreeInputSchema` carries the
     * only recursive (`z.lazy`) shape any tool sends: its top-level `type` would go missing the
     * same way a union's does.
     */
    const names = sentTools(await sendOneTurn()).map((t) => t.function?.name);
    expect(names).toEqual(expect.arrayContaining([...PLAN_TOOL_NAMES]));
  });

  it("offers ila_table, whose schema is a flat object like the rest", async () => {
    /*
     * The context-gated tool this file's docblock warns about, covered from the start rather than
     * after the first 400: its schema is written by hand in the flat shape (`name` / `table` /
     * `summary`), which is exactly the shape a later "tidy-up" into a discriminated union would
     * break — see the `ila_query` case below for what that costs in production.
     *
     * Asserted through a real turn rather than by calling `buildTools`, because the conversion the
     * provider rejects happens in the request the loop builds.
     */
    const tools = sentTools(await sendOneTurn());
    const table = tools.find((t) => t.function?.name === "ila_table");
    expect(table).toBeDefined();
    expect(table?.function?.parameters).toMatchObject({ type: "object" });
    expect(table?.function?.parameters).not.toHaveProperty("anyOf");
  });

  it("offers ila_explore only once the conversation holds an `@` grant", async () => {
    // The gate is the grant, the `read_document` rule: a tool that could only refuse is one the
    // model wastes a step discovering. Asserted in both directions, because "never assembled"
    // would pass a one-sided test and is the same failure.
    const bare = sentTools(await sendOneTurn()).map((t) => t.function?.name);
    expect(bare).not.toContain("ila_explore");

    const scoped = sentTools(await sendOneTurn({ all: true })).map((t) => t.function?.name);
    expect(scoped).toContain("ila_explore");
  });

  it("sends the object-typed schema for ila_explore in particular", async () => {
    // The tool most at risk of the `ila_query` trap by shape: five kinds over one flat object.
    // The case above covers it generically; this names it, the way `ila_query`'s does.
    const tool = sentTools(await sendOneTurn({ all: true })).find(
      (t) => t.function?.name === "ila_explore"
    );
    expect(tool, "ila_explore should be offered once a grant exists").toBeDefined();

    const parameters = tool!.function!.parameters!;
    expect(parameters.type).toBe("object");
    expect(parameters).not.toHaveProperty("anyOf");
    const properties = parameters.properties as Record<string, { enum?: string[] }>;
    // Read from the shared list rather than restated: the point is that the discriminator
    // survives as an enum, not that it has five members today.
    expect(properties.kind?.enum).toEqual([...EXPLORE_KINDS]);
    expect(parameters.required).toEqual(["kind"]);
  });
});

describe("the trap this file exists for", () => {
  it("is that a union converts to no top-level type at all", () => {
    /*
     * The failure mode in one line, asserted rather than described, so the next person
     * contemplating a `z.discriminatedUnion` for a tool's parameters can see what happens to it:
     * the conversion yields `anyOf` and **no `type`**, which a strict endpoint reports as
     * `type: null` and refuses. It is not that a union is invalid JSON Schema — it is that a
     * function's parameters must be an object, and a union of objects is not one.
     */
    const union = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }).strict(),
      z.object({ kind: z.literal("b") }).strict(),
    ]);
    const converted = toJsonSchema(union) as Record<string, unknown>;

    expect(converted.type).toBeUndefined();
    expect(converted).toHaveProperty("anyOf");
    // The counterpart, so this reads as "flatten it" rather than "never use zod": the flat object
    // carrying the same discriminator as an enum converts to exactly what is required.
    const flat = toJsonSchema(z.object({ kind: z.enum(["a", "b"]) })) as Record<string, unknown>;
    expect(flat.type).toBe("object");
    expect(flat).not.toHaveProperty("anyOf");
  });
});
