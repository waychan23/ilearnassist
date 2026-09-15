import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { ProviderDef } from "../src/config.js";
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
 */
async function sendOneTurn(): Promise<Record<string, unknown>> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  const session = await newSession(env, workspace.id);
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/chat`,
    payload: { message: "你好" },
  });
  expect(res.statusCode).toBe(200);

  const request = llm.requests().find((r) => Array.isArray(r.tools));
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
    expect(properties.kind?.enum).toEqual(["plan", "quiz", "thread", "note", "diagram"]);
    expect(parameters.required).toEqual(["kind"]);
  });

  it("names every tool it offers, so a schema-less entry cannot hide", async () => {
    // A tool with no `function.name` would slip past both cases above under "(unnamed)".
    const tools = sentTools(await sendOneTurn());
    expect(tools.every((t) => typeof t.function?.name === "string" && t.function.name.length > 0)).toBe(
      true
    );
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
