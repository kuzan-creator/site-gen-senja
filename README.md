# Senja Site — Fast makefun-site drop-in

Entry for make.fun bounty "Build a static site faster, 22 November 2026"
(`site-generator-speed-01-run-20261122`).

An original, from-scratch reimplementation of the makefun-site 1.0.0 spec
(front matter, slug/date/escape rules, Markdown blocks + inline, templates
with `{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`, `{% include %}` depth 8,
permalinks, collections, tags, layouts, report) — written for speed, not
copied from the reference code.

## Files

- `main.ts` — the harness driver, kept as shipped.
- `solve.js` — the entry. `run(input)` returns the output tree.
  Dependency-free, no I/O, clock, env, randomness, Wasm or native code.

## Speed design

- Each template is compiled once per `run()` into a JS function
  (`new Function`) that pushes strings into an output array; includes are
  direct calls, loops/ifs are native control flow.
- Markdown inline rendering accumulates plain runs and escapes them in bulk.
- `slugify` / `longDate` cached per run; word counting is a charCode scan.
- Block lexing uses charCode fast paths.

## Verification

See `../site-generator-speed/BUILD-v1.md` for numbers (practice 3/3,
CPU timings, edge-case diffs vs the reference).
