# Differential testing reference interpreter

This directory contains a **test-only** reference interpreter for a restricted
subset of the `binary-parser` declaration chain, plus a fixed-seed generator and
a differential harness. It is not shipped (`package.json` `files` only includes
`dist` and `lib`) and contains no production code paths.

## Why

The production parser compiles declarations into a JavaScript function where
`offset`, a bit cursor, and nested `vars` objects are manipulated by generated
code. A bug in code generation can be silently shared by any test that only
re-parses fixed buffers. The reference interpreter instead executes the same
declaration **step by step** using independently written semantics, so the two
sides can only agree if the generated code matches the intended behaviour. The
differential harness deliberately does **not** import or reuse production
offset arithmetic, primitive tables, or code templates.

## Pipeline

```
generator.ts  -> restricted IR (ir.ts)
                   |        \____________________
                   v                              \
build-parser.ts   serializer.ts           interpreter.ts (reference)
   public API      independent layout        independent cursor/bit reader
        \              /                               /
         \            v                               /
          differential.ts  compare result, final offset, error kind/path
                   |
              shrink.ts + replay.ts on mismatch
```

1. `generator.ts` produces a fixed sequence of declarations from a single seed
   (`rng.ts`, an integer-only mulberry32). The seed, caps and algorithm are the
   only inputs; there is no `Math.random()`, clock, or directory walk.
2. `serializer.ts` lays each declaration out into deterministic bytes,
   including pointer target segments appended after the main chain.
3. `build-parser.ts` constructs the same declaration through the public
   `Parser` API and runs the compiled production function.
4. `interpreter.ts` runs the IR independently.
5. `differential.ts` compares the returned structure, the final offset (observed
   through a trailing `saveOffset` probe), and a normalized error kind plus the
   reference interpreter's structured error path.

On mismatch, `shrink.ts` greedily removes declaration nodes and trailing input
bytes while the difference still reproduces, and `replay.ts` renders a
self-contained Node script that rebuilds the parser using only the public API.

## Supported AST subset

- Integer primitives (`u?int{8,16,32,64}{le,be}`) and floating point
  (`float{le,be}`, `double{le,be}`), with explicit per-field endianness.
- Consecutive big-endian bit fields, including a group that crosses a byte
  boundary, followed by a byte-aligned node. Little-endian bit extraction is
  covered via `.endianness("little")`.
- Fixed-length `string` (UTF-8) and `buffer`, including truncated inputs.
- Fixed-length `array` with an inline struct element type.
- Tag `choice` with numeric literal keys and an earlier `uint8` tag field.
- Relative and absolute `pointer` to an inline struct, restoring the main-chain
  offset afterwards.
- `nest` with an inline struct type (named and flattening forms).
- Simple numeric `assert` on fixed-width integers.
- A finite catalog of pure formatter built-ins (`builtins.ts`).

### Filtered out by the generator (nodes the reference interpreter does not
implement or that are not declarable on the supported platform)

- `seek`, `saveOffset` except the harness probe, `wrapped`, named aliases,
  `readUntil`, `lengthInBytes`, hashed (`key`) arrays, function/string tag or
  offset callbacks other than the one finite relative-pointer form, and
  `create` / context variables.
- Zero-length `string`, `buffer`, and `array`: the production builder rejects
  these with a truthiness check (`!options.length`). They are filtered at
  generation time rather than treated as supported semantics.
- Non-byte-aligned bit groups directly inside array/choice/pointer element
  structs. Production keeps a private bit cursor for those compound bodies, so
  an unaligned group there does not share the outer byte stream the way a
  top-level group or a `nest` does. The generator only emits full-width groups
  in such bodies; crossing groups are exercised at the root and through `nest`.
- Arbitrary user functions. Formatters are drawn exclusively from
  `builtins.ts`; the interpreter reproduces each by name instead of calling
  user code.

## Error model

Both sides classify failures as `range` (DataView/bounds), `choice` (undefined
tag), `assert` (assertion failure), or `other`. The reference additionally
records a structural path (for example `items.0.inner.magic`) and, for choice
errors, the offending tag value. Truncated fixed `string`/`buffer` reads match
production: the available prefix is returned and the offset advances by the
declared length; a subsequent primitive read surfaces the bounds error.

## Complexity and limits

Hard caps live in `ir.ts` (`LIMITS`): nesting depth 4, at most 6 nodes per
struct, arrays up to 4 elements, bounded string/buffer lengths, bit groups up
to 32 bits, and inputs up to 160 bytes. The generator emits a fixed number of
cases; every case also gets a small set of tail-truncation variants plus
unknown-tag and bad-assert variants where applicable. Total work is linear in
the number of declarations and input bytes per case. Shrinking is bounded by
node count and input length.

## Determinism and compatibility

- The same seed produces the same declarations, values, tags and bytes on any
  file ordering, locale, or Node minor version. Integer arithmetic is used
  throughout the PRNG.
- No network, real clock, timers, or filesystem traversal order are used.
- Tests run through the existing Mocha dependency. `npm test` invokes
  `scripts/run-tests.js`, which drives Mocha programmatically: Mocha 10.x's CLI
  loads `yargs/yargs`, whose extensionless entry is loaded as an ES module on
  newer V8/Node runtimes (`require is not defined in ES module scope`). The
  programmatic runner avoids that CLI-only path while keeping the existing dev
  dependencies and supported Node range.
