// Reference interpreter for the restricted parser IR.
//
// This walks the IR step by step and maintains its own offset, scope chain and
// bit accumulator. It deliberately does not import or reuse any production
// offset calculation or code-generation template; primitives are read through
// an independent range-checking DataView wrapper, strings through Buffer, and
// bit fields through an explicit streaming bit reader.

import { applyFormatter } from "./builtins";
import { Node, PrimType, StructIr } from "./ir";

export type RefErrorKind = "range" | "choice" | "assert";

export class RefError extends Error {
  kind: RefErrorKind;
  path: string[];
  detail?: { tag?: number; expected?: any };

  constructor(
    kind: RefErrorKind,
    path: string[],
    message: string,
    detail?: { tag?: number; expected?: any },
  ) {
    super(message);
    this.kind = kind;
    this.path = path;
    this.detail = detail;
  }
}

function fail(
  kind: RefErrorKind,
  pathStack: string[],
  suffix: string,
  message: string,
  detail?: { tag?: number; expected?: any },
): never {
  throw new RefError(
    kind,
    pathStack.concat(suffix ? [suffix] : []),
    message,
    detail,
  );
}

interface Frame {
  vars: Record<string, any>;
}

class Cursor {
  buffer: Buffer;
  view: DataView;
  offset = 0;
  bitEndian: "be" | "le";
  bitBuf = 0;
  bitCount = 0;

  constructor(buffer: Buffer, bitEndian: "be" | "le") {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
    this.bitEndian = bitEndian;
  }

  private need(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) {
      throw new RefError(
        "range",
        [],
        `read of ${bytes} byte(s) at offset ${this.offset} exceeds ${this.buffer.length}`,
      );
    }
  }

  align(): void {
    if (this.bitCount > 0) {
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  // Read a single bit, refilling one byte from the current offset as needed.
  private readBit(): number {
    if (this.bitCount === 0) {
      this.need(1);
      this.bitBuf = this.view.getUint8(this.offset);
      this.offset += 1;
      this.bitCount = 8;
    }
    let bit: number;
    if (this.bitEndian === "be") {
      this.bitCount -= 1;
      bit = (this.bitBuf >>> this.bitCount) & 1;
    } else {
      bit = this.bitBuf & 1;
      this.bitBuf >>>= 1;
      this.bitCount -= 1;
    }
    return bit;
  }

  readBits(width: number): number {
    let value = 0;
    if (this.bitEndian === "be") {
      for (let i = 0; i < width; i++) value = (value << 1) | this.readBit();
    } else {
      for (let i = 0; i < width; i++) value |= this.readBit() << i;
    }
    return width === 32 ? value >>> 0 : value;
  }

  readPrim(type: PrimType): number | bigint {
    this.align();
    const size = PRIM_SIZE[type];
    this.need(size);
    const v = readDataView(this.view, type, this.offset);
    this.offset += size;
    return v;
  }
}

const PRIM_SIZE: Record<PrimType, number> = {
  uint8: 1,
  uint16le: 2,
  uint16be: 2,
  uint32le: 4,
  uint32be: 4,
  int8: 1,
  int16le: 2,
  int16be: 2,
  int32le: 4,
  int32be: 4,
  uint64le: 8,
  uint64be: 8,
  int64le: 8,
  int64be: 8,
  floatle: 4,
  floatbe: 4,
  doublele: 8,
  doublebe: 8,
};

function readDataView(
  view: DataView,
  type: PrimType,
  offset: number,
): number | bigint {
  switch (type) {
    case "uint8":
      return view.getUint8(offset);
    case "int8":
      return view.getInt8(offset);
    case "uint16le":
      return view.getUint16(offset, true);
    case "uint16be":
      return view.getUint16(offset, false);
    case "uint32le":
      return view.getUint32(offset, true);
    case "uint32be":
      return view.getUint32(offset, false);
    case "int16le":
      return view.getInt16(offset, true);
    case "int16be":
      return view.getInt16(offset, false);
    case "int32le":
      return view.getInt32(offset, true);
    case "int32be":
      return view.getInt32(offset, false);
    case "uint64le":
      return view.getBigUint64(offset, true);
    case "uint64be":
      return view.getBigUint64(offset, false);
    case "int64le":
      return view.getBigInt64(offset, true);
    case "int64be":
      return view.getBigInt64(offset, false);
    case "floatle":
      return view.getFloat32(offset, true);
    case "floatbe":
      return view.getFloat32(offset, false);
    case "doublele":
      return view.getFloat64(offset, true);
    case "doublebe":
      return view.getFloat64(offset, false);
  }
}

export interface RefResult {
  result: Record<string, any>;
  finalOffset: number;
}

export interface RefOutcome {
  ok: boolean;
  result?: RefResult;
  error?: RefError;
}

// Scope chain mirroring the generated code's nested `vars` objects.
class ScopeChain {
  frames: Frame[] = [];

  push(vars: Record<string, any>): void {
    this.frames.push({ vars });
  }
  pop(): void {
    this.frames.pop();
  }
  current(): Record<string, any> {
    return this.frames[this.frames.length - 1].vars;
  }
  // Mirrors generated-code lexical resolution: references are looked up on the
  // current object only; there is no implicit parent fallback.
  lookup(name: string): any {
    const vars = this.frames[this.frames.length - 1].vars;
    return Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : undefined;
  }
}

function setField(target: Record<string, any>, node: Node, value: any): void {
  if (node.name) target[node.name] = value;
}

function finishScalar(
  target: Record<string, any>,
  node: Node,
  value: any,
  pathStack: string[],
): any {
  let out = value;
  if (node.assert && node.assert.kind === "number") {
    if (out !== node.assert.expected) {
      fail(
        "assert",
        pathStack,
        node.name,
        `assertion failed for ${node.name}`,
        { expected: node.assert.expected },
      );
    }
  }
  if (node.formatter) {
    out = applyFormatter(node.formatter, out);
  }
  setField(target, node, out);
  return out;
}

function runStruct(
  cursor: Cursor,
  scope: ScopeChain,
  target: Record<string, any>,
  struct: StructIr,
  pathStack: string[],
): void {
  const previousEndian = cursor.bitEndian;
  cursor.bitEndian = struct.bitEndian ?? cursor.bitEndian;
  for (const node of struct.nodes) {
    if (
      cursor.bitCount > 0 &&
      node.kind !== "bit" &&
      !(node.kind === "nest" && structStartsWithBit(node.body))
    ) {
      // Returning to a byte-aligned node ends the open bit group.
      cursor.align();
    }
    execNode(cursor, scope, target, node, pathStack);
    // Array, choice and pointer bodies are independent byte streams.
    if (
      cursor.bitCount > 0 &&
      (node.kind === "array" ||
        node.kind === "choice" ||
        node.kind === "pointer")
    ) {
      cursor.align();
    }
  }
  // No alignment here: a nest whose body starts with bits continues the
  // enclosing group; the top-level entry performs the final alignment.
  cursor.bitEndian = previousEndian;
}

function structStartsWithBit(struct: StructIr): boolean {
  const first = struct.nodes[0];
  if (!first) return false;
  if (first.kind === "bit") return true;
  if (first.kind === "nest") return structStartsWithBit(first.body);
  return false;
}

function execNode(
  cursor: Cursor,
  scope: ScopeChain,
  target: Record<string, any>,
  node: Node,
  pathStack: string[],
): void {
  switch (node.kind) {
    case "saveOffset":
      target[node.name] = cursor.offset;
      return;
    case "prim": {
      const value = cursor.readPrim(node.type);
      finishScalar(target, node, value, pathStack);
      return;
    }
    case "bit": {
      const value = cursor.readBits(node.width);
      finishScalar(target, node, value, pathStack);
      return;
    }
    case "string": {
      cursor.align();
      // Production decodes the available prefix (subarray clamps) and
      // unconditionally advances by the declared length; a later primitive
      // read is what surfaces the out-of-bounds condition.
      const start = Math.min(cursor.offset, cursor.buffer.length);
      const end = Math.min(cursor.offset + node.length, cursor.buffer.length);
      const value = cursor.buffer.subarray(start, end).toString("utf8");
      cursor.offset += node.length;
      finishScalar(target, node, value, pathStack);
      return;
    }
    case "buffer": {
      cursor.align();
      const start = Math.min(cursor.offset, cursor.buffer.length);
      const end = Math.min(cursor.offset + node.length, cursor.buffer.length);
      const value = cursor.buffer.subarray(start, end);
      cursor.offset += node.length;
      finishScalar(target, node, value, pathStack);
      return;
    }
    case "array": {
      const items: any[] = [];
      for (let i = 0; i < node.length; i++) {
        const elem: Record<string, any> = {};
        const elemPath = pathStack.concat(node.name, String(i));
        scope.push(elem);
        try {
          runStruct(cursor, scope, elem, node.elem, elemPath);
        } finally {
          scope.pop();
        }
        items.push(elem);
      }
      setField(target, node, items);
      return;
    }
    case "nest": {
      if (node.name) {
        const nested: Record<string, any> = {};
        const nestPath = pathStack.concat(node.name);
        scope.push(nested);
        try {
          runStruct(cursor, scope, nested, node.body, nestPath);
        } finally {
          scope.pop();
        }
        target[node.name] = nested;
      } else {
        runStruct(cursor, scope, target, node.body, pathStack);
      }
      return;
    }
    case "choice": {
      const tagValue = scope.lookup(node.tagField);
      const branch = node.branches.find((b) => b.tag === tagValue);
      if (!branch) {
        fail(
          "choice",
          pathStack,
          node.name,
          `met undefined tag value ${tagValue} at choice`,
          { tag: Number(tagValue) },
        );
      }
      if (node.name) {
        const branchTarget: Record<string, any> = {};
        const branchPath = pathStack.concat(node.name);
        scope.push(branchTarget);
        try {
          runStruct(cursor, scope, branchTarget, branch!.body, branchPath);
        } finally {
          scope.pop();
        }
        target[node.name] = branchTarget;
      } else {
        runStruct(cursor, scope, target, branch!.body, pathStack);
      }
      return;
    }
    case "pointer": {
      const anchor = scope.lookup(node.anchor);
      const base = node.relativeTo ? scope.lookup(node.relativeTo) : 0;
      const destination = Number(anchor) + Number(base);
      const savedOffset = cursor.offset;
      cursor.offset = destination;
      const pointed: Record<string, any> = {};
      const ptrPath = pathStack.concat(node.name);
      // The pointed type has its own vars object; references resolve only
      // within it (lexical scope), while the main offset is restored after.
      scope.push(pointed);
      try {
        runStruct(cursor, scope, pointed, node.body, ptrPath);
      } finally {
        scope.pop();
      }
      cursor.offset = savedOffset;
      target[node.name] = pointed;
      return;
    }
  }
}

export function interpret(root: StructIr, buffer: Buffer): RefOutcome {
  const scope = new ScopeChain();
  const vars: Record<string, any> = {};
  scope.push(vars);
  const cursor = new Cursor(buffer, root.bitEndian ?? "be");
  try {
    runStruct(cursor, scope, vars, root, []);
    cursor.align();
    if (root.offsetProbe) vars[root.offsetProbe] = cursor.offset;
    return {
      ok: true,
      result: { result: vars, finalOffset: cursor.offset },
    };
  } catch (error) {
    if (error instanceof RefError) return { ok: false, error };
    throw error;
  }
}
