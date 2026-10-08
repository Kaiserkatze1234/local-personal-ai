# Full Autonomous Development Loop Report

**Projekt:** `local-personal-ai` · **Branch:** `arena/e0389ad4-local-personal-ai`
**Stand:** 2026-10-08 · **Basis-Commit:** `4a477bb` (Projektstand unabhaengig vom Loop)

Dieser Bericht beschreibt den gebauten Kreislauf

```
Arena  →  Code-Aenderung  →  GitHub  →  Windows-PC  →  Testlauf  →  Report
      ↑                                                                  ↓
      └──────────────  Rueckkanal (Check, PR-Kommentar, Auftrag)  ←───────┘
```

und trennt sauber, was **hier verifiziert** wurde und was **auf dem
Windows-Runner noch nicht gelaufen ist** (Abschnitt 11 – keine Scheinaussage).

---

## 1. Architektur

Kleinste sinnvolle Aufteilung: **ein** Einstiegspunkt, **ein** Reportformat,
**eine** Sicherheitsentscheidung. Alles laeuft auf dem vorhandenen Node-Stack
(keine neuen Laufzeitabhaengigkeiten ausser `@playwright/test` als devDependency).

```
npm run test:autonomous  (scripts/autonomous-test.mjs)
  │
  ├─ prereqs      Node/npm/OS, node_modules, Node-ABI-Probe, Electron-Dist,
  │               Playwright, Plattenplatz, Ollama-Erreichbarkeit
  ├─ native       scripts/rebuild-native.mjs  (Electron-ABI-Binding, gecacht)
  ├─ typecheck    tsc node + web
  ├─ build        scripts/build.mjs + vite build
  ├─ unit         ┐ EINE Vitest-Ausfuehrung, zwei Sichten
  ├─ integration  ┘ (Dateien, die die echte CoreApp booten)
  ├─ smoke        LPAI_SMOKE=1 Electron in Wegwerf-Datenordner (SMOKE_OK + Screenshot)
  ├─ e2e          npx playwright test  (echtes Electron)
  └─ ollama       tests/ollama-live.test.ts gegen den echten lokalen Server
        │
        ├─ test-reports/latest.json|.md (+ zeitgestempelte Kopien)
        ├─ test-reports/latest-fix-prompt.md      (nur bei Fehlschlag)
        ├─ test-reports/latest-analysis.json
        └─ test-reports/cycle-state.json          (Runden + Fingerprints)
```

Statusmodell: `PASS` / `FAIL` / `SKIP` / `INFRASTRUCTURE_ERROR`, Gesamturteil
`FAIL` > `INFRASTRUCTURE_ERROR` > `PASS`, Exitcodes 1 / 2 / 0.

## 2. Aenderungen (Dateien)

**Neu**

| Datei | Zweck |
| --- | --- |
| `scripts/autonomous-test.mjs` | Orchestrator (9 Stufen, Reports, Analyse, Guards, GH-Ausgaben) |
| `scripts/autonomous/report.mjs` | Report-Schema 1, Markdown, Reparaturauftrag, PR-Kommentar, Fingerprint |
| `scripts/autonomous/guards.mjs` | Zykluszustand, Stop-Regeln, gefaehrliche Aenderungen |
| `scripts/lib/ensure-bundle.mjs` | esbuild-Helfer (TS-Logik headless als `.mjs` ausfuehren, wie `scripts/bench.mjs`) |
| `scripts/analyze-failure.mjs` | CLI: Analyse eines fertigen Reports wiederholen |
| `scripts/feedback-pull.mjs` | Rueckkanal: Report + Artefakte + PR-Kommentar von GitHub holen |
| `scripts/windows/install-runner.ps1` | Einmalige Einrichtung des self-hosted Runners |
| `scripts/windows/remove-runner.ps1` | vollstaendiger Rueckbau |
| `src/main/diagnostics/failureAnalysis.ts` | Regeln + Prompt + Antwortvalidierung + Modellaufruf |
| `tests/e2e/harness.ts` | Electron-Launch, Isolation, scripted Provider, Diagnose-Anhaenge |
| `tests/e2e/startup.spec.ts`, `chat.spec.ts`, `memory-context.spec.ts`, `real-ollama.spec.ts` | 10 E2E-Szenarien |
| `playwright.config.ts` | seriell, 1 Worker, Trace/Screenshot nur bei Fehlschlag |
| `tests/autonomy.test.ts` | 29 Tests fuer Report, Guards, Analyse, Verdrahtung |
| `tests/e2e-contract.test.ts` | 5 Tests: IPC-Allowlist, Selektoren, Config-Schema, ps1-ASCII |
| `.github/workflows/autonomous-test.yml` | Push → self-hosted Windows-Runner → Artefakte, Kommentar, Eskalation |
| `.github/workflows/pull-request-ci.yml` | Fork-sichere Schnellpruefung auf GitHub-Runnern |
| `docs/AUTONOMOUS_LOOP.md` | Betriebshandbuch + die exakten einmaligen Schritte |

**Geaendert**

| Datei | Aenderung |
| --- | --- |
| `package.json` | Scripts `test:autonomous`, `test:e2e`, `analyze:failure`, `feedback:pull`; devDependency `@playwright/test` |
| `src/main/index.ts` | Electron-`userData` folgt `LPAI_DATA_DIR` → Tests isolieren auch Fensterzustand und Single-Instance-Lock |
| `scripts/native-swap.mjs` | **echter Bugfix** (siehe unten) |
| `tests/native-swap.test.ts` | zwei Regressionstests fuer genau diesen Bug (7 Tests gesamt) |
| `tsconfig.node.json` | `allowJs` — die Specs/Tests duerfen die `.mjs`-Loop-Module typisiert importieren |
| `.gitignore` | `test-reports/*` (Reports reisen als CI-Artefakt, nicht im Git) |
| `README.md` | Abschnitt „Automated test loop“ |

### Gefundener und behobener Fehler (Regression)

Beim ersten echten Durchlauf des Loops brach die Stufe `native` **und** die
komplette Testsuite zusammen: `better-sqlite3` war aus `node_modules`
verschwunden. Ursache war ein realer Fehler in `scripts/native-swap.mjs`:
Wenn der Producer (node-gyp/\@electron/rebuild) zuerst `build/Release`
**loescht** und danach scheitert, kopierte das `finally` das Sicherungsfile in
ein nicht mehr existierendes Verzeichnis → `ENOENT` aus dem `finally`, das
Paket blieb **ohne Node-Bindung** zurueck, das Backup lag verwaist herum.

Behoben durch:
* `mkdirSync(dirname(pkgBin), { recursive: true })` vor der Wiederherstellung,
* Byte-Vergleich (SHA) nach dem Restore statt stillem Vertrauen,
* **kein** `throw` mehr im `finally` (haette den Producer-Fehler maskiert),
 sondern gemerkter Fehler nach dem Block,
* zwei neue Regressionstests: „Producer loescht `build/Release` und scheitert“
 und „Restore muss die Originalbytes reproduzieren“.

Damit ist der Fall im Loop selbst zu Ende getestet — der erste Lauf hat einen
echten Defekt gefunden, der Loop hat ihn sichtbar gemacht, der Fix ist durch
einen Test abgesichert.

## 3. Wiederverwendete Komponenten (nichts neu erfunden)

* **`CoreApp`** (`src/main/app.ts`) — headless bootbar; die Analyse nutzt genau
  den App-Container, keine Parallelwelt.
* **ModelRouter + ModelRoleService + Capability-System + ResourceManager** —
  Modellwahl fuer die Fehleranalyse laeuft ueber `router.select('review',
  'classification', { preferSmall: true })`. Die Rollenanforderung
  `text_generation` schliesst Embedding-only-Modelle strukturell aus; es gibt
  **keinen** neuen Ollama-Client, kein neues Routing, keine Cloud, keine
  hartkodierten Modellnamen.
* **Provider-/Adapter-Abstraktion** (`ollama`, `openai_compat`, `mock`) — die
  E2E-Szenarien sprechen ueber `LPAI_OPENAI_BASE_URL` mit einem geskripteten
  Endpunkt; die App bleibt echt (Adapter, Router, ContextEngine, Renderer).
* **`scripts/rebuild-native.mjs` / `native-swap.mjs`** — die Native-Stufe ruft
  das vorhandene Skript, statt ABI-Logik zu duplizieren.
* **Smoke-Vertrag** (`LPAI_SMOKE=1` → `<dataDir>/smoke-result.txt` +
  `smoke-window.png`) — unveraendert wiederverwendet.
* **`tests/helpers.ts`, `MockProvider`, `tests/ollama-live.test.ts`** — die
  bestehende Testinfrastruktur; Unit/Integration sind **ein** Vitest-Lauf.
* **`scripts/bench.mjs` + `scripts/lib/ensure-bundle.mjs`-Muster** — dieselbe
  Technik (TS mit esbuild headless ausfuehren) fuer `failureAnalysis.ts`.
* **`docs/MASTER_SPECIFICATION.txt`-Sprache** — Statusvokabular
  (`PASS/FAIL/SKIP/INFRASTRUCTURE_ERROR`, ehrliche Fehlermeldungen) und
  Style-Regeln des Repos bleiben erhalten; `npm run lint` (biome) 0/0.

## 4. Automatisierung

* **Ausloeser:** `push` auf `main` und `arena/**`, plus manueller Dispatch
  (Eingaben `quick`, `require_ollama`, `max_attempts`). Bewusst **kein**
  `pull_request` fuer den self-hosted Job (Sicherheit, Abschnitt 9).
* **Ablauf pro Push:** Checkout des exakten Commits → Cache-Restore des
  Zykluszustands → `npm ci` → `npm run test:autonomous -- --ci …` →
  Artefakt-Upload → PR-Kommentar → ggf. Issue `needs-human` → Job-Fehler bei
  rotem Lauf.
* **GitHub-Ausgaben des Orchestrators:** `GITHUB_STEP_SUMMARY` (Kommentar +
  Markdown), `GITHUB_OUTPUT` (`verdict`, `exit_code`, `stop`, `stop_reasons`,
  `report_id`, `ollama_reachable`, `duration_s`), `::error::`/`::warning::`
  Annotationen je Stufe.
* **Artefakte:** `lpai-test-reports` (immer, 14 Tage) und `lpai-e2e-artifacts`
  (bei Fehlschlag, 7 Tage) inklusive Screenshots und Playwright-Traces.
* **Rueckkanal in den Arbeitsbaum:** `npm run feedback:pull` holt den letzten
  Lauf (Report, Fix-Prompt, Zykluszustand, PR-Kommentar) nach
  `test-reports/inbox/` und schreibt `BRIEF.md`.

## 5. E2E

`playwright.config.ts` + `tests/e2e/` — echtes Electron ueber `_electron.launch`:

| Szenario | Prueft |
| --- | --- |
| Start/Bridge/IPC | Fenster da, Renderer geladen, `window.lpai.invoke`/`onEvent`/`getPathForFile`, `app.info` gegen den Temp-Datenordner, `conversations.list`, unbekannte Methode wird blockiert |
| Sauberes Ende | Fenster schliessen → Prozess endet mit Exitcode 0 (Polling, kein `sleep`) |
| Chat | Antwort exakt wie vom Modell geliefert, Request enthaelt den Prompt, keine internen Marker in der Antwort, Turn in der DB |
| Streaming | Zwischenstand ist **echtes Praefix**, Endstand exakt (kein „alles auf einmal“) |
| Stop | Abbruch friert den Text ein, Send-Button kehrt zurueck, Text nach Stop unveraendert |
| Provider-Fehler | ehrlicher Hinweis (`.notice`) statt erfundener Antwort |
| Memory | „remember that …“ landet in der DB, taucht im naechsten gesendeten Prompt auf, **ueberlebt den Neustart** |
| Kontext | Verlauf im selben Gespraech im Request, in einem **neuen** Gespraech nicht |
| Relevanz | passende Memory steht vor der unpassenden im injizierten Block |
| Echtes Ollama | Antwort eines echten Modells, keine internen Marker, plausible Zeit — **skip mit Begruendung**, wenn kein Server antwortet |

Deterministik: ein winziger OpenAI-kompatibler Endpunkt (`ScriptedProvider`)
liefert geskriptete Antworten und **protokolliert die Requests** — Aussagen
ueber Kontext/Memory werden am tatsaechlich gesendeten Prompt geprueft, nicht
aus der Antwort geraten. Keine `sleep`-Ketten, keine Test-Hooks im Produktcode,
kein Produktivdaten-Verzeichnis: jeder Lauf bekommt `LPAI_DATA_DIR` unter
`%TEMP%`.

## 6. Fehleranalyse

1. **Deterministisch zuerst** — Regelkategorien (`infrastructure`,
   `runtime_provider`, `build_defect`, `test_defect`, `ui_defect`,
   `regression`, `code_defect`, `preexisting_unrelated`, `unknown`) inkl.
   Vergleich mit den bekannten Vorab-Fehlern aus `cycle-state.json`.
2. **Nur bei einem Fehler** und nur wenn die Regeln nicht eindeutig sind, wird
   das lokale Modell gefragt (Rolle `review`, `classification`, `preferSmall`,
   `temperature 0`, Timeout 150 s, Prompt ≤ 6000 Zeichen, `maxPromptChars`). Der
   Prompt enthaelt ausschliesslich Diagnose-Relevantes: fehlgeschlagene Stufe,
   Fehlerzeilen (gekuerzt), erwartet vs. beobachtet, `git diff --stat` + Auszug,
   Artefaktpfade — **nie** das Repository.
3. **Antwort** wird als JSON validiert (`category`, `probableCause`, `component`,
   `file`, `observation`, `recommendedFix`, `confidence`); eine eindeutige
   Infrastruktur-/Runtime-Diagnose darf nicht in einen Codefehler umgedeutet
   werden. Ohne Modell bleibt der Lauf voll funktionsfaehig (Regeln +
   Reparaturauftrag).
4. **Ergebnis** landet in `latest-analysis.json`, im Report und im
   Reparaturauftrag.

Verifiziert in diesem Lauf: fehlende Electron-Distribution/kein Display wurde
als `infrastructure` (Konfidenz 0.8, Quelle `heuristic`) erkannt, und die
Analyse hat den Modellaufruf **bewusst ausgelassen** („deterministic evidence is
decisive“).

## 7. Arena-Rueckkanal

Automatisch, ohne Copy-Paste:

1. Check-Annotationen je fehlgeschlagener Stufe (erste echte Fehlerzeile).
2. Strukturierter PR-Kommentar (Marker `<!-- lpai-autonomous-report -->`, wird
   aktualisiert, nicht gespammt) mit Stufentabelle, fehlgeschlagenen Tests,
   Analyse, Stop-Grund und Umgebungs-Warnung.
3. Artefakt `lpai-test-reports` mit `latest.json|.md`,
   `latest-fix-prompt.md`, `latest-analysis.json`, `cycle-state.json`,
   Screenshots und Traces — ueber die offizielle API abrufbar.
4. `npm run feedback:pull` materialisiert den Lauf im Arbeitsbaum
   (`test-reports/inbox/BRIEF.md`, `pr-comment.md`, `artifacts/**`) und druckt
   den Auftrag.
5. Testlauf aus der Entwicklungsumgebung heraus startbar ueber die offizielle
   Workflow-API (`gh workflow run`) bzw. `repository_dispatch`.

**Verbleibende Grenze (ehrlich):** GitHub kann keinen **neuen Arena-Agentenlauf**
starten — dafuer existiert keine oeffentliche, dokumentierte Arena-Schnittstelle
und es wird keine erfunden. Der Kreislauf ist automatisch bis zum fertigen,
maschinenlesbaren Auftrag; der letzte Anstoss („jetzt reparieren“) ist der
einzige verbleibende manuelle Moment und im Abschnitt 11 benannt.

## 8. Reparaturzyklus

Ein Zyklus ist eine Folge roter Runden ueber Fix-Commits hinweg; ein `PASS`
setzt Zaehler und Fingerprints zurueck und merkt sich den letzten guten Commit.
`cycle-state.json` wird im Workflow gecacht und ueberlebt so den Lauf.

Stop-Regeln (alle als Unit-Tests abgesichert):

| Grund | Bedingung |
| --- | --- |
| `max_attempts_reached` | mehr als `max_attempts` Runden (Standard 3) |
| `repeated_failure` | identischer Fingerprint ≥ 3× |
| `infrastructure_error` | eine Stufe `INFRASTRUCTURE_ERROR` |
| `ollama_unavailable` | `--require-ollama` und kein Server |
| `tests_regressed` | neue rote Stufen gegenueber der Vorrunde |
| `dangerous_change` | ab Runde 2 Aenderungen an Workflows/Autonomie-/Runner-Skripten/Playwright-Config |

Bei einem Stop: keine automatische Weiterarbeit, Warnung im Lauf, optional
Issue `needs-human`, Grund im Report und im Reparaturauftrag. Reparaturauftraege
verlangen fuer echte Fehler einen Reproduktionstest; bestehende Tests duerfen
nicht rot werden, kein „gruen durch Anpassen“.

## 9. Sicherheit

* Der self-hosted Job laeuft **nur** auf Push in dieses Repository und nur mit
  `if: github.repository == 'Kaiserkatze1234/local-personal-ai'`.
* **Kein** `pull_request`/`pull_request_target` fuer self-hosted; Fork-PRs
  laufen auf GitHub-Runnern (`pull-request-ci.yml`, nur typecheck/lint/build/unit).
* Keine Secrets im Job; der Token darf nur PR-Kommentar/Issue schreiben.
* Wegwerf-`LPAI_DATA_DIR` je Testprozess — `%APPDATA%\lpai` wird nie beruehrt;
  die Analyse arbeitet auf einer **Kopie** von `config.json`/`lpai.db`.
* Vor Electron-Stufen werden ausschliesslich eigene verwaiste `electron.exe`
  (unter `node_modules\electron`) beendet.
* Alle Kindprozesse werden ueber Prozessgruppen beendet (`taskkill /T` auf
  Windows), Tests laufen seriell (`workers: 1`), `retries: 0` — ein Retry darf
  einen echten Fehler nicht verstecken.
* Die PowerShell-Skripte sind ASCII-only (Windows PowerShell 5.1 liest `.ps1`
  sonst als ANSI) — per Test erzwungen, ebenso dass jeder benutzte `[switch]`
  auch deklariert ist.

## 10. Ergebnisse

| Bereich | Ergebnis | Umgebung |
| --- | --- | --- |
| `npm run lint` (biome) | **0 Fehler, 0 Warnungen, 0 Hinweise** (144 Dateien) | Linux-Sandbox |
| `npm run typecheck` | **PASS** (`tsc` node + web) | Linux-Sandbox |
| `npm run build` | **PASS** (main, preload, renderer) | Linux-Sandbox |
| `npm test` | **186 passed**, 10 skipped, 1 Datei übersprungen (ffmpeg), 18,2 s | Linux-Sandbox |
| `test:autonomous` — `unit` | **PASS** 12 Dateien, 103 Tests | Linux-Sandbox |
| `test:autonomous` — `integration` | **PASS** 13 Dateien, 83 Tests | Linux-Sandbox |
| `test:autonomous` — `prereqs`/`native`/`typecheck`/`build` | **PASS** | Linux-Sandbox |
| `test:autonomous` — `smoke` | **INFRASTRUCTURE_ERROR** | kein Electron-Dist/Display in der Sandbox |
| `test:autonomous` — `e2e` | **INFRASTRUCTURE_ERROR** | kein Electron-Dist/Display in der Sandbox |
| `test:autonomous` — `ollama` | **SKIP** (nie PASS) | kein lokaler Ollama-Server |
| `test:autonomous` — Gesamt | **INFRASTRUCTURE_ERROR**, Zyklus korrekt gestoppt | Linux-Sandbox |
| `test:autonomous --quick` | **PASS** (smoke/e2e/ollama bewusst SKIP) | Linux-Sandbox |
| `npm run analyze:failure` | **PASS** — `infrastructure`, KI bewusst nicht aufgerufen | Linux-Sandbox |
| `npm run feedback:pull` | **PASS** — korrekter Branch erkannt, sauberer „noch kein Lauf“-Exit (3) | Linux-Sandbox |
| `npx playwright test --list` | **10 Tests in 4 Dateien** korrekt eingesammelt | Linux-Sandbox |
| **GitHub PR-Checks** (`pull-request-ci.yml`) | **PASS** — Typecheck, Lint, Build, Unit + Integration auf einem frischen Ubuntu-Runner | GitHub Actions, Lauf `37779636957` (PR #1) |
| **Self-hosted Lauf** (`autonomous-test.yml`) | **in der Warteschlange** — wartet auf den noch nicht installierten Windows-Runner; startet automatisch danach | GitHub Actions |

Selbsttests des Loops: 29 Tests `tests/autonomy.test.ts` + 5 Tests
`tests/e2e-contract.test.ts` — **alle gruen** (im `npm test`-Lauf enthalten).

## 11. Manuelle Schritte

**Einmalig (danach kein Handgriff mehr):**

1. Node 22 auf dem Windows-PC (falls noch nicht vorhanden).
2. `git clone https://github.com/Kaiserkatze1234/local-personal-ai`
   (oder vorhandene Kopie nutzen).
3. `powershell -ExecutionPolicy Bypass -File scripts\windows\install-runner.ps1`
   — prueft die Toolchain, laedt den offiziellen Runner, registriert ihn mit den
   Labels `self-hosted, Windows, X64, lpai-test`, richtet den Autostart ein
   (Standard: geplante Aufgabe bei der Anmeldung; `-Mode Service` nur, wenn
   GUI-Tests verzichtbar sind) und verifiziert die Online-Anzeige.
4. Einmal `npm ci` + `npm run rebuild:native` (waermt Bindings vor).

Optional, wenn Ollama ohne Modell installiert ist: `ollama pull qwen3:4b`.

Der Push dieses Branches hat die beiden self-hosted-Laeufe bereits ausgeloest;
sie warten in der Warteschlange auf den noch nicht installierten Runner und
laufen nach dessen Installation von selbst (oder werden in der
Actions-Uebersicht storniert).

**Pro Durchlauf: keiner.** Push → Testlauf → Report → Kommentar → Artefakt.
Der **einzige verbleibende** manuelle Moment im gesamten Kreislauf ist der
Start der naechsten Reparaturrunde (Abschnitt 12).

## 12. Verbleibende Einschraenkungen

1. **Kein automatischer Start eines Arena-Laufs.** Es gibt keine oeffentliche
   Arena-Schnittstelle, die ein GitHub-Ereignis in einen neuen Agentenlauf
   umsetzen koennte. Deshalb endet die Automatik beim fertigen, strukturierten
   Auftrag (`latest-fix-prompt.md`, PR-Kommentar, Artefakt,
   `feedback:pull` → `BRIEF.md`). Alles andere — Erkennung, Klassifikation,
   Auftragsformulierung, Sicherheitsstopps, Rueckweg nach GitHub — ist
   automatisiert. Ein Platzhalter-Endpunkt oder ein „Fake-Trigger“ wurde bewusst
   **nicht** gebaut.
2. **Smoke/E2E/Ollama sind auf dem Windows-Runner noch nicht gelaufen** — die
   beiden ausgeloesten Laeufe stehen in der Warteschlange, bis
   `install-runner.ps1` gelaufen ist. Verifiziert ist bisher: die
   GitHub-gehosteten PR-Checks (Typecheck/Lint/Build/Tests) und alle
   Sandbox-Stufen (Abschnitt 10). Die
   Stufen sind implementiert und werden hier korrekt als
   `INFRASTRUCTURE_ERROR`/`SKIP` gemeldet (erste Amtshandlung des Loops:
   Umgebung, nicht Code), aber ihre Gruen-Meldung kann erst nach der
   Runner-Installation und dem ersten Push belegt werden. Der Bericht behauptet
   sie deshalb **nicht**.
3. **GUI-E2E braucht eine interaktive Sitzung** — der Runner laeuft als
   geplante Aufgabe bei der Anmeldung. Im Dienstmodus (Session 0) kann Electron
   kein Fenster oeffnen; das Skript sagt das und die Stufe meldet dann
   `INFRASTRUCTURE_ERROR` statt falsch-gruen.
4. **Rundenbegrenzung** ist eine Sicherheitseigenschaft, keine Luecke: nach
   `max_attempts` bzw. bei gleichem Fehler wird bewusst gestoppt und eskaliert.
5. **`test-reports/` liegt nicht im Git** (Reports reisen als Artefakt). Soll
   ein Report dauerhaft im Repository stehen, muss er bewusst committet werden.

## 13. Fazit

Der Kreislauf ist **bis zum Reparaturauftrag vollstaendig automatisch**: Push →
Windows-Testlauf → strukturierter Report → Fehlerklassifikation →
GitHub-Check/-Kommentar/-Artefakt → Import in den Arbeitsbaum. Der Testlauf
selbst startet ohne Handgriff, die Testumgebung ist gegen Produktivdaten
isoliert, und der Loop faellt bei Umgebungsstoerungen bewusst nicht auf „gruen“
zurueck.

**Nicht** behauptet wird volle Automatik bis zum reparierenden Commit: dafuer
fehlt die dokumentierte Arena-Schnittstelle fuer eingehende Trigger
(Abschnitt 12.1). Diese Grenze ist exakt benannt — der maximale technisch
moegliche Automatisierungsgrad ist implementiert.
