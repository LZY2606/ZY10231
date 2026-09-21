// Compiles an IR struct into a production Parser declaration using only the
// public builder API. Unsupported node kinds never reach here because the
// generator filters them out by construction.

import { Parser } from "../../lib/binary_parser";
import { Node, PrimType, StructIr } from "./ir";
import { FORMATTERS } from "./builtins";

function bitMethod(
  parser: Parser,
  width: number,
  name: string,
  options: any,
): Parser {
  switch (width) {
    case 1:
      return parser.bit1(name, options);
    case 2:
      return parser.bit2(name, options);
    case 3:
      return parser.bit3(name, options);
    case 4:
      return parser.bit4(name, options);
    case 5:
      return parser.bit5(name, options);
    case 6:
      return parser.bit6(name, options);
    case 7:
      return parser.bit7(name, options);
    case 8:
      return parser.bit8(name, options);
    case 9:
      return parser.bit9(name, options);
    case 10:
      return parser.bit10(name, options);
    case 11:
      return parser.bit11(name, options);
    case 12:
      return parser.bit12(name, options);
    case 13:
      return parser.bit13(name, options);
    case 14:
      return parser.bit14(name, options);
    case 15:
      return parser.bit15(name, options);
    case 16:
      return parser.bit16(name, options);
    case 17:
      return parser.bit17(name, options);
    case 18:
      return parser.bit18(name, options);
    case 19:
      return parser.bit19(name, options);
    case 20:
      return parser.bit20(name, options);
    case 21:
      return parser.bit21(name, options);
    case 22:
      return parser.bit22(name, options);
    case 23:
      return parser.bit23(name, options);
    case 24:
      return parser.bit24(name, options);
    case 25:
      return parser.bit25(name, options);
    case 26:
      return parser.bit26(name, options);
    case 27:
      return parser.bit27(name, options);
    case 28:
      return parser.bit28(name, options);
    case 29:
      return parser.bit29(name, options);
    case 30:
      return parser.bit30(name, options);
    case 31:
      return parser.bit31(name, options);
    default:
      return parser.bit32(name, options);
  }
}

function primMethod(
  parser: Parser,
  type: PrimType,
  name: string,
  options: any,
): Parser {
  switch (type) {
    case "uint8":
      return parser.uint8(name, options);
    case "uint16le":
      return parser.uint16le(name, options);
    case "uint16be":
      return parser.uint16be(name, options);
    case "uint32le":
      return parser.uint32le(name, options);
    case "uint32be":
      return parser.uint32be(name, options);
    case "int8":
      return parser.int8(name, options);
    case "int16le":
      return parser.int16le(name, options);
    case "int16be":
      return parser.int16be(name, options);
    case "int32le":
      return parser.int32le(name, options);
    case "int32be":
      return parser.int32be(name, options);
    case "uint64le":
      return parser.uint64le(name, options);
    case "uint64be":
      return parser.uint64be(name, options);
    case "int64le":
      return parser.int64le(name, options);
    case "int64be":
      return parser.int64be(name, options);
    case "floatle":
      return parser.floatle(name, options);
    case "floatbe":
      return parser.floatbe(name, options);
    case "doublele":
      return parser.doublele(name, options);
    case "doublebe":
      return parser.doublebe(name, options);
  }
}

function nodeOptions(node: Node): any {
  const options: any = {};
  if (node.formatter) options.formatter = FORMATTERS[node.formatter].fn;
  if (node.assert) {
    if (node.assert.kind === "number") options.assert = node.assert.expected;
  }
  return options;
}

function emitNode(parser: Parser, node: Node): Parser {
  switch (node.kind) {
    case "prim":
      return primMethod(parser, node.type, node.name, nodeOptions(node));
    case "bit":
      return bitMethod(parser, node.width, node.name, nodeOptions(node));
    case "string":
      return parser.string(node.name, {
        length: node.length,
        ...nodeOptions(node),
      });
    case "buffer":
      return parser.buffer(node.name, {
        length: node.length,
        ...nodeOptions(node),
      });
    case "saveOffset":
      return parser.saveOffset(node.name);
    case "array":
      return parser.array(node.name, {
        type: buildStruct(node.elem),
        length: node.length,
        ...nodeOptions(node),
      });
    case "nest":
      return parser.nest(node.name, {
        type: buildStruct(node.body),
        ...nodeOptions(node),
      });
    case "choice": {
      const choices: Record<number, Parser> = {};
      for (const branch of node.branches) {
        choices[branch.tag] = buildStruct(branch.body);
      }
      return parser.choice(node.name, {
        tag: node.tagField,
        choices,
      });
    }
    case "pointer": {
      const options: any = {
        type: buildStruct(node.body),
        offset: node.relativeTo
          ? function (this: any) {
              return this[node.anchor!] + this[node.relativeTo!];
            }
          : node.anchor,
      };
      return parser.pointer(node.name, options);
    }
  }
}

export function buildStruct(struct: StructIr): Parser {
  let parser = Parser.start();
  if (struct.bitEndian === "le") {
    parser = parser.endianness("little");
  }
  for (const node of struct.nodes) {
    parser = emitNode(parser, node);
  }
  if (struct.offsetProbe) {
    parser = parser.saveOffset(struct.offsetProbe);
  }
  return parser;
}
