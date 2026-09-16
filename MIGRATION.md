# Migrating to 0.2.6

Circuit IR v1 is unchanged. No IR rewrite needed. State v2, chunking,
checkpoints, resume, and `unknown_after_timeout` semantics are unchanged.

Behavior changes that fix the vcm-controller field failure:

1. `global: true` nets compile to deterministic sheet-local labels, like all
   other nets. If you relied on `global_label` objects appearing in the
   schematic for power rails, expect plain `label` objects instead; net
   membership is what reconciliation verifies.
2. Symbol preflight rejects unknown pin selectors before any mutation. IRs
   with pin typos that previously compiled into unconnected pins now stop
   with the offending `ref:pin (symbol)` list.
3. Auto-placement separates symbol origins by 15.24 mm and the compiler
   refuses to wire cross-net endpoint coincidences. Extremely dense designs
   that used to compile into shorted nets now either spread out or stop with
   the colliding coordinate.

Upgrade path: install 0.2.6, run `kicad_flow_reconcile` on the existing
project, then `kicad_flow_compile` without `forceRebuild` only when the
existing state is safe to resume.

---

# Migrating to 0.2.5

Circuit IR v1 is unchanged. Existing 0.2.x IR files do not need rewriting.

## Important change: do not automatically force rebuild

0.2.5 can inspect and safely adopt a partial 0.2.4 schematic. For an existing project:

1. preserve the current `.kicad_sch` and backups;
2. install 0.2.5;
3. run `kicad_flow_reconcile` with the same `designPath`;
4. if reconciliation reports no duplicates/unexpected endpoints, run `kicad_flow_compile` **without** `forceRebuild`;
5. 0.2.5 materializes only missing components/endpoints and checkpoints each confirmed chunk.

If reconciliation reports duplicates (for example a timed-out component batch that was later repeated), unexpected components, unexpected net endpoints, or undeclared unconnected pins, the compiler stops. Resolve or explicitly restore a known-good checkpoint before retrying; the plugin does not repair those states automatically.

## State format

`.kicad-flow/state.json` is upgraded to version 2 when 0.2.5 takes control. It stores:

- overall completed targets;
- schematic status (`pending`, `in_progress`, `unknown_after_timeout`, `failed`, `reconciled`, `complete`);
- confirmed component references;
- confirmed net names;
- latest reconciliation report;
- last operation and chunk status.

The actual KiCad netlist remains authoritative; state is a checkpoint/history record, not proof that the file is correct.

## Timeout semantics

A timeout no longer means "failed and safe to retry". It means `unknown_after_timeout`. Compilation stops immediately. A later explicitly requested run reconciles the current file before doing additional mutation.

## Preflight

Symbol preflight is a hard gate in 0.2.5. A broken or unavailable symbol-resolution backend stops before component placement instead of continuing optimistically.

---

# Migration from 0.1.x

Normal architecture remains:

`LLM -> Circuit IR JSON -> kicad_flow_compile -> deterministic compiler -> KiCAD-MCP-Server -> KiCad`

Keep `exposeRawMcp: false` for normal work. Raw MCP is diagnostic only.
