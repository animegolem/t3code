import { assert, describe, it } from "@effect/vitest";

import { RexMessageScanner, RexSnapshotSkipper } from "./rexStream.ts";

const encoder = new TextEncoder();
const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};
/** One snapshot record: a 10-byte header that gives the tag and the payload's length, then the payload. */
const record = (tag: number, payload: Uint8Array) => {
  const header = new Uint8Array(10);
  const view = new DataView(header.buffer);
  view.setUint16(0, tag, true);
  view.setUint32(2, payload.length, true);
  view.setUint32(6, 0xdeadbeef, true);
  return concat(header, payload);
};
const prefix = (magic = "GHOSTSNP", version = 1) => {
  const bytes = new Uint8Array(10);
  bytes.set(encoder.encode(magic));
  new DataView(bytes.buffer).setUint16(8, version, true);
  return bytes;
};
const SNAPSHOT = concat(
  prefix(),
  record(1, new Uint8Array(3).fill(7)),
  record(3, new Uint8Array(300).fill(6)),
  // A payload that looks like a finish record must not end the snapshot.
  record(4, record(6, new Uint8Array(0))),
  record(6, new Uint8Array(5).fill(9)),
);
const OUTPUT = encoder.encode("prompt> ");

describe("RexSnapshotSkipper", () => {
  it("returns what follows the snapshot, wherever the stream is cut", () => {
    const stream = concat(SNAPSHOT, OUTPUT);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const skipper = new RexSnapshotSkipper();
      const first = skipper.skip(stream.subarray(0, cut));
      const second = skipper.skip(stream.subarray(cut));
      const after = concat(first ?? new Uint8Array(0), second ?? new Uint8Array(0));
      assert.deepEqual(after, OUTPUT, `cut at ${cut}`);
      assert.strictEqual(first === null, cut < SNAPSHOT.length, `cut at ${cut}`);
    }
  });

  it("passes later chunks through untouched", () => {
    const skipper = new RexSnapshotSkipper();
    assert.deepEqual(skipper.skip(SNAPSHOT), new Uint8Array(0));
    assert.strictEqual(skipper.skip(OUTPUT), OUTPUT);
  });

  it("refuses a stream that does not open with a snapshot it knows", () => {
    assert.throws(() => new RexSnapshotSkipper().skip(concat(prefix("GHOSTSNQ"), OUTPUT)));
    assert.throws(() => new RexSnapshotSkipper().skip(concat(prefix("GHOSTSNP", 2), OUTPUT)));
  });
});

describe("RexMessageScanner", () => {
  const NONCE = "1234567890123";
  const apc = (body: string) => `\u001b_${body}\u001b\\`;
  const resize = apc(`rex1;${NONCE};{"type":"resize","cols":100,"rows":30,"owner":"client:a"}`);

  it("finds Rex's messages and says where each ends", () => {
    const text = `before${resize}after${apc(`rex1;${NONCE};{"type":"child_exited","exit_code":3}`)}`;
    const found = new RexMessageScanner(NONCE).scan(encoder.encode(text));
    assert.deepEqual(found, [
      {
        message: { type: "resize", cols: 100, rows: 30, owner: "client:a" },
        end: "before".length + resize.length,
      },
      { message: { type: "child_exited", exitCode: 3 }, end: text.length },
    ]);
  });

  it("finds a message cut anywhere between two chunks", () => {
    const bytes = encoder.encode(`ab${resize}cd`);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const scanner = new RexMessageScanner(NONCE);
      const found = [...scanner.scan(bytes.subarray(0, cut)), ...scanner.scan(bytes.subarray(cut))];
      assert.strictEqual(found.length, 1, `cut at ${cut}`);
      assert.strictEqual(found[0]?.message.type, "resize");
    }
  });

  it("skips what a program printed, an unknown type and a message it cannot read", () => {
    const scanner = new RexMessageScanner(NONCE);
    const text = [
      apc('rex1;999;{"type":"resize","cols":1,"rows":1}'),
      apc(`rex1;${NONCE};{"type":"theme","background":"000000"}`),
      apc(`rex1;${NONCE};{"type":"resize","cols":0,"rows":30}`),
      apc(`rex1;${NONCE};not json`),
      apc("Gf=100,a=T;kitty graphics"),
      // An APC that never ends is abandoned at the next escape sequence.
      `\u001b_rex1;${NONCE};{"type":"resize"\u001b[0m`,
      apc(`rex1;${NONCE};${"x".repeat(70_000)}`),
      resize,
    ].join("text");
    assert.deepEqual(
      scanner.scan(encoder.encode(text)).map((found) => found.message.type),
      ["resize"],
    );
  });
});
