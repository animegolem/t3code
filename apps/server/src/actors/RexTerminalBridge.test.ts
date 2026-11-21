import { assert, describe, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import {
  REX_VIEWER_CLOSE_GONE,
  REX_VIEWER_CLOSE_LOST,
  REX_VIEWER_CLOSE_PROTOCOL,
  RexTerminalBridge,
  type RexSocket,
} from "./RexTerminalBridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NONCE = 77n;
const ME = "client:me";
const SESSION = "session:1";
const BLOCK = "block:1";

class FakeSocket implements RexSocket {
  binaryType = "blob";
  closed: { readonly code: number | undefined; readonly reason: string | undefined } | null = null;
  onSend: (data: string | Uint8Array) => void = () => undefined;
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string } = {}) {
    const full = { data: event.data, code: event.code, reason: event.reason };
    for (const listener of this.listeners.get(type) ?? []) listener(full as never);
  }
  send(data: string | Uint8Array) {
    this.onSend(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
}

/** The smallest snapshot: the magic, version 1, and a finish record with no payload. */
function snapshot(): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set(encoder.encode("GHOSTSNP"));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, 6, true);
  return bytes;
}
const sizeMessage = (cols: number, rows: number, owner: string | null) =>
  `\u001b_rex1;${NONCE};${JSON.stringify({ type: "resize", cols, rows, owner })}\u001b\\`;

/** A Rex server that answers from a table, so a test can change one answer. */
class FakeRex {
  readonly calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
  control: FakeSocket | null = null;
  data: FakeSocket | null = null;
  size = { cols: 80, rows: 24 };
  answers: Record<string, (payload: never) => unknown> = {
    "session.list": () => ({
      sessions: [
        { session_id: "session:0", label: "other" },
        { session_id: SESSION, label: "desk" },
      ],
    }),
    "session.attach": () => ({
      client_id: ME,
      view: {
        active_window_id: "window:1",
        windows: [{ window_id: "window:1", focused_block_id: BLOCK }],
      },
    }),
    "session.list_blocks": () => ({
      blocks: [
        { block_id: "block:0", label: "tunnel", creator_name: "com.superlogical.tunnel" },
        {
          block_id: BLOCK,
          label: "claude",
          creator_name: "com.superlogical.terminal",
          placement: "placed",
        },
        {
          block_id: "block:2",
          label: "logs",
          creator_name: "com.superlogical.terminal",
          placement: "placed",
        },
      ],
    }),
    "session.own_block": () => ({ blocks: [{ block_id: BLOCK, owner: ME }] }),
    "data.connect": () => ({
      ticket: Buffer.alloc(16, 5).toString("base64url"),
      expires_in_ms: 60000,
    }),
    "com.superlogical.terminal.resize": (payload: { args: { columns: number; rows: number } }) => {
      this.size = { cols: payload.args.columns, rows: payload.args.rows };
      this.stream(sizeMessage(this.size.cols, this.size.rows, ME));
      return {};
    },
    "com.superlogical.terminal.format": () => ({ content: "SCREEN" }),
    "com.superlogical.terminal.write": () => ({ bytes_written: 1 }),
  };

  readonly connect = (path: "/api/control" | "/api/data"): RexSocket => {
    const socket = new FakeSocket();
    if (path === "/api/control") {
      this.control = socket;
      socket.onSend = (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "hello") {
          return this.later(() =>
            socket.emit("message", {
              data: JSON.stringify({
                type: "welcome",
                protocol: "rex.control.v1",
                client: { id: ME },
              }),
            }),
          );
        }
        this.calls.push({ method: message.method, payload: message.payload });
        const answer = this.answers[message.method];
        this.later(() => {
          let reply: object;
          try {
            if (answer === undefined) throw new Error("method not found");
            reply = { payload: answer(message.payload as never) };
          } catch (error) {
            reply = {
              error: { code: "not_found", message: String((error as Error).message), status: 404 },
            };
          }
          socket.emit("message", {
            data: JSON.stringify({ type: "response", id: message.id, seq: 0, ...reply }),
          });
        });
      };
    } else {
      this.data = socket;
      socket.onSend = (hello) => {
        assert.deepEqual(hello, new Uint8Array([1, ...Buffer.alloc(16, 5)]));
        const welcome = new Uint8Array(32);
        welcome[0] = 0x81;
        new DataView(welcome.buffer).setBigUint64(24, NONCE, true);
        this.later(() => {
          this.frame(welcome);
          this.frame(snapshot());
          this.stream(sizeMessage(this.size.cols, this.size.rows, null));
        });
      };
    }
    this.later(() => socket.emit("open"));
    return socket;
  };

  stream(text: string) {
    this.frame(encoder.encode(text));
  }
  event(type: string, payload: object) {
    this.control?.emit("message", {
      data: JSON.stringify({
        type: "event",
        seq: 1,
        payload: {
          type: "session_event",
          payload: { session_id: SESSION, event: { type, payload } },
        },
      }),
    });
  }
  methods() {
    return this.calls.map((call) => call.method.replace("com.superlogical.terminal.", ""));
  }
  private frame(bytes: Uint8Array) {
    this.data?.emit("message", {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    });
  }
  private later(run: () => void) {
    queueMicrotask(run);
  }
}

function open(
  rex: FakeRex,
  target: { session: string; block: string | null } = { session: "desk", block: null },
) {
  const messages: Array<Record<string, unknown>> = [];
  let output = "";
  let closed: { readonly code: number; readonly reason: string } | null = null;
  const bridge = new RexTerminalBridge({
    target,
    connect: rex.connect,
    viewer: {
      send: (frame) => {
        if (typeof frame === "string") messages.push(JSON.parse(frame));
        else output += decoder.decode(frame);
      },
      close: (code, reason) => {
        closed = { code, reason };
      },
    },
  });
  return {
    bridge,
    messages,
    output: () => output,
    closed: () => closed,
    say: (message: object) => bridge.viewerMessage(JSON.stringify(message)),
  };
}

describe("RexTerminalBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes the focused terminal, sizes it, paints the screen and then follows the output", async () => {
    const rex = new FakeRex();
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(200);

    assert.deepEqual(rex.methods(), [
      "session.list",
      "session.attach",
      "session.list_blocks",
      "session.own_block",
      "data.connect",
      "resize",
      "format",
    ]);
    assert.deepEqual(rex.calls[3]?.payload, {
      session_id: SESSION,
      block_ids: [BLOCK],
      mode: "take",
    });
    assert.deepEqual(viewer.messages, [
      { type: "seed", cols: 100, rows: 30, owned: true, quiet: true, data: "SCREEN" },
    ]);
    // What Rex sent before the screen was read is in the screen, so none of it is drawn again.
    assert.strictEqual(viewer.output(), "");

    rex.stream(`live${sizeMessage(90, 25, "client:other")}more`);
    assert.deepEqual(viewer.messages[1], { type: "size", cols: 90, rows: 25, owned: false });
    assert.include(viewer.output(), "live");
    assert.isTrue(viewer.output().endsWith("more"));
    assert.isNull(viewer.closed());
  });

  it("reads the screen again when output arrives during the read", async () => {
    const rex = new FakeRex();
    let reads = 0;
    rex.answers["com.superlogical.terminal.format"] = () => {
      reads += 1;
      if (reads === 1) rex.stream("racing");
      return { content: `SCREEN-${reads}` };
    };
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(500);

    assert.strictEqual(reads, 2);
    assert.strictEqual(viewer.messages[0]?.data, "SCREEN-2");
    assert.strictEqual(viewer.messages[0]?.quiet, true);
    assert.strictEqual(viewer.output(), "");
  });

  it("draws the output of the last read after its screen when the terminal never pauses", async () => {
    const rex = new FakeRex();
    let reads = 0;
    rex.answers["com.superlogical.terminal.format"] = () => {
      reads += 1;
      rex.stream(`racing-${reads};`);
      return { content: `SCREEN-${reads}` };
    };
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(3000);

    assert.strictEqual(reads, 4);
    assert.strictEqual(viewer.messages[0]?.data, "SCREEN-4");
    assert.strictEqual(viewer.messages[0]?.quiet, false);
    assert.strictEqual(viewer.output(), "racing-4;");
  });

  it("reads a long screen in parts", async () => {
    const rex = new FakeRex();
    rex.answers["com.superlogical.terminal.format"] = () => ({ content: "one,", id: 9 });
    rex.answers["com.superlogical.terminal.blob_read"] = (payload: {
      args: { id: number; offset: number };
    }) =>
      payload.args.offset === 4
        ? { id: 9, data: "two,", eof: false }
        : { id: 9, data: "three", eof: true };
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(200);
    assert.strictEqual(viewer.messages[0]?.data, "one,two,three");
  });

  it("sends typing one call at a time and in order", async () => {
    const rex = new FakeRex();
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 80, rows: 24 });
    viewer.say({ type: "write", data: "early " });
    await vi.advanceTimersByTimeAsync(200);
    viewer.say({ type: "write", data: "a" });
    viewer.say({ type: "write", data: "b" });
    viewer.say({ type: "write", data: "c" });
    viewer.say({ type: "resize", cols: 70, rows: 20 });
    viewer.say({ type: "resize", cols: 60, rows: 20 });
    await vi.advanceTimersByTimeAsync(50);

    const typed = rex.calls
      .filter((call) => call.method.endsWith(".write"))
      .map((call) => (call.payload as { args: { data: string } }).args.data);
    // Typing that arrives while a write is in flight waits for it, and goes in one call.
    assert.deepEqual(typed, ["early ", "a", "bc"]);
    assert.deepEqual(rex.size, { cols: 60, rows: 20 });
  });

  it("names a terminal by its label, and refuses one that is not there", async () => {
    const rex = new FakeRex();
    const logs = open(rex, { session: "desk", block: "logs" });
    logs.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(200);
    assert.deepEqual(rex.calls[3]?.payload, {
      session_id: SESSION,
      block_ids: ["block:2"],
      mode: "take",
    });

    const absent = open(new FakeRex(), { session: "desk", block: "tunnel" });
    absent.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(200);
    assert.strictEqual(absent.closed()?.code, REX_VIEWER_CLOSE_GONE);

    const nowhere = open(new FakeRex(), { session: "elsewhere", block: null });
    nowhere.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(200);
    assert.deepEqual(nowhere.messages, [
      { type: "error", message: "Rex has no session called elsewhere." },
    ]);
    assert.strictEqual(nowhere.closed()?.code, REX_VIEWER_CLOSE_GONE);
  });

  it("closes for good when the terminal closes in Rex, and frees both connections", async () => {
    const rex = new FakeRex();
    const viewer = open(rex);
    viewer.say({ type: "open", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(200);
    rex.event("block_closed", { block_id: "block:2" });
    assert.isNull(viewer.closed());
    rex.event("block_closed", { block_id: BLOCK });
    assert.strictEqual(viewer.closed()?.code, REX_VIEWER_CLOSE_GONE);
    assert.deepEqual(rex.control?.closed, { code: 1000, reason: "done" });
    assert.deepEqual(rex.data?.closed, { code: 1000, reason: "done" });
  });

  it("says that Rex could not be reached when its socket refuses", async () => {
    const socket = new FakeSocket();
    const messages: Array<unknown> = [];
    let closed: number | null = null;
    const bridge = new RexTerminalBridge({
      target: { session: "desk", block: null },
      connect: () => socket,
      viewer: {
        send: (frame) => messages.push(JSON.parse(String(frame))),
        close: (code) => {
          closed = code;
        },
      },
    });
    bridge.viewerMessage(JSON.stringify({ type: "open", cols: 80, rows: 24 }));
    socket.emit("error");
    socket.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    assert.deepEqual(messages, [
      { type: "error", message: "Rex could not be reached. Is its server running?" },
    ]);
    assert.strictEqual(closed, REX_VIEWER_CLOSE_LOST);
  });

  it("closes a viewer that sends something else", async () => {
    for (const message of [
      { type: "write", data: "before open" },
      { type: "open", cols: 0, rows: 24 },
      { type: "open", cols: 80, rows: 100000 },
      { type: "shell", command: "rm" },
    ]) {
      const viewer = open(new FakeRex());
      viewer.say(message);
      assert.strictEqual(viewer.closed()?.code, REX_VIEWER_CLOSE_PROTOCOL, JSON.stringify(message));
    }
    const viewer = open(new FakeRex());
    viewer.bridge.viewerMessage("not json");
    assert.strictEqual(viewer.closed()?.code, REX_VIEWER_CLOSE_PROTOCOL);
  });
});
