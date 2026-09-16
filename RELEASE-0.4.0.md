# dsh-plugin-kicad-flow 0.4.0 — Level 1 Complete (Release Report)

Fecha: 2026-09-16 · Estado: PUBLICADO e instalado en perfil web · VCM: sin cambios.

## Alcance entregado (Level 1)

Pipeline completo: `requirements → Circuit IR → schematic → ERC → footprints → PCB →
placement → routing (freerouting) → routing recon → copper zones → final DRC →
Gerbers → drill → BOM → CPL → manufacturing package → STOP`.

- `CompileTarget`: `schematic | pcb | board (alias) | routed | manufacturing`.
- Nuevas herramientas: `kicad_flow_route`, `kicad_flow_routing_reconcile`,
  `kicad_flow_manufacturing_pack`.
- `RoutingBackend` abstraction: el LLM nunca emite trazas ni coordenadas; el
  backend (freerouting vía export_dsn/import_ses) decide el cobre.
- Routing preflight gates (reconcile OK, ERC errors=0, PCB recon OK, footprints,
  netclasses, outline, backend preflight) y routing recon: `unrouted=0` requerido,
  si no `phase='incomplete'` + STOP; pads flotantes contados aparte en
  `floatingPads`.
- Checkpoints + idempotencia: segunda corrida devuelve `reused=true` sin duplicar
  tracks/vias/zones (verificado en suite y en E2E real con sha256 del tablero y
  del ZIP sin cambios).
- Copper zones: solo zonas declaradas explícitamente en el IR (una
  `add_copper_pour` por declaración), `refill_zones` server-side, reconcile +
  chequeo live contra `query_zones` (zona ausente o sin fill ⇒ STOP).
- Final DRC: gate `errors=0 AND unconnected=0`; errores clasificados bloquean el
  pipeline antes de manufacturing.
- Manufacturing gate (motor y `evaluateManufacturingGate` en manufacturing.ts,
  incluyendo ERC): pack solo si todo pasa. `state.status = 'level1_complete'` al
  terminar `manufacturing`.
- Pack reproducible: directorio `manufacturing/` (gerbers/, ZIP, BOM.csv,
  CPL.csv, positions.csv, manifest.json con sha256 por artefacto). ZIP byte a
  byte reproducible (entradas ordenadas, timestamps fijos 1980).
- State v3 (migración v2→v3 cubierta en tests).

## Cambios de código respecto a la iteración anterior

1. `src/engine.ts` — `compileZones`: llamada `add_copper_pour` alineada con el
   esquema zod real del KiCAD-MCP-Server: `{ net, layer, clearance, outline:[{x,y},…] }`.
   El servidor **stripea** claves desconocidas: `netName`, `priority`, `unit`,
   `minWidth`, `fillType` no llegan al handler python (defaults: priority 0,
   minThickness 0.25 mm, fill sólido). Fix verificado en E2E real.
2. `src/manufacturing.ts` — recolección de gerbers acepta extensiones Protel que
   emite KiCad 10 (`gtl/gbl/gts/gbs/gto/gbo/gtp/gm1/gko`, además de `.gbr`).
   Antes solo `.gbr`: el ZIP real salía con el drill solamente (defecto
   detectado en E2E real, corregido y cubierto en tests con `GT=gtl`).
3. `src/manufacturing.ts` — `evaluateManufacturingGate` incluye el chequeo de ERC
   (`schematic.erc`), alineando el gate del tool standalone con el del motor.
4. Fixture E2E genérico: J1 ahora es SMD
   (`PinHeader_1x02_P2.54mm_Vertical_SMD_Pin1Left`). Con el pad THT original,
   freerouting dejaba el via/traza VCC en B.Cu estrangulando 2 de 4 thermal
   spokes del pad GND contra la zona ⇒ `starved_thermal` real de KiCad (el gate
   funcionó correctamente y paró el pipeline). El servidor MCP no expone modo de
   conexión de pads, así que el fixture usa SMD para no depender de decisiones
   del autorouter. Aprendizaje documentado para fixtures futuros.

## Verificación

| Verificación | Resultado |
|---|---|
| Suite unitaria + regresión (`tsc && node --test tests/*.test.mjs`) | **99/99 pass** |
| E2E real `routed` (KiCAD-MCP-Server, KiCad 10.0.6) | ERC 0/0, DRC fundación 0/0, routing `ok unrouted=0 tracks=16`, zonas 1/1, final DRC `errors=0 unconnected=0` (1 warning `isolated_copper` esperado), `completed=[schematic,pcb,routed]` |
| E2E real `manufacturing` (fresh) | `level1Complete=true`, pack con 8 gerbers + drill + BOM(4) + CPL(4, sin #PWR) + ZIP (9 entradas) + manifest 13 archivos hasheados, `state v3 completed=[schematic,pcb,routed,manufacturing]` |
| E2E real idempotencia (2.ª corrida) | `reused=true` en 0.1 s; sha256 del `.kicad_pcb` y del ZIP sin cambios |
| Reproducibilidad ZIP (tests) | sha256 idéntico entre corridas |
| Proyecto | `kicad-projects/level1-e2e-generic/` (fixture genérico; VCM intacto) |

Notas de E2E real (no bloqueantes): warnings de paridad DRC
(`net_conflict` por prefijo `/` del netname del esquema vs PCB,
`footprint_symbol_field_mismatch` por Description vacía en PCB) — cosméticos,
provienen de la generación 0.3.0; warning `isolated_copper` de la zona B.Cu sin
cobre GND del mismo lado (esperado en el fixture).

## Artefactos

- Paquete npm: `/tmp/dsh-plugin-kicad-flow-0.4.0.tgz`
  (sha256 `fe5344c752d2eae3b5ad4c2790553fc176b938ff4155e237ec3070ce11ae0be0`)
- Paquete zip: `/tmp/dsh-plugin-kicad-flow-0.4.0.zip`
  (sha256 `c7efec0ddc260b4a505cdfbb1468d1e235972137a9988b2301a715e67a5b3757`)
- Instalación: `dsh plugin --profile web list` → `dsh-plugin-kicad-flow@0.4.0` ✓
- Fuente: `/home/juan/dev/Kicad/dsh-plugin-kicad-flow-v0.4.0/`
- IR del fixture: `/tmp/kf040-e2e.ir.json` · driver E2E: `/tmp/kf-040-real-e2e.mjs`

## STOP

0.4.0 Level 1 completo y publicado. No se inicia Level 2 sin petición explícita.

---

# Anexo — Recompilación VCM con 0.4.0 (2026-09-16, autorizada por el usuario)

## 1. Fix autorizado del IR (ERC pin_to_pin)

- **Hecho**: el IR heredado de 0.2.x llevaba PWR_FLAG explícitos P1 (VBAT_FILT) y
  P2 (GND) además de los `#PWR##` que 0.3.x/0.4.x genera automáticamente para
  las nets `erc.powerDriven` → dos "power output" por red → ERC pin_to_pin ×2.
- **Cambio mínimo aplicado** (autorizado en sesión): eliminados P1 y P2 del IR
  (54→52 componentes; 2 endpoints de nets; cero referencias residuales). Los
  PWR_FLAG siguen garantizados por `expectedPowerFlags` (#PWR01 GND, #PWR02
  VBAT_FILT). IR revalidado: ok, 0 errores.
- **Resultado**: recompilación esquemática 0.4.0 OK, **ERC 0 errores**.

## 2. Fix autorizado de KiCAD-MCP-Server (timeout)

- **Hecho**: `create_board_from_schematic` (52 comps) superó el timeout por
  defecto de 30 s del servidor (Node). El policy `command-timeout.ts` da 600 s
  a `sync_schematic_to_board`, pero no a su envoltorio
  `create_board_from_schematic`, que internamente ejecuta ese mismo sync
  (kicad_interface.py:1919). Causa raíz: omisión del policy, no del IR.
- **Cambio mínimo aplicado** (autorizado en sesión): `create_board_from_schematic`
  añadido a `LONG_RUNNING_COMMANDS` en
  `tools/KiCAD-MCP-Server/src/command-timeout.ts` + `npm run build` (tsc, exit 0).
  Sin más cambios.
- Antes del fix, el estado quedó `pcb=unknown_after_timeout`; además se
  eliminaron 2 procesos huérfanos del servidor MCP (driver del run ERC-muerto).

## 3. Recompilación VCM tras los fixes

Pendiente de relanzamiento con `forceRebuild=true` (driver `/tmp/kf-040-vcm.mjs`,
target routed). Los artifacts 0.3.x previos permanecen en
`.kicad-flow/backups/2026-09-16T07-16-49-131Z/` y `.mcp-backups/`.

