import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  ACTOR_PICTURE_MAX_BYTES,
  ACTOR_PICTURES_FOLDER,
  actorPictureFileName,
  isActorPictureSvg,
  readActorPictures,
  writeActorPicture,
} from "./ActorPictures.ts";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';

const layer = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-actor-pictures-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("ActorPictures", (it) => {
  it.effect("names a picture file so that no thread ID can leave the folder", () =>
    Effect.sync(() => {
      assert.strictEqual(
        actorPictureFileName("6d3fdd6e-10f8-480f-8fcc-0eba240b3474"),
        "6d3fdd6e-10f8-480f-8fcc-0eba240b3474.svg",
      );
      assert.strictEqual(actorPictureFileName("../../etc/passwd"), "..%2F..%2Fetc%2Fpasswd.svg");
      assert.strictEqual(actorPictureFileName("a\\b:c%d"), "a%5Cb%3Ac%25d.svg");
      assert.strictEqual(actorPictureFileName(".."), "...svg");
      assert.strictEqual(
        actorPictureFileName("it's (a) ~test*!"),
        "it%27s%20%28a%29%20%7Etest%2A%21.svg",
      );
      assert.strictEqual(actorPictureFileName(""), null);
      assert.strictEqual(actorPictureFileName("\uD800"), null);
      assert.strictEqual(actorPictureFileName("x".repeat(252)), null);
      assert.strictEqual(actorPictureFileName("x".repeat(251)), `${"x".repeat(251)}.svg`);
      assert.strictEqual(actorPictureFileName("é".repeat(42)), null);
    }),
  );

  it.effect("accepts only an SVG document within the size cap", () =>
    Effect.sync(() => {
      assert.isTrue(isActorPictureSvg(SVG));
      assert.isTrue(isActorPictureSvg(`<?xml version="1.0"?>\n<!-- made by hand -->\n${SVG}`));
      assert.isFalse(isActorPictureSvg(""));
      assert.isFalse(isActorPictureSvg("<html><svg></svg></html>"));
      assert.isFalse(isActorPictureSvg('{"kind":"monogram"}'));
      assert.isFalse(isActorPictureSvg(`<svg>${"x".repeat(ACTOR_PICTURE_MAX_BYTES)}</svg>`));
    }),
  );

  it.effect("writes, reads back, and clears a picture", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const folder = path.join(config.stateDir, ACTOR_PICTURES_FOLDER);
      const threadId = "thread:delegated/one";
      const fileName = actorPictureFileName(threadId)!;

      assert.deepEqual(yield* readActorPictures([threadId]), []);
      assert.strictEqual(yield* writeActorPicture(fileName, SVG), "written");
      assert.deepEqual(yield* fs.readDirectory(folder), [fileName]);
      assert.deepEqual(yield* readActorPictures(["absent", threadId]), [{ threadId, svg: SVG }]);

      assert.strictEqual(yield* writeActorPicture(fileName, ""), "cleared");
      assert.strictEqual(yield* writeActorPicture(fileName, ""), "cleared");
      assert.deepEqual(yield* readActorPictures([threadId]), []);
    }),
  );

  it.effect("reads a hand-edited file that is not a usable picture as absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const folder = path.join(config.stateDir, ACTOR_PICTURES_FOLDER);
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "not-svg.svg"), "hello");
      yield* fs.writeFileString(
        path.join(folder, "too-big.svg"),
        `<svg>${"x".repeat(ACTOR_PICTURE_MAX_BYTES)}</svg>`,
      );
      yield* fs.makeDirectory(path.join(folder, "a-folder.svg"));
      yield* fs.writeFileString(path.join(folder, "good.svg"), SVG);

      assert.deepEqual(yield* readActorPictures(["not-svg", "too-big", "a-folder", "good"]), [
        { threadId: "good", svg: SVG },
      ]);
      assert.strictEqual(yield* fs.readFileString(path.join(folder, "not-svg.svg")), "hello");
    }),
  );
});
