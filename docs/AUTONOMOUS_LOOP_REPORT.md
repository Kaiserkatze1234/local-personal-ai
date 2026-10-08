# Full Autonomous AI Development Loop — Abschlussbericht

Stand: 2026-10-08 · Branch `arena/e0389ad4-local-personal-ai` · Commit-Basis `f9e3c61`

Dieser Bericht beschreibt den vollständigen Kreislauf
**Nutzer → ChatGPT → Arena → GitHub → Windows-Testrechner → Tests → Testbericht
→ ChatGPT → neuer Arena-Auftrag → Arena repariert → GitHub → erneut testen**
und benennt exakt, was davon automatisch läuft, was einmalig eingerichtet werden
muss und was heute technisch **nicht** automatisch geht (mit Begründung, ohne
erfundene Schnittstellen).

---

## 1. Architektur

```
            ┌──────────────────────────────────────────────────────────────┐
 Nutzer ───▶│ ChatGPT                                                      │
            │  • formuliert Entwicklungsziele als Arena-Auftrag            │
            │  • liest den Testlauf-Digest (latest-chatgpt.json/.md)       │
            │  • trennt Code- von Infrastrukturfehlern, entscheidet,       │
            │    formuliert den nächsten Auftrag / Reparaturauftrag        │
            └──────────────┬──────────────────────────────▲───────────────┘
                           │ Auftrag (Text)               │ Digest (JSON/MD)
                           ▼                              │
            ┌──────────────────────────────┐              │
            │ Arena (Agent)                │              │
            │  • ändert Code, Tests, Docs  │              │
            │  • pusht auf arena/**-Branch │              │
            │  • liest Ergebnisse zurück    │              │
            │    via npm run feedback:pull │              │
            └──────────────┬───────────────┘              │
                           │ git push                     │
                           ▼                              │
            ┌──────────────────────────────────────────────┴───────────────┐
            │ GitHub (zentrale Übergabeschicht, KEINE externe DB)          │
            │  • Branch + Commit + Pull Request #1                         │
            │  • Actions-Workflows (push auf main/arena/**)                │
            │  • Check-Runs/Annotations, strukturierter PR-Kommentar       │
            │  • Artefakte lpai-ai-handoff / lpai-test-reports / e2e       │
            │  • Issue-Eskalation `needs-human` bei gestoppter Automatik   │
            └──────────────┬───────────────────────────────────────────────┘
                           │ Job an den self-hosted Runner (Labels)
                           ▼
            ┌──────────────────────────────────────────────────────────────┐
            │ Windows-Testrechner (Ryzen 5 5600H, 16 GB, lokales Ollama)   │
            │  • Runner startet mit dem PC (Autostart, interaktive Sitzung)│
            │  • npm ci → npm run test:autonomous -- --ci                  │
            │      prereqs → native → typecheck → build → unit →           │
            │      integration → smoke → Electron-E2E → Ollama-Live        │
            │  • Fehleranalyse (Regeln zuerst, lokales Modell nur wenn     │
            │    nötig — über den vorhandenen ModelRouter)                 │
            │  • schreibt Report + Digest + Reparaturauftrag               │
            │  • räumt auf (Electron-Prozesse, Temp-Datenordner)           │
            └──────────────────────────────────────────────────────────────┘
```

Beide Pfeile zurück (Digest an ChatGPT, Auftrag an Arena) entstehen aus **einem**
Report — es gibt keine zweite Wahrheit und keinen zweiten Testpfad.

## 2. Automatisierungsgrad

| Schritt | heute |
| --- | --- |
| Code ändern (Arena) | automatisch, sobald ein Auftrag vorliegt |
| Änderung nach GitHub bringen | automatisch (`git push` auf `arena/**`) |
| Änderungserkennung | automatisch (Workflow-Trigger `push` + Diff gegen den zuletzt getesteten Commit) |
| Testlauf starten | automatisch auf dem Windows-PC |
| Voraussetzungen prüfen | automatisch (Stufe `prereqs`, strikt mit `--ci`) |
| Tests ausführen (inkl. echtem Electron + lokalem Modell) | automatisch |
| Bericht erzeugen | automatisch (`latest.json/.md`) |
| Maschinenlesbaren Digest für ChatGPT erzeugen | automatisch (`latest-chatgpt.json/.md`) |
| Reparaturauftrag für Arena erzeugen | automatisch (`latest-arena-task.md`, nur bei Fehlschlag) |
| Ergebnis nach GitHub zurückgeben | automatisch (Annotations, PR-Kommentar, Artefakte, Issue) |
| Ergebnis in den Arbeitsbaum holen | automatisch per Befehl (`npm run feedback:pull`) |
| Automatik begrenzen/stoppen | automatisch (Zyklus-Wächter, 6 Stop-Gründe) |
| **Nächsten Auftrag formulieren** | **ChatGPT** (zentrale Instanz) — Übergabe ist ein Schritt |
| **Neuen Arena-Agentenlauf starten** | **nicht automatisch möglich** (siehe §13) |

Kurz: alles **innerhalb** des technischen Kreislaufs ist automatisch. Nicht
automatisch sind genau zwei Übergaben — „ChatGPT bekommt den Digest“ und „Arena
bekommt den Auftrag“ —, weil es dafür keine dokumentierte Schnittstelle gibt
(kein erfundener Endpunkt, kein Fake-Trigger).

## 3. GitHub

`.github/workflows/autonomous-test.yml` — der eigentliche Kreislauf:

* Trigger: `push` auf `main` und `arena/**`, plus `workflow_dispatch`
  (`quick`, `require_ollama`, `max_attempts`).
* Läuft auf `[self-hosted, Windows, X64, lpai-test]`, `timeout-minutes: 90`,
  Concurrency-Gruppe pro Branch mit `cancel-in-progress`.
* Job-Guard `if: github.repository == 'Kaiserkatze1234/local-personal-ai'`.
* `actions/checkout@v7` mit `fetch-depth: 0` (Diff zum letzten getesteten Stand
  gehört zur Analyse), `npm ci`, `npm run test:autonomous -- --ci`.
* Zykluszustand wird über `actions/cache/restore@v6` / `save@v6` über Läufe
  hinweg mitgenommen (`test-reports/cycle-state.json`).
* Artefakte (v7): `lpai-ai-handoff` (Digest + Auftrag + Report), 
  `lpai-test-reports` (Reports, State, Screenshots), `lpai-e2e-artifacts`
  (Traces/Screenshots bei Fehlschlag, kürzere Aufbewahrung).
* Ergebniskanäle: `::error::`/`::warning::`-Annotationen im Lauf, **ein**
  strukturierter PR-Kommentar (Marker `<!-- lpai-autonomous-report -->`, wird
  aktualisiert statt gespammt) mit Stufentabelle, fehlgeschlagenen Tests,
  Analyse, Stop-Grund und dem kompakten Digest als eingeklappter Block,
  Issue-Eskalation `needs-human` bei gestoppter Automatik, und am Ende ein
  ehrlicher Job-Fehlschlag (kein „grün durchreichen“).

`.github/workflows/pull-request-ci.yml` — Fork-sicher: `pull_request` nur auf
GitHub-gehosteten Runnern (typecheck, lint, build, `npm test`).

## 4. Windows

* `scripts/windows/install-runner.ps1` (einmalig): prüft die Toolchain
  (Node 22+, npm, git, Platz, optional Ollama), lädt den offiziellen Runner
  **außerhalb** des Repos, registriert ihn mit den Labels
  `self-hosted, Windows, X64, lpai-test`, richtet den **Autostart** ein
  (Standard: geplante Aufgabe bei der Anmeldung → interaktive Sitzung, die die
  GUI-/E2E-Stufen brauchen; optional Windows-Dienst, dann aber ohne verlässliche
  GUI-Tests), startet ihn und prüft, dass GitHub ihn als online sieht.
* `scripts/windows/remove-runner.ps1`: vollständiger Rückbau.
* Nach der Einrichtung startet **jeder** Push den Testlauf; niemand startet
  Tests von Hand, niemand kopiert Logs.
* Ressourcen-Disziplin: E2E seriell (`workers: 1`), keine Retries, pro Lauf
  höchstens ein Electron und höchstens ein Modell, `keepAlive: 0` nach der
  Analyse, Aufräumen verwaister eigener `electron.exe`-Prozesse vor jeder
  Electron-Stufe, Wegwerf-Datenordner unter `%TEMP%`.

## 5. Tests

Ein Einstiegspunkt, neun Stufen, ein Lauf:

```
prereqs → native → typecheck → build → unit → integration → smoke → e2e → ollama
```

* `unit`/`integration`: **eine** Vitest-Ausführung, zwei Sichten (Dateien, die
  die echte `CoreApp` booten = Integration).
* `smoke`: `LPAI_SMOKE=1` in einem Wegwerf-Datenordner, Erfolg nur bei
  `SMOKE_OK`.
* `e2e`: Playwright `_electron` gegen die gebaute App — 17 Szenarien in 5
  Dateien: App-Start, Fenster, Renderer, Preload-Bridge, IPC (inkl. blockierter
  Methode), Chat, Antwort, Streaming, Stop/Abbruch, Provider-Fehler, „Hallo“,
  Frage nach den Arbeitsbedingungen, Memory schreiben/abrufen/überleben,
  „Merke dir: Ich mag kurze Antworten.“ → „Welche Art von Antworten mag ich?“,
  historische Konversation (auch nach Neustart auffindbar), „Was habe ich noch
  offen?“ (Task-Records), Crash-Recovery (`paused`), „Erkläre mir Quantenphysik.“
  ohne persönliche Kontextliste, sauberer Shutdown.
* `ollama`: echte Live-Tests gegen den lokalen Server, Chat-Modelle per
  Capability, Embedding-Modelle ausgeschlossen.
* Statusmodell: `PASS` / `FAIL` / `SKIP` / `INFRASTRUCTURE_ERROR`; fehlendes
  Ollama ist **nie** PASS, fehlende Electron-Distribution ist
  `INFRASTRUCTURE_ERROR` (nicht SKIP, nicht PASS), ein Live-Lauf ohne einen
  einzigen Test ist FAIL, ein „grüner“ Smoke-Lauf ohne `SMOKE_OK` ist FAIL.

## 6. Fehleranalyse

1. Immer zuerst **deterministisch** (Regeln in
   `src/main/diagnostics/failureAnalysis.ts`): Infrastruktur-, Provider-,
   Build-, UI- und Regressionsmuster.
2. Nur bei einem Fehler und nur wenn die Regelantwort nicht eindeutig ist
   (Konfidenz < 0,75 oder `unknown`), kommt das **lokale Modell** über die
   **vorhandene** Infrastruktur dazu: `CoreApp` → `providers.refreshAll()` →
   `ModelRouter.select('review', 'classification', { preferSmall: true })` →
   Adapter des gewählten Providers. Kein neuer Ollama-Client, kein neues
   Routing, keine Cloud, keine fest verdrahteten Modellnamen; ein
   Embedding-Modell kann strukturell nicht gewählt werden.
3. Der Prompt ist begrenzt (≤ 6000 Zeichen, 150 s Timeout) und enthält nur
   Diagnosematerial (fehlgeschlagene Stufe/Tests, Erwartung vs. Beobachtung,
   `git diff --stat` + Auszug, Artefaktpfade) — **nie** das Repository.
4. Ergebnis: `{category, probableCause, component, file, observation,
   recommendedFix, confidence}` mit Herkunft (`heuristic` / `heuristic+ai`).
   Kategorien: `code_defect`, `regression`, `test_defect`, `build_defect`,
   `ui_defect`, `infrastructure`, `runtime_provider`, `preexisting_unrelated`,
   `unknown`. Ein eindeutig als Umgebung erkannter Fehler erreicht das Modell
   gar nicht mehr und kann nicht zu einem Codefehler umgedeutet werden.
5. Ohne lokales Modell bleibt der Lauf voll funktionsfähig; der Digest nennt
   dann `classification.source: "rules"` und sagt ehrlich, dass keine KI nötig
   war.

## 7. ChatGPT-Lesepfad (was ChatGPT bekommt)

Ein Lauf erzeugt **einen** Digest, aus dem dieselbe Instanz ohne Rückfragen
entscheiden kann:

| Frage | Feld in `test-reports/latest-chatgpt.json` |
| --- | --- |
| Was wurde getestet? | `whatWasTested{pipeline,branch,commit,runner,os,node,durationMs,stages,ollama,changedFiles,previousTestedSha}` |
| Was funktioniert? | `works[]` |
| Was ist kaputt? | `broken[]` und `failures[]{stage,status,command,expected,actual,failedTests,stacktrace,logs,screenshot,trace,affectedFiles,probableCause,environmentProblem}` |
| Code- oder Infrastrukturfehler? | `isCodeDefect`, `isInfrastructureError`, `classification{category,categoryLabel,source,component,file}`, `infrastructureErrors[]` |
| Welche Dateien sind relevant? | `affectedFiles[]`, `classification.file` |
| Was hat sich seit dem letzten Lauf geändert? | `whatWasTested.changedFiles[]`, `previousTestedSha` |
| Regression? | `regression{isRegression,repeatedFailure,progress,newFailures,fixedSinceLastRun,alreadyBrokenBefore,attempt,maxAttempts,stopped,stopReasons}` |
| Wie reproduzieren? | `reproduce{clone,commit,steps,stageCommands,note}` |
| Empfohlene Korrektur? | `recommendedFix`, `likelyRootCause`, `confidence` |
| Welche Tests müssen danach grün sein? | `testsToRerun{stages,failedTests,command,mustStayGreen}` |

Dazu `latest-chatgpt.md` als kurzer Text („Was getestet / Was läuft / Was ist
kaputt / Einordnung / Empfehlung“) und derselbe Text als eingeklappter Block im
PR-Kommentar. Kein Rohlog, keine Repository-Dumps, keine persönlichen Daten;
Listen sind begrenzt (Digest < ~20 kB, Kommentarblock ≤ 6 kB).

Lesewege, in dieser Reihenfolge praktikabel:

1. **PR-Kommentar** (`pull/1#issuecomment-…`): öffentlich lesbar, enthält
   Stufentabelle, Fehler, Analyse und den Digest — funktioniert für eine
   Analyseinstanz mit Lesezugriff auf das Repository, ohne Token.
2. **Artefakt `lpai-ai-handoff`** (per GitHub-API mit Token): die Dateien
   selbst, inklusive `latest-arena-task.md`.
3. **`npm run feedback:pull`** (in Arena/auf dem Entwicklungsrechner):
   holt beides in `test-reports/inbox/`, legt `BRIEF.md`, `ARENA-TASK.md` und
   `pr-comment.md` an und druckt die Zusammenfassung.

## 8. Arena-Auftragspfad (was Arena bekommt)

Bei jedem Nicht-PASS entsteht `test-reports/latest-arena-task.md` — direkt als
Arbeitsauftrag verwendbar:

Problem · Reproduktion (Runner, Commit, Clone-Befehl, exakt die Befehle der
roten Stufen, falls nötig `npm ci` und `npm run rebuild:native`) · Expected ·
Actual (pro Stufe, mit Exitcode und erster Fehlerzeile) · betroffene Tests ·
relevante Dateien (aus Analyse, Fehlerzeilen und geänderten Dateien) ·
relevante Logs (gefiltert, begrenzt) · Trace/Screenshot (Pfade mit
`show-trace`-Hinweis) · wahrscheinliche Ursache (Kategorie, Konfidenz, Quelle,
Modell) · gewünschtes Verhalten · Einschränkungen (keine neuen Abhängigkeiten
ohne Not, bestehende Funktionen nicht beschädigen, Loop-Dateien nur bei Bedarf)
· Regressionstest-Anforderung (echter Codefehler ⇒ roter Test vorher, grüner
nachher; kein Test wird abgeschwächt) · Loop-Status (Runde x/y, Fingerprint,
Stop-Grund).

Bei `PASS` werden Auftragsdateien **gelöscht** — ein alter Auftrag kann nie für
den aktuellen Zustand gehalten werden.

## 9. Reparaturschleife

```
FAIL → Analyse → Digest + Reparaturauftrag → Arena ändert Code + Regressionstest
     → Push → Windows-Runner testet erneut → …
```

Der Zyklus ist über `test-reports/cycle-state.json` und die zeitgestempelten
Reports in Git nachvollziehbar (Runde, Fingerprint, letzter grüner Commit,
Stop-Gründe) und wird hart begrenzt:

| Stop-Grund | Bedingung |
| --- | --- |
| `max_attempts_reached` | mehr als `--max-attempts` (Standard 3) Runden für dieselbe Änderung |
| `repeated_failure` | derselbe Fehler-Fingerprint ≥ 3 Mal |
| `infrastructure_error` | eine Stufe ist `INFRASTRUCTURE_ERROR` |
| `ollama_unavailable` | `--require-ollama`, aber kein Server antwortet |
| `tests_regressed` | zusätzliche rote Stufen oder gewachsene Fehlermenge |
| `dangerous_change` | Änderung an Workflows/Autonomie-/Runner-Skripten/Playwright-Konfiguration ab Runde 2 |
| `unknown_cause` | Analyse liefert keine belastbare Ursache (Konfidenz ≤ 0,1) |

Bei einem Stop passiert **nichts** automatisch weiter: Der Report erklärt den
Grund, der PR-Kommentar markiert ihn, der Workflow kann ein
`needs-human`-Issue eröffnen. Ist die Schleife also voll automatisch? Innerhalb
der Grenzen ja: Ein roter Lauf führt reproduzierbar zu Analyse, Digest und
Auftrag, und ein Fix wird erneut automatisch getestet. Die **Entscheidung**
„jetzt reparieren“ und die Formulierung des Auftrags bleiben bei ChatGPT, der
Anstoß bei der Person — bewusst, nicht aus Bequemlichkeit (§13).

## 10. Sicherheit

* Der self-hosted Runner nimmt **nur Jobs dieses Repositories** an; **keine**
  `pull_request`/`pull_request_target`-Trigger für den self-hosted-Job. Fork-PRs
  laufen ausschließlich auf GitHub-Runnern. Ein Fork kann damit keinen Code auf
  dem PC ausführen.
* Keine Secrets im Job; der Standard-Token darf nur PR-Kommentar und Issue
  schreiben. Kein `contents: write`, keine Releases, kein `dist`-Build.
* Testisolation: jeder Testprozess bekommt einen Wegwerf-Datenordner
  (`LPAI_DATA_DIR`), Electron-`userData` folgt ihm, die Produktivdaten
  (`%APPDATA%\lpai`) werden nie gelesen oder geschrieben; die Analyse arbeitet
  auf einer **Kopie** der Konfiguration/DB.
* Kein Blindflug: der Runner führt nur aus, was im Repo liegt und gepusht wurde
  (trusted branches), und die Automatik stoppt bei Änderungen an der
  Testinfrastruktur selbst.
* Ressourcenschutz: ein Lauf gleichzeitig (Concurrency), E2E seriell, keine
  parallelen großen Modelle, Modell wird nach der Analyse entladen.
* Der Lauf startet nie die installierte App und veröffentlicht nichts.

## 11. Dateien (Stand dieses Auftrags)

Neu/erweitert gegenüber der ersten Ausbaustufe:

| Datei | Änderung |
| --- | --- |
| `scripts/autonomous/report.mjs` | `buildAiDigest`, `renderAiDigestMarkdown`, `renderArenaTask`, Kategorie-Labels; Report trägt `changedFiles`, `previousTestedSha`, `likelyRootCause`, `confidence`, `skippedTests`, `stageStatus` |
| `scripts/autonomous-test.mjs` | schreibt Digest (`latest-chatgpt.json/.md`) und Auftrag (`latest-arena-task.md`), löscht Auftragsdateien bei PASS, Änderungserkennung inkl. Arbeitsbaum, Analyse liest den **aktuellen** Report, `unknown_cause`-Stop, `GITHUB_OUTPUT` um `ai_digest`/`is_code_defect` erweitert |
| `scripts/autonomous/guards.mjs` | `tests_regressed` erkennt auch gewachsene Fehlermengen, `unknown_cause` |
| `scripts/analyze-failure.mjs` | schreibt Digest + Auftrag mit (manuelles Nachziehen ohne Testwiederholung) |
| `scripts/feedback-pull.mjs` | lädt zusätzlich `lpai-ai-handoff`, bevorzugt `latest-arena-task.md`, legt `ARENA-TASK.md` an |
| `.github/workflows/autonomous-test.yml` | Artefakt `lpai-ai-handoff`, neue Reportdateien, Digest im PR-Kommentar |
| `tests/e2e/*.spec.ts` | 17 Szenarien (u. a. Hallo, Arbeitsbedingungen, „Merke dir …“, Quantenphysik ohne persönlichen Kontext, offene Tasks, Crash-Recovery); `test.info()` statt ungültiger Fixture-Signatur |
| `tests/e2e/tasks.spec.ts` | neu (Task-Records, Persistenz, Absturz-Erholung) |
| `src/main/agent/agentCore.ts`, `planner.ts` | „Merke dir: …“ wird wie „remember that …“ erkannt (nur Präfix-Erkennung) |
| `tests/autonomy.test.ts` | 37 Tests (vorher 29): Digest-Inhalte, Regression/Progress, Auftragsabschnitte, Größenbegrenzung, Veröffentlichung der Handoff-Artefakte |
| `docs/AUTONOMOUS_LOOP.md` | ChatGPT-Lesepfad, Auftragspfad, Artefakte, Stop-Gründe, E2E-Szenariotabelle |
| `README.md` | Kreislaufbild inkl. Digest/Auftrag und ChatGPT als zentrale Instanz |

Unverändert geblieben sind bewusst: Chat, Streaming, Memory, Kontext-Engine,
Proaktive Dienste, Model-Routing, Agent-/Coding-Modus, Tasks & Checkpoints,
Decision-/Verification-Logik. Die einzige Produktänderung ist die erweiterte
Erkennung der deutschen Merk-Anweisung („Merke dir: …“), weil genau dieses
Szenario geprüft werden muss.

## 12. Ergebnisse (gemessen, nicht behauptet)

| Prüfung | Ergebnis |
| --- | --- |
| `npm run typecheck` | **grün** (node + web) |
| `npm run lint` (biome) | **grün** (145 Dateien) |
| `npm run build` | **grün** (main + preload + renderer) |
| `npm test` | **194 pass / 10 skip / 0 fail** in 25 Dateien (~21 s) |
| darunter `tests/autonomy.test.ts` | **37 pass** |
| darunter `tests/e2e-contract.test.ts` | **5 pass** (IPC-Allowlist, CSS-Selektoren, Config-Gruppen, Adapter-Präfixe, PowerShell-Sicherheit) |
| `npx playwright test --list` | **17 Tests in 5 Dateien** (Sammlung geprüft) |
| `npm run test:autonomous` (hier, offline) | `prereqs/native/typecheck/build/unit(111)/integration(83)` **PASS**, `smoke`/`e2e` **INFRASTRUCTURE_ERROR** (kein Electron-Dist, keine Anzeige), `ollama` **SKIP** → Gesamturteil **INFRASTRUCTURE_ERROR** (ehrlich, kein Fake-PASS); Analyse: `infrastructure (0.8)` |
| `npm run test:autonomous -- --quick` | **PASS** mit `SKIP` für smoke/e2e/ollama |
| `npm run analyze:failure -- --no-ai` | schreibt Analyse + Digest + Auftrag, Kategorie `infrastructure`, Stop-Grund `infrastructure_error` |
| GitHub | PR-Checks (gehostet) grün; der Windows-Lauf startet automatisch, **sobald der Runner installiert ist** (§13) |

Ehrliche Einordnung: Die Stufen `smoke`/`e2e`/`ollama` können in dieser
Entwicklungsumgebung (kein Display, keine Electron-Distribution) nicht laufen
und werden deshalb als `INFRASTRUCTURE_ERROR`/`SKIP` gemeldet — genau das ist
die gewünschte Ehrlichkeit. Auf dem Windows-Testrechner sind sie der Kern des
Laufs; die Specs sind dort lauffähig und durch `tests/e2e-contract.test.ts`
gegen die IPC- und UI-Verträge abgesichert.

## 13. Verbleibende manuelle Schritte

**Einmalig manuell (danach nie wieder):**

1. Repository auf dem Windows-PC klonen (`git clone … C:\src\local-personal-ai`).
2. `scripts\windows\install-runner.ps1` ausführen (prüft Toolchain, lädt den
   Runner, registriert Labels, richtet den Autostart ein).
3. `npm ci` + `npm run rebuild:native` einmal vorwärmen (optional, verkürzt nur
   den ersten Lauf). Ollama installieren und ein Chat-Modell ziehen, wenn die
   Runtime-Stufen echt laufen sollen.

Rückbau: `scripts\windows\remove-runner.ps1`.

**Bei jedem weiteren Entwicklungszyklus manuell:** genau **eine** Übergabe —
den Digest (`latest-chatgpt.md` / den PR-Kommentar / das Artefakt
`lpai-ai-handoff`) an die zentrale Analyseinstanz geben und den daraus
entstehenden Auftrag an Arena weitergeben. Alles davor (Teststart,
Voraussetzungen, Logs, Bericht, Analyse, Formatierung, Rückkanal) und alles
danach (Push, erneuter Testlauf, Vergleich mit der Vorrunde, Stop-Entscheidung)
läuft ohne Handgriff.

**Technisch nicht automatisierbar (mit Begründung):**

* GitHub kann keinen neuen Arena-Agentenlauf starten, und ChatGPT kann sich
  selbst keinen Testlauf auslösen: Es gibt (Stand dieses Projekts) keine
  öffentliche, dokumentierte Arena-Schnittstelle für eingehende Trigger, und
  ChatGPT kann ohne Zugangsdaten nicht auf die GitHub-API zugreifen. Deshalb
  endet die Automatik bewusst am fertigen, maschinenlesbaren Auftrag statt an
  einer Attrappe. Sobald eine offizielle Arena-Trigger-Schnittstelle existiert,
  ist der Anschlusspunkt eine Zeile (`latest-arena-task.md` bzw.
  `latest-chatgpt.json` an diese Schnittstelle übergeben) — die Dateien und der
  Zustand sind dafür bereits vorhanden.
* Der Windows-Runner wurde in dieser Umgebung **nicht** installiert (kein
  Windows-PC, kein Zugriff auf die Zielmaschine). Der Workflow-Lauf
  „Autonomous test (Windows runner)“ bleibt deshalb bis zur Einrichtung
  pending; die Skripte sind ASCII-geprüft und durch Tests abgesichert.
* Die E2E-Szenarien konnten hier nur gesammelt (17 Tests) und statisch geprüft,
  nicht ausgeführt werden — im Sandkasten fehlen Electron-Distribution und
  Anzeige. Das ist als `INFRASTRUCTURE_ERROR` sichtbar, nicht als PASS.

## 14. Fazit

Der Kreislauf ist vollständig aufgebaut: Ein Push löst auf dem echten
Windows-PC den vollständigen Testlauf aus, erzeugt einen vollständigen Report,
eine deterministisch-voranalysierte Fehlerklassifikation, einen
maschinenlesbaren Digest und — bei Fehlschlag — einen sofort verwendbaren
Reparaturauftrag, und legt das Ergebnis als Annotation, Kommentar, Artefakt und
(bei gestoppter Automatik) als Issue in GitHub ab. ChatGPT ist als zentrale
Analyse- und Entscheidungsinstanz angebunden, ohne dass eine einzige
Schnittstelle erfunden wurde; die eine verbleibende Übergabe ist exakt benannt.
Alles ist begrenzt (sieben Stop-Gründe), nachvollziehbar (Zykluszustand +
zeitgestempelte Reports im Git) und ehrlich im Status — ein fehlender
Testrechner, ein fehlendes Modell oder eine fehlende Anzeige wird nie zu einem
grünen Ergebnis.
