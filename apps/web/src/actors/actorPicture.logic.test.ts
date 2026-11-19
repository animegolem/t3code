import { describe, expect, it } from "vite-plus/test";

import {
  actorPictureColor,
  actorPictureText,
  defaultPictureSvg,
  imagePictureSvg,
  minuteStart,
  monogramPictureSvg,
  pictureImageUrl,
  selectActors,
  splitActorDock,
} from "./actorPicture.logic";

const NOW = "2026-11-19T12:00:00.000Z";

const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  environmentId: "env-a",
  projectId: "project-1",
  title: id,
  createdAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: "root" },
  pinnedAt: "2026-11-02T00:00:00.000Z",
  pinOrderKey: null,
  settledOverride: null,
  snoozedUntil: null,
  ...overrides,
});

const select = (threads: ReadonlyArray<ReturnType<typeof thread>>) =>
  selectActors({
    threads: threads as never,
    delegatedUnderParent: new Set(),
    loadedEnvironmentIds: new Set(["env-a", "env-b"]),
    now: NOW,
  }).map((actor) => `${actor.environmentId}:${actor.id}`);

describe("selectActors", () => {
  it("keeps pinned threads from every environment and drops the ones upstream does not list as pinned", () => {
    expect(
      select([
        thread("pinned", { pinOrderKey: "a1" }),
        thread("other-machine", { environmentId: "env-b", pinOrderKey: "a0" }),
        thread("unpinned", { pinnedAt: null }),
        thread("archived", { archivedAt: NOW }),
        thread("settled", { settledOverride: "settled" }),
        thread("snoozed", { snoozedUntil: "2026-11-20T00:00:00.000Z" }),
        thread("woken", { snoozedUntil: "2026-11-18T00:00:00.000Z", pinOrderKey: "a2" }),
        thread("subagent", {
          lineage: {
            rootThreadId: "pinned",
            parentThreadId: "pinned",
            relationshipToParent: "subagent",
          },
        }),
      ]),
    ).toEqual(["env-b:other-machine", "env-a:pinned", "env-a:woken"]);
  });
});

describe("minuteStart", () => {
  it("turns the minute clock into an instant the snooze check can parse as UTC", () => {
    expect(new Date(minuteStart("2026-11-19T12:00")).toISOString()).toBe(NOW);
    // Just after the minute a snooze ends, the thread is an actor again.
    const waking = [thread("waking", { snoozedUntil: "2026-11-19T12:00:00.000Z" })];
    const at = (nowMinute: string) =>
      selectActors({
        threads: waking as never,
        delegatedUnderParent: new Set(),
        loadedEnvironmentIds: new Set(["env-a"]),
        now: minuteStart(nowMinute),
      }).length;
    expect(at("2026-11-19T11:59")).toBe(0);
    expect(at("2026-11-19T12:00")).toBe(1);
  });
});

describe("splitActorDock", () => {
  const actors = Array.from({ length: 23 }, (_, index) => index);

  it("shows every actor when they fit", () => {
    expect(splitActorDock(actors.slice(0, 20), () => false)).toEqual({
      shown: actors.slice(0, 20),
      overflow: [],
    });
  });

  it("puts the actors past the limit behind the overflow entry, dropping none", () => {
    const { shown, overflow } = splitActorDock(actors, () => false);
    expect(shown).toEqual(actors.slice(0, 20));
    expect(overflow).toEqual([20, 21, 22]);
  });

  it("gives the open actor the last place when it would overflow", () => {
    const { shown, overflow } = splitActorDock(actors, (actor) => actor === 21);
    expect(shown).toEqual([...actors.slice(0, 19), 21]);
    expect(overflow).toEqual([19, 20, 22]);
  });
});

describe("pictures", () => {
  it("counts characters the way a person does", () => {
    expect(actorPictureText("  abc ")).toBe("ab");
    expect(actorPictureText("👩‍🚀🦊x")).toBe("👩‍🚀🦊");
    expect(actorPictureText("")).toBe("");
  });

  it("escapes what it puts in an SVG", () => {
    const svg = monogramPictureSvg("<&", '"><script>');
    expect(svg).toContain("&lt;&amp;</text>");
    expect(svg).toContain('fill="&quot;&gt;&lt;script&gt;"');
    expect(svg).not.toContain("<script>");
  });

  it("wraps only an image it can vouch for", () => {
    expect(imagePictureSvg("data:image/png;base64,iVBORw0KGgo=")).toContain(
      '<image href="data:image/png;base64,iVBORw0KGgo="',
    );
    expect(imagePictureSvg('data:image/png;base64,AAAA"/><script>')).toBeNull();
    expect(imagePictureSvg("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(imagePictureSvg("https://example.com/a.png")).toBeNull();
    expect(imagePictureSvg(`data:image/png;base64,${"A".repeat(128 * 1024)}`)).toBeNull();
  });

  it("gives a thread the same default picture through a rename of another thread", () => {
    expect(actorPictureColor("thread-1")).toBe(actorPictureColor("thread-1"));
    expect(defaultPictureSvg({ id: "thread-1", title: "Release notes" })).toBe(
      monogramPictureSvg("RN", actorPictureColor("thread-1").background),
    );
  });

  it("makes an image URL that survives any SVG text", () => {
    const svg = monogramPictureSvg("é#", "#2563eb");
    expect(decodeURIComponent(pictureImageUrl(svg).split(",")[1] ?? "")).toBe(svg);
  });
});
