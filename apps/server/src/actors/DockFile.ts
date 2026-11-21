import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import {
  ACTOR_PICTURE_MAX_BYTES,
  ACTOR_PICTURES_FOLDER,
  isActorPictureSvg,
} from "./ActorPictures.ts";
import { KDL_MAX_BYTES, type KdlNode, parseKdl } from "./dockKdl.ts";

const ACTOR_DOCK_ROUTE = "/api/actor-dock";
export const DOCK_FILE_NAME = "dock.kdl";
/** The dock draws 20 pictures; a file with more Rex actors than this is a mistake. */
export const DOCK_FILE_MAX_REX_ACTORS = 32;
const TEXT_MAX_LENGTH = 256;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** A name is part of a URL and a key in the dock, so it is kept to characters that need no escaping. */
const REX_ACTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A picture is a file beside the dock file, never a path. */
const PICTURE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.svg$/;

export interface RexActorEntry {
  readonly name: string;
  readonly title: string;
  /** A Rex session's label, or its ID. */
  readonly session: string;
  /** A block's label or ID. Null means the block the session has focused. */
  readonly block: string | null;
  readonly picture: string | null;
}

export interface DockProblem {
  readonly line: number;
  readonly message: string;
}

export interface Dock {
  readonly rexActors: ReadonlyArray<RexActorEntry>;
  /** Where Rex listens, when the file says. */
  readonly rexSocket: string | null;
  readonly problems: ReadonlyArray<DockProblem>;
}

const EMPTY_DOCK: Dock = { rexActors: [], rexSocket: null, problems: [] };

function oneString(node: KdlNode, problems: Array<DockProblem>): string | null {
  const value = node.args[0];
  if (
    node.args.length !== 1 ||
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TEXT_MAX_LENGTH ||
    Object.keys(node.props).length > 0 ||
    node.children.length > 0
  ) {
    problems.push({
      line: node.line,
      message: `${node.name} takes one quoted value of at most ${TEXT_MAX_LENGTH} characters.`,
    });
    return null;
  }
  return value;
}

/** Turns the dock file's text into the dock. A line it cannot use is reported and skipped. */
export function readDock(text: string): Dock {
  const document = parseKdl(text);
  if (!document.ok) {
    return { ...EMPTY_DOCK, problems: [{ line: document.line, message: document.message }] };
  }
  const problems: Array<DockProblem> = [];
  const rexActors: Array<RexActorEntry> = [];
  let rexSocket: string | null = null;
  for (const node of document.nodes) {
    if (node.name === "rex-socket") {
      rexSocket = oneString(node, problems) ?? rexSocket;
      continue;
    }
    if (node.name !== "rex") {
      problems.push({ line: node.line, message: `${node.name} is not something a dock holds.` });
      continue;
    }
    const name = node.args[0];
    if (node.args.length !== 1 || typeof name !== "string" || !REX_ACTOR_NAME.test(name)) {
      problems.push({
        line: node.line,
        message: 'rex takes one quoted name of letters, digits, ".", "_" and "-", at most 64 long.',
      });
      continue;
    }
    if (rexActors.some((actor) => actor.name === name)) {
      problems.push({ line: node.line, message: `${name} is already in the dock.` });
      continue;
    }
    const fields: Record<"session" | "block" | "title" | "picture", string | null> = {
      session: null,
      block: null,
      title: null,
      picture: null,
    };
    for (const child of node.children) {
      if (!Object.hasOwn(fields, child.name)) {
        problems.push({
          line: child.line,
          message: `${child.name} is not something a rex actor has.`,
        });
        continue;
      }
      fields[child.name as keyof typeof fields] = oneString(child, problems);
    }
    if (fields.picture !== null && !PICTURE_FILE_NAME.test(fields.picture)) {
      problems.push({
        line: node.line,
        message: `${name}'s picture must be the name of an .svg file beside this file, not a path.`,
      });
      fields.picture = null;
    }
    if (Object.keys(node.props).length > 0) {
      problems.push({ line: node.line, message: `${name}'s settings go inside its { } block.` });
    }
    if (rexActors.length >= DOCK_FILE_MAX_REX_ACTORS) {
      problems.push({
        line: node.line,
        message: `The dock file holds at most ${DOCK_FILE_MAX_REX_ACTORS} rex actors.`,
      });
      continue;
    }
    rexActors.push({
      name,
      title: fields.title ?? name,
      // An actor with no session named shows the session labelled as the actor is.
      session: fields.session ?? name,
      block: fields.block,
      picture: fields.picture,
    });
  }
  return { rexActors, rexSocket, problems };
}

/** A missing file is an empty dock. The server only ever reads the file. */
export const loadDock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, ACTOR_PICTURES_FOLDER, DOCK_FILE_NAME);
  const size = yield* fs.stat(file).pipe(
    Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
    Effect.orElseSucceed(() => null),
  );
  if (size === null) return EMPTY_DOCK;
  if (size > KDL_MAX_BYTES) {
    return {
      ...EMPTY_DOCK,
      problems: [{ line: 1, message: `The file is larger than ${KDL_MAX_BYTES} bytes.` }],
    };
  }
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  if (text === null) {
    return { ...EMPTY_DOCK, problems: [{ line: 1, message: "The file could not be read." }] };
  }
  return readDock(text);
});

const readPicture = Effect.fnUntraced(function* (fileName: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, ACTOR_PICTURES_FOLDER, fileName);
  const size = yield* fs.stat(file).pipe(
    Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
    Effect.orElseSucceed(() => null),
  );
  if (size === null || size === 0 || size > ACTOR_PICTURE_MAX_BYTES) return null;
  const svg = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  return svg !== null && isActorPictureSvg(svg) ? svg : null;
});

const handleRead = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const dock = yield* loadDock;
  const rex: Array<{ readonly name: string; readonly title: string; readonly svg: string | null }> =
    [];
  for (const actor of dock.rexActors) {
    rex.push({
      name: actor.name,
      title: actor.title,
      svg: actor.picture === null ? null : yield* readPicture(actor.picture),
    });
  }
  // The client is told which actors exist, not which Rex sessions they name.
  return yield* HttpServerResponse.json({ rex, problems: dock.problems }, { headers: NO_STORE });
});

export const layer = HttpRouter.add("GET", ACTOR_DOCK_ROUTE, handleRead);
