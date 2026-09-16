import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@ilearnassist/shared";
import {
  DEFAULT_WRITE_LOCATION,
  parseWriteLocation,
  resolveWriteLocation,
} from "../src/writeLocation.js";
import { newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Where an unqualified write goes, and which level decides it.
 *
 * The chain has four levels and exists because the question is genuinely the user's: a file
 * that belongs to a conversation and a file the whole workspace is about are different things,
 * and a model cannot tell them apart from the text of a request. Three of the four levels are
 * settings a person chose; the fourth is what happens when none of them did.
 */

describe("resolveWriteLocation", () => {
  it("falls back to the built-in default when nobody has an opinion", () => {
    expect(resolveWriteLocation({})).toBe(DEFAULT_WRITE_LOCATION);
    // `session` is the product decision, not an accident of ordering: a workspace directory
    // every conversation writes into is a junk drawer nobody organised.
    expect(DEFAULT_WRITE_LOCATION).toBe("session");
  });

  it("reads the nearest level that said something", () => {
    expect(resolveWriteLocation({ workspace: { writeLocation: "workspace" } })).toBe("workspace");
    expect(
      resolveWriteLocation({
        session: { writeLocation: "session" },
        workspace: { writeLocation: "workspace" },
      })
    ).toBe("session");
    expect(
      resolveWriteLocation({
        request: "workspace",
        session: { writeLocation: "session" },
        workspace: { writeLocation: "session" },
      })
    ).toBe("workspace");
  });

  it("treats null and an absent field alike", () => {
    // `null` is "inherit", which is what a settings object with a cleared field holds.
    expect(resolveWriteLocation({ session: { writeLocation: null } })).toBe(DEFAULT_WRITE_LOCATION);
    expect(resolveWriteLocation({ session: {} })).toBe(DEFAULT_WRITE_LOCATION);
    expect(
      resolveWriteLocation({ session: { writeLocation: null }, workspace: { writeLocation: "workspace" } })
    ).toBe("workspace");
  });

  it("refuses a value that is not a location rather than coercing it", () => {
    // A stored `"true"` is a caller that has misunderstood something, and a value silently
    // treated as "no opinion" looks exactly like a setting that had no effect.
    expect(parseWriteLocation("everywhere")).toBeNull();
    expect(parseWriteLocation("")).toBeNull();
    expect(parseWriteLocation(undefined)).toBeNull();
    expect(parseWriteLocation(true)).toBeNull();
    expect(parseWriteLocation("workspace")).toBe("workspace");
  });
});

/**
 * The same chain, through the real thing.
 *
 * `resolveWriteLocation` is only half the claim — the other half is that a conversation
 * *carries* the resolved answer, and that the three levels reach it in the right order at the
 * moment the conversation is created. That is a route's job, so this asks the route.
 */
describe("the chain at session creation", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await startTestServer();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function writeLocationOf(session: Session): Promise<string | undefined> {
    const sessions = (
      await env.inject({ method: "GET", url: `/api/workspaces/${session.workspaceId}/sessions` })
    ).json<Session[]>();
    return sessions.find((s) => s.id === session.id)!.settings.writeLocation ?? undefined;
  }

  it("copies the workspace's default into a new conversation", async () => {
    const workspace = await newWorkspace(env, "Study");
    await env.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { settings: { writeLocation: "workspace" } },
    });

    const session = (
      await env.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/sessions`,
        payload: {},
      })
    ).json<Session>();

    expect(await writeLocationOf(session)).toBe("workspace");
  });

  it("lets the request override the workspace", async () => {
    const workspace = await newWorkspace(env, "Study");
    await env.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { settings: { writeLocation: "workspace" } },
    });

    const session = (
      await env.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/sessions`,
        payload: { settings: { writeLocation: "session" } },
      })
    ).json<Session>();

    expect(await writeLocationOf(session)).toBe("session");
  });

  it("leaves the field unset when no level has an opinion", async () => {
    // Absent rather than written as the default: the stored value is "what somebody chose",
    // and materialising the built-in default into every conversation would make a later change
    // to the default unable to reach the conversations that never chose anything.
    const workspace = await newWorkspace(env, "Study");
    const session = (
      await env.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/sessions`,
        payload: {},
      })
    ).json<Session>();

    expect(await writeLocationOf(session)).toBeUndefined();
  });

  it("survives a generation-parameter save", async () => {
    /*
     * The settings dialog writes all seven generation parameters at once, and the session's
     * settings are *merged* rather than replaced — which is what keeps a field the dialog does
     * not draw. Worth a test rather than a reading, because the day that merge becomes an
     * assignment the write location silently resets to the workspace default on every save.
     */
    const workspace = await newWorkspace(env, "Study");
    const session = (
      await env.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/sessions`,
        payload: { settings: { writeLocation: "workspace" } },
      })
    ).json<Session>();

    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { temperature: 0.5, maxSteps: 20 } },
    });

    expect(await writeLocationOf(session)).toBe("workspace");
  });
});
