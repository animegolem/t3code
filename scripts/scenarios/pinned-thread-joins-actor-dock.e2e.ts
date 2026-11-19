import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const storedPictures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = (yield* Path.Path).join(T3_HOME, "userdata/actors");
  const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
  return yield* Effect.forEach(
    names.filter((name) => name.endsWith(".svg")),
    (name) => Effect.map(fs.readFileString(`${folder}/${name}`), (svg) => ({ name, svg }) as const),
  );
});

// In-app navigation percent-encodes the colon in a thread ID; a link opened directly does not.
const endsWithThread = (threadId: string) => new RegExp(`${threadId.split(":").at(-1)}$`);

const overwritePicture = Effect.fn("scenario.overwritePicture")(function* (
  fileName: string,
  svg: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const folder = (yield* Path.Path).join(T3_HOME, "userdata/actors");
  yield* fs.writeFileString(`${folder}/${fileName}`, svg);
});

test(
  "A pinned thread joins the actor dock and takes the picture set from its menu",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Release captain", messages: ["first"] });
    const other = await t3.thread({ project, title: "Scratch notes", messages: ["first"] });
    const elsewhere = await t3.project("elsewhere");
    await t3.thread({ project: elsewhere, title: "Side quest", messages: ["first"] });
    await t3.open(thread);
    const tile = screen.getByTestId("actor-tile");
    const actions = screen.getByRole("button", "Thread actions for Release captain");
    await expect(actions).toBeVisible();
    await expect(tile).toHaveCount(0);
    await app.screenshot("before-pin");

    await actions.tap();
    await screen.getByRole("menuitem", "Pin thread").tap();
    await expect(tile).toHaveCount(1);
    await expect(tile).toHaveAttribute("aria-current", "page");
    await app.screenshot("pinned-default-picture");

    await actions.tap();
    await screen.getByRole("menuitem", "Set picture…").tap();
    await screen.getByLabel("Letters").fill("🦊");
    await screen.getByRole("button", "Green").tap();
    await app.screenshot("picture-dialog");
    await screen.getByRole("button", "Save picture").tap();
    await expect(screen.getByRole("button", "Save picture")).toHaveCount(0);
    // The tile shows the saved picture: a fox, URL-encoded in the image's source.
    await expect(
      browser.locator('[data-testid="actor-tile"] img[src*="%F0%9F%A6%8A"]'),
    ).toHaveCount(1);
    await app.screenshot("picture-set");

    const pictures = await runPromise(storedPictures);
    // A thread ID holds characters a file name must not, so the name is percent-encoded.
    const fileName = `${thread.threadId.replaceAll(":", "%3A")}.svg`;
    expect(pictures.map((picture) => picture.name)).toEqual([fileName]);
    expect(pictures[0]?.svg).toContain("🦊");
    expect(pictures[0]?.svg).toContain("#15803d");

    // An agent sets its own picture by writing the file; the window re-reads pictures on focus.
    await runPromise(
      overwritePicture(
        fileName,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#123456"/></svg>',
      ),
    );
    await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(browser.locator('[data-testid="actor-tile"] img[src*="%23123456"]')).toHaveCount(
      1,
    );
    await app.screenshot("picture-written-by-agent");

    // The pinned thread has no row; the other two threads do.
    const rows = screen.getByTestId("sidebar-row-card");
    await expect(rows).toHaveCount(2);
    await screen.getByRole("button", "Scratch notes, Done, demo").tap();
    await expect(browser).toHaveURL(endsWithThread(other.threadId));
    await expect(tile).not.toHaveAttribute("aria-current", "page");

    // The dock is the way back to an actor from any other thread.
    await tile.tap();
    await expect(browser).toHaveURL(endsWithThread(thread.threadId));
    await expect(tile).toHaveAttribute("aria-current", "page");

    // Opening an actor from outside the project filter leaves the filter as the person set it.
    await screen.getByRole("combobox", "Filter threads by project").tap();
    await screen.getByRole("option", "elsewhere").tap();
    await expect(rows).toHaveCount(1);
    await app.screenshot("filtered-to-another-project");
    await screen.getByRole("button", "Side quest, Done, elsewhere").tap();
    await tile.tap();
    await expect(browser).toHaveURL(endsWithThread(thread.threadId));
    await expect(rows).toHaveCount(1);
    await app.screenshot("actor-opened-filter-kept");

    // A right-click on the picture opens the thread's own menu.
    await browser.evaluate(
      () =>
        document.querySelector('[data-testid="actor-tile"]')?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 30,
            clientY: 130,
          }),
        ) ?? false,
    );
    await expect(screen.getByRole("menuitem", "Unpin thread")).toBeVisible();
    await expect(screen.getByRole("menuitem", "Set picture…")).toBeVisible();
    await app.screenshot("picture-menu");
  },
);
