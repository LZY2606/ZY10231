// Deterministic layout engine: turns an IR struct into concrete input bytes.
//
// This is a completely independent serializer. It does not call any
// production parsing or offset code; it simply lays fields out in the same
// byte order that a straightforward stream writer would use, then appends
// pointer target segments and patches pointer anchors.

import { Rng } from "./rng";
import { CaseMode } from "./generator";
import { Node, StructIr } from "./ir";

interface PointerWork {
  anchor: string;
  relativeTo?: string;
  body: StructIr;
  segmentStart: number;
}

const RELATIVE_DELTA = 3;

class Writer {
  bytes: number[] = [];
  bitBuf = 0;
  bitCount = 0;
  bitEndian: "be" | "le";
  pointers: PointerWork[] = [];
  anchorPositions = new Map<string, number>();
  mode: CaseMode;
  rng: Rng;

  constructor(mode: CaseMode, rng: Rng, bitEndian: "be" | "le") {
    this.mode = mode;
    this.rng = rng;
    this.bitEndian = bitEndian;
  }

  u8(value: number): void {
    this.align();
    this.bytes.push(value & 0xff);
  }

  align(): void {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  writeBits(width: number, value: number): void {
    if (this.bitEndian === "be") {
      // MSB-first packing into the current byte.
      for (let i = width - 1; i >= 0; i--) {
        const bit = (value >>> i) & 1;
        this.bitBuf = (this.bitBuf << 1) | bit;
        this.bitCount += 1;
        if (this.bitCount === 8) {
          this.bytes.push(this.bitBuf & 0xff);
          this.bitBuf = 0;
          this.bitCount = 0;
        }
      }
    } else {
      // LSB-first packing into the current byte.
      for (let i = 0; i < width; i++) {
        const bit = (value >>> i) & 1;
        this.bitBuf |= bit << this.bitCount;
        this.bitCount += 1;
        if (this.bitCount === 8) {
          this.bytes.push(this.bitBuf & 0xff);
          this.bitBuf = 0;
          this.bitCount = 0;
        }
      }
    }
  }
}

function writePrim(
  writer: Writer,
  node: { type: string; assert?: any },
): number | bigint {
  let value: number | bigint;
  const rng = writer.rng;
  if (node.assert && node.assert.kind === "number") {
    value =
      writer.mode.kind === "badAssert"
        ? node.assert.expected + 1
        : node.assert.expected;
  } else {
    switch (node.type) {
      case "floatle":
      case "floatbe":
        value = rng.int(-1000, 1000);
        break;
      case "doublele":
      case "doublebe":
        value = rng.int(-100000, 100000) + 0.25;
        break;
      case "uint8":
      case "uint16le":
      case "uint16be":
      case "uint32le":
      case "uint32be":
        value = rng.int(0, 200);
        break;
      case "int8":
      case "int16le":
      case "int16be":
      case "int32le":
      case "int32be":
        value = rng.int(-100, 100);
        break;
      default:
        value = BigInt(rng.int(0, 5000));
    }
  }
  writePrimBytes(writer, node.type, value);
  return value;
}

function writePrimBytes(
  writer: Writer,
  type: string,
  value: number | bigint,
): void {
  writer.align();
  const bytes = writer.bytes;
  const v = typeof value === "bigint" ? value : value;
  switch (type) {
    case "uint8":
    case "int8":
      bytes.push(Number(v) & 0xff);
      break;
    case "uint16le":
    case "int16le":
      push16(bytes, Number(v), true);
      break;
    case "uint16be":
    case "int16be":
      push16(bytes, Number(v), false);
      break;
    case "uint32le":
    case "int32le":
      push32(bytes, Number(v), true);
      break;
    case "uint32be":
    case "int32be":
      push32(bytes, Number(v), false);
      break;
    case "uint64le":
    case "int64le":
      push64(bytes, BigInt(v), true);
      break;
    case "uint64be":
    case "int64be":
      push64(bytes, BigInt(v), false);
      break;
    case "floatle":
      push32(bytes, floatBits(Number(v)), true);
      break;
    case "floatbe":
      push32(bytes, floatBits(Number(v)), false);
      break;
    case "doublele":
      push64(bytes, doubleBits(Number(v)), true);
      break;
    case "doublebe":
      push64(bytes, doubleBits(Number(v)), false);
      break;
  }
}

function push16(bytes: number[], value: number, le: boolean): void {
  const u = value & 0xffff;
  const hi = (u >>> 8) & 0xff;
  const lo = u & 0xff;
  if (le) bytes.push(lo, hi);
  else bytes.push(hi, lo);
}

function push32(bytes: number[], value: number, le: boolean): void {
  const u = value >>> 0;
  for (let i = 0; i < 4; i++) {
    const shift = le ? i * 8 : (3 - i) * 8;
    bytes.push((u >>> shift) & 0xff);
  }
}

function push64(bytes: number[], value: bigint, le: boolean): void {
  const mask = BigInt(0xff);
  for (let i = 0; i < 8; i++) {
    const shift = BigInt((le ? i : 7 - i) * 8);
    bytes.push(Number((value >> shift) & mask));
  }
}

function floatBits(value: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, false);
  return new DataView(buf).getUint32(0, false);
}

function doubleBits(value: number): bigint {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return new DataView(buf).getBigUint64(0, false);
}

const STRING_ALPHABET = "ABCDEFGH";

function writeString(writer: Writer, length: number): void {
  writer.align();
  for (let i = 0; i < length; i++) {
    writer.bytes.push(
      STRING_ALPHABET.charCodeAt(writer.rng.int(0, STRING_ALPHABET.length - 1)),
    );
  }
}

function writeBuffer(writer: Writer, length: number): void {
  writer.align();
  for (let i = 0; i < length; i++) {
    writer.bytes.push(writer.rng.int(0, 255));
  }
}

function writeStruct(writer: Writer, struct: StructIr): void {
  const savedEndian = writer.bitEndian;
  writer.bitEndian = struct.bitEndian ?? "be";
  for (const node of struct.nodes) {
    if (
      writer.bitCount > 0 &&
      node.kind !== "bit" &&
      !(node.kind === "nest" && startsWithBit(node.body))
    ) {
      writer.align();
    }
    writeNode(writer, node);
    if (
      writer.bitCount > 0 &&
      (node.kind === "array" ||
        node.kind === "choice" ||
        node.kind === "pointer")
    ) {
      writer.align();
    }
  }
  writer.bitEndian = savedEndian;
}

function startsWithBit(struct: StructIr): boolean {
  const first = struct.nodes[0];
  if (!first) return false;
  if (first.kind === "bit") return true;
  if (first.kind === "nest") return startsWithBit(first.body);
  return false;
}

function writeNode(writer: Writer, node: Node): void {
  switch (node.kind) {
    case "saveOffset":
      return;
    case "prim": {
      let value: number | bigint | undefined;
      if (writer.anchorPositions.has(node.name)) {
        // Placeholder for a pointer anchor; patched after segments are laid.
        writePrimBytes(writer, node.type, 0);
      } else {
        value = writePrim(writer, node);
      }
      if (node.name) {
        // Remember any uint16 anchor position (the 2 bytes were just written).
        if (node.type === "uint16le" || node.type === "uint16be") {
          writer.anchorPositions.set(node.name, writer.bytes.length - 2);
        }
      }
      void value;
      break;
    }
    case "bit": {
      const max = 0xffffffff >>> (32 - node.width);
      const value =
        node.assert && node.assert.kind === "number"
          ? node.assert.expected & max
          : writer.rng.int(0, Math.min(max, 200));
      writer.writeBits(node.width, value);
      break;
    }
    case "string":
      writeString(writer, node.length);
      break;
    case "buffer":
      writeBuffer(writer, node.length);
      break;
    case "array":
      for (let i = 0; i < node.length; i++) writeStruct(writer, node.elem);
      break;
    case "nest":
      writeStruct(writer, node.body);
      break;
    case "choice": {
      let chosen = node.branches[0];
      if (writer.mode.kind === "unknownTag") {
        writer.u8(200);
      } else {
        chosen = node.branches[writer.rng.int(0, node.branches.length - 1)];
        writer.u8(chosen.tag);
      }
      writeStruct(writer, chosen.body);
      break;
    }
    case "pointer": {
      // Target segments are appended after the full main chain in serialize();
      // here we only register the pointer and emit nothing inline.
      writer.pointers.push({
        anchor: node.anchor,
        relativeTo: node.relativeTo,
        body: node.body,
        segmentStart: -1,
      });
      break;
    }
  }
}

export interface Serialized {
  buffer: Buffer;
  goldenLength: number;
}

export function serialize(
  struct: StructIr,
  mode: CaseMode,
  seedCase: number,
): Serialized {
  const rng = new Rng(seedCase ^ 0x55aa55aa);
  const writer = new Writer(mode, rng, struct.bitEndian ?? "be");

  writeStruct(writer, struct);
  writer.align();

  // Pointer targets are reached by jumping from the main chain, so append all
  // target segments after it and patch each anchor afterwards.
  for (const work of writer.pointers) {
    work.segmentStart = writer.bytes.length;
    writeStruct(writer, work.body);
  }

  for (const work of writer.pointers) {
    const pos = writer.anchorPositions.get(work.anchor);
    if (pos === undefined) {
      throw new Error(`internal: missing pointer anchor ${work.anchor}`);
    }
    let target = work.segmentStart;
    if (work.relativeTo) {
      const basePos = writer.anchorPositions.get(work.relativeTo);
      if (basePos === undefined) {
        throw new Error(`internal: missing relative base ${work.relativeTo}`);
      }
      // Write a small, fixed delta into the base field and derive the anchor
      // value so that anchor + base == segmentStart.
      writeUint16At(writer.bytes, basePos, RELATIVE_DELTA, true);
      target = work.segmentStart - RELATIVE_DELTA;
    }
    writeUint16At(writer.bytes, pos, target, true);
  }

  let bytes = writer.bytes;
  const goldenLength = writer.bytes.length;

  if (mode.kind === "truncate") {
    bytes = bytes.slice(0, Math.max(0, goldenLength - mode.bytes));
  }

  return { buffer: Buffer.from(bytes), goldenLength };
}

function writeUint16At(
  bytes: number[],
  pos: number,
  value: number,
  le: boolean,
): void {
  const u = value & 0xffff;
  if (le) {
    bytes[pos] = u & 0xff;
    bytes[pos + 1] = (u >>> 8) & 0xff;
  } else {
    bytes[pos] = (u >>> 8) & 0xff;
    bytes[pos + 1] = u & 0xff;
  }
}
