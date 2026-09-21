/**
 * Differential comparator: runs the production compiled parser and the
 * reference interpreter on the same input and compares
 *   1. the returned structure (deep, order-insensitive),
 *   2. the final offset (observed through a trailing saveOffset probe),
 *   3. structured error information (kind, and path/tag where defined).
 *
 * On mismatch the parser declaration and the input bytes are shrunk while
 * the same mismatch signature keeps reproducing, and a replayable report
 * is produced.
 */
import { Parser } from "../../lib/binary_parser";
import { interpret, InterpretError, InterpErrorInfo } from "./interpreter";
import { buildTestParser, printReplay, SpecNode, OFFSET_PROBE } from "./spec";

export interface ErrorOutcome {
  kind: "eof" | "assert" | "choice" | "unknown";
  path?: string[];
  tag?: number;
  message: string;
}

export type Outcome =
  | { ok: true; value: unknown; offset: number }
  | { ok: false; error: ErrorOutcome };

/** Canonicalize a parse result so both sides can be compared structurally. */
export function normalize(value: any): any {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $nan: true };
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === "bigint") return { $big: value.toString() };
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return { $buf: Array.from(value) };
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return { $typeof: typeof value };
}

function classifyGeneratedError(error: unknown): ErrorOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RangeError) {
    return { kind: "eof", message };
  }
  const assertMatch = /^Assertion error: (.+) is /.exec(message);
  if (assertMatch) {
    const path = assertMatch[1]
      .replace(/^vars\.?/, "")
      .split(".")
      .filter((part) => part.length > 0);
    return { kind: "assert", path, message };
  }
  const choiceMatch = /^Met undefined tag value (.+) at choice$/.exec(message);
  if (choiceMatch) {
    return { kind: "choice", tag: Number(choiceMatch[1]), message };
  }
  return { kind: "unknown", message };
}

function classifyInterpretedError(error: InterpErrorInfo): ErrorOutcome {
  return {
    kind: error.kind,
    path: error.path.length > 0 ? error.path : undefined,
    tag: error.tag,
    message: error.detail,
  };
}

export function runGenerated(parser: Parser, input: number[]): Outcome {
  try {
    const result = parser.parse(Uint8Array.from(input)) as Record<string, any>;
    const offset = result[OFFSET_PROBE];
    delete result[OFFSET_PROBE];
    return { ok: true, value: normalize(result), offset };
  } catch (error) {
    return { ok: false, error: classifyGeneratedError(error) };
  }
}

export function runInterpreted(parser: Parser, input: number[]): Outcome {
  try {
    const { value, offset } = interpret(parser, Uint8Array.from(input));
    delete (value as Record<string, any>)[OFFSET_PROBE];
    return { ok: true, value: normalize(value), offset };
  } catch (error) {
    if (error instanceof InterpretError) {
      return { ok: false, error: classifyInterpretedError(error.info) };
    }
    throw error;
  }
}

export interface Mismatch {
  signature: string;
  detail: string;
  generated: Outcome;
  interpreted: Outcome;
}

function formatError(error: ErrorOutcome): string {
  const where = error.path ? ` at ${error.path.join(".")}` : "";
  const tag = error.tag !== undefined ? ` tag=${error.tag}` : "";
  return `${error.kind}${where}${tag}`;
}

export function compareOutcomes(
  generated: Outcome,
  interpreted: Outcome,
): Mismatch | null {
  const make = (signature: string, detail: string): Mismatch => ({
    signature,
    detail,
    generated,
    interpreted,
  });

  if (generated.ok !== interpreted.ok) {
    return make(
      `ok:${generated.ok}/${interpreted.ok}`,
      `one side threw: generated ${
        generated.ok ? "succeeded" : `failed (${formatError(generated.error)})`
      }, interpreted ${
        interpreted.ok
          ? "succeeded"
          : `failed (${formatError(interpreted.error)})`
      }`,
    );
  }

  if (generated.ok && interpreted.ok) {
    const generatedJson = JSON.stringify(generated.value);
    const interpretedJson = JSON.stringify(interpreted.value);
    if (generatedJson !== interpretedJson) {
      return make(
        "result",
        `result mismatch:\n  generated:   ${generatedJson}\n  interpreted: ${interpretedJson}`,
      );
    }
    if (generated.offset !== interpreted.offset) {
      return make(
        "offset",
        `final offset mismatch: generated=${generated.offset} interpreted=${interpreted.offset}`,
      );
    }
    return null;
  }

  const genErr = generated.error;
  const intErr = interpreted.error;
  if (genErr.kind !== intErr.kind) {
    return make(
      `error-kind:${genErr.kind}/${intErr.kind}`,
      `error kind mismatch: generated=${genErr.kind} (${genErr.message}) interpreted=${intErr.kind} (${intErr.message})`,
    );
  }
  if (genErr.kind === "assert") {
    const genPath = (genErr.path ?? []).join(".");
    const intPath = (intErr.path ?? []).join(".");
    if (genPath !== intPath) {
      return make(
        "error-path",
        `assert path mismatch: generated=${genPath} interpreted=${intPath}`,
      );
    }
  }
  if (genErr.kind === "choice" && genErr.tag !== intErr.tag) {
    return make(
      "error-tag",
      `choice tag mismatch: generated=${genErr.tag} interpreted=${intErr.tag}`,
    );
  }
  return null;
}

export interface Case {
  seed: number;
  index: number;
  spec: SpecNode[];
  input: number[];
  features: string[];
}

export function checkCase(testCase: Case): Mismatch | null {
  const parser = buildTestParser(testCase.spec);
  const generated = runGenerated(parser, testCase.input);
  const interpreted = runInterpreted(parser, testCase.input);
  return compareOutcomes(generated, interpreted);
}

// ---------------------------------------------------------------------------
// Shrinking: reduce the parser declaration and the input bytes while the
// same mismatch signature keeps reproducing.
// ---------------------------------------------------------------------------

function declaredNames(node: SpecNode): string[] {
  switch (node.kind) {
    case "primitive":
    case "string":
    case "buffer":
    case "array":
    case "choice":
    case "pointer":
      return [node.name];
    case "bits":
      return node.fields.map((field) => field.name);
    case "nest":
      return node.name === null ? [] : [node.name];
    default:
      return [];
  }
}

function refsOf(node: SpecNode): string[] {
  const refs: string[] = [];
  const visitElement = (element: { kind: string } & any): void => {
    if (element.kind === "nest") {
      for (const field of element.fields) collectRefs(field);
    }
  };
  const collectRefs = (n: SpecNode): void => {
    switch (n.kind) {
      case "string":
      case "buffer":
        if (n.lenRef) refs.push(n.lenRef);
        break;
      case "array":
        if (n.lenRef) refs.push(n.lenRef);
        visitElement(n.element);
        break;
      case "choice":
        if (typeof n.tag !== "number") refs.push(n.tag.ref);
        for (const branch of n.choices) visitElement(branch.element);
        if (n.defaultChoice) visitElement(n.defaultChoice);
        break;
      case "nest":
        for (const field of n.fields) collectRefs(field);
        break;
      case "pointer":
        if (typeof n.offset !== "number") refs.push(n.offset.ref);
        visitElement(n.target);
        break;
      default:
        break;
    }
  };
  collectRefs(node);
  return refs;
}

/**
 * A spec is well-formed if every name referenced by length/tag/offset
 * options is declared by an earlier node in the same scope.
 */
export function isWellFormed(spec: SpecNode[]): boolean {
  const declared = new Set<string>();
  for (const node of spec) {
    for (const ref of refsOf(node)) {
      if (!declared.has(ref)) return false;
    }
    for (const name of declaredNames(node)) declared.add(name);
  }
  return true;
}

function forEachScope(spec: SpecNode[], fn: (scope: SpecNode[]) => void): void {
  fn(spec);
  const visitElement = (element: { kind: string } & any): void => {
    if (element.kind === "nest") forEachScope(element.fields, fn);
  };
  for (const node of spec) {
    switch (node.kind) {
      case "array":
        visitElement(node.element);
        break;
      case "choice":
        for (const branch of node.choices) visitElement(branch.element);
        if (node.defaultChoice) visitElement(node.defaultChoice);
        break;
      case "nest":
        forEachScope(node.fields, fn);
        break;
      case "pointer":
        visitElement(node.target);
        break;
      default:
        break;
    }
  }
}

function tryRemoveNodes(
  testCase: Case,
  stillFails: (candidate: Case) => boolean,
): Case {
  const { spec, input } = testCase;
  let changed = true;
  while (changed) {
    changed = false;
    const scopes: SpecNode[][] = [];
    forEachScope(spec, (scope) => scopes.push(scope));
    for (const scope of scopes) {
      for (let i = scope.length - 1; i >= 0 && scope.length > 0; i--) {
        const removed = scope[i];
        scope.splice(i, 1);
        if (!isWellFormed(spec) || !stillFails({ ...testCase, spec, input })) {
          scope.splice(i, 0, removed);
        } else {
          changed = true;
        }
      }
    }
  }
  return { ...testCase, spec, input };
}

function tryShrinkInput(
  testCase: Case,
  stillFails: (candidate: Case) => boolean,
): Case {
  const { spec } = testCase;
  let { input } = testCase;
  let changed = true;
  while (changed) {
    changed = false;
    for (let length = 0; length < input.length; length++) {
      const candidate = input.slice(0, length);
      if (stillFails({ ...testCase, spec, input: candidate })) {
        input = candidate;
        changed = true;
        break;
      }
    }
    for (let i = 0; i < input.length; i++) {
      const candidate = input.slice(0, i).concat(input.slice(i + 1));
      if (stillFails({ ...testCase, spec, input: candidate })) {
        input = candidate;
        changed = true;
      }
    }
  }
  return { ...testCase, spec, input };
}

export interface ShrunkCase {
  testCase: Case;
  mismatch: Mismatch;
  report: string;
}

export function shrinkCase(testCase: Case, mismatch: Mismatch): ShrunkCase {
  const stillFails = (candidate: Case): boolean => {
    if (!isWellFormed(candidate.spec)) return false;
    let result: Mismatch | null;
    try {
      result = checkCase(candidate);
    } catch {
      return false;
    }
    return result !== null && result.signature === mismatch.signature;
  };

  let current = tryRemoveNodes(testCase, stillFails);
  current = tryShrinkInput(current, stillFails);
  current = tryRemoveNodes(current, stillFails);

  const finalMismatch = checkCase(current) ?? mismatch;
  return {
    testCase: current,
    mismatch: finalMismatch,
    report: formatReport(current, finalMismatch),
  };
}

export function formatReport(testCase: Case, mismatch: Mismatch): string {
  const lines: string[] = [];
  lines.push(
    `Differential mismatch (seed=${testCase.seed} case=${testCase.index}):`,
  );
  lines.push(`  ${mismatch.detail}`);
  lines.push("");
  lines.push("Generated outcome:");
  lines.push(`  ${JSON.stringify(mismatch.generated)}`);
  lines.push("Interpreted outcome:");
  lines.push(`  ${JSON.stringify(mismatch.interpreted)}`);
  lines.push("");
  lines.push("Replay:");
  lines.push(printReplay(testCase.spec, testCase.input));
  return lines.join("\n");
}
