// Failure reduction: given a mismatching case, greedily remove declaration
// nodes and trim trailing input bytes while the mismatch still reproduces.

import { GeneratedCase } from "./generator";
import { Node, StructIr } from "./ir";
import { compareOutcomes, runProduction } from "./differential";
import { interpret } from "./interpreter";
import { serialize } from "./serializer";

// Indirection so tests can inject a synthetic divergence; production runs use
// the real comparator unchanged.
export const shrinkHooks = {
  compare: compareOutcomes,
};

// Re-serialize a possibly modified struct for the same mode.
function bytesFor(root: StructIr, testCase: GeneratedCase): Buffer {
  return serialize(root, testCase.mode, testCase.seedCase).buffer;
}

function stillMismatches(
  root: StructIr,
  testCase: GeneratedCase,
  bytes?: Buffer,
): boolean {
  const buffer = bytes ?? bytesFor(root, testCase);
  const prod = runProduction(root, buffer);
  const ref = interpret(root, buffer);
  return !shrinkHooks.compare(prod, ref).matches;
}

function countNodes(struct: StructIr): number {
  let total = struct.nodes.length;
  for (const node of struct.nodes) {
    if (node.kind === "array") total += countNodes(node.elem);
    if (node.kind === "nest") total += countNodes(node.body);
    if (node.kind === "pointer") total += countNodes(node.body);
    if (node.kind === "choice") {
      for (const branch of node.branches) total += countNodes(branch.body);
    }
  }
  return total;
}

function removeNodeAt(
  struct: StructIr,
  target: number,
): { struct: StructIr; removed: Node | null } {
  let index = target;
  const clone: StructIr = JSON.parse(JSON.stringify(struct));
  let removed: Node | null = null;

  const walk = (s: StructIr): boolean => {
    for (let i = 0; i < s.nodes.length; i++) {
      if (index === 0) {
        removed = s.nodes[i];
        s.nodes.splice(i, 1);
        return true;
      }
      index -= 1;
      const node = s.nodes[i];
      if (node.kind === "array" && walk(node.elem)) return true;
      if (node.kind === "nest" && walk(node.body)) return true;
      if (node.kind === "pointer" && walk(node.body)) return true;
      if (node.kind === "choice") {
        for (const branch of node.branches) {
          if (walk(branch.body)) return true;
        }
      }
    }
    return false;
  };
  walk(clone);
  return { struct: clone, removed };
}

export interface Shrunk {
  root: StructIr;
  bytes: number[];
}

export function shrink(testCase: GeneratedCase, initialBuffer: Buffer): Shrunk {
  let root = testCase.root;
  let bytes = initialBuffer;

  // Greedily drop declaration nodes while the mismatch persists.
  let changed = true;
  while (changed) {
    changed = false;
    const total = countNodes(root);
    for (let i = 0; i < total; i++) {
      const candidate = removeNodeAt(root, i);
      if (!candidate.removed) continue;
      let candidateBytes: Buffer;
      try {
        candidateBytes = bytesFor(candidate.struct, testCase);
      } catch {
        continue;
      }
      if (
        candidateBytes.length > 0 &&
        stillMismatches(candidate.struct, testCase, candidateBytes)
      ) {
        root = candidate.struct;
        bytes = candidateBytes;
        changed = true;
        break;
      }
    }
  }

  // Trim trailing bytes one at a time while the mismatch still reproduces.
  let trimmed = bytes;
  while (trimmed.length > 0) {
    const candidate = trimmed.subarray(0, trimmed.length - 1);
    if (stillMismatches(root, testCase, Buffer.from(candidate))) {
      trimmed = Buffer.from(candidate);
    } else {
      break;
    }
  }

  return { root, bytes: Array.from(trimmed) };
}
