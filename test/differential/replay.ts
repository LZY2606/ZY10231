// Renders a failing (IR, bytes) pair as a self-contained Node-runnable script.
// The snippet uses only the public Parser builder API so it can be pasted into
// a scratch file and replayed without the fuzzer or reference interpreter.

import { CaseMode, OFFSET_PROBE } from "./generator";
import { Node, PrimType, StructIr } from "./ir";

function emitNode(node: Node, indent: string): string {
  const pad = indent + "  ";
  const head = optionsPrelude(node);
  switch (node.kind) {
    case "prim":
      return `${indent}.${primBuilder(node.type)}(${q(node.name)}${head})`;
    case "bit":
      return `${indent}.bit${node.width}(${q(node.name)}${head})`;
    case "string":
      return `${indent}.string(${q(node.name)}, { length: ${node.length}${tail(
        node,
      )} })`;
    case "buffer":
      return `${indent}.buffer(${q(node.name)}, { length: ${node.length}${tail(
        node,
      )} })`;
    case "saveOffset":
      return `${indent}.saveOffset(${q(node.name)})`;
    case "array":
      return (
        `${indent}.array(${q(node.name)}, { length: ${node.length}, type:\n` +
        `${pad}Parser.start()\n` +
        emitStructNodes(node.elem, pad) +
        `\n${pad} })`
      );
    case "nest":
      return (
        `${indent}.nest(${q(node.name)}, { type:\n` +
        `${pad}Parser.start()\n` +
        emitStructNodes(node.body, pad) +
        `\n${pad} })`
      );
    case "choice": {
      const branches = node.branches
        .map((branch) => {
          const body =
            branch.body.nodes.length === 0
              ? `${pad}  Parser.start()`
              : `${pad}  Parser.start()\n${emitStructNodes(
                  branch.body,
                  pad + "  ",
                )}`;
          return `${pad}${branch.tag}: \n${body}`;
        })
        .join(",\n");
      return (
        `${indent}.choice(${q(node.name)}, {\n` +
        `${pad}tag: ${q(node.tagField)},\n` +
        `${pad}choices: {\n${branches}\n${pad}}\n` +
        `${indent}})`
      );
    }
    case "pointer": {
      const offsetOption = node.relativeTo
        ? `offset: function () { return this.${node.anchor} + this.${node.relativeTo}; }`
        : `offset: ${q(node.anchor)}`;
      return (
        `${indent}.pointer(${q(node.name)}, {\n` +
        `${pad}${offsetOption},\n` +
        `${pad}type:\n` +
        `${pad}Parser.start()\n` +
        emitStructNodes(node.body, pad) +
        `\n${pad} })`
      );
    }
  }
}

function primBuilder(type: PrimType): string {
  return type;
}

function optionsPrelude(node: Node): string {
  const parts: string[] = [];
  if (node.formatter) parts.push(`formatter: FORMATTERS.${node.formatter}.fn`);
  if (node.assert && node.assert.kind === "number") {
    parts.push(`assert: ${node.assert.expected}`);
  }
  return parts.length ? `, { ${parts.join(", ")} }` : "";
}

function tail(node: Node): string {
  if (node.formatter) return `, formatter: FORMATTERS.${node.formatter}.fn`;
  return "";
}

function emitStructNodes(struct: StructIr, indent: string): string {
  return struct.nodes.map((node) => emitNode(node, indent)).join("\n");
}

function q(value: string): string {
  return JSON.stringify(value);
}

export function renderDeclaration(root: StructIr): string {
  const endianPrefix =
    root.bitEndian === "le" ? '  .endianness("little")\n' : "";
  const nodes = emitStructNodes(root, "  ");
  const probe = root.offsetProbe ? `\n  .saveOffset(${q(OFFSET_PROBE)})` : "";
  return `Parser.start()\n${endianPrefix}${nodes}${probe}`;
}

export function renderReplay(
  label: string,
  root: StructIr,
  bytes: number[],
  mode: CaseMode,
  refResult?: any,
  prodResult?: any,
): string {
  const replacer =
    '(_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v)';
  const declaration = renderDeclaration(root);
  const byteLiteral =
    "Buffer.from([\n  " +
    bytes.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ") +
    "\n])";

  return [
    `// Replay for failing differential case: ${label}`,
    `// Mode: ${JSON.stringify(mode)}`,
    `// Save this snippet as a .cjs file at the repository root`,
    `// (so './dist/binary_parser.js' resolves) and run: node <this-file>`,
    `// Build first with: npm run build`,
    `const { Parser } = require("./dist/binary_parser.js");`,
    `const FORMATTERS = {`,
    `  identity: { fn: (v) => v },`,
    `  negate: { fn: (v) => -v },`,
    `  double: { fn: (v) => v * 2 },`,
    `  isEven: { fn: (v) => v % 2 === 0 },`,
    `  toHex: { fn: (v) => v.toString(16) },`,
    `};`,
    `const parser = ${declaration};`,
    `const buffer = ${byteLiteral};`,
    `try {`,
    `  console.log(JSON.stringify(parser.parse(buffer), ${replacer}, 2));`,
    `} catch (error) {`,
    `  console.log("threw:", error.message);`,
    `}`,
    refResult !== undefined
      ? `// Reference result: ${JSON.stringify(refResult, replacerJson, 2)}`
      : `// Reference threw`,
    prodResult !== undefined
      ? `// Production result: ${JSON.stringify(prodResult, replacerJson, 2)}`
      : `// Production threw`,
  ].join("\n");
  function replacerJson(_key: string, value: any): any {
    return typeof value === "bigint" ? value.toString() + "n" : value;
  }
}
