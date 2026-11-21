/**
 * Reads the two things in a Rex terminal stream that are not the program's output: the snapshot
 * the stream opens with, and Rex's own messages. Both arrive cut at arbitrary places, so each
 * reader keeps its place between chunks. Rex's guide, served by each Rex server at /llms.txt,
 * defines the stream.
 */

const SNAPSHOT_MAGIC = "GHOSTSNP";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_PREFIX_BYTES = SNAPSHOT_MAGIC.length + 2;
const SNAPSHOT_RECORD_HEADER_BYTES = 10;
const SNAPSHOT_FINISH_TAG = 6;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_RECORDS = 1_000_000;

/**
 * Steps over the snapshot at the start of a stream. T3 Code's terminal engine is built from a
 * Ghostty revision that cannot load it, so the screen is painted another way and the snapshot is
 * only measured: a magic and a version, then records of a 10-byte header and a payload whose
 * length the header gives, the last with tag 6.
 */
export class RexSnapshotSkipper {
  private header = new Uint8Array(Math.max(SNAPSHOT_PREFIX_BYTES, SNAPSHOT_RECORD_HEADER_BYTES));
  private headerFilled = 0;
  private headerWanted = SNAPSHOT_PREFIX_BYTES;
  private prefixRead = false;
  private payloadLeft = 0;
  private finishing = false;
  private finished = false;
  private seen = 0;
  private records = 0;

  /**
   * Returns the bytes after the snapshot, which may be none, or null while the snapshot has not
   * ended. Throws when the stream does not open with a snapshot this reader knows.
   */
  skip(chunk: Uint8Array): Uint8Array | null {
    if (this.finished) return chunk;
    let at = 0;
    while (at < chunk.length) {
      if (this.payloadLeft > 0) {
        const taken = Math.min(this.payloadLeft, chunk.length - at);
        this.payloadLeft -= taken;
        at += taken;
        this.count(taken);
      } else {
        const taken = Math.min(this.headerWanted - this.headerFilled, chunk.length - at);
        this.header.set(chunk.subarray(at, at + taken), this.headerFilled);
        this.headerFilled += taken;
        at += taken;
        this.count(taken);
        if (this.headerFilled === this.headerWanted) this.readHeader();
      }
      if (this.finishing && this.payloadLeft === 0) {
        this.finished = true;
        return chunk.subarray(at);
      }
    }
    return null;
  }

  private count(bytes: number) {
    this.seen += bytes;
    if (this.seen > SNAPSHOT_MAX_BYTES) {
      throw new Error(`Rex's snapshot is larger than ${SNAPSHOT_MAX_BYTES} bytes.`);
    }
  }

  private readHeader() {
    const view = new DataView(this.header.buffer);
    this.headerFilled = 0;
    if (!this.prefixRead) {
      this.prefixRead = true;
      const magic = String.fromCharCode(...this.header.subarray(0, SNAPSHOT_MAGIC.length));
      const version = view.getUint16(SNAPSHOT_MAGIC.length, true);
      if (magic !== SNAPSHOT_MAGIC || version !== SNAPSHOT_VERSION) {
        throw new Error(
          "Rex's terminal stream opened with a snapshot this T3 Code cannot measure.",
        );
      }
      this.headerWanted = SNAPSHOT_RECORD_HEADER_BYTES;
      return;
    }
    this.records += 1;
    if (this.records > SNAPSHOT_MAX_RECORDS) {
      throw new Error(`Rex's snapshot has more than ${SNAPSHOT_MAX_RECORDS} records.`);
    }
    this.payloadLeft = view.getUint32(2, true);
    this.finishing = view.getUint16(0, true) === SNAPSHOT_FINISH_TAG;
  }
}

export type RexStreamMessage =
  | {
      readonly type: "resize";
      readonly cols: number;
      readonly rows: number;
      /** The client that owned the terminal when the size was set, or null. */
      readonly owner: string | null;
    }
  | { readonly type: "child_exited"; readonly exitCode: number | null };

const ESC = 0x1b;
const APC_START = 0x5f; // _
const STRING_END = 0x5c; // \
/** Rex's messages are a few hundred bytes. A longer APC is a program's own, and is not kept. */
const MESSAGE_MAX_BYTES = 64 * 1024;

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * Finds Rex's messages in a terminal's output. Each is an APC sequence that carries the stream's
 * nonce: `ESC _ rex1;<nonce>;<json> ESC \`. The scanner only reads; the caller passes the same
 * bytes on unchanged, since a terminal draws nothing for an APC.
 */
export class RexMessageScanner {
  private readonly prefix: string;
  private state: "text" | "escape" | "body" | "bodyEscape" = "text";
  private body: Array<number> = [];
  private overflowed = false;

  /** `nonce` is the WELCOME's channel nonce in decimal. A message without it came from a program. */
  constructor(nonce: string) {
    this.prefix = `rex1;${nonce};`;
  }

  /** Each message comes with `end`, the place in `chunk` just after it, so output keeps its order. */
  scan(chunk: Uint8Array): Array<{ readonly message: RexStreamMessage; readonly end: number }> {
    const messages: Array<{ readonly message: RexStreamMessage; readonly end: number }> = [];
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index] ?? 0;
      if (this.state === "text") {
        if (byte === ESC) this.state = "escape";
      } else if (this.state === "escape") {
        this.state = byte === APC_START ? "body" : byte === ESC ? "escape" : "text";
        this.body = [];
        this.overflowed = false;
      } else if (this.state === "body") {
        if (byte === ESC) this.state = "bodyEscape";
        else if (this.body.length < MESSAGE_MAX_BYTES) this.body.push(byte);
        else this.overflowed = true;
      } else {
        // Only ESC \ ends an APC. Any other byte after ESC abandons it.
        if (byte === STRING_END && !this.overflowed) {
          const message = this.read();
          if (message !== null) messages.push({ message, end: index + 1 });
        }
        this.state = byte === ESC ? "escape" : "text";
      }
    }
    return messages;
  }

  private read(): RexStreamMessage | null {
    const text = new TextDecoder().decode(Uint8Array.from(this.body));
    if (!text.startsWith(this.prefix)) return null;
    let json: unknown;
    try {
      json = JSON.parse(text.slice(this.prefix.length));
    } catch {
      return null;
    }
    if (typeof json !== "object" || json === null || !("type" in json)) return null;
    if (json.type === "resize" && "cols" in json && "rows" in json) {
      if (!isSize(json.cols) || !isSize(json.rows)) return null;
      const owner = "owner" in json && typeof json.owner === "string" ? json.owner : null;
      return { type: "resize", cols: json.cols, rows: json.rows, owner };
    }
    if (json.type === "child_exited") {
      const exitCode =
        "exit_code" in json && typeof json.exit_code === "number" ? json.exit_code : null;
      return { type: "child_exited", exitCode };
    }
    // Rex's guide says to skip a type a client does not know. Colours are left to T3 Code's theme.
    return null;
  }
}
