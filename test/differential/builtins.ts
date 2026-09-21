// Finite catalog of pure built-in functions.
//
// Arbitrary user code never enters the generated domain in these tests. The
// generator only attaches functions from this fixed catalog. The production
// parser receives the real function objects (as ordinary formatter/assert
// callbacks), while the reference interpreter re-derives the same result from
// the function name without calling the production machinery.

import { FormatterName } from "./ir";

export interface NamedFn {
  name: FormatterName;
  fn: (value: any) => any;
}

export const FORMATTERS: Record<FormatterName, NamedFn> = {
  identity: { name: "identity", fn: (value) => value },
  negate: { name: "negate", fn: (value) => -value },
  double: { name: "double", fn: (value) => value * 2 },
  isEven: { name: "isEven", fn: (value) => value % 2 === 0 },
  toHex: { name: "toHex", fn: (value) => (value as number).toString(16) },
};

// Formatter names that are valid for every scalar value kind, including
// zero-length strings/buffers and bit fields.
export const SAFE_FORMATTERS: FormatterName[] = ["identity", "double"];

export function applyFormatter(name: FormatterName, value: any): any {
  switch (name) {
    case "identity":
      return value;
    case "negate":
      return -value;
    case "double":
      return value * 2;
    case "isEven":
      return value % 2 === 0;
    case "toHex":
      return (value as number).toString(16);
  }
}
