import { assert, describe, it } from "@effect/vitest";

import { KDL_MAX_BYTES, parseKdl } from "./dockKdl.ts";

const nodes = (text: string) => {
  const document = parseKdl(text);
  if (!document.ok) throw new Error(`line ${document.line}: ${document.message}`);
  return document.nodes;
};
const problem = (text: string) => {
  const document = parseKdl(text);
  if (document.ok) throw new Error("the text was read");
  return document;
};

describe("parseKdl", () => {
  it("reads nodes, arguments, properties and children", () => {
    assert.deepEqual(
      nodes('rex "scout" width=2 {\n  session "desk"\n  "a title" "T" 0x10 -1.5\n}\n'),
      [
        {
          name: "rex",
          args: ["scout"],
          props: { width: 2 },
          line: 1,
          children: [
            { name: "session", args: ["desk"], props: {}, children: [], line: 2 },
            { name: "a title", args: ["T", 16, -1.5], props: {}, children: [], line: 3 },
          ],
        },
      ],
    );
  });

  it("skips comments, commented-out parts and continued lines", () => {
    const read = nodes(
      [
        "// a line comment",
        "/* a block /* nested */ comment */ one 1; two 2",
        '/- dropped "node" { child 1 }',
        'three /- "dropped" "kept" /- key="dropped" \\ // carried on',
        '  key="kept" /- { dropped 1 }',
      ].join("\r\n"),
    );
    assert.deepEqual(
      read.map(({ name, args, props }) => ({ name, args, props })),
      [
        { name: "one", args: [1], props: {} },
        { name: "two", args: [2], props: {} },
        { name: "three", args: ["kept"], props: { key: "kept" } },
      ],
    );
    assert.strictEqual(read[2]?.line, 4);
  });

  it("reads string escapes", () => {
    assert.deepEqual(nodes('say "a\\tb\\n\\"c\\" \\u{1F600}\\\\"')[0]?.args, ['a\tb\n"c" 😀\\']);
  });

  it("refuses what it does not read, and says on which line", () => {
    assert.deepEqual(problem("one 1\ntwo bare\n"), {
      ok: false,
      line: 2,
      message: "Put bare in quotes.",
    });
    assert.strictEqual(problem('\n\nnode "never closed').line, 3);
    assert.strictEqual(problem("node {\n  child 1\n").message, "A { is never closed.");
    assert.strictEqual(problem("}").message, "A } has no { before it.");
    assert.strictEqual(problem("node #true").line, 1);
    assert.strictEqual(problem('node r#"raw"#').line, 1);
    assert.strictEqual(problem('node """\nmany\n"""').line, 1);
    assert.strictEqual(problem("(type)node 1").line, 1);
    assert.strictEqual(problem('node "a"{ }').message, 'Put a space before "{".');
    assert.strictEqual(problem('node "\\q"').message, "\\q is not an escape this file knows.");
    assert.strictEqual(problem("/* open").message, "A /* comment is never closed.");
    assert.strictEqual(
      problem("a { b { c { d { e { f { g { h { i { j 1 } } } } } } } } }").line,
      1,
    );
  });

  it("refuses a file over the size cap before reading it", () => {
    assert.isFalse(parseKdl(`// ${"x".repeat(KDL_MAX_BYTES)}`).ok);
    assert.isTrue(parseKdl(`// ${"x".repeat(KDL_MAX_BYTES - 3)}`).ok);
  });
});
