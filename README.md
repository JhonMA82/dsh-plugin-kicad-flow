# dsh-plugin-kicad-flow

**Compilador determinista de hardware para KiCad.** Describes un circuito en un archivo JSON (Circuit IR) y el plugin lo convierte en un proyecto KiCad completo: esquemático, PCB, enrutado y paquete de fabricación — sin que nadie trace pistas, elija coordenadas ni toque KiCad a mano.

```
design.ir.json  ──►  esquemático  ──►  PCB  ──►  enrutado (freerouting)  ──►  DRC  ──►  Gerbers + BOM + CPL
     (tú)            (el plugin, verificado en cada etapa)
```

Versión actual: **0.4.2** (estable).

## Para quién es

Para usar con un agente de IA (por ejemplo, dentro de DeepSeek Harness): el modelo decide **qué** circuito es (componentes, footprints, nets) y el motor decide **cómo** materializarlo en KiCad. La IA nunca emite trazas, vias ni coordenadas — eso es trabajo del compilador, y es la razón por la que el resultado es reproducible.

## Garantía central: nada se da por bueno

Un "success" del backend MCP **no prueba nada**. El plugin considera un diseño correcto solo cuando:

1. todos los componentes esperados están colocados, sin referencias duplicadas;
2. todas las nets declaradas existen y cada pin está en exactamente una net;
3. la reconciliación IR ↔ KiCad (comparación contra el netlist real exportado) pasa;
4. ERC corre después de eso, y sus errores/warnings se reportan;
5. para fabricar: routing completo (unrouted = 0), DRC final con 0 errores, y solo entonces Gerbers/BOM/CPL.

Cualquier desviación → **STOP y reporte**. El plugin nunca repara, nunca reintenta tras un timeout y nunca usa `forceRebuild` como recuperación automática. Un timeout significa "resultado desconocido hasta reconciliar", no "falló".

## Qué trae 0.4.2

- Preflight estricto de símbolos y de **footprints** (existencia de librería/módulo y compatibilidad pin↔pad) antes de tocar el proyecto.
- Reanudación segura por fases desde `state.json` (checkpoints con reconciliación en cada lote).
- Tolerancia en reconciliación pre-merge para nets intrínsecas de pines coincidentes (p. ej. relés con COM duplicado).
- Conteos reales de tracks/vias en el resultado (fuente: reconciliación del board, no el router).
- Manifest de fabricación con sha256 de cada archivo.

Detalle completo por versión: [CHANGELOG.md](CHANGELOG.md) y `RELEASE-0.4.x.md`. Los límites de alcance (qué NO se implementa, por nivel): [ROADMAP.md](ROADMAP.md).

## Requisitos

- Node.js 22.19+ o 24+
- KiCad 10 con `kicad-cli` en PATH
- [KiCAD-MCP-Server](https://github.com/mixelpixx/KiCAD-MCP-Server) funcionando
- Java + [Freerouting](https://github.com/freerouting/freerouting) solo si usas target `routed`
- `zip` para el paquete de Gerbers

## Instalación

```bash
npm run build
npm pack                    # genera dsh-plugin-kicad-flow-0.4.2.tgz
npm test                    # 104 tests offline
```

## Uso mínimo

```bash
kicad_flow_validate_ir  designPath=/ruta/design.ir.json   # valida el IR, no toca KiCad
kicad_flow_compile      designPath=/ruta/design.ir.json target=schematic
kicad_flow_compile      designPath=/ruta/design.ir.json target=manufacturing   # esquemático→PCB→routing→Gerbers
```

Targets en orden: `schematic` → `pcb` → `routed` → `manufacturing`. Cada etapa reutiliza la anterior si su fingerprint coincide; `forceRebuild` es explícito y destruye el progreso.

Ejemplos de IR en [`examples/`](examples/), referencia de compilación en [`docs/`](docs/). El contrato operativo del agente que opera este plugin (reglas de STOP, protocolo de errores, modos NORMAL/DIAGNÓSTICO/REPAIR) está en [`docs/kicad-flow-agent.md`](docs/kicad-flow-agent.md).

## Un ejemplo real

El proyecto de prueba que validó esta versión: controlador VCM de 52 componentes y 35 nets, compilado de punta a punta con KiCad 10.0.6 — ERC 0 errores, 361 pistas / 34 vias enrutadas, unrouted 0, DRC final 0/0, Gerbers + BOM + CPL exportados.

## Límites honestos

ERC/DRC y la reconciliación prueban **consistencia estructural**, no seguridad eléctrica. Ratings de componentes, protección transitoria, EMC, térmica y seguridad funcional siguen requiriendo validación de ingeniería. Este plugin no sustituye a un ingeniero; elimina el trabajo mecánico y los errores de transcripción.

## Licencia

MIT
