// Serves one Rex terminal to one viewer over a WebSocket. A terminal is a shell on this machine,
// so the route asks for the terminal scope and ends with the viewer's session.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { Agent, WebSocket } from "undici";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { requestUrl } from "../requestUrl.ts";
import { loadDock } from "./DockFile.ts";
import {
  REX_VIEWER_CLOSE_GONE,
  REX_VIEWER_CLOSE_LOST,
  type RexConnect,
  RexTerminalBridge,
} from "./RexTerminalBridge.ts";

const REX_TERMINAL_ROUTE = "/api/rex-terminal";
/** Each open terminal holds two connections to Rex. */
const REX_TERMINALS_MAX_OPEN = 16;
/** A viewer this far behind is dropped instead of being buffered for. */
const VIEWER_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** How long a viewer has to answer a close before its connection is cut. */
const VIEWER_CLOSE_GRACE = "2 seconds";

let openTerminals = 0;

/** Where Rex's server listens on macOS, below the home folder. Elsewhere the dock file has to say. */
const MACOS_REX_SOCKET = ["Library", "Application Support", "rex", "server.sock"];

function rexConnect(agent: Agent): RexConnect {
  return (path, protocol) => {
    // The host is ignored: the agent sends every connection to Rex's Unix socket.
    const socket = new WebSocket(`ws://localhost${path}`, {
      protocols: [protocol],
      dispatcher: agent,
    });
    return {
      get binaryType() {
        return socket.binaryType;
      },
      set binaryType(value) {
        socket.binaryType = value === "arraybuffer" ? "arraybuffer" : "blob";
      },
      addEventListener: (type, listener) =>
        socket.addEventListener(type, (event) =>
          listener({
            data: "data" in event ? event.data : undefined,
            code: "code" in event && typeof event.code === "number" ? event.code : undefined,
            reason:
              "reason" in event && typeof event.reason === "string" ? event.reason : undefined,
          }),
        ),
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };
  };
}

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const name = Option.getOrUndefined(requestUrl(request))?.searchParams.get("actor") ?? "";
  if (request.headers.upgrade?.toLowerCase() !== "websocket" || name.length === 0) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const session = yield* authenticateMediaRequest(AuthTerminalOperateScope);
  const sessions = yield* SessionStore.SessionStore;
  // The viewer names an actor. Which Rex session that is comes from the dock file alone.
  const dock = yield* loadDock;
  const actor = dock.rexActors.find((entry) => entry.name === name);
  const path = yield* Path.Path;
  const socketPath =
    dock.rexSocket ??
    ((yield* HostProcess.Platform) === "darwin"
      ? path.join(yield* HostProcess.HomeDirectory, ...MACOS_REX_SOCKET)
      : null);
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;

  const serve = Effect.gen(function* () {
    const client = yield* request.upgrade;
    const reader = yield* client.reader;
    const writer = yield* client.writer;
    // A refused upgrade reads as a failed sign-in to a client that came with a ticket, so every
    // refusal from here on is a message and a close code on the open socket.
    const refuse = (code: number, message: string) =>
      writer
        .write(JSON.stringify({ type: "error", message }))
        .pipe(Effect.andThen(writer.write(new Socket.CloseEvent(code, message.slice(0, 120)))));
    if (actor === undefined) {
      return yield* refuse(REX_VIEWER_CLOSE_GONE, `The dock file has no rex actor called ${name}.`);
    }
    if (socketPath === null) {
      return yield* refuse(
        REX_VIEWER_CLOSE_GONE,
        'Say where Rex listens with a rex-socket "/path" line in the dock file.',
      );
    }
    if (openTerminals >= REX_TERMINALS_MAX_OPEN) {
      return yield* refuse(
        REX_VIEWER_CLOSE_LOST,
        `${REX_TERMINALS_MAX_OPEN} Rex terminals are already open from this T3 Code.`,
      );
    }
    openTerminals += 1;
    const agent = new Agent({ connect: { socketPath } });
    const outgoing = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>();
    const bridge = new RexTerminalBridge({
      target: actor,
      connect: rexConnect(agent),
      viewer: {
        send: (frame) => void Queue.offerUnsafe(outgoing, frame),
        close: (code, reason) =>
          void Queue.offerUnsafe(outgoing, new Socket.CloseEvent(code, reason)),
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        openTerminals -= 1;
        bridge.dispose();
        void agent.destroy();
      }),
    );
    const send = Queue.take(outgoing).pipe(
      Effect.flatMap((frame) => {
        if (Socket.isCloseEvent(frame)) {
          // The viewer reads the reason and the close code, then closes its side, which ends the
          // read loop. Cutting the connection at once would drop both before they are sent.
          return writer
            .write(frame)
            .pipe(
              Effect.andThen(Effect.sleep(VIEWER_CLOSE_GRACE)),
              Effect.andThen(Effect.interrupt),
            );
        }
        return transport.writableLength > VIEWER_MAX_BUFFER_BYTES
          ? Effect.interrupt
          : writer.write(frame);
      }),
    );
    const decoder = new TextDecoder();
    const receive = reader.pull.pipe(
      Effect.map((frames) => {
        for (const frame of frames) {
          bridge.viewerMessage(typeof frame === "string" ? frame : decoder.decode(frame));
        }
      }),
    );
    return yield* Effect.raceFirst(Effect.forever(send), Effect.forever(receive)).pipe(
      Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
    );
  }).pipe(Effect.scoped);

  yield* Effect.raceFirst(
    serve,
    sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

export const layer = HttpRouter.add("GET", REX_TERMINAL_ROUTE, handler);
