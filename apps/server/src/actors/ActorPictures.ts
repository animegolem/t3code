import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import { requestUrl } from "../requestUrl.ts";

const ACTOR_PICTURES_ROUTE = "/api/actor-pictures";
export const ACTOR_PICTURES_FOLDER = "actors";
export const ACTOR_PICTURE_MAX_BYTES = 128 * 1024;
const ACTOR_PICTURES_MAX_PER_READ = 24;
const ACTOR_PICTURES_MAX_FILES = 4096;

const FILE_SUFFIX = ".svg";
const THREAD_ID_MAX_LENGTH = 512;
// Most filesystems cap one name at 255 bytes; an encoded name is ASCII.
const FILE_NAME_MAX_LENGTH = 255;
const SVG_START =
  /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** A thread ID is an unrestricted string, so it never reaches the disk as written. */
export function actorPictureFileName(threadId: string): string | null {
  if (threadId.length === 0 || threadId.length > THREAD_ID_MAX_LENGTH) return null;
  let encoded: string;
  try {
    encoded = encodeURIComponent(threadId).replace(
      /[!'()*~]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    // A lone surrogate has no UTF-8 form.
    return null;
  }
  const fileName = `${encoded}${FILE_SUFFIX}`;
  return fileName.length > FILE_NAME_MAX_LENGTH ? null : fileName;
}

export function isActorPictureSvg(text: string): boolean {
  return (
    text.length > 0 &&
    new TextEncoder().encode(text).byteLength <= ACTOR_PICTURE_MAX_BYTES &&
    SVG_START.test(text)
  );
}

const text = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: NO_STORE });

export const readActorPictures = Effect.fnUntraced(function* (threadIds: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const folder = path.join(config.stateDir, ACTOR_PICTURES_FOLDER);
  const pictures: Array<{ readonly threadId: string; readonly svg: string }> = [];
  for (const threadId of threadIds) {
    const fileName = actorPictureFileName(threadId);
    if (fileName === null) continue;
    const file = path.join(folder, fileName);
    // A hand-edited file can be any size or shape; one that fails a check reads as absent.
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
      Effect.orElseSucceed(() => null),
    );
    if (size === null || size === 0 || size > ACTOR_PICTURE_MAX_BYTES) continue;
    const svg = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
    if (svg === null || !isActorPictureSvg(svg)) continue;
    pictures.push({ threadId, svg });
  }
  return pictures;
});

export const writeActorPicture = Effect.fnUntraced(function* (fileName: string, svg: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const folder = path.join(config.stateDir, ACTOR_PICTURES_FOLDER);
  const file = path.join(folder, fileName);
  if (svg.length === 0) {
    yield* fs.remove(file, { force: true });
    return "cleared" as const;
  }
  yield* fs.makeDirectory(folder, { recursive: true });
  if (!(yield* fs.exists(file))) {
    // Pictures outlive their threads, so the folder is capped instead of trusted to stay small.
    const names = yield* fs.readDirectory(folder);
    if (names.length >= ACTOR_PICTURES_MAX_FILES) return "full" as const;
  }
  // A reader never sees a half-written picture.
  yield* writeFileStringAtomically({ filePath: file, contents: svg });
  return "written" as const;
});

const handleRead = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return text(400, "Bad Request");
  const threadIds = url.value.searchParams.getAll("thread");
  if (threadIds.length > ACTOR_PICTURES_MAX_PER_READ) {
    return text(400, `At most ${ACTOR_PICTURES_MAX_PER_READ} threads per request.`);
  }
  const pictures = yield* readActorPictures(threadIds);
  return yield* HttpServerResponse.json({ pictures }, { headers: NO_STORE });
});

const handleWrite = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return text(400, "Bad Request");
  const fileName = actorPictureFileName(url.value.searchParams.get("thread") ?? "");
  if (fileName === null) return text(400, "A thread is required.");
  // A declared length over the cap is refused before reading; chunked bodies hit the reader cap.
  if (Number(request.headers["content-length"] ?? "0") > ACTOR_PICTURE_MAX_BYTES) {
    return text(413, "The picture is too large.");
  }
  const body = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(ACTOR_PICTURE_MAX_BYTES)),
    Effect.option,
  );
  if (Option.isNone(body)) return text(413, "The picture is too large or unreadable.");
  if (body.value.length > 0 && !isActorPictureSvg(body.value)) {
    return text(400, "The picture must be an SVG document.");
  }
  const outcome = yield* writeActorPicture(fileName, body.value).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to store an actor picture.", { cause }).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );
  if (outcome === "full") return text(507, "The picture folder is full.");
  if (outcome === "failed") return text(500, "Internal Server Error");
  return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
});

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", ACTOR_PICTURES_ROUTE, handleRead),
  HttpRouter.add("POST", ACTOR_PICTURES_ROUTE, handleWrite),
);
