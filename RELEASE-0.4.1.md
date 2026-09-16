# dsh-plugin-kicad-flow 0.4.1 — Hardening de preflights genéricos (Release Report)

Fecha: 2026-09-16 · Estado: working copy verificada (104/104 tests); instalación en
perfil web pendiente de reempaquetado posterior si se autoriza. VCM: compilación
`routed` completa pasada con las correcciones 1-3 (ERC 0 errores, 35/35 nets,
unrouted=0, DRC final 0/0).

## Origen

La campaña de recompilación del proyecto de prueba `vcm-controller` (52 componentes,
35 nets) expuso tres huecos **genéricos** del pipeline — ninguno específico de VCM —
más un defecto cosmético del resultado expuesto al driver. Esta versión los cierra.

## 1. Gate `success=false` del MCP (engine.ts, REPAIR autorizado en sesión)

`call()` ignoraba `result.json.success === false` de herramientas MCP como
`batch_move_components` (all-or-nothing: referencias ausentes ⇒ `success:false` y
(0,0) intacto). El motor proseguía como si nada. Ahora:

```ts
if (result.json.success === false) {
  throw new Error(`KiCad MCP ${name} failed: ${message}${details}`);
}
```

## 2. `assertSafeToResume` fase-consciente (engine.ts)

Los checkpoints de **solo componentes** (post-chunk `batch_add_components` y
post-todos-los-componentes) exigían `netIssues` limpios, pero antes de la fase de
conexiones ninguna net del IR puede existir aún en la netlist. Nueva firma:

```ts
assertSafeToResume(report, phase: 'components' | 'full' = 'full')
```

`'components'` exige solo invariantes de componentes (refs duplicadas, componentes
inesperados); los checkpoints de conexiones y la validación final mantienen la fase
`'full'` íntegra. Los checkpoints pre-añadido (resume) y post-conexiones siguen
estrictos.

## 3. Tolerancia de pre-merge para cortos intrínsecos de símbolo (reconciliation.ts)

Símbolos oficiales con pins coincidentes (p. ej. `Relay:G5V-1`: COM duplicado en los
pins 5 y 6, mismo origen/rotación/longitud, pin 6 oculto) generan desde su colocación
una red auto-nombrada real de 2 nodos (`Net-(ref-PadN)`) que no puede casar con el IR
hasta que `batch_connect` la absorbe bajo el label común. Regla aplicada en el bucle
de redes no representadas en el IR:

- Todos los nodos de la red mapean (ref,pin) a **una misma** net del IR → tolerada
  (pre-merge; desaparecerá al materializarse su label).
- Algún nodo sin net IR, o nodos de ≥2 nets IR distintas → sigue siendo error real
  (corto no intencionado) y bloquea.
- La validación final estricta no cambia: una red intrínseca que sobreviva a todas
  las conexiones con nodos que no casan con la net final sigue fallando.

## 4. Preflight estricto de footprints (nuevo `src/footprint-preflight.ts`)

Ejecutado tras `preflightSymbols` y `assertNoEndpointCollisions`, **antes de
cualquier mutación** de componentes/huellas:

- **(a) Existencia**: cada `footprint` declarado se resuelve por la cadena
  `fp-lib-table` (KICAD_CONFIG_HOME / `~/.config/kicad/<ver>` → tablas anidadas
  `(type "Table")` → template global) con sonda de raíces por defecto para
  `${KICADn_FOOTPRINT_DIR}` sin resolver. Un renombrado upstream (el caso real
  `Fuse_SMD.pretty` → `Fuse.pretty` en KiCad 10, que antes pasaba como
  `footprints_skipped` y acababa en (0,0) con un error de courtyard confuso) ahora
  aborta en el arranque con el motivo exacto.
- **(b) Compatibilidad pin↔pad**: todo pin usado por el diseño (endpoints de nets +
  no-connect) debe existir como pad en el `.kicad_mod` (caso real: pins
  `A1/A2/11/12/14` de `Relay:Relay_SPDT` vs pads `1,2,5,6,9,10` de
  `Relay_SPDT_Omron_G5V-1`, que antes se descubría en la reconciliación de PCB).

Componentes sin footprint declarado: no compiten aquí (lo reporta la fase PCB).
Errores agregados con detalle por componente; fallo = STOP sin mutación de contenido.

## 5. Conteos de routing autoritativos en el resultado de `compile()` (cosmético)

`compileRouted` devolvía `routeResult.tracks/vias` (el backend freerouting no los
cuenta ⇒ 0/0) en lugar de los de la reconciliación sobre el board parseado
(autoritativa). Ahora: `tracks: recon.tracks, vias: recon.vias`.

## Verificación

- Suite: **104/104 tests** (99 previos + 5 nuevos en `tests/footprint-preflight.test.mjs`
  para `parseFpLibTable`, resolución anidada/sobreescritura por versión, sonda de
  raíces, parseo de pads y rechazo engine-level de pin↔pad con cero mutaciones).
- E2E real: `vcm-controller` target `routed` → todos los gates pasados
  (reconciliación 52/52 y 35/35, ERC 0 errores/2 warnings de caché de símbolo,
  freerouting 362 tracks / 34 vias, unrouted=0, DRC final 0/0).

## No incluido (pendiente de decisión)

- Reempaquetado del tgz instalable con los puntos 4-5 (el tgz 0.4.1 publicado en la
  sesión contiene solo 1-3).
