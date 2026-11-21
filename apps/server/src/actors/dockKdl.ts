/**
 * Reads the part of KDL the dock file uses: nodes, quoted strings, numbers, properties, children,
 * comments, slashdash and continued lines. That text means the same in KDL 1 and KDL 2. Anything
 * else, such as a bare word as a value or a raw string, is refused with its line.
 */

import * as Schema from "effect/Schema";

export type KdlValue = string | number;

export interface KdlNode {
  readonly name: string;
  readonly args: ReadonlyArray<KdlValue>;
  readonly props: Readonly<Record<string, KdlValue>>;
  readonly children: ReadonlyArray<KdlNode>;
  readonly line: number;
}

export type KdlDocument =
  | { readonly ok: true; readonly nodes: ReadonlyArray<KdlNode> }
  | { readonly ok: false; readonly line: number; readonly message: string };

export const KDL_MAX_BYTES = 64 * 1024;
const KDL_MAX_DEPTH = 8;
const KDL_MAX_NODES = 1024;

class KdlSyntaxError extends Schema.TaggedError<KdlSyntaxError>()("KdlSyntaxError", {
  line: Schema.Number,
  message: Schema.String,
}) {}
const isKdlSyntaxError = Schema.is(KdlSyntaxError);

const SPACE = /[ \t\uFEFF\u00A0]/;
const NEWLINE = /[\n\r\u0085\u000C\u2028\u2029]/;
const WORD_END = /[\s\\/(){};[\]="#]/;
const NUMBER =
  /^[+-]?(?:0x[0-9a-fA-F][0-9a-fA-F_]*|0o[0-7][0-7_]*|0b[01][01_]*|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?)$/;
const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
  "/": "/",
  b: "\b",
  f: "\f",
  s: " ",
};

export function parseKdl(text: string): KdlDocument {
  if (new TextEncoder().encode(text).byteLength > KDL_MAX_BYTES) {
    return { ok: false, line: 1, message: `The file is larger than ${KDL_MAX_BYTES} bytes.` };
  }
  let at = 0;
  let line = 1;
  let nodeCount = 0;

  const fail = (message: string): never => {
    throw new KdlSyntaxError({ line, message });
  };
  const peek = (offset = 0) => text[at + offset] ?? "";
  const startsWith = (literal: string) => text.startsWith(literal, at);

  const skipNewline = () => {
    if (startsWith("\r\n")) at += 1;
    at += 1;
    line += 1;
  };
  const skipBlockComment = () => {
    const opened = line;
    at += 2;
    let depth = 1;
    while (depth > 0) {
      if (at >= text.length)
        throw new KdlSyntaxError({ line: opened, message: "A /* comment is never closed." });
      if (startsWith("/*")) {
        depth += 1;
        at += 2;
      } else if (startsWith("*/")) {
        depth -= 1;
        at += 2;
      } else if (NEWLINE.test(peek())) skipNewline();
      else at += 1;
    }
  };
  /** Skips spaces, comments and continued lines. With `lines`, also skips line ends and `;`. */
  const skipGaps = (lines: boolean) => {
    while (at < text.length) {
      const character = peek();
      if (SPACE.test(character)) at += 1;
      else if (startsWith("//")) while (at < text.length && !NEWLINE.test(peek())) at += 1;
      else if (startsWith("/*")) skipBlockComment();
      else if (lines && (NEWLINE.test(character) || character === ";")) {
        if (character === ";") at += 1;
        else skipNewline();
      } else if (character === "\\" && !lines) {
        at += 1;
        while (SPACE.test(peek())) at += 1;
        if (startsWith("//")) while (at < text.length && !NEWLINE.test(peek())) at += 1;
        if (!NEWLINE.test(peek())) fail("A backslash must be the last thing on its line.");
        skipNewline();
      } else return;
    }
  };

  const readQuoted = (): string => {
    const opened = line;
    if (startsWith('"""')) fail("Multi-line strings are not read here. Use one line.");
    at += 1;
    let value = "";
    while (true) {
      if (at >= text.length)
        throw new KdlSyntaxError({ line: opened, message: "A string is never closed." });
      const character = peek();
      if (character === '"') {
        at += 1;
        return value;
      }
      if (NEWLINE.test(character))
        throw new KdlSyntaxError({ line: opened, message: "A string must end on its line." });
      if (character !== "\\") {
        value += character;
        at += 1;
        continue;
      }
      const escaped = peek(1);
      if (escaped === "u") {
        const match = /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(at, at + 12));
        const codePoint = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 16);
        if (
          match === null ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          fail("A \\u escape is written \\u{1F600}, with one to six hex digits.");
        }
        value += String.fromCodePoint(codePoint);
        at += match?.[0].length ?? 0;
        continue;
      }
      const replacement = ESCAPES[escaped];
      if (replacement === undefined) fail(`\\${escaped} is not an escape this file knows.`);
      value += replacement;
      at += 2;
    }
  };
  const readWord = (): string => {
    const start = at;
    while (at < text.length && !WORD_END.test(peek())) at += 1;
    return text.slice(start, at);
  };
  const readValue = (): KdlValue => {
    if (peek() === '"') return readQuoted();
    if (peek() === "#" || (peek() === "r" && (peek(1) === '"' || peek(1) === "#"))) {
      fail("Raw strings and # keywords are not read here. Put the value in quotes.");
    }
    if (peek() === "(") fail("Type annotations are not read here.");
    const word = readWord();
    if (word.length === 0) fail(`Unexpected ${JSON.stringify(peek())}.`);
    if (NUMBER.test(word)) {
      // JavaScript reads 0x, 0o and 0b, but not with a sign in front.
      const digits = word.replaceAll("_", "").replace(/^[+-]/, "");
      return word.startsWith("-") ? -Number(digits) : Number(digits);
    }
    return fail(`Put ${word} in quotes.`);
  };

  const readNodes = (depth: number): Array<KdlNode> => {
    if (depth > KDL_MAX_DEPTH) fail(`Blocks are nested more than ${KDL_MAX_DEPTH} deep.`);
    const nodes: Array<KdlNode> = [];
    while (true) {
      skipGaps(true);
      if (at >= text.length) {
        if (depth > 0) fail("A { is never closed.");
        return nodes;
      }
      if (peek() === "}") {
        if (depth === 0) fail("A } has no { before it.");
        at += 1;
        return nodes;
      }
      const dropped = startsWith("/-");
      if (dropped) {
        at += 2;
        skipGaps(true);
      }
      const node = readNode(depth);
      if (dropped) continue;
      nodeCount += 1;
      if (nodeCount > KDL_MAX_NODES) fail(`The file has more than ${KDL_MAX_NODES} nodes.`);
      nodes.push(node);
    }
  };
  const readNode = (depth: number): KdlNode => {
    const nodeLine = line;
    if (peek() === "(") fail("Type annotations are not read here.");
    const name = peek() === '"' ? readQuoted() : readWord();
    if (name.length === 0) fail(`Unexpected ${JSON.stringify(peek())} where a node should start.`);
    if (NUMBER.test(name)) fail(`A node cannot be named ${name}.`);
    const args: Array<KdlValue> = [];
    const props: Record<string, KdlValue> = {};
    let children: Array<KdlNode> = [];
    let hasChildren = false;
    while (true) {
      const before = at;
      skipGaps(false);
      const character = peek();
      if (at >= text.length || NEWLINE.test(character) || character === ";" || character === "}") {
        break;
      }
      if (at === before) fail(`Put a space before ${JSON.stringify(character)}.`);
      const dropped = startsWith("/-");
      if (dropped) {
        at += 2;
        skipGaps(false);
      }
      if (peek() === "{") {
        at += 1;
        const block = readNodes(depth + 1);
        if (dropped) continue;
        if (hasChildren) fail("A node has one { } block.");
        hasChildren = true;
        children = block;
        continue;
      }
      if (hasChildren) fail("Arguments go before the { } block.");
      // A property's key is a bare word or a quoted string, directly followed by `=`.
      const wordStart = at;
      const key = peek() === '"' ? readQuoted() : readWord();
      if (key.length > 0 && peek() === "=") {
        at += 1;
        const value = readValue();
        if (!dropped) props[key] = value;
        continue;
      }
      at = wordStart;
      const value = readValue();
      if (!dropped) args.push(value);
    }
    return { name, args, props, children, line: nodeLine };
  };

  try {
    return { ok: true, nodes: readNodes(0) };
  } catch (error) {
    if (isKdlSyntaxError(error)) {
      return { ok: false, line: error.line, message: error.message };
    }
    throw error;
  }
}
