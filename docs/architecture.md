# Architecture — v0.2.7

The LLM stays at the engineering-decision layer. Deterministic code owns KiCad mutation and verification.

```text
Natural-language requirement
          |
          v
        LLM
 (engineering intent)
          |
          v
 Circuit IR v1 JSON
  source of truth
          |
          v
 kicad-flow-agent
 strict operator / STOP on error
          |
          v
 dsh-plugin-kicad-flow
  - validate IR
  - strict symbol preflight
  - deterministic placement
  - chunked MCP mutation
  - state v2 checkpoints
  - IR <-> KiCad reconciliation
  - ERC / DRC
          |
          +-------------------+
          |                   |
          v                   v
 KiCAD-MCP-Server          kicad-cli
          |                   |
          +---------+---------+
                    v
                  KiCad
```

## Compiler truth model

Three sources exist, with different authority:

1. **Circuit IR** — intended circuit and required endpoints.
2. **KiCad schematic/netlist** — actual materialized result.
3. **state.json** — checkpoint/history only.

A MCP response is never treated as proof that the schematic is correct. After every mutation chunk, the compiler exports/inspects the real KiCad netlist and reconciles it against the IR.

## Deterministic schematic flow

```text
validate IR
 -> strict symbol preflight (every IR pin verified verbatim: 11/12/14/A1/A2)
 -> endpoint coordinate collision check (cross-net sharing stops the compile)
 -> inspect current schematic
 -> add only missing components in chunks
 -> reconcile/checkpoint each chunk
 -> connect only missing endpoints in chunks (all nets via deterministic labels)
 -> reconcile/checkpoint each chunk
 -> add declared no-connect markers/properties
 -> full reconciliation
 -> ERC
 -> mark schematic complete
```

Default chunk sizes are 12 components and 16 endpoints. They are internal compiler policy, not model decisions.

## Resume and timeout semantics

A timeout may leave the backend still mutating the file. Therefore:

```text
timeout -> state=unknown_after_timeout -> STOP
```

The same compile invocation never retries the mutation. A later explicitly requested run first inspects the actual schematic and only schedules work still missing from the IR.

Unsafe existing states are not auto-repaired. Duplicate references, unexpected components, unexpected endpoints, or undeclared unconnected pins cause STOP.

## State v2

Every generated project may contain:

```text
<Project>/
  <Project>.kicad_pro
  <Project>.kicad_sch
  <Project>.kicad_pcb
  .kicad-flow/
    design.json
    state.json
    reconcile-netlist.xml
    erc.json
    drc.json
    backups/
```

`state.json` records the design hash, completed targets, current schematic status, confirmed references/nets, latest reconciliation report, and last operation/chunk status.

## Boundary of responsibility

The LLM owns topology, component selection, ratings, pin mapping and net meaning. The compiler owns mechanical EDA work, mutation order, batches, checkpoints, reconciliation, verification and artifact paths. The dedicated agent owns operational discipline: follow the plugin flow and stop/report rather than autonomously repairing code or infrastructure.
