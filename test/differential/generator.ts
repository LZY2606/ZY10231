// Fixed-seed grammar generator for restricted parser declarations.
//
// Every node kind the reference interpreter does not implement is filtered out
// by construction: the IR only contains node types understood by the
// interpreter, and build-parser.ts only invokes the corresponding supported
// builder methods. The sequence of generated cases depends solely on
// LIMITS.fixedSeed; it never consults the clock, Math.random(), or directory
// enumeration order.

import { Rng } from "./rng";
import {
  ArrayNode,
  BitNode,
  BufferNode,
  ChoiceNode,
  LIMITS,
  NestNode,
  Node,
  PointerNode,
  PrimNode,
  PrimType,
  StringNode,
  StructIr,
} from "./ir";
import { SAFE_FORMATTERS } from "./builtins";

const PRIM_TYPES: PrimType[] = [
  "uint8",
  "uint16le",
  "uint16be",
  "uint32le",
  "uint32be",
  "int8",
  "int16le",
  "int16be",
  "int32le",
  "int32be",
  "uint64le",
  "uint64be",
  "int64le",
  "int64be",
  "floatle",
  "floatbe",
  "doublele",
  "doublebe",
];

// Integer primitives that fit a safe JS number and can carry assert/formatter.
const SMALL_INT_TYPES: PrimType[] = [
  "uint8",
  "uint16le",
  "uint16be",
  "uint32le",
  "uint32be",
  "int8",
  "int16le",
  "int16be",
  "int32le",
  "int32be",
];

let nameCounter = 0;
function freshName(prefix: string): string {
  nameCounter += 1;
  return `${prefix}${nameCounter}`;
}

function resetNames(seedCase: number): void {
  // Stable naming across runs: case index keeps names reproducible without
  // relying on global state left by previous cases.
  nameCounter = seedCase * 1000;
}

interface Scope {
  uint8Fields: string[];
  uint16Fields: string[];
}

function makePrim(rng: Rng): PrimNode {
  return { kind: "prim", name: freshName("p"), type: rng.pick(PRIM_TYPES) };
}

// Emit one run of consecutive big-endian bit fields (total <= 32 bits).
// When byteAligned is true the run totals exactly 8, 16, 24 or 32 bits, so
// the enclosing parser returns to a byte boundary. This is required inside
// array/choice/pointer bodies, where production keeps a private bit cursor
// that is not shared with the outer declaration chain.
function makeBitGroup(rng: Rng, byteAligned: boolean): BitNode[] {
  const fields: BitNode[] = [];
  let remaining = byteAligned
    ? rng.pick([8, 16, 24, 32])
    : rng.int(1, LIMITS.maxBitGroupBits);
  while (remaining > 0) {
    const width = rng.int(1, Math.min(8, remaining));
    fields.push({ kind: "bit", name: freshName("b"), width });
    remaining -= width;
  }
  return fields;
}

// Generate one struct body.
function genStruct(
  rng: Rng,
  depth: number,
  bitEndian: "be" | "le",
  alignedBitsOnly: boolean,
): StructIr {
  const nodes: Node[] = [];
  const scope: Scope = { uint8Fields: [], uint16Fields: [] };
  const nodeCount = rng.int(2, LIMITS.maxNodesPerStruct);

  // A bit group is emitted at most once and only as the leading declaration
  // of a struct. Non-root structs (array/choice/pointer bodies) always get a
  // byte-aligned group, because production keeps a private bit cursor for
  // those compound nodes; only the root struct deliberately crosses a byte
  // boundary so the subsequent realignment transition is exercised.
  if (bitEndian === "be" && rng.int(0, 3) === 0) {
    const group = makeBitGroup(rng, alignedBitsOnly);
    for (const bit of group) nodes.push(bit);
  }

  while (nodes.length < nodeCount) {
    const maxKind = depth < LIMITS.maxDepth ? 7 : 3;
    const kind = rng.int(0, maxKind);
    switch (kind) {
      case 0: {
        const prim = makePrim(rng);
        if (SMALL_INT_TYPES.includes(prim.type)) {
          scope.uint8Fields.push(prim.name);
          if (prim.type === "uint16le" || prim.type === "uint16be") {
            scope.uint16Fields.push(prim.name);
          }
          maybeDecorateScalar(rng, prim);
        }
        nodes.push(prim);
        break;
      }
      case 1: {
        const stringNode: StringNode = {
          kind: "string",
          name: freshName("s"),
          // length:0 is rejected by the production builder (truthy check), so
          // it is filtered out of the generated domain entirely.
          length: rng.int(1, LIMITS.maxStringLength),
        };
        if (rng.bool()) stringNode.formatter = rng.pick(SAFE_FORMATTERS);
        nodes.push(stringNode);
        break;
      }
      case 2: {
        const bufferNode: BufferNode = {
          kind: "buffer" as const,
          name: freshName("u"),
          // length:0 is rejected by the production builder (truthy check);
          // zero-length buffers are therefore filtered out of the domain.
          length: rng.int(1, LIMITS.maxBufferLength),
        };
        if (rng.bool()) bufferNode.formatter = rng.pick(SAFE_FORMATTERS);
        nodes.push(bufferNode);
        break;
      }
      case 3: {
        // Plain uint8 primitives are the most common tag/anchor candidates;
        // emit one explicitly so later choice/pointer nodes can reference it.
        const anchor: PrimNode = {
          kind: "prim",
          name: freshName("p"),
          type: "uint8",
        };
        scope.uint8Fields.push(anchor.name);
        nodes.push(anchor);
        break;
      }
      case 4: {
        const arrayNode: ArrayNode = {
          kind: "array",
          name: freshName("a"),
          // length:0 is rejected by the production builder (truthy check).
          length: rng.int(1, LIMITS.maxArrayLength),
          elem: genStruct(rng, depth + 1, "be", true),
        };
        nodes.push(arrayNode);
        break;
      }
      case 5: {
        if (scope.uint8Fields.length === 0) {
          const tagField: PrimNode = {
            kind: "prim",
            name: freshName("p"),
            type: "uint8",
          };
          scope.uint8Fields.push(tagField.name);
          nodes.push(tagField);
        }
        const branchCount = rng.int(2, 3);
        const usedTags = new Set<number>();
        const branches: ChoiceNode["branches"] = [];
        for (let i = 0; i < branchCount; i++) {
          let tag = rng.int(1, 6);
          while (usedTags.has(tag)) tag = rng.int(1, 6);
          usedTags.add(tag);
          branches.push({ tag, body: genStruct(rng, depth + 1, "be", true) });
        }
        nodes.push({
          kind: "choice",
          name: freshName("c"),
          tagField: rng.pick(scope.uint8Fields),
          branches,
        });
        break;
      }
      case 6: {
        const nestNode: NestNode = {
          kind: "nest",
          name: freshName("n"),
          body: genStruct(rng, depth + 1, bitEndian, alignedBitsOnly),
        };
        nodes.push(nestNode);
        break;
      }
      case 7: {
        if (scope.uint16Fields.length === 0) {
          const ptrAnchor: PrimNode = {
            kind: "prim",
            name: freshName("p"),
            type: "uint16le",
          };
          scope.uint16Fields.push(ptrAnchor.name);
          scope.uint8Fields.push(ptrAnchor.name);
          nodes.push(ptrAnchor);
        }
        const anchor = rng.pick(scope.uint16Fields);
        const pointerNode: PointerNode = {
          kind: "pointer",
          name: freshName("q"),
          anchor,
          body: genStruct(rng, depth + 1, "be", true),
        };
        if (rng.bool() && scope.uint16Fields.length > 1) {
          pointerNode.relativeTo = rng.pick(
            scope.uint16Fields.filter((f) => f !== anchor),
          );
        }
        nodes.push(pointerNode);
        break;
      }
    }
  }

  return { nodes, bitEndian };
}

function maybeDecorateScalar(rng: Rng, node: Node): void {
  if (rng.int(0, 5) !== 0) return;
  if (rng.bool()) {
    node.formatter = rng.pick(SAFE_FORMATTERS);
  } else {
    // Small non-negative values fit every signed/unsigned 8..32-bit type, so
    // the serializer can always encode the asserted value faithfully.
    node.assert = { kind: "number", expected: rng.int(0, 50) };
  }
}

export const OFFSET_PROBE = "__finalOffset";

export type CaseMode =
  | { kind: "golden" }
  | { kind: "truncate"; bytes: number }
  | { kind: "unknownTag" }
  | { kind: "badAssert" };

export interface GeneratedCase {
  label: string;
  root: StructIr;
  mode: CaseMode;
  seedCase: number;
}

function rootOf(nodes: Node[], bitEndian: "be" | "le" = "be"): StructIr {
  return {
    nodes,
    bitEndian,
    offsetProbe: OFFSET_PROBE,
  };
}

export function hasChoice(struct: StructIr): boolean {
  return struct.nodes.some((node) => {
    if (node.kind === "choice") return true;
    if (node.kind === "array") return hasChoice(node.elem);
    if (node.kind === "nest") return hasChoice(node.body);
    if (node.kind === "pointer") return hasChoice(node.body);
    return false;
  });
}

export function hasAssert(struct: StructIr): boolean {
  return struct.nodes.some((node) => {
    if (node.assert) return true;
    if (node.kind === "array") return hasAssert(node.elem);
    if (node.kind === "nest") return hasAssert(node.body);
    if (node.kind === "pointer") return hasAssert(node.body);
    if (node.kind === "choice")
      return node.branches.some((b) => hasChoice(b.body));
    return false;
  });
}

// Hand-written scenarios guarantee the required edge combinations are always
// exercised even if the random grammar happened not to produce them.
function explicitCases(): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  let id = 0;
  const add = (label: string, root: StructIr): void => {
    cases.push({ label, root, mode: { kind: "golden" }, seedCase: id++ });
  };

  // Bit fields crossing a byte boundary, then byte realignment, interleaved
  // little/big endian primitives.
  add(
    "bit-cross-byte-then-align",
    rootOf(
      [
        { kind: "bit", name: "hi", width: 5 },
        { kind: "bit", name: "lo", width: 6 },
        { kind: "bit", name: "tail", width: 5 },
        { kind: "prim", name: "w16", type: "uint16le" },
        { kind: "prim", name: "w32", type: "uint32be" },
      ],
      "be",
    ),
  );

  // Absolute and relative pointers; main offset must be restored afterwards.
  add(
    "pointer-absolute-and-relative-restore",
    rootOf([
      { kind: "prim", name: "absOff", type: "uint16le" },
      { kind: "prim", name: "base", type: "uint16le" },
      { kind: "prim", name: "relOff", type: "uint16le" },
      {
        kind: "pointer",
        name: "abs",
        anchor: "absOff",
        body: {
          nodes: [
            { kind: "prim", name: "magic", type: "uint32be" },
            { kind: "prim", name: "v", type: "uint16le" },
          ],
        },
      },
      {
        kind: "pointer",
        name: "rel",
        anchor: "relOff",
        relativeTo: "base",
        body: { nodes: [{ kind: "prim", name: "only", type: "uint16le" }] },
      },
      { kind: "prim", name: "after", type: "uint8" },
    ]),
  );

  // Choice with an unknown tag variant (exercised in unknownTag mode too).
  add(
    "choice-tag-selection",
    rootOf([
      { kind: "prim", name: "tag", type: "uint8" },
      {
        kind: "choice",
        name: "data",
        tagField: "tag",
        branches: [
          {
            tag: 1,
            body: { nodes: [{ kind: "prim", name: "x", type: "uint16be" }] },
          },
          {
            tag: 2,
            body: {
              nodes: [
                { kind: "prim", name: "y", type: "uint8" },
                { kind: "prim", name: "z", type: "uint8" },
              ],
            },
          },
        ],
      },
    ]),
  );

  // Fixed array whose elements contain a nested struct.
  add(
    "array-of-nest",
    rootOf([
      {
        kind: "array",
        name: "items",
        length: 3,
        elem: {
          nodes: [
            { kind: "prim", name: "kind", type: "uint8" },
            {
              kind: "nest",
              name: "inner",
              body: {
                nodes: [
                  { kind: "prim", name: "a", type: "uint16le" },
                  { kind: "prim", name: "b", type: "uint32be" },
                ],
              },
            },
          ],
        },
      },
    ]),
  );

  // Zero-length string and buffer plus a non-empty fixed buffer.
  add(
    "fixed-string-and-buffer",
    rootOf([
      { kind: "buffer", name: "bytes", length: 3 },
      { kind: "string", name: "text", length: 2 },
    ]),
  );

  // Mixed endian integers and floating point.
  add(
    "endian-and-float-interleave",
    rootOf([
      { kind: "prim", name: "a", type: "uint16be" },
      { kind: "prim", name: "b", type: "uint16le" },
      { kind: "prim", name: "f", type: "floatle" },
      { kind: "prim", name: "d", type: "doublebe" },
      { kind: "prim", name: "g", type: "int32le" },
    ]),
  );

  // Simple numeric assert on a magic field.
  add(
    "simple-assert",
    rootOf([
      {
        kind: "prim",
        name: "magic",
        type: "uint32be",
        assert: { kind: "number", expected: 42 },
      },
      { kind: "prim", name: "rest", type: "uint8" },
    ]),
  );

  return cases;
}

export function generateCases(): GeneratedCase[] {
  const cases = explicitCases();
  const randomCount = LIMITS.caseCount - cases.length;
  const rng = new Rng(LIMITS.fixedSeed);

  for (let i = 0; i < randomCount; i++) {
    resetNames(100 + i);
    const bitEndian = i % 4 === 0 ? "le" : "be";
    const root = genStruct(rng, 0, bitEndian, false);
    root.offsetProbe = OFFSET_PROBE;
    cases.push({
      label: `random-${i}`,
      root,
      mode: { kind: "golden" },
      seedCase: 100 + i,
    });
  }

  const variants: GeneratedCase[] = [];
  let variantId = 100000;

  cases.forEach((base) => {
    if (hasChoice(base.root)) {
      variants.push({
        label: `${base.label}#unknown-tag`,
        root: cloneRoot(base.root),
        mode: { kind: "unknownTag" },
        seedCase: variantId++,
      });
    }
    if (hasAssert(base.root)) {
      variants.push({
        label: `${base.label}#bad-assert`,
        root: cloneRoot(base.root),
        mode: { kind: "badAssert" },
        seedCase: variantId++,
      });
    }
  });

  return cases.concat(variants);
}

function cloneRoot(root: StructIr): StructIr {
  return JSON.parse(JSON.stringify(root)) as StructIr;
}
