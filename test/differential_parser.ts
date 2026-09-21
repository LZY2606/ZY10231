// Differential testing: an independent reference interpreter is stepped over
// the same restricted parser declarations and inputs as the generated
// production code, and the returned structure, final offset and structured
// error path are compared.
//
// Everything these tests use lives under test/differential/ and is test-only.
// See test/differential/README.md for the supported AST subset and semantics.

import { ok } from "assert";
import { generateCases } from "./differential/generator";
import { runAll, runOne } from "./differential/runner";
import { interpret } from "./differential/interpreter";
import { serialize } from "./differential/serializer";
import { runProduction } from "./differential/differential";

describe("Differential reference interpreter", () => {
  const runs = runAll();

  it("covers every required edge scenario at least once", () => {
    const labels = new Set(runs.map((run) => run.label.split("#")[0]));
    for (const required of [
      "bit-cross-byte-then-align",
      "pointer-absolute-and-relative-restore",
      "choice-tag-selection",
      "array-of-nest",
      "fixed-string-and-buffer",
      "endian-and-float-interleave",
      "simple-assert",
    ]) {
      ok(labels.has(required), `missing required scenario: ${required}`);
    }
  });

  for (const run of runs) {
    it(`agrees on ${run.label}`, () => {
      ok(
        run.matches,
        run.failureReport ?? `differential mismatch for ${run.label}`,
      );
    });
  }

  it("reports a structured path for unknown choice tags", () => {
    const testCase = generateCases().find(
      (c) => c.label === "choice-tag-selection#unknown-tag",
    )!;
    const { buffer } = serialize(
      testCase.root,
      testCase.mode,
      testCase.seedCase,
    );
    const production = runProduction(testCase.root, buffer);
    const reference = interpret(testCase.root, buffer);

    ok(!production.ok && production.error!.kind === "choice");
    ok(!reference.ok && reference.error!.kind === "choice");
    ok(reference.error!.path[0] === "data");
    ok(typeof reference.error!.detail!.tag === "number");
  });

  it("restores the main offset after an absolute pointer", () => {
    const testCase = generateCases().find(
      (c) => c.label === "pointer-absolute-and-relative-restore",
    )!;
    const { buffer } = serialize(
      testCase.root,
      testCase.mode,
      testCase.seedCase,
    );
    const production = runProduction(testCase.root, buffer);
    const reference = interpret(testCase.root, buffer);

    ok(production.ok && reference.ok);
    ok(production.finalOffset === reference.result!.finalOffset);
    // main chain: 2 absOff + 2 base + 2 relOff + 1 trailing byte
    ok(production.finalOffset === 7);
  });

  it("realigns to a byte boundary after a crossing bit group", () => {
    const testCase = generateCases().find(
      (c) => c.label === "bit-cross-byte-then-align",
    )!;
    const { buffer } = serialize(
      testCase.root,
      testCase.mode,
      testCase.seedCase,
    );
    const production = runProduction(testCase.root, buffer);
    const reference = interpret(testCase.root, buffer);

    ok(production.ok && reference.ok);
    ok(production.finalOffset === reference.result!.finalOffset);
    // 2 bytes of bits (5+6+5) + 2 (uint16) + 4 (uint32)
    ok(production.finalOffset === 8);
  });
});

describe("Differential harness determinism and reduction", () => {
  it("produces an identical case sequence and bytes across invocations", () => {
    const first = generateCases();
    const second = generateCases();
    const sig = (cases: typeof first) =>
      JSON.stringify(cases, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
    ok(sig(first) === sig(second));

    const a = runOne(first[0]);
    const b = runOne(second[0]);
    ok(JSON.stringify(a.bytes) === JSON.stringify(b.bytes));
  });

  it("renders replay code that references only the public builder API", () => {
    const run = runOne(generateCases()[0]);
    const { renderReplay } = require("./differential/replay");
    const replay = renderReplay("manual", run.root, run.bytes, {
      kind: "golden",
    });
    ok(replay.includes("Parser.start()"));
    ok(replay.includes("Buffer.from(["));
    ok(!replay.includes("interpreter"));
  });

  it("reduces a divergent case without growing the input", () => {
    const { shrink, shrinkHooks } = require("./differential/shrink");
    const realCompare = shrinkHooks.compare;
    // Inject a synthetic divergence: a successful parse consuming more than
    // one byte is treated as different by the reducer.
    shrinkHooks.compare = (production: any, reference: any) => {
      const real = realCompare(production, reference);
      if (
        real.matches &&
        production.ok &&
        reference.ok &&
        production.finalOffset > 1
      ) {
        return { matches: false, details: ["injected synthetic divergence"] };
      }
      return real;
    };
    const base = generateCases().find((c) => c.label === "simple-assert")!;
    const { buffer } = serialize(base.root, base.mode, base.seedCase);
    let shrunk;
    try {
      shrunk = shrink(base, buffer);
    } finally {
      shrinkHooks.compare = realCompare;
    }
    ok(Array.isArray(shrunk.bytes));
    ok(shrunk.bytes.length <= buffer.length);
    ok(shrunk.bytes.length < buffer.length, "expected input to be reduced");
  });
});
