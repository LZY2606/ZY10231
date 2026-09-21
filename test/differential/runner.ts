// Drives the comparison for every generated case, including derived
// truncation cases, and assembles readable failure context.

import { GeneratedCase, generateCases } from "./generator";
import { compareOutcomes, runProduction } from "./differential";
import { interpret } from "./interpreter";
import { serialize } from "./serializer";
import { shrink } from "./shrink";
import { renderReplay } from "./replay";
import { StructIr } from "./ir";

export interface CaseRun {
  label: string;
  root: StructIr;
  bytes: number[];
  mode: unknown;
  matches: boolean;
  failureReport?: string;
}

function buildTruncations(base: GeneratedCase): GeneratedCase[] {
  const golden = serialize(base.root, { kind: "golden" }, base.seedCase);
  const variants: GeneratedCase[] = [];
  // Truncate near the tail to exercise buffer/primitive cut-offs.
  const cuts = [1, 2, 4, 8];
  for (const cut of cuts) {
    if (cut < golden.goldenLength) {
      variants.push({
        label: `${base.label}#trunc${cut}`,
        root: JSON.parse(JSON.stringify(base.root)),
        mode: { kind: "truncate", bytes: cut },
        seedCase: base.seedCase,
      });
    }
  }
  return variants;
}

export function runOne(base: GeneratedCase): CaseRun {
  const serialized = serialize(base.root, base.mode, base.seedCase);
  const bytes = Array.from(serialized.buffer);

  const prod = runProduction(base.root, serialized.buffer);
  const ref = interpret(base.root, serialized.buffer);
  const comparison = compareOutcomes(prod, ref);

  if (comparison.matches) {
    return {
      label: base.label,
      root: base.root,
      bytes,
      mode: base.mode,
      matches: true,
    };
  }

  const shrunk = shrink(base, serialized.buffer);
  const replay = renderReplay(
    base.label,
    shrunk.root,
    shrunk.bytes,
    base.mode,
    ref.ok ? ref.result : ref.error,
    prod.ok
      ? { result: prod.result, finalOffset: prod.finalOffset }
      : prod.error,
  );

  const report = [
    `Differential mismatch in case "${base.label}"`,
    `Mode: ${JSON.stringify(base.mode)}`,
    `Original bytes: ${bytes.length}, shrunk bytes: ${shrunk.bytes.length}`,
    ...comparison.details.map((line) => `  - ${line}`),
    ``,
    `Replay program:`,
    replay,
  ].join("\n");

  return {
    label: base.label,
    root: shrunk.root,
    bytes: shrunk.bytes,
    mode: base.mode,
    matches: false,
    failureReport: report,
  };
}

export function runAll(): CaseRun[] {
  const cases = generateCases();
  const runs: CaseRun[] = [];
  for (const testCase of cases) {
    runs.push(runOne(testCase));
    for (const truncation of buildTruncations(testCase)) {
      runs.push(runOne(truncation));
    }
  }
  return runs;
}
