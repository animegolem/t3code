// @effect-diagnostics globalTimers:off globalDate:off -- the bridge runs on WebSocket events, outside any Effect fiber, so that a test can drive it with fake sockets and a fake clock.
/**
 * Shows one Rex terminal to one viewer, over Rex's client protocol (each Rex server documents it
 * at /llms.txt). Every viewer has its own bridge and Rex client, and takes the terminal: in Rex a
 * terminal follows its owner's size. Any failure closes the viewer with a reason; nothing resumes.
 */
import * as Schema from "effect/Schema";

import { RexMessageScanner, RexSnapshotSkipper } from "./rexStream.ts";

/** The part of a WebSocket the bridge uses. */
export interface RexSocket {
  binaryType: string;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      readonly data: unknown;
      readonly code: number | undefined;
      readonly reason: string | undefined;
    }) => void,
  ): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type RexConnect = (path: "/api/control" | "/api/data", protocol: string) => RexSocket;

export interface RexViewer {
  /** Text is one JSON message. Bytes are terminal output. */
  readonly send: (frame: string | Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

/** The terminal closed in Rex, or the dock names nothing that exists. Opening again will not help. */
export const REX_VIEWER_CLOSE_GONE = 4000;
/** Rex could not be reached or dropped the connection. Opening again may work. */
export const REX_VIEWER_CLOSE_LOST = 4001;
/** The viewer broke this protocol. */
export const REX_VIEWER_CLOSE_PROTOCOL = 4002;

const CONTROL_PROTOCOL = "rex.control.v1";
const TERMINAL_PROTOCOL = "rex.data.terminal.v1";
const TERMINAL_CREATOR = "com.superlogical.terminal";
/** The revision of Rex's control API this file was written against. Rex translates for older clients. */
const REX_API_REVISION = 18;
const CALL_TIMEOUT_MS = 8000;
const OPEN_TIMEOUT_MS = 5000;
/** Output must pause this long before the screen is read. */
const QUIET_MS = 40;
const QUIET_POLL_MS = 10;
const QUIET_MAX_WAIT_MS = 300;
const JOIN_MAX_ATTEMPTS = 4;
/** The most output held back while the screen is read. */
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
/** The most typing held while an earlier write is in flight. */
const WRITE_QUEUE_MAX_LENGTH = 1024 * 1024;
/** One call to Rex's write. Its messages are capped at 1 MiB and an escape can take six bytes. */
const WRITE_MAX_LENGTH = 64 * 1024;
const FORMAT_PART_MAX_BYTES = 983_040;
const FORMAT_MAX_PARTS = 64;
const GRID_MAX = 1000;

const DATA_HELLO = 0x01;
const DATA_WELCOME = 0x81;
const DATA_REJECT = 0x82;
const DATA_WELCOME_BYTES = 32;
const TICKET_BYTES = 16;
const DATA_CLOSE_BLOCK_CLOSED = 4000;
const DATA_REJECT_REASONS: Readonly<Record<number, string>> = {
  1: "the ticket was unknown, expired or already used",
  2: "this client already reads that terminal",
  3: "the stream is not available",
  4: "a limit was reached",
  5: "the handshake was malformed or late",
  6: "the server failed",
  7: "the subprotocol was wrong",
};

/** Everything `format` can add, so the engine ends up in the terminal's modes as well as its text. */
const FORMAT_ARGS = {
  format: "vt",
  max_bytes: FORMAT_PART_MAX_BYTES,
  extra_charsets: true,
  extra_cursor: true,
  extra_hyperlink: true,
  extra_keyboard: true,
  extra_kitty_keyboard: true,
  extra_modes: true,
  extra_palette: true,
  extra_protection: true,
  extra_pwd: true,
  extra_scrolling_region: true,
  extra_style: true,
  extra_tabstops: true,
};

/** A reason to close the viewer that carries which close code says so. */
class BridgeClosed extends Schema.TaggedError<BridgeClosed>()("BridgeClosed", {
  code: Schema.Number,
  message: Schema.String,
}) {}
const isBridgeClosed = Schema.is(BridgeClosed);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const isGrid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= GRID_MAX;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RexTerminalBridge {
  private readonly target: { readonly session: string; readonly block: string | null };
  private readonly connect: RexConnect;
  private readonly viewer: RexViewer;
  private state: "waiting" | "attaching" | "live" | "closed" = "waiting";

  private control: RexSocket | null = null;
  private data: RexSocket | null = null;
  private nextCallId = 1;
  private readonly calls = new Map<
    string,
    { readonly resolve: (payload: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private clientId = "";
  private sessionId = "";
  private blockId = "";

  private skipper = new RexSnapshotSkipper();
  private scanner: RexMessageScanner | null = null;
  private onDataWelcome: ((frame: Uint8Array) => void) | null = null;
  private streamBytes = 0;
  private lastOutputAt = 0;
  private pending: Array<Uint8Array> = [];
  private pendingBytes = 0;
  private grid: { cols: number; rows: number } | null = null;
  private owned = false;

  private writeQueue = "";
  private writing = false;
  private wantedSize: { readonly cols: number; readonly rows: number } | null = null;
  private resizing = false;

  constructor(options: {
    readonly target: { readonly session: string; readonly block: string | null };
    readonly connect: RexConnect;
    readonly viewer: RexViewer;
  }) {
    this.target = options.target;
    this.connect = options.connect;
    this.viewer = options.viewer;
  }

  /** One JSON message from the viewer: `open` first, then `write`, `resize` and `own`. */
  viewerMessage(text: string): void {
    if (this.state === "closed") return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return this.close(REX_VIEWER_CLOSE_PROTOCOL, "A message was not JSON.");
    }
    const type = field(message, "type");
    const cols = field(message, "cols");
    const rows = field(message, "rows");
    if (type === "open" && this.state === "waiting" && isGrid(cols) && isGrid(rows)) {
      this.state = "attaching";
      void this.attach(cols, rows).catch((error: unknown) => this.fail(error));
      return;
    }
    if (type === "resize" && this.state !== "waiting" && isGrid(cols) && isGrid(rows)) {
      this.wantedSize = { cols, rows };
      if (this.state === "live") void this.pumpResize();
      return;
    }
    if (type === "own" && this.state === "live") {
      // Another client took the terminal, and the person here wants it back at this viewer's size.
      void this.call("session.own_block", {
        session_id: this.sessionId,
        block_ids: [this.blockId],
        mode: "take",
      }).catch((error: unknown) => this.fail(error));
      return;
    }
    const data = field(message, "data");
    if (
      type === "write" &&
      this.state !== "waiting" &&
      typeof data === "string" &&
      data.length <= WRITE_MAX_LENGTH
    ) {
      if (this.writeQueue.length + data.length > WRITE_QUEUE_MAX_LENGTH) {
        return this.close(REX_VIEWER_CLOSE_LOST, "Rex is not taking typing fast enough.");
      }
      this.writeQueue += data;
      if (this.state === "live") void this.pumpWrites();
      return;
    }
    this.close(REX_VIEWER_CLOSE_PROTOCOL, "A message was not one this terminal takes.");
  }

  /** Ends both Rex connections. Rex then passes the terminal to the next client in line for it. */
  dispose(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const call of this.calls.values()) call.reject(new Error("The terminal was closed."));
    this.calls.clear();
    // A close frame ends the Rex client at once. A dropped connection would hold the terminal for a minute.
    this.data?.close(1000, "done");
    this.control?.close(1000, "done");
  }

  private close(code: number, message: string): void {
    if (this.state === "closed") return;
    this.viewer.send(JSON.stringify({ type: "error", message }));
    this.viewer.close(code, message.slice(0, 120));
    this.dispose();
  }

  private fail(error: unknown): void {
    if (isBridgeClosed(error)) return this.close(error.code, error.message);
    this.close(
      REX_VIEWER_CLOSE_LOST,
      error instanceof Error ? error.message : "The connection to Rex failed.",
    );
  }

  private assertOpen(): void {
    if (this.state === "closed")
      throw new BridgeClosed({ code: REX_VIEWER_CLOSE_LOST, message: "Closed." });
  }

  private call(method: string, payload: unknown): Promise<unknown> {
    const control = this.control;
    if (control === null || this.state === "closed") {
      return Promise.reject(new BridgeClosed({ code: REX_VIEWER_CLOSE_LOST, message: "Closed." }));
    }
    const id = String(this.nextCallId);
    this.nextCallId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Rex did not answer ${method}.`));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      control.send(JSON.stringify({ type: "request", id, method, payload }));
    });
  }

  private terminalCall(method: string, args: unknown): Promise<unknown> {
    return this.call(`${TERMINAL_CREATOR}.${method}`, {
      session_id: this.sessionId,
      block_id: this.blockId,
      args,
    });
  }

  private openControl(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.connect("/api/control", CONTROL_PROTOCOL);
      this.control = socket;
      const timer = setTimeout(
        () => reject(new Error("Rex did not answer. Is its server running?")),
        OPEN_TIMEOUT_MS,
      );
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            api_revision: REX_API_REVISION,
            client: { kind: "app", name: "T3 Code", label: "t3code" },
          }),
        ),
      );
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const type = field(message, "type");
        if (type === "welcome") {
          clearTimeout(timer);
          const clientId = field(field(message, "client"), "id");
          if (field(message, "protocol") !== CONTROL_PROTOCOL || typeof clientId !== "string") {
            return reject(new Error("Rex answered with a welcome this T3 Code cannot use."));
          }
          this.clientId = clientId;
          return resolve();
        }
        if (type === "response") {
          const id = field(message, "id");
          const call = typeof id === "string" ? this.calls.get(id) : undefined;
          if (call === undefined || typeof id !== "string") return;
          this.calls.delete(id);
          const error = field(message, "error");
          if (isRecord(error)) {
            const detail = typeof error.message === "string" ? error.message : "no reason given";
            return call.reject(new Error(`Rex refused: ${detail}.`));
          }
          return call.resolve(field(message, "payload"));
        }
        if (type === "event") this.controlEvent(field(message, "payload"));
      });
      const lost = () => {
        clearTimeout(timer);
        reject(new Error("Rex could not be reached. Is its server running?"));
        this.close(
          REX_VIEWER_CLOSE_LOST,
          this.clientId === ""
            ? "Rex could not be reached. Is its server running?"
            : "The connection to Rex closed.",
        );
      };
      socket.addEventListener("close", lost);
      socket.addEventListener("error", lost);
    });
  }

  private controlEvent(event: unknown): void {
    // A session's events arrive wrapped in a session_event.
    const inner =
      field(event, "type") === "session_event" ? field(field(event, "payload"), "event") : event;
    const type = field(inner, "type");
    const payload = field(inner, "payload");
    if (field(payload, "block_id") !== this.blockId || this.blockId === "") return;
    if (type === "block_closed") {
      return this.close(REX_VIEWER_CLOSE_GONE, "The terminal closed in Rex.");
    }
    if (type === "block_owner_changed") {
      this.owned = field(payload, "owner") === this.clientId;
      if (this.state === "live") {
        this.viewer.send(JSON.stringify({ type: "owner", owned: this.owned }));
      }
    }
  }

  /** Opens the data connection and resolves once Rex has welcomed it. Output then flows to `output`. */
  private openData(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ticketBytes = Buffer.from(ticket, "base64url");
      if (ticketBytes.length !== TICKET_BYTES) {
        return reject(new Error("Rex gave a ticket of the wrong length."));
      }
      const socket = this.connect("/api/data", TERMINAL_PROTOCOL);
      socket.binaryType = "arraybuffer";
      this.data = socket;
      const timer = setTimeout(
        () => reject(new Error("Rex did not open the terminal's stream.")),
        OPEN_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        const hello = new Uint8Array(1 + TICKET_BYTES);
        hello[0] = DATA_HELLO;
        hello.set(ticketBytes, 1);
        socket.send(hello);
      });
      this.onDataWelcome = (frame) => {
        clearTimeout(timer);
        this.onDataWelcome = null;
        if (frame[0] === DATA_REJECT) {
          const reason = DATA_REJECT_REASONS[frame[1] ?? 0] ?? "no reason it gave";
          return reject(new Error(`Rex refused the terminal's stream: ${reason}.`));
        }
        if (frame[0] !== DATA_WELCOME || frame.length !== DATA_WELCOME_BYTES) {
          return reject(
            new Error("Rex opened the terminal's stream in a way this T3 Code cannot read."),
          );
        }
        const nonce = new DataView(frame.buffer, frame.byteOffset, frame.length).getBigUint64(
          24,
          true,
        );
        if (nonce === 0n) return reject(new Error("Rex sent a stream with no nonce."));
        this.scanner = new RexMessageScanner(nonce.toString());
        resolve();
      };
      socket.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(event.data);
        if (this.onDataWelcome !== null) return this.onDataWelcome(frame);
        try {
          this.output(frame);
        } catch (error) {
          this.fail(error);
        }
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        reject(new Error("Rex closed the terminal's stream."));
        if (event.code === DATA_CLOSE_BLOCK_CLOSED) {
          return this.close(REX_VIEWER_CLOSE_GONE, "The terminal closed in Rex.");
        }
        this.close(REX_VIEWER_CLOSE_LOST, "Rex closed the terminal's stream.");
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("The terminal's stream failed."));
        this.close(REX_VIEWER_CLOSE_LOST, "The terminal's stream failed.");
      });
    });
  }

  /** One frame of the stream: the snapshot is stepped over, Rex's messages are read, output goes on. */
  private output(frame: Uint8Array): void {
    const scanner = this.scanner;
    if (scanner === null || this.state === "closed") return;
    const bytes = this.skipper.skip(frame);
    if (bytes === null || bytes.length === 0) return;
    this.streamBytes += bytes.length;
    this.lastOutputAt = Date.now();
    let from = 0;
    for (const { message, end } of scanner.scan(bytes)) {
      // Output before a size change is drawn at the old size, so it goes out first.
      this.forward(bytes.subarray(from, end));
      from = end;
      if (message.type === "resize") {
        this.grid = { cols: message.cols, rows: message.rows };
        this.owned = message.owner === this.clientId;
        if (this.state === "live") {
          this.viewer.send(JSON.stringify({ type: "size", ...this.grid, owned: this.owned }));
        }
      } else if (this.state === "live") {
        this.viewer.send(JSON.stringify({ type: "exit", code: message.exitCode }));
      }
    }
    this.forward(bytes.subarray(from));
  }

  private forward(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.state === "live") return this.viewer.send(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes > PENDING_MAX_BYTES) {
      throw new BridgeClosed({
        code: REX_VIEWER_CLOSE_LOST,
        message: "The terminal wrote too much while it was opening.",
      });
    }
    // The frame's buffer belongs to the socket's event, so the held part is copied.
    this.pending.push(bytes.slice());
  }

  private async attach(cols: number, rows: number): Promise<void> {
    await this.openControl();
    this.assertOpen();
    const { session, block } = this.target;

    const sessions = list(field(await this.call("session.list", {}), "sessions"));
    const matches = sessions.filter(
      (entry) => field(entry, "session_id") === session || field(entry, "label") === session,
    );
    const sessionId = field(matches[0], "session_id");
    if (typeof sessionId !== "string") {
      throw new BridgeClosed({
        code: REX_VIEWER_CLOSE_GONE,
        message: `Rex has no session called ${session}.`,
      });
    }
    if (matches.length > 1) {
      throw new BridgeClosed({
        code: REX_VIEWER_CLOSE_GONE,
        message: `Rex has ${matches.length} sessions called ${session}. Name one by its ID in the dock file.`,
      });
    }
    this.sessionId = sessionId;

    const view = field(await this.call("session.attach", { session_id: sessionId }), "view");
    const terminals = list(
      field(await this.call("session.list_blocks", { session_id: sessionId }), "blocks"),
    ).filter((entry) => field(entry, "creator_name") === TERMINAL_CREATOR);
    const focused = field(
      list(field(view, "windows")).find(
        (window) => field(window, "window_id") === field(view, "active_window_id"),
      ),
      "focused_block_id",
    );
    const chosen =
      block === null
        ? (terminals.find((entry) => field(entry, "block_id") === focused) ??
          terminals.find((entry) => field(entry, "placement") === "placed") ??
          terminals[0])
        : terminals.find(
            (entry) => field(entry, "block_id") === block || field(entry, "label") === block,
          );
    const blockId = field(chosen, "block_id");
    if (typeof blockId !== "string") {
      throw new BridgeClosed({
        code: REX_VIEWER_CLOSE_GONE,
        message:
          block === null
            ? `Rex's session ${session} has no terminal.`
            : `Rex's session ${session} has no terminal called ${block}.`,
      });
    }
    this.blockId = blockId;

    await this.call("session.own_block", {
      session_id: sessionId,
      block_ids: [blockId],
      mode: "take",
    });
    const ticket = field(
      await this.call("data.connect", {
        session_id: sessionId,
        block_id: blockId,
        data_ref_id: "terminal",
        subprotocol: TERMINAL_PROTOCOL,
      }),
      "ticket",
    );
    if (typeof ticket !== "string") throw new Error("Rex gave no ticket for the terminal.");
    await this.openData(ticket);
    this.assertOpen();
    // The stream is open before the size changes, so the program's repaint is seen and waited out.
    const wanted = this.wantedSize ?? { cols, rows };
    this.wantedSize = null;
    await this.terminalCall("resize", { columns: wanted.cols, rows: wanted.rows });
    // The program repaints a moment after the call returns, so the quiet wait starts from here.
    this.lastOutputAt = Date.now();

    const { data, quiet } = await this.join();
    this.assertOpen();
    const grid = this.grid ?? wanted;
    this.viewer.send(JSON.stringify({ type: "seed", ...grid, owned: this.owned, quiet, data }));
    this.state = "live";
    for (const bytes of this.pending) this.viewer.send(bytes);
    this.pending = [];
    this.pendingBytes = 0;
    void this.pumpResize();
    void this.pumpWrites();
  }

  /**
   * Reads the screen so that the output sent after it continues from it. Output received before
   * the read is in the screen and is dropped. Output received during it may be in the screen or
   * not, so the read waits for a pause and is made again; the last try's output is drawn anyway.
   */
  private async join(): Promise<{ readonly data: string; readonly quiet: boolean }> {
    for (let attempt = 1; ; attempt += 1) {
      const waitingSince = Date.now();
      while (
        Date.now() - this.lastOutputAt < QUIET_MS &&
        Date.now() - waitingSince < QUIET_MAX_WAIT_MS
      ) {
        await sleep(QUIET_POLL_MS);
        this.assertOpen();
      }
      this.pending = [];
      this.pendingBytes = 0;
      const before = this.streamBytes;
      const first = await this.terminalCall("format", FORMAT_ARGS);
      // No output was seen during the read. The two connections share no order, so this cannot
      // rule out output written just before the read that has yet to arrive.
      const quiet = this.streamBytes === before;
      if (!quiet && attempt < JOIN_MAX_ATTEMPTS) continue;
      let data = field(first, "content");
      if (typeof data !== "string") throw new Error("Rex returned no screen for the terminal.");
      // A long scrollback comes in parts. They are parts of the screen as it was at the call above.
      const id = field(first, "id");
      const parts = typeof id === "number" && id !== 0 ? FORMAT_MAX_PARTS + 1 : 0;
      for (let part = 1; part <= parts; part += 1) {
        if (part > FORMAT_MAX_PARTS)
          throw new Error("The terminal's scrollback is too long to show.");
        const next = await this.terminalCall("blob_read", {
          id,
          offset: Buffer.byteLength(data),
          max_bytes: FORMAT_PART_MAX_BYTES,
        });
        const more = field(next, "data");
        if (typeof more !== "string")
          throw new Error("Rex returned part of the screen unreadably.");
        data += more;
        if (field(next, "eof") === true) break;
      }
      return { data, quiet };
    }
  }

  /** Rex runs writes in any order, so each waits for the one before it. */
  private async pumpWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.writeQueue.length > 0 && this.state === "live") {
        let length = Math.min(this.writeQueue.length, WRITE_MAX_LENGTH);
        // A character outside the basic plane is two units, and is not cut in half.
        const last = this.writeQueue.charCodeAt(length - 1);
        if (length < this.writeQueue.length && last >= 0xd800 && last <= 0xdbff) length -= 1;
        const data = this.writeQueue.slice(0, length);
        this.writeQueue = this.writeQueue.slice(length);
        await this.terminalCall("write", { data });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.writing = false;
    }
  }

  /** Only the newest size is sent. */
  private async pumpResize(): Promise<void> {
    if (this.resizing) return;
    this.resizing = true;
    try {
      while (this.wantedSize !== null && this.state === "live") {
        const { cols, rows } = this.wantedSize;
        this.wantedSize = null;
        await this.terminalCall("resize", { columns: cols, rows });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.resizing = false;
    }
  }
}
