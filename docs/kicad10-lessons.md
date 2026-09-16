# KiCad 10 compatibility notes

These are the compatibility rules retained from the original plugin and encoded in v0.2 where they still matter.

## Schematic authoring

- Use the KiCAD-MCP-Server batch authoring surface instead of writing `.kicad_sch` S-expressions directly.
- Net-label-driven wiring is preferred because it removes wire-crossing and junction-coordinate ambiguity.
- Intentionally unused pins should be represented as `noConnectPins` in Circuit IR.
- Run `validate_schematic` when the connected MCP exposes it, then enforce ERC with `kicad-cli`.

## ERC / DRC

- JSON reports require `-o <file>`; do not expect JSON on stdout.
- KiCad 10.0.0-10.0.6 was observed returning ERC positions in inches while declaring `coordinate_units: mm`. v0.2 retains a version-gated ×25.4 diagnostic-position workaround.
- DRC coordinates follow their declared units.
- DRC is blocking on errors, unconnected items and schematic parity issues.

## Netclasses

- Netclass definitions and assignments live in the `.kicad_pro` project settings on modern KiCad.
- v0.2 prefers KiCAD-MCP-Server `create_netclass`, including explicit net assignments, because current server versions persist those settings correctly.
- Direct `.kicad_pro` patching remains only as a compatibility fallback for older MCP builds.

## Freerouting

- v0.2 does not implement its own pcbnew DSN/SES bridge.
- It delegates the complete round trip to the MCP `autoroute` operation, which exports DSN, runs Freerouting, imports the winning SES and saves the routed board.
- Multiple attempts can be requested through `board.routingAttempts`.

## Manufacturing / JLCPCB

- Gerber archive: `<Project>_Gerbers.zip`.
- Exported layers: `F.Cu,B.Cu,F.Mask,B.Mask,F.SilkS,B.SilkS,F.Paste,Edge.Cuts`.
- Drill: Excellon, millimetres.
- Position export: CSV, millimetres, both sides, drill-file origin.
- KiCad position CSV is mapped to JLCPCB CPL columns: `Designator,Val,Package,Mid X,Mid Y,Rotation,Layer`.
- The earlier real-board test showed a Y-up-negative position export. When board height is known, v0.2 normalizes it with `Mid Y = boardHeight + PosY`.

## Design principle carried into v0.2

The model should decide circuit intent and engineering facts. Coordinate transforms, batching, KiCad tool selection, stage order and file export belong in deterministic code.
