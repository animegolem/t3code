// Needs a Rex server on this machine and the `rex` command. It creates one Rex session, labelled
// with a random suffix, and kills that session when it ends. It touches no other session.
// @effect-diagnostics nodeBuiltinImport:off -- the scenario drives the rex command line.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const REX_TIMEOUT_MS = 10_000;
const rex = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("rex", args, { encoding: "utf8", timeout: REX_TIMEOUT_MS });
const terminalCall = (session: string, method: string, args: object): unknown =>
  JSON.parse(rex("block", "call", "--session", session, method, JSON.stringify(args)));
const screenText = (session: string) =>
  String(
    (terminalCall(session, "format", { format: "text", trim: true }) as { content?: unknown })
      .content,
  );

const writeDockFile = Effect.fn("scenario.writeDockFile")(function* (text: string) {
  const fs = yield* FileSystem.FileSystem;
  const folder = (yield* Path.Path).join(T3_HOME, "userdata/actors");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(`${folder}/dock.kdl`, text);
});

test(
  "A Rex actor's picture opens its terminal beside the sidebar",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const session = `t3-scenario-${NodeCrypto.randomUUID().slice(0, 8)}`;
    rex("session", "new", session);
    try {
      // A marker that is on the screen before T3 Code ever connects.
      terminalCall(session, "write", { data: "clear; echo BEFORE-$((6*7))\n" });
      await expect.poll(() => screenText(session)).toContain("BEFORE-42");
      const before = terminalCall(session, "size", {}) as { columns: number; owner: unknown };
      expect(before.owner).toBeNull();

      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Release captain", messages: ["first"] });
      await runPromise(
        writeDockFile(
          [
            "// Agents that still live in Rex.",
            'rex "scenario" {',
            `    session "${session}"`,
            '    title "Scenario shell"',
            "}",
            "",
          ].join("\n"),
        ),
      );
      await t3.open(thread);

      // The dock file is read when the window gains focus, as pictures are.
      const tile = screen.getByTestId("rex-actor-tile");
      await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(tile).toHaveCount(1);
      await expect(screen.getByRole("button", "Scenario shell, in Rex")).toBeVisible();
      await app.screenshot("rex-actor-in-dock");

      await tile.tap();
      await expect(browser).toHaveURL(/\/rex\/[^/]+\/scenario$/);
      await expect(tile).toHaveAttribute("aria-current", "page");
      const terminal = screen.getByTestId("rex-terminal");
      await expect(terminal).toHaveAttribute("data-rex-terminal-state", "live");
      // The sidebar is still there: the thread's row and the dock.
      await expect(screen.getByTestId("actor-dock")).toBeVisible();
      await expect(screen.getByTestId("sidebar-row-card")).toHaveCount(1);
      await app.screenshot("rex-terminal-open");

      // T3 Code took the terminal and gave it the size of its own pane.
      const taken = terminalCall(session, "size", {}) as { columns: number; owner: unknown };
      expect(typeof taken.owner).toBe("string");
      expect(taken.columns).not.toBe(before.columns);

      // Typing in T3 Code reaches the program in Rex.
      await screen.getByLabel("Terminal input").focus();
      await browser.keyboard.type("echo TYPED-$((6*7))");
      await browser.keyboard.press("Enter");
      await expect.poll(() => screenText(session)).toContain("TYPED-42");

      // Output that Rex's program writes afterwards is drawn: the canvas changes.
      const canvas = () =>
        browser.evaluate(() => {
          const element = document.querySelector<HTMLCanvasElement>(
            '[data-testid="rex-terminal"] canvas',
          );
          return element?.toDataURL() ?? "";
        });
      const quiet = await canvas();
      terminalCall(session, "write", { data: "printf '\\033[41m  LIVE-FROM-REX  \\033[0m\\n'\n" });
      await expect.poll(canvas).not.toBe(quiet);
      await app.screenshot("rex-terminal-after-output");

      // Leaving for a thread and coming back opens the terminal again, with what was written.
      await screen.getByTestId("sidebar-row-card").tap();
      await expect(terminal).toHaveCount(0);
      await tile.tap();
      await expect(terminal).toHaveAttribute("data-rex-terminal-state", "live");
      await app.screenshot("rex-terminal-reopened");

      // An actor whose session is not there says so and stops: nothing to try again for.
      const dockFile = (lines: ReadonlyArray<string>) =>
        runPromise(writeDockFile([...lines, ""].join("\n")));
      const status = screen.getByTestId("rex-terminal-status");
      const reload = () => browser.evaluate(() => window.dispatchEvent(new Event("focus")));
      await dockFile([
        `rex "scenario" {\n    session "${session}"\n}`,
        `rex "absent" {\n    session "${session}-absent"\n}`,
      ]);
      await reload();
      await screen.getByRole("button", "absent, in Rex").tap();
      await expect(status).toContainText(`Rex has no session called ${session}-absent.`);
      await expect(screen.getByRole("button", "Open again")).toBeVisible();
      await expect(screen.getByText("Trying again…")).toHaveCount(0);
      await app.screenshot("rex-session-absent");

      // With Rex unreachable the window says so, tries again by itself, and then offers a button.
      const nowhere = `/tmp/${session}-no-rex.sock`;
      await dockFile([`rex-socket "${nowhere}"`, `rex "scenario" {\n    session "${session}"\n}`]);
      await reload();
      await screen.getByRole("button", "scenario, in Rex").tap();
      await expect(status).toContainText("Rex could not be reached. Is its server running?");
      await expect(screen.getByText("Trying again…")).toBeVisible();
      await expect(screen.getByRole("button", "Open again")).toBeVisible({ timeout: 20_000 });
      await app.screenshot("rex-unreachable");

      // The server is still up: with Rex back in its place, the button opens the terminal.
      await dockFile([`rex "scenario" {\n    session "${session}"\n}`]);
      await screen.getByRole("button", "Open again").tap();
      await expect(terminal).toHaveAttribute("data-rex-terminal-state", "live");

      // A dock file that cannot be read says so in the dock, with the line.
      await runPromise(writeDockFile('rex "scenario"\nrex unquoted\n'));
      await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
      await screen.getByTestId("dock-file-problems").tap();
      await expect(screen.getByText("Line 2: Put unquoted in quotes.")).toBeVisible();
      await app.screenshot("dock-file-problem");
    } finally {
      rex("session", "kill", session);
    }
  },
);
