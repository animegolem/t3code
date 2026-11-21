import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ACTOR_PICTURES_FOLDER } from "./ActorPictures.ts";
import { DOCK_FILE_MAX_REX_ACTORS, DOCK_FILE_NAME, loadDock, readDock } from "./DockFile.ts";

const layer = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-dock-file-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("DockFile", (it) => {
  it.effect("reads rex actors in the order the file lists them", () =>
    Effect.sync(() => {
      const dock = readDock(
        [
          "// Agents that still live in Rex.",
          'rex-socket "/tmp/rex.sock"',
          'rex "scout" {',
          '    session "scout-desk"',
          '    block "claude"',
          '    title "Scout"',
          '    picture "scout.svg"',
          "}",
          'rex "clerk"',
        ].join("\n"),
      );
      assert.deepEqual(dock, {
        rexSocket: "/tmp/rex.sock",
        problems: [],
        rexActors: [
          {
            name: "scout",
            title: "Scout",
            session: "scout-desk",
            block: "claude",
            picture: "scout.svg",
          },
          // With nothing else said, an actor shows the session that carries its name.
          { name: "clerk", title: "clerk", session: "clerk", block: null, picture: null },
        ],
      });
    }),
  );

  it.effect("reports a line it cannot use and keeps the rest", () =>
    Effect.sync(() => {
      const dock = readDock(
        [
          'rex "ok"',
          'rex "has space"',
          'rex "ok"',
          'wave "later"',
          'rex "path" { picture "../secrets.svg" }',
          'rex "extra" { colour "red"; session "a" "b" }',
          'rex "flat" session="desk"',
        ].join("\n"),
      );
      assert.deepEqual(
        dock.rexActors.map((actor) => [actor.name, actor.session, actor.picture]),
        [
          ["ok", "ok", null],
          ["path", "path", null],
          ["extra", "extra", null],
          ["flat", "flat", null],
        ],
      );
      assert.deepEqual(
        dock.problems.map((entry) => entry.line),
        [2, 3, 4, 5, 6, 6, 7],
      );
    }),
  );

  it.effect("reports a syntax error with its line and shows no actors", () =>
    Effect.sync(() => {
      assert.deepEqual(readDock('rex "one"\nrex two\n'), {
        rexActors: [],
        rexSocket: null,
        problems: [{ line: 2, message: "Put two in quotes." }],
      });
    }),
  );

  it.effect("holds a bounded number of rex actors", () =>
    Effect.sync(() => {
      const text = Array.from(
        { length: DOCK_FILE_MAX_REX_ACTORS + 2 },
        (_, index) => `rex "a${index}"`,
      ).join("\n");
      const dock = readDock(text);
      assert.strictEqual(dock.rexActors.length, DOCK_FILE_MAX_REX_ACTORS);
      assert.strictEqual(dock.problems.length, 2);
    }),
  );

  it.effect("treats a missing file as an empty dock and reads one that is there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const folder = path.join(config.stateDir, ACTOR_PICTURES_FOLDER);

      assert.deepEqual(yield* loadDock, { rexActors: [], rexSocket: null, problems: [] });
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, DOCK_FILE_NAME), 'rex "scout"\n');
      assert.deepEqual(
        (yield* loadDock).rexActors.map((actor) => actor.name),
        ["scout"],
      );
    }),
  );
});
