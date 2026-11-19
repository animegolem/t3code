import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { runPromise, test, WEB } from "./t3.ts";

// In-app navigation percent-encodes the colon in a thread ID; a link opened directly does not.
const endsWithThread = (threadId: string) => new RegExp(`${threadId.split(":").at(-1)}$`);

/** Longer than the dock keeps a dropped order on screen by itself, so what shows afterwards is the server's order. */
const PAST_THE_HOLD_MS = 5000;
const DRAG_STEPS = 8;

test(
  "A dragged actor keeps its new place in the dock",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const first = await t3.thread({ project, title: "Alpha lead", messages: ["first"] });
    await t3.thread({ project, title: "Beta scout", messages: ["first"] });
    const last = await t3.thread({ project, title: "Gamma clerk", messages: ["first"] });
    await t3.open(first);

    const tiles = screen.getByTestId("actor-tile");
    const pin = async (title: string) => {
      const actions = screen.getByRole("button", `Thread actions for ${title}`);
      await expect(actions).toBeVisible();
      await actions.tap();
      await screen.getByRole("menuitem", "Pin thread").tap();
    };
    await pin("Alpha lead");
    await expect(tiles).toHaveCount(1);
    await screen.getByRole("button", "Beta scout, Done, demo").tap();
    await pin("Beta scout");
    await expect(tiles).toHaveCount(2);
    await screen.getByRole("button", "Gamma clerk, Done, demo").tap();
    await pin("Gamma clerk");
    await expect(tiles).toHaveCount(3);
    await expect(browser).toHaveURL(endsWithThread(last.threadId));

    const dock = () =>
      browser.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="actor-tile"]'), (tile) => {
          const rect = tile.getBoundingClientRect();
          return {
            title: tile.getAttribute("aria-label") ?? "",
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
          };
        }),
      );
    const before = await dock();
    const titles = before.map((tile) => tile.title);
    expect(titles.toSorted()).toEqual(["Alpha lead", "Beta scout", "Gamma clerk"]);
    await app.screenshot("three-actors");

    // A newly pinned thread goes first, so the open thread's picture is first and the last picture is
    // another thread's. Drag that last one to the front: if letting go counted as a click, the URL would change.
    expect(titles[0]).toBe("Gamma clerk");
    const from = before[2]!;
    const to = before[0]!;
    const opened = await browser.evaluate(() => window.location.pathname);
    await browser.mouse.move(from.x, from.y);
    await browser.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      await browser.mouse.move(
        from.x + ((to.x - to.width / 4 - from.x) * step) / DRAG_STEPS,
        from.y + ((to.y - from.y) * step) / DRAG_STEPS,
      );
    }
    await app.screenshot("mid-drag");
    await browser.mouse.up();

    const moved = [titles[2], titles[0], titles[1]];
    await expect.poll(async () => (await dock()).map((tile) => tile.title)).toEqual(moved);
    // Letting go of a drag is not a click on the picture.
    expect(await browser.evaluate(() => window.location.pathname)).toBe(opened);
    await app.screenshot("after-drop");

    // The order still shows once the dock has stopped holding it, so it is the order the server saved.
    await runPromise(Effect.sleep(PAST_THE_HOLD_MS));
    expect((await dock()).map((tile) => tile.title)).toEqual(moved);

    // A second drag starts from the saved order: bring the middle picture back to the front.
    const again = await dock();
    await browser.mouse.move(again[1]!.x, again[1]!.y);
    await browser.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      await browser.mouse.move(
        again[1]!.x + ((again[0]!.x - again[0]!.width / 4 - again[1]!.x) * step) / DRAG_STEPS,
        again[1]!.y,
      );
    }
    await browser.mouse.up();
    const movedAgain = [moved[1], moved[0], moved[2]];
    await expect.poll(async () => (await dock()).map((tile) => tile.title)).toEqual(movedAgain);
    await runPromise(Effect.sleep(PAST_THE_HOLD_MS));
    expect((await dock()).map((tile) => tile.title)).toEqual(movedAgain);
    await app.screenshot("after-second-drop");
  },
);
