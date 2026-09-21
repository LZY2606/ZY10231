// Restricted parser description ("IR") consumed independently by three
// components:
//   1. build-parser.ts  - turns an IR into a production Parser declaration
//   2. serializer.ts    - lays an IR out into deterministic input bytes
//   3. interpreter.ts   - reference step-by-step interpreter of the same IR
//
// The reference interpreter never imports production offset helpers or code
// templates; both sides merely agree on this plain data contract.

export type PrimType =
  | "uint8"
  | "uint16le"
  | "uint16be"
  | "uint32le"
  | "uint32be"
  | "int8"
  | "int16le"
  | "int16be"
  | "int32le"
  | "int32be"
  | "uint64le"
  | "uint64be"
  | "int64le"
  | "int64be"
  | "floatle"
  | "floatbe"
  | "doublele"
  | "doublebe";

export type FormatterName =
  | "identity"
  | "negate"
  | "double"
  | "isEven"
  | "toHex";

export type AssertSpec =
  | { kind: "number"; expected: number }
  | { kind: "string"; field: string };

// How a pointer anchor field (an already-parsed uint16) is interpreted.
export type PointerOffsetKind = "absolute" | "relative";

export interface BaseNode {
  kind: string;
  name: string;
  formatter?: FormatterName;
  assert?: AssertSpec;
}

export interface PrimNode extends BaseNode {
  kind: "prim";
  type: PrimType;
}

export interface BitNode extends BaseNode {
  kind: "bit";
  width: number; // 1..32; consecutive bit nodes share big-endian packing
}

export interface StringNode extends BaseNode {
  kind: "string";
  length: number; // fixed length, may be 0
}

export interface BufferNode extends BaseNode {
  kind: "buffer";
  length: number; // fixed length, may be 0
}

export interface ArrayNode extends BaseNode {
  kind: "array";
  length: number; // fixed element count, may be 0
  elem: StructIr; // each element is an inline struct
}

export interface ChoiceNode extends BaseNode {
  kind: "choice";
  tagField: string; // name of an earlier uint8 field in the same scope
  branches: { tag: number; body: StructIr }[];
}

export interface NestNode extends BaseNode {
  kind: "nest";
  body: StructIr;
}

export interface PointerNode extends BaseNode {
  kind: "pointer";
  anchor: string; // earlier uint16 field holding the absolute target
  relativeTo?: string; // earlier uint16 field; when set, target = anchor + relativeTo
  body: StructIr;
}

export interface SaveOffsetNode extends BaseNode {
  kind: "saveOffset";
}

export type Node =
  | PrimNode
  | BitNode
  | StringNode
  | BufferNode
  | ArrayNode
  | ChoiceNode
  | NestNode
  | PointerNode
  | SaveOffsetNode;

// A struct is a flat sequence of named declarations, possibly with one
// trailing anonymous saveOffset marker used to observe the final offset.
export interface StructIr {
  nodes: Node[];
  // Bit-extraction order for this parser instance. Primitives always carry
  // their own explicit endian suffix and are unaffected by this.
  bitEndian?: "be" | "le";
  // Name of the magic saveOffset field appended to the root struct only.
  offsetProbe?: string;
}

// Hard limits keep every generated case bounded and easy to shrink.
export const LIMITS = {
  maxDepth: 4,
  maxNodesPerStruct: 6,
  maxArrayLength: 4,
  maxStringLength: 6,
  maxBufferLength: 8,
  maxBitGroupBits: 32,
  maxInputLength: 160,
  caseCount: 300,
  fixedSeed: 0x9e3779b9,
} as const;
