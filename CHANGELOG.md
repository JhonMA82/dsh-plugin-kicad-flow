# Changelog

## 0.2.7.1

Field fix for the first real 0.2.7 run: KiCad 10 netlist export
(`kicad-cli sch export netlist`) EXCLUDES power symbols entirely — no
`<comp>` entries, no net nodes, not even `unconnected-(#PWRxx-Pad1)` nets.
The 0.2.7 netlist-based reconciliation therefore reported `#PWR01/#PWR02`
as missing although they were present in the schematic, and the compile
stopped at the chunk-5 gate (correct fail-safe behavior).

- `SchematicSnapshot` gains optional `schematicArtifacts` (ref + attached
  net). `inspectSchematicNetlist` now enriches the netlist snapshot with
  `parseSchematicPowerFlags(schematicText)`: instances of `power:PWR_FLAG`
  parsed from the `.kicad_sch` (reference, origin, embedded pin-1 offset,
  rotation) plus the net attached via the label/global_label anchored at the
  artifact's pin origin (0.05 mm tolerance).
- Reconciliation uses schematic facts as the authority for artifact
  presence, attachment (`misattachedArtifacts`), per-net
  `powerFlagCounts` and unexpected `#PWR*` detection; the netlist-only path
  remains as fallback for synthetic snapshots. Real coverage: attached,
  floating and unexpected flags.
- Version 0.2.7.1 (plugin status + MCP client), CHANGELOG only; compiler,
  layout and IR untouched. Suite: 49/49.

## 0.2.7

Explicit ERC power intent for the reconciled vcm-controller schematic
(ERC failed only with 2× `power_pin_not_driven`: GND/U1-14 and VBAT_FILT/U2-1
had no `power_out` driver; VCC5 did not, thanks to U2-3 VO). Wiring is
untouched; the fix models designer intent, not ERC errors.

- IR v1 extension: optional `net.erc.powerDriven` (boolean, default `false`,
  never inferred, independent of `net.global`). Validation accepts the block
  only with a boolean `powerDriven`.
- For every `powerDriven: true` net the compiler materializes exactly one
  `power:PWR_FLAG` artifact with deterministic reference `#PWR01`, `#PWR02`,
  … (sorted by net name), placed deterministically below the working area
  through the shared de-collision pass, wired by the same label mechanism,
  checkpointed in `state.json` (reconciliation + `confirmedComponentRefs`),
  and idempotent on resume (an attached flag yields no add/connect task).
- Reconciliation now separates functional components from compiler
  artifacts: `expectedComponents` stays at the IR count, artifacts are
  tracked as `expectedArtifacts` / `missingArtifacts` /
  `misattachedArtifacts` / `unexpectedArtifacts` plus per-net
  `powerFlagCounts`; a missing, misattached, or unexpected `#PWR*` fails
  reconciliation. Pending (added-not-yet-wired) flags are the only allowed
  intermediate state; arbitrary `#PWR*` extras fail as unexpected components.
- Endpoint collision detection hardened: `computeEndpointCoordinates` keys
  offsets by reference, but 0.2.6 passed a symbol-keyed map, so the detector
  resolved zero coordinates (silent no-op — origin separation still prevented
  the field failure, but the gate itself was vacuous). The engine now keys by
  reference and the gate is real; it also covers artifact pins.
- vcm-controller fixture IRs (`vcm-controller.slim.ir.json`,
  `vcm-controller.ir.json`) declare `erc.powerDriven` exclusively on `GND`
  and `VBAT_FILT`, the two ERC-confirmed under-driven nets. `VCC5` (driven
  by U2-3 `power_out`) gets no flag.
- New `tests/regression-0.2.7.test.mjs` (12 tests): default false, global ≠
  powerDriven, one/two flags, resume idempotency, state checkpoint,
  exact-artifact acceptance, unexpected-flag failure, artifact-inclusive
  collision detection, no flag for power pins without intent, fixture
  declaration audit, deterministic artifact layout. Full suite: 47/47.
- Known-pending (requires separately authorized real compile + ERC): ERC
  fixture run confirming `power_pin_not_driven = 0`.

## 0.2.6 (transport fix)

- Fixed `McpBridge.call` for `@modelcontextprotocol/sdk >= 1.30`, whose
  `callTool` signature is `(params, resultSchema?, options?)`. The timeout
  object was passed as the second argument, so `protocol.js` validated every
  tool response against a plain object and every MCP mutation crashed with
  `TypeError: v3Schema.safeParse is not a function`, while
  start/`listTools` kept working. The timeout is now the third argument
  (`undefined` selects the default result schema). No compiler, IR, or
  layout changes; covered by `tests/mcp-bridge.test.mjs`.

## 0.2.6

Field-failure repair for the 52-component vcm-controller design (0/39 power-rail
endpoints materialized, 5/5 K1 relay pins skipped, Q1-3 shorted into DRAIN5).
No IR, schematic, server, or architecture changes; compiler-only fixes.

- `global: true` nets are now materialized with deterministic sheet-local
  labels, exactly like every other net. `global: true` can never mean "skip
  connection". No `power:` symbols are introduced unless the IR requests them.
- Strict symbol preflight now verifies every IR pin selector verbatim against
  the preflight pin list before any mutation. Multi-digit (`11/12/14`) and
  alphanumeric (`A1/A2`) pins resolve generically; unknown pins stop the
  compile with the offending `ref:pin (symbol)` list. Pin selectors stay
  opaque strings end to end, never numerically coerced.
- Auto-placement enforces a deterministic 15.24 mm minimum origin separation
  (explicit IR coordinates win and are never moved). Before any mutation the
  engine maps every endpoint to absolute pin-base coordinates from preflight
  offsets and refuses to wire when endpoints of different nets coincide, so a
  placement defect stops the compile instead of shorting nets silently.
- `batch_connect` reporting `Placed 0 label(s)` is now a hard semantic
  failure even when the failed count is 0.
- Chunking, state v2 checkpoints, resume, `unknown_after_timeout`, and
  IR ↔ KiCad reconciliation are unchanged.
- New `tests/regression-0.2.6.test.mjs`: global-rail materialization,
  multi-endpoint global netlist, numeric/alphanumeric relay pins, Q1-D/Q6-S
  collision reproduction, layout separation, exact DRAIN5 membership, full
  relay+FET+rails reconciliation with only declared no-connects, resume
  without duplication, connection-phase timeout, preflight rejection before
  mutation, and the zero-label guard.

## 0.2.5

- Added deterministic chunking: 12 components and 16 connection endpoints per batch by default.
- Added state v2 checkpoints after reconciled chunks.
- Added `unknown_after_timeout`; timed-out mutations stop and are not automatically retried.
- Added read-only `kicad_flow_reconcile` using `kicad-cli sch export netlist --format kicadxml`.
- Added exact IR ↔ KiCad comparison for component refs, duplicate refs, net names and endpoints.
- Normalizes KiCad root-sheet local net names (`/NAME` -> `NAME`).
- Matches IR symbolic pin names against KiCad `pinfunction` as well as numeric pin IDs.
- Added safe adoption/resume of existing partial schematics: only missing refs/endpoints are materialized.
- Blocks resume on duplicate references, unexpected components, unexpected net endpoints or undeclared unconnected pins.
- Symbol preflight is strict again: failure stops before component mutation.
- MCP client `callTool` timeout raised to 660 seconds to exceed the KiCAD-MCP long-operation window.
- Added `kicad_flow_erc`, which refuses to run unless reconciliation passes.
- Updated system prompt to enforce `ERROR -> STOP -> REPORT` rather than autonomous repair.
- Added regression tests for chunking, safe resume, timeout checkpointing and netlist reconciliation.


## 0.2.4

- Make `batch_list_symbol_pins` a soft preflight instead of a compile gate.
- Detect stale/mixed KiCAD-MCP-Server installations where the TypeScript tool is advertised but the Python backend returns `success=false` without a message.
- Fall back to a single `list_symbol_pins` diagnostic probe; both failures become warnings, not blockers.
- Keep `batch_add_components` as the authoritative schematic materialization step and hard-stop on its per-component errors.
- Preserve the 0.2.3 semantic failure guards so downstream `batch_connect` cannot hide component-placement failures.

## 0.2.4

- Added one-shot `batch_list_symbol_pins` preflight for every unique symbol before schematic mutation.
- Fixed hidden batch failures: textual summaries such as `Added 0 component(s), 52 error(s)` now stop compilation immediately and surface the real per-symbol errors.
- Prevents misleading downstream `batch_connect` failures when no components were actually placed.
- Added semantic guards for `batch_connect`, batch component edits, and symbol-pin preflight errors.
- Added regression tests for the exact hidden-error pattern observed with the 52-component VCM design.
- Improved deterministic schematic placement to keep many functional blocks inside an A4-landscape-friendly working area instead of placing all blocks in a single horizontal row.

## 0.2.2

- Fixed the KiCAD-MCP-Server `create_project(path, name)` path contract. Projects now materialize at `<projectDir>/<projectName>/<projectName>.kicad_*` as the compiler expects.
- Switched model-facing validation/compile to **file-first Circuit IR transport** via required `designPath`; large IR objects no longer cross the DSH tool boundary.
- Validation returns a compact summary instead of echoing the full normalized design and placement maps.
- Canonicalizes every model-facing result through JSON serialization to prevent DSH `not lossless JSON` failures caused by `undefined` optional fields.
- Updated the system prompt to make the IR file the source of truth.
- Added regression coverage for the project-path contract.

## 0.2.1

- Fixed DeepSeek Harness bundle packaging: adds `dsh.bundle` and `cordis.patch.yml`.
- Reduced required injection to `tools` only.
- Added current ToolRuntime mandatory canonical `output` declarations.
- Updated model-visible tool names to underscore form.
- Updated system-prompt registration to current `order`/`text` contract.
- Added Schemastery `Config` schema with defaults.
- Targets current DSH/Node runtime requirements.


## 0.2.0

- Replaced the agent-driven 6-stage orchestration with a **Circuit IR compiler**.
- Added `kicad_flow.compile` as the primary one-call workflow.
- Added deterministic schematic and PCB seed placement.
- Uses `batch_add_components`, `batch_connect`, `batch_move_components` and other batch primitives internally.
- Stores normalized design and pipeline state in `.kicad-flow/`.
- Re-running an unchanged design can reuse the previous result; changed designs require explicit `forceRebuild`.
- `forceRebuild` backs up generated KiCad files before rebuilding.
- Raw `kicad.mcp_call` is disabled by default (`exposeRawMcp: false`).
- Added actual `kicad_flow.manufacturing_pack` implementation.
- Added JLCPCB Gerber/drill/BOM/CPL generation.
- Added CLI (`kicad-flow validate|normalize|preview`).
- Added offline unit tests for IR validation and deterministic layout.
- Removed hard dependency on an automotive-only checklist; automotive is now a profile with warnings/default netclasses.
- Uses KiCAD-MCP-Server's own `autoroute` workflow instead of hand-written DSN/SES import logic.
