import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, WorkResource } from "@ilearnassist/shared";

/**
 * What a note about an object is about, resolved live.
 *
 * The claims worth pinning are the ones that fail quietly: that a file note costs **one** request
 * rather than three, that a failed lookup degrades to the note's own snapshot instead of throwing
 * into a render, and that a 查看详情 control is absent — not dead — for an object this build
 * cannot draw.
 */

const mocks = vi.hoisted(() => ({
  api: {
    listSessionDiagrams: vi.fn(),
    listSessionTables: vi.fn(),
    listSessionResources: vi.fn(),
  },
}));

vi.mock("../../src/api/client", () => ({
  ...mocks,
  setUnauthenticatedHandler: vi.fn(),
  streamAnswers: vi.fn(),
  streamChat: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
}));

import { useNoteTargets } from "../../src/composables/noteTarget";
import type { FigureViewer } from "../../src/composables/figureViewer";

const SESSION = "s1";

function note(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    sessionId: SESSION,
    messageId: null,
    type: "annotation",
    quote: "",
    occurrence: 0,
    content: "",
    targetKind: "text",
    targetRef: null,
    messageMissing: false,
    targetMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function resource(over: Partial<WorkResource> = {}): WorkResource {
  return {
    id: "wr-7",
    resourceType: "file",
    resourceId: "f-1",
    ownerType: "session",
    ownerId: SESSION,
    title: "handbook.pdf",
    parseStatus: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    resource: {
      id: "f-1",
      userId: "u1",
      path: "users/u/workspaces/w/sessions/s1/handbook.pdf",
      sourceType: "upload",
      size: 10,
      mimeType: "application/pdf",
      title: "handbook.pdf",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  } as WorkResource;
}

/** A viewer whose only job here is to record which figure was asked for. */
function viewer(): FigureViewer["open"] {
  return vi.fn<FigureViewer["open"]>().mockResolvedValue(undefined);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.api.listSessionDiagrams.mockResolvedValue({ diagrams: [] });
  mocks.api.listSessionTables.mockResolvedValue({ tables: [] });
  mocks.api.listSessionResources.mockResolvedValue([]);
});

describe("resolving a note's target", () => {
  it("fetches only the kind the list names", async () => {
    // A file note costs one request, not three — which matters because this runs whenever the
    // notes list changes, on a panel the reader may only be glancing at.
    const open = viewer();
    const targets = useNoteTargets(open);
    await targets.load(SESSION, [
      note({ targetKind: "resource", targetRef: "wr-7", quote: "员工手册" }),
    ]);

    expect(mocks.api.listSessionResources).toHaveBeenCalledWith(SESSION);
    expect(mocks.api.listSessionDiagrams).not.toHaveBeenCalled();
    expect(mocks.api.listSessionTables).not.toHaveBeenCalled();
  });

  it("asks for nothing at all when the list has no object notes", async () => {
    const open = viewer();
    const targets = useNoteTargets(open);
    await targets.load(SESSION, [note({ quote: "一段话" })]);

    expect(mocks.api.listSessionDiagrams).not.toHaveBeenCalled();
    expect(mocks.api.listSessionResources).not.toHaveBeenCalled();
    expect(targets.detailFor(note({ quote: "一段话" }))).toBeNull();
  });

  it("resolves a diagram by its canonical name and opens it through the viewer", async () => {
    mocks.api.listSessionDiagrams.mockResolvedValue({
      diagrams: [
        {
          id: "d1",
          sessionId: SESSION,
          threadId: null,
          threadTitle: null,
          name: "auth-flow.mmd",
          summary: "登录与刷新的时序",
          toolCallId: null,
          fileMissing: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const open = viewer();
    const targets = useNoteTargets(open);
    const about = note({ targetKind: "diagram", targetRef: "auth-flow.mmd" });
    await targets.load(SESSION, [about]);

    const detail = targets.detailFor(about)!;
    expect(detail.summary).toBe("登录与刷新的时序");
    detail.open!();
    expect(open).toHaveBeenCalledWith("diagram", "auth-flow.mmd", "auth-flow.mmd", "登录与刷新的时序");
  });

  it("draws no control for a diagram whose file is gone", async () => {
    // The row is still there, so `targetMissing` is false and the chip is drawn — but opening it
    // would show an empty preview, which is the control-that-does-nothing failure.
    mocks.api.listSessionDiagrams.mockResolvedValue({
      diagrams: [
        {
          id: "d1",
          sessionId: SESSION,
          threadId: null,
          threadTitle: null,
          name: "gone.mmd",
          summary: "",
          toolCallId: null,
          fileMissing: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const open = viewer();
    const targets = useNoteTargets(open);
    const about = note({ targetKind: "diagram", targetRef: "gone.mmd" });
    await targets.load(SESSION, [about]);

    expect(targets.detailFor(about)!.open).toBeNull();
  });

  it("draws no control for a web page, which has no file to preview", async () => {
    mocks.api.listSessionResources.mockResolvedValue([
      resource({ id: "wr-9", resourceType: "web_page", title: "一篇报道" }),
    ]);
    const open = viewer();
    const targets = useNoteTargets(open);
    const about = note({ targetKind: "resource", targetRef: "wr-9" });
    await targets.load(SESSION, [about]);

    const detail = targets.detailFor(about)!;
    expect(detail.title).toBe("一篇报道");
    expect(detail.open).toBeNull();
  });

  it("keys by kind as well as by ref, so a diagram and a table can share a name", async () => {
    mocks.api.listSessionDiagrams.mockResolvedValue({
      diagrams: [
        {
          id: "d1",
          sessionId: SESSION,
          threadId: null,
          threadTitle: null,
          name: "scores",
          summary: "图上的",
          toolCallId: null,
          fileMissing: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mocks.api.listSessionTables.mockResolvedValue({
      tables: [{ name: "scores", summary: "表里的", content: "| a |", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const open = viewer();
    const targets = useNoteTargets(open);
    const asDiagram = note({ targetKind: "diagram", targetRef: "scores" });
    const asTable = note({ targetKind: "table", targetRef: "scores" });
    await targets.load(SESSION, [asDiagram, asTable]);

    expect(targets.detailFor(asDiagram)!.summary).toBe("图上的");
    expect(targets.detailFor(asTable)!.summary).toBe("表里的");
  });

  it("answers null rather than throwing when a lookup fails", async () => {
    // The fallback is the snapshot already in the note, so a failed lookup costs a slightly stale
    // 标注原文 — not an error about a panel the reader was reading happily.
    mocks.api.listSessionResources.mockRejectedValue(new Error("offline"));
    const open = viewer();
    const targets = useNoteTargets(open);
    const about = note({ targetKind: "resource", targetRef: "wr-7" });
    await expect(targets.load(SESSION, [about])).resolves.toBeUndefined();
    expect(targets.detailFor(about)).toBeNull();
  });

  it("reports a target the conversation does not hold as unknown", async () => {
    // The one gap: the server resolves a resource note against the whole account while this
    // looks in the conversation's own union, so a reference held by another workspace misses
    // here — and the chip falls back to the note's snapshot with no control.
    const open = viewer();
    const targets = useNoteTargets(open);
    const about = note({ targetKind: "resource", targetRef: "elsewhere" });
    await targets.load(SESSION, [about]);

    expect(targets.detailFor(about)).toBeNull();
  });
});
