/**
 * Declarative, JSON-friendly description of a restricted Parser AST.
 *
 * The differential harness generates a `SpecNode[]`, then derives two
 * artefacts from it:
 *   - a real `Parser` built exclusively through the public fluent API
 *     (which is compiled to JavaScript by the production code), and
 *   - input for the independent reference interpreter (interpreter.ts).
 *
 * Nodes that the interpreter does not implement (wrapper, readUntil
 * predicates, lengthInBytes, alias references, key-hashes, hex encodings,
 * function-valued options, arbitrary user formatters) are filtered out at
 * generation time and can never appear in a spec.
 */
import { Parser } from "../../lib/binary_parser";

/** Built-in pure formatters. Arbitrary user code never enters the domain. */
export const FORMATTERS: Record<string, (value: any) => any> = {
  double: (value: number) => value * 2,
  increment: (value: number) => value + 1,
  negate: (value: number) => -value,
  shout: (value: string) => String(value).toUpperCase(),
};

export const NUMERIC_FORMATTERS = ["double", "increment", "negate"];
export const STRING_FORMATTERS = ["shout"];

export type PrimitiveMethod =
  | "uint8"
  | "uint16"
  | "uint16le"
  | "uint16be"
  | "uint32"
  | "uint32le"
  | "uint32be"
  | "int8"
  | "int16"
  | "int16le"
  | "int16be"
  | "int32"
  | "int32le"
  | "int32be"
  | "int64le"
  | "int64be"
  | "uint64le"
  | "uint64be"
  | "floatle"
  | "floatbe"
  | "doublele"
  | "doublebe";

/** Explicit-endian type names usable as array/choice/pointer element types. */
export type ElementPrimitive =
  | "uint8"
  | "int8"
  | "uint16le"
  | "uint16be"
  | "uint32le"
  | "uint32be"
  | "int16le"
  | "int16be"
  | "int32le"
  | "int32be"
  | "floatle"
  | "floatbe"
  | "doublele"
  | "doublebe"
  | "uint64le"
  | "uint64be"
  | "int64le"
  | "int64be";

export type ElementSpec =
  | { kind: "primitive"; type: ElementPrimitive }
  | { kind: "nest"; fields: SpecNode[] };

export type SpecNode =
  | { kind: "endianness"; value: "little" | "big" }
  | {
      kind: "primitive";
      name: string;
      method: PrimitiveMethod;
      assert?: number | string;
      formatter?: string;
    }
  | {
      kind: "bits";
      fields: {
        name: string;
        size: number;
        assert?: number;
        formatter?: string;
      }[];
    }
  | {
      kind: "string";
      name: string;
      mode: "fixed" | "ref" | "zeroTerm" | "zeroTermFixed" | "greedy";
      length?: number;
      lenRef?: string;
      stripNull?: boolean;
      formatter?: string;
    }
  | {
      kind: "buffer";
      name: string;
      mode: "fixed" | "ref" | "eof";
      length?: number;
      lenRef?: string;
      clone?: boolean;
    }
  | {
      kind: "array";
      name: string;
      length?: number;
      lenRef?: string;
      element: ElementSpec;
    }
  | {
      kind: "choice";
      name: string;
      tag: number | { ref: string };
      choices: { tag: number; element: ElementSpec }[];
      defaultChoice?: ElementSpec;
    }
  | { kind: "nest"; name: string | null; fields: SpecNode[] }
  | {
      kind: "pointer";
      name: string;
      offset: number | { ref: string };
      target: ElementSpec;
    }
  | { kind: "seek"; amount: number };

/** Field name used by the harness to observe the final offset. */
export const OFFSET_PROBE = "__offset__";

function buildElement(element: ElementSpec): string | Parser {
  if (element.kind === "primitive") {
    return element.type;
  }
  return buildParser(element.fields);
}

/** Build a real Parser chain from a spec, using only the public API. */
export function buildParser(spec: SpecNode[]): Parser {
  const parser = Parser.start();
  for (const node of spec) {
    switch (node.kind) {
      case "endianness":
        parser.endianness(node.value);
        break;
      case "primitive": {
        const options: { assert?: number | string; formatter?: (v: any) => any } = {};
        if (node.assert !== undefined) options.assert = node.assert;
        if (node.formatter) options.formatter = FORMATTERS[node.formatter];
        (parser as any)[node.method](node.name, options);
        break;
      }
      case "bits":
        for (const field of node.fields) {
          const options: { assert?: number; formatter?: (v: any) => any } = {};
          if (field.assert !== undefined) options.assert = field.assert;
          if (field.formatter) options.formatter = FORMATTERS[field.formatter];
          (parser as any)[`bit${field.size}`](field.name, options);
        }
        break;
      case "string": {
        const options: any = {};
        if (node.mode === "fixed") options.length = node.length;
        if (node.mode === "ref") options.length = node.lenRef;
        if (node.mode === "zeroTerm") options.zeroTerminated = true;
        if (node.mode === "zeroTermFixed") {
          options.zeroTerminated = true;
          options.length = node.length;
        }
        if (node.mode === "greedy") options.greedy = true;
        if (node.stripNull) options.stripNull = true;
        if (node.formatter) options.formatter = FORMATTERS[node.formatter];
        parser.string(node.name, options);
        break;
      }
      case "buffer": {
        const options: any = {};
        if (node.mode === "fixed") options.length = node.length;
        if (node.mode === "ref") options.length = node.lenRef;
        if (node.mode === "eof") options.readUntil = "eof";
        if (node.clone) options.clone = true;
        parser.buffer(node.name, options);
        break;
      }
      case "array": {
        const options: any = { type: buildElement(node.element) };
        if (node.lenRef !== undefined) options.length = node.lenRef;
        else options.length = node.length;
        parser.array(node.name, options);
        break;
      }
      case "choice": {
        const choices: Record<number, string | Parser> = {};
        for (const branch of node.choices) {
          choices[branch.tag] = buildElement(branch.element);
        }
        const options: any = {
          tag: typeof node.tag === "number" ? node.tag : node.tag.ref,
          choices,
        };
        if (node.defaultChoice) {
          options.defaultChoice = buildElement(node.defaultChoice);
        }
        parser.choice(node.name, options);
        break;
      }
      case "nest": {
        const type = buildParser(node.fields);
        if (node.name === null) parser.nest({ type });
        else parser.nest(node.name, { type });
        break;
      }
      case "pointer": {
        parser.pointer(node.name, {
          offset: typeof node.offset === "number" ? node.offset : node.offset.ref,
          type: buildElement(node.target),
        } as any);
        break;
      }
      case "seek":
        parser.seek(node.amount);
        break;
    }
  }
  return parser;
}

/** Build the parser under test: the spec plus a trailing offset probe. */
export function buildTestParser(spec: SpecNode[]): Parser {
  const parser = buildParser(spec);
  parser.saveOffset(OFFSET_PROBE);
  return parser;
}

// ---------------------------------------------------------------------------
// Replay printer: turns a (possibly shrunk) spec + input into a self-contained
// snippet that can be pasted into a file and run to reproduce a failure.
// ---------------------------------------------------------------------------

function printElement(element: ElementSpec, subs: string[]): string {
  if (element.kind === "primitive") {
    return JSON.stringify(element.type);
  }
  const id = `sub${subs.length}`;
  subs.push(`const ${id} = ${printChain(element.fields, subs)};`);
  return id;
}

function printOptions(options: [string, unknown][]): string {
  const parts = options
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return `{ ${parts.join(", ")} }`;
}

function printChain(spec: SpecNode[], subs: string[]): string {
  const lines: string[] = [];
  for (const node of spec) {
    switch (node.kind) {
      case "endianness":
        lines.push(`.endianness(${JSON.stringify(node.value)})`);
        break;
      case "primitive":
        lines.push(
          `.${node.method}(${JSON.stringify(node.name)}, ${printOptions([
            ["assert", node.assert === undefined ? undefined : JSON.stringify(node.assert)],
            ["formatter", node.formatter ? `formatters.${node.formatter}` : undefined],
          ])})`,
        );
        break;
      case "bits":
        for (const field of node.fields) {
          lines.push(
            `.bit${field.size}(${JSON.stringify(field.name)}, ${printOptions([
              ["assert", field.assert === undefined ? undefined : JSON.stringify(field.assert)],
              ["formatter", field.formatter ? `formatters.${field.formatter}` : undefined],
            ])})`,
          );
        }
        break;
      case "string":
        lines.push(
          `.string(${JSON.stringify(node.name)}, ${printOptions([
            ["length", node.mode === "fixed" ? node.length : node.mode === "ref" ? JSON.stringify(node.lenRef) : node.mode === "zeroTermFixed" ? node.length : undefined],
            ["zeroTerminated", node.mode === "zeroTerm" || node.mode === "zeroTermFixed" ? true : undefined],
            ["greedy", node.mode === "greedy" ? true : undefined],
            ["stripNull", node.stripNull ? true : undefined],
            ["formatter", node.formatter ? `formatters.${node.formatter}` : undefined],
          ])})`,
        );
        break;
      case "buffer":
        lines.push(
          `.buffer(${JSON.stringify(node.name)}, ${printOptions([
            ["length", node.mode === "fixed" ? node.length : node.mode === "ref" ? JSON.stringify(node.lenRef) : undefined],
            ["readUntil", node.mode === "eof" ? JSON.stringify("eof") : undefined],
            ["clone", node.clone ? true : undefined],
          ])})`,
        );
        break;
      case "array":
        lines.push(
          `.array(${JSON.stringify(node.name)}, ${printOptions([
            ["length", node.lenRef !== undefined ? JSON.stringify(node.lenRef) : node.length],
            ["type", printElement(node.element, subs)],
          ])})`,
        );
        break;
      case "choice": {
        const branches = node.choices
          .map((branch) => `${branch.tag}: ${printElement(branch.element, subs)}`)
          .join(", ");
        lines.push(
          `.choice(${JSON.stringify(node.name)}, ${printOptions([
            ["tag", typeof node.tag === "number" ? node.tag : JSON.stringify(node.tag.ref)],
            ["choices", `{ ${branches} }`],
            ["defaultChoice", node.defaultChoice ? printElement(node.defaultChoice, subs) : undefined],
          ])})`,
        );
        break;
      }
      case "nest": {
        const type = printElement({ kind: "nest", fields: node.fields }, subs);
        lines.push(
          node.name === null
            ? `.nest({ type: ${type} })`
            : `.nest(${JSON.stringify(node.name)}, { type: ${type} })`,
        );
        break;
      }
      case "pointer":
        lines.push(
          `.pointer(${JSON.stringify(node.name)}, ${printOptions([
            ["offset", typeof node.offset === "number" ? node.offset : JSON.stringify(node.offset.ref)],
            ["type", printElement(node.target, subs)],
          ])})`,
        );
        break;
      case "seek":
        lines.push(`.seek(${node.amount})`);
        break;
    }
  }
  return `Parser.start()\n  ${lines.join("\n  ")}`;
}

/** Print a self-contained, directly replayable reproduction script. */
export function printReplay(spec: SpecNode[], input: number[]): string {
  const subs: string[] = [];
  const chain = printChain(spec, subs);
  const formatterDefs = Object.entries(FORMATTERS)
    .map(([key, fn]) => `  ${key}: ${fn.toString()},`)
    .join("\n");
  return [
    `const { Parser } = require("binary-parser");`,
    `const formatters = {`,
    formatterDefs,
    `};`,
    ...subs,
    `const parser = ${chain};`,
    `const input = Buffer.from(${JSON.stringify(input)});`,
    `console.log(parser.parse(input));`,
  ].join("\n");
}
