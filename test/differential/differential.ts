// Differential comparison between generated production code and the reference
// interpreter, plus shrinking and replay-code rendering on mismatch.

import { deepStrictEqual } from "assert";
import { buildStruct } from "./build-parser";
import { OFFSET_PROBE } from "./generator";
import { RefError, RefOutcome } from "./interpreter";
import { StructIr } from "./ir";

export type ProdErrorKind = "range" | "choice" | "assert" | "other";

export interface NormalizedError {
  kind: ProdErrorKind;
  message: string;
}

export interface ProdOutcome {
  ok: boolean;
  result?: Record<string, any>;
  finalOffset?: number;
  error?: NormalizedError;
}

export function classifyProductionError(error: any): NormalizedError {
  const message = String(error && error.message ? error.message : error);
  if (message.includes("Met undefined tag value")) {
    return { kind: "choice", message };
  }
  if (message.startsWith("Assertion error")) {
    return { kind: "assert", message };
  }
  if (
    error instanceof RangeError ||
    /out of (range|bounds)|Attempted to access|beyond the end|Index or size/i.test(
      message,
    )
  ) {
    return { kind: "range", message };
  }
  return { kind: "other", message };
}

export function runProduction(root: StructIr, buffer: Buffer): ProdOutcome {
  const parser = buildStruct(root);
  try {
    const result = parser.parse(buffer) as Record<string, any>;
    const finalOffset = result[OFFSET_PROBE];
    delete result[OFFSET_PROBE];
    return { ok: true, result, finalOffset };
  } catch (error) {
    return { ok: false, error: classifyProductionError(error) };
  }
}

export interface Comparison {
  matches: boolean;
  details: string[];
}

export function compareOutcomes(
  prod: ProdOutcome,
  ref: RefOutcome,
): Comparison {
  const details: string[] = [];

  if (prod.ok !== ref.ok) {
    details.push(
      `success mismatch: production ${
        prod.ok ? "succeeded" : "threw " + prod.error!.kind
      }, ` + `reference ${ref.ok ? "succeeded" : "threw " + ref.error!.kind}`,
    );
    if (!prod.ok && ref.error) {
      details.push(`production message: ${prod.error!.message}`);
    }
    return { matches: false, details };
  }

  if (!prod.ok && !ref.ok) {
    const normalizedRef = normalizeRefError(ref.error!);
    if (normalizedRef.kind !== prod.error!.kind) {
      details.push(
        `error kind mismatch: production=${prod.error!.kind} reference=${
          normalizedRef.kind
        }`,
      );
    }
    if (normalizedRef.kind === "choice" && prod.error!.kind === "choice") {
      const prodTag = extractTag(prod.error!.message);
      const refTag = ref.error!.detail?.tag;
      if (prodTag !== undefined && refTag !== undefined && prodTag !== refTag) {
        details.push(
          `choice tag mismatch: production=${prodTag} reference=${refTag}`,
        );
      }
    }
    if (normalizedRef.kind === "assert" && prod.error!.kind === "assert") {
      const prodExpected = extractAssertExpected(prod.error!.message);
      const refExpected = ref.error!.detail?.expected;
      if (
        prodExpected !== undefined &&
        refExpected !== undefined &&
        Number(prodExpected) !== Number(refExpected)
      ) {
        details.push(
          `assert expected mismatch: production=${prodExpected} reference=${refExpected}`,
        );
      }
    }
    details.push(`reference error path: ${formatPath(ref.error!.path)}`);
    return {
      matches: details.filter((d) => d.includes("mismatch")).length === 0,
      details,
    };
  }

  const refResult = ref.result!.result;
  const refFinalOffset = ref.result!.finalOffset;
  if (refResult[OFFSET_PROBE] !== undefined) delete refResult[OFFSET_PROBE];

  try {
    deepStrictEqual(prod.result!, refResult);
  } catch (error) {
    details.push(
      `structure mismatch:\n${indent(
        String((error as Error).message)
          .split("\n")
          .slice(0, 14)
          .join("\n"),
      )}`,
    );
  }

  if (prod.finalOffset !== ref.result!.finalOffset) {
    details.push(
      `final offset mismatch: production=${prod.finalOffset} reference=${refFinalOffset}`,
    );
  }

  return { matches: details.length === 0, details };
}

function normalizeRefError(error: RefError): { kind: ProdErrorKind } {
  return { kind: error.kind };
}

function extractTag(message: string): number | undefined {
  const match = message.match(/tag value (\S+) at choice/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isNaN(value) ? undefined : value;
}

// Production assert messages end with the JSON-encoded expected value.
function extractAssertExpected(message: string): number | undefined {
  const match = message.match(/ is (.+)$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isNaN(value) ? undefined : value;
}

function formatPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
