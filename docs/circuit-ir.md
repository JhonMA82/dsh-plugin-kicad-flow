# Circuit IR v1

Circuit IR is deliberately small. It is not another EDA format; it is the stable interface between an LLM and the deterministic compiler.

## Required

```json
{
  "version": 1,
  "project": { "name": "my-board", "profile": "generic" },
  "components": [
    {
      "ref": "R1",
      "symbol": "Device:R",
      "value": "10k",
      "footprint": "Resistor_SMD:R_0603_1608Metric",
      "block": "sensor"
    }
  ],
  "nets": [
    {
      "name": "SIGNAL",
      "pins": [{ "ref": "R1", "pin": "1" }]
    }
  ]
}
```

## Useful optional fields

- `project.profile`: `generic` or `automotive`.
- `blocks`: preferred left-to-right functional block order.
- `component.block`: functional placement group.
- `component.schematic`: explicit schematic x/y only when really required.
- `component.pcb`: explicit PCB x/y only for hard mechanical constraints.
- `component.properties`: arbitrary BOM fields such as `LCSC`, `MPN`, `Manufacturer`.
- `component.noConnectPins`: intentionally unused pins.
- `net.global`: rails/cross-sheet scope. Independent of ERC semantics.
- `net.erc.powerDriven`: explicit designer statement that this net is
  legitimately powered. The compiler materializes exactly one `power:PWR_FLAG`
  artifact on that net so KiCad ERC treats it as driven. Default `false`,
  never inferred, and NOT implied by `global: true` — rails whose power comes
  from an explicit `power_out` pin (or that ERC does not question) must NOT
  carry it.
- `net.class`: netclass name.
- `netclasses`: custom track width / clearance / via settings.
- `board`: width, height, margin, autoroute, routing attempts, GND pours.
- `manufacturing`: output directory and export switches.

The compiler rejects duplicate references, duplicate net names, unknown component references and assigning the same component pin to two different nets.
