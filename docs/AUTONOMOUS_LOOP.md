# Autonomer Entwicklungs- und Testkreislauf

Dieses Dokument beschreibt den automatischen Weg

```
ChatGPT  →  Arena-Auftrag  →  Arena (Code)  →  GitHub  →  Windows-PC
   ↑                                                          ↓
   └──  Digest (latest-chatgpt.json/.md)  ←──  Testlauf + Analyse + Reports
```

Zwei Leser bekommen aus **einem** Report zwei Formate: die zentrale
Analyse-/Entscheidungsinstanz (ChatGPT) liest den kompakten, maschinenlesbaren
**Digest** (`test-reports/latest-chatgpt.json|.md`), der Reparatur-Agent
(Arena) den fertigen **Auftrag** (`test-reports/latest-arena-task.md`).

und **genau die manuellen Schritte, die einmalig nötig sind** (Abschnitt 2).
Danach startet jeder Push auf `main` oder `arena/*` den echten Testlauf auf dem
Windows-PC — ohne ZIP, ohne Kopieren, ohne manuellen Teststart.

---

## 1. Bausteine (kleinstmögliche Architektur)

| Baustein | Datei | Aufgabe |
| --- | --- | --- |
| Orchestrator | `scripts/autonomous-test.mjs` (`npm run test:autonomous`) | EIN Einstiegspunkt: prüft Voraussetzungen, führt alle Stufen aus, schreibt Reports, ruft die Fehleranalyse, wertet die Sicherheitsgrenzen aus |
| Report | `scripts/autonomous/report.mjs` | `test-reports/latest.json|.md`, zeitgestempelte Kopien, PR-Kommentar-Text **und die beiden Handoff-Formate**: `latest-chatgpt.json|.md` (Digest für die Analyseinstanz) und `latest-arena-task.md` (Reparaturauftrag) |
| Zyklus-Wächter | `scripts/autonomous/guards.mjs` | Runden zählen, Wiederholungen erkennen, Stop-Entscheidungen, `cycle-state.json` |
| Fehleranalyse | `src/main/diagnostics/failureAnalysis.ts` + `scripts/analyze-failure.mjs` | deterministische Regeln, nur bei Fehlern zusätzlich das lokale Modell über den vorhandenen ModelRouter |
| E2E | `tests/e2e/*.spec.ts` + `playwright.config.ts` | echtes Electron: Fenster, Preload-Bridge, IPC, Chat, Streaming, Stop, Memory, Kontext, Shutdown |
| CI | `.github/workflows/autonomous-test.yml` | startet den Lauf auf dem self-hosted Runner, lädt Artefakte hoch, kommentiert den PR |
| CI (Fork-sicher) | `.github/workflows/pull-request-ci.yml` | nur schnelle Checks auf GitHub-Runnern (typecheck/lint/build/unit) |
| Rückkanal | `scripts/feedback-pull.mjs` (`npm run feedback:pull`) | holt Report + Artefakte + PR-Kommentar des letzten Laufs in den Arbeitsbaum |
| Einrichtung | `scripts/windows/install-runner.ps1`, `remove-runner.ps1` | Runner installieren/entfernen (einmalig bzw. Rückbau) |

Stufen des Orchestrators (Reihenfolge = Abhängigkeit):

```
prereqs → native → typecheck → build → unit → integration → smoke → e2e → ollama
```

* **unit** und **integration** stammen aus **einer** Vitest-Ausführung (zwei
  Sichten auf denselben Lauf): Integrationsdateien sind die, die die echte
  `CoreApp` booten. Ein zweiter Durchlauf für eine zweite Tabellenspalte würde
  auf einem 16-GB-Laptop nur doppelt so lange dauern.
* **ollama** fährt `tests/ollama-live.test.ts` gegen den echten lokalen Server
  (`LPAI_LIVE_OLLAMA=1`), nur mit chat-fähigen Modellen; Embedding-Modelle sind
  per Capability ausgeschlossen.

## 2. Einmalige Einrichtung (die einzigen manuellen Schritte)

Voraussetzungen auf dem Windows-PC: **Node 22 LTS**, `git`, optional **Ollama**
mit einem Chat-Modell (`ollama pull qwen3:4b`). Der Runner bringt sein eigenes
git für den Checkout mit.

```powershell
# 1) Repository einmal klonen (oder eine vorhandene Kopie verwenden)
git clone https://github.com/Kaiserkatze1234/local-personal-ai C:\src\local-personal-ai

# 2) Runner installieren — prüft Toolchain, lädt den offiziellen Runner,
#    registriert ihn mit den Labels self-hosted/Windows/X64/lpai-test und
#    richtet den Autostart ein (Standard: geplante Aufgabe bei der Anmeldung,
#    weil die GUI/E2E-Stufen eine interaktive Sitzung brauchen)
powershell -ExecutionPolicy Bypass -File C:\src\local-personal-ai\scripts\windows\install-runner.ps1

# 3) Abhängigkeiten einmal vorwärmen (macht den ersten Lauf deutlich kürzer)
cd C:\src\local-personal-ai
npm ci
npm run rebuild:native
```

Das war alles. **Kein** ZIP, **kein** Dateikopieren, **kein** manueller
Teststart mehr: Der nächste Push auf `main` oder `arena/*` läuft von allein.

Optionen von `install-runner.ps1`:

* `-Mode Service` — Windows-Dienst (Session 0). Für reine Headless-Stufen
  brauchbar, **GUI/E2E ist dort unzuverlässig**; braucht eine erhöhte Shell.
* `-Token <ghs_…>` — Registrierungs-Token manuell (sonst über `gh` /
  `$env:GH_TOKEN` / Rückfrage).
* `-RunnerName`, `-RunnerDir`, `-Labels`, `-Replace`, `-ForceDownload`,
  `-SkipToolchainCheck`.

Rückbau vollständig:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\remove-runner.ps1
```

## 3. Was bei einem Push passiert

`.github/workflows/autonomous-test.yml` (Trigger: `push` auf `main` und
`arena/**`, plus manueller Start mit `quick`, `require_ollama`, `max_attempts`):

1. Checkout des **exakten** Commits (`fetch-depth: 0` — der Diff zum letzten
   getesteten Stand gehört zur Analyse).
2. Wiederherstellen von `test-reports/cycle-state.json` aus dem Cache
   (Rundenzähler und Wiederholungserkennung überleben den Lauf).
3. `npm ci`
4. `npm run test:autonomous -- --ci …`
5. Artefakt-Upload `lpai-test-reports` (immer), `lpai-ai-handoff` (immer:
   genau die Dateien, die die Analyseinstanz braucht) und `lpai-e2e-artifacts`
   (bei Fehlschlag), jeweils mit Screenshots und Playwright-Traces.
6. Strukturierter PR-Kommentar (Marker `<!-- lpai-autonomous-report -->`,
   wird aktualisiert statt gespammt) + Check-Annotationen im Lauf.
7. Bei gestopptem Zyklus: Issue-Eskalation mit Label `needs-human`.
8. Der Job schlägt fehl, wenn der Lauf fehlschlägt (kein „grün durchreichen“).

## 4. Statusmodell (kein Fake-PASS)

| Status | Bedeutung |
| --- | --- |
| `PASS` | Stufe ist wirklich durchgelaufen und grün |
| `FAIL` | Stufe ist durchgelaufen und rot — echter Befund |
| `SKIP` | Stufe bewusst nicht ausgeführt (z. B. `--quick`) — **nie** als bestanden gewertet |
| `INFRASTRUCTURE_ERROR` | Voraussetzung der Umgebung fehlt (Electron-Dist, Binding, Anzeige) — **kein Codefehler** |

Regeln, die im Code erzwungen werden:

* fehlendes Ollama ⇒ `SKIP` (mit `--require-ollama` ⇒ `FAIL`), niemals `PASS`;
* fehlende Electron-Distribution ⇒ `smoke`/`e2e` = `INFRASTRUCTURE_ERROR`
  (nicht `SKIP`, nicht `PASS`);
* ein Lauf, der „grün“ endet, aber `smoke-result.txt` verweigert, wird `FAIL`;
* ein Live-Lauf ohne einen einzigen ausgeführten Test wird `FAIL`;
* Gesamturteil: `FAIL` > `INFRASTRUCTURE_ERROR` > `PASS`
  (Exitcodes 1 / 2 / 0).

## 5. Reports

Alles liegt in `test-reports/` (nicht in Git, Reports reisen als CI-Artefakt):

| Datei | Inhalt |
| --- | --- |
| `latest.json` | vollständiger Report (Schema 1): `reportId`, `verdict`, `exitCode`, `git{commit,branch,subject,dirty}`, `runner{os,node,npm,cpu,ram,…}`, `ollama{reachable,baseUrl,models,version}`, `stages[]{name,status,durationMs,exitCode,counts,failedTests,errors,note,artifacts}`, `summary{passed,failed,skipped,infrastructureErrors,failedTests}`, `guards{stop,reasons,attempt}`, `analysis`, `artifacts{screenshots,traces,logs}` |
| `latest.md` | derselbe Report als lesbares Markdown |
| `<reportId>.json` / `.md` | zeitgestempelte Kopie jedes Laufs |
| `latest-chatgpt.json` | **Digest für die Analyseinstanz** (Schema 1): `verdict`, `whatWasTested{pipeline,branch,commit,runner,os,durationMs,stages,ollama,changedFiles,previousTestedSha}`, `works[]`, `broken[]`, `failedTests[]`, `skippedTests[]`, `infrastructureErrors[]`, `isCodeDefect`/`isInfrastructureError`, `likelyRootCause`, `confidence`, `classification{category,categoryLabel,source}`, `regression{isRegression,repeatedFailure,progress,newFailures,fixedSinceLastRun,...}`, `reproduce{clone,commit,steps,stageCommands}`, `affectedFiles[]`, `recommendedFix`, `testsToRerun{stages,failedTests,mustStayGreen}`, `artifacts` |
| `latest-chatgpt.md` | derselbe Digest als knapper Text (was getestet / was läuft / was ist kaputt / Einordnung / Empfehlung) |
| `latest-arena-task.md` | **nur bei Fehlschlag**: der für Arena direkt verwendbare Reparaturauftrag (Problem, Reproduktion, Erwartet/Gemessen, betroffene Tests, Dateien, Logs, Trace/Screenshot, Ursache, gewünschtes Verhalten, Einschränkungen, Regressionstest, Loop-Status) — wird bei `PASS` gelöscht |
| `latest-fix-prompt.md` | dasselbe Zielformat wie bisher (Kompatibilität), wird bei `PASS` gelöscht |
| `latest-analysis.json` | Ergebnis der Fehleranalyse |
| `cycle-state.json` | Runden, Fingerprints, letzter guter Stand, Stop-Grund |
| `e2e-artifacts/`, `artifacts/` | Screenshots, Traces, Anhänge |

Im Report stehen **keine** riesigen Rohlogs: `errors` enthält gefilterte,
auf 500 Zeichen gekürzte Zeilen (Fehler, Asserts, TS-Codes, Zeitüberschreitungen
…).

## 6. Fehleranalyse

1. **Immer zuerst deterministisch** (`classifyStage`/`classifyReport`):
   Infrastruktur- und Runtime-Signale (`ENOENT`, `ECONNREFUSED`,
   `NODE_MODULE_VERSION`, fehlendes Modell …) werden regelbasiert erkannt.
2. **Nur bei einem Fehler** und nur wenn die Regel-Antwort nicht eindeutig ist,
   kommt das **lokale Modell** über die vorhandene Infrastruktur zum Einsatz:
   `CoreApp` (bestehender `ModelRouter`, `ModelRoleService`, Capability-System,
   `ResourceManager`), Rolle `review`, Taskklasse `classification`,
   `preferSmall` — ein reines Embedding-Modell kann dadurch nie gewählt werden
   (die Rolle verlangt `text_generation`).
   *Prompt*: nur Diagnose-relevantes Material (fehlgeschlagene Stufe/Tests,
     Fehlerzeilen, Erwartung vs. Beobachtung, `git diff --stat` + Auszug,
     Artefaktpfade), hart begrenzt (`maxPromptChars` 6000, Timeout 150 s).
   *Antwort*: `{category, probableCause, component, file, observation,
     recommendedFix, confidence}` — JSON, validiert.
   *Kategorien*: `code_defect`, `regression`, `test_defect`, `build_defect`,
     `ui_defect`, `infrastructure`, `runtime_provider`, `preexisting_unrelated`,
     `unknown`. Eine eindeutige Infrastruktur-/Runtime-Diagnose darf das Modell
     nicht zu einem Codefehler umdeuten.
3. Ohne lokales Modell bleibt der Lauf vollständig funktionsfähig: die
   heuristische Analyse und der Reparaturauftrag entstehen trotzdem
   (`KI nicht nötig — deterministische Evidenz ist eindeutig`).

Manuell nachziehen (z. B. nach dem Installieren eines Modells), ohne die Tests
zu wiederholen:

```bash
npm run analyze:failure                 # letzter Report, mit lokaler KI
npm run analyze:failure -- --no-ai      # nur Regeln
```

## 7. ChatGPT-Lesepfad und Arena-Auftragspfad

**ChatGPT (zentrale Analyse-/Entscheidungsinstanz)** liest genau eine Datei:
`test-reports/latest-chatgpt.json` (Artefakt `lpai-ai-handoff`) bzw. die
Kurzfassung `latest-chatgpt.md`. Beide beantworten ohne Nachdenken:

| Frage | Feld |
| --- | --- |
| Was wurde getestet? | `whatWasTested{pipeline,branch,commit,runner,os,stages,ollama,changedFiles}` |
| Was funktioniert? | `works[]` |
| Was ist kaputt? | `broken[]`, `failures[]{stage,expected,actual,failedTests,affectedFiles,stacktrace,screenshot,trace}` |
| Code- oder Infrastrukturfehler? | `isCodeDefect`, `isInfrastructureError`, `classification.category(+Label)`, `infrastructureErrors[]` |
| Welche Dateien sind relevant? | `affectedFiles[]`, `classification.file` |
| Was hat sich seit dem letzten Lauf geändert? | `whatWasTested.changedFiles[]`, `previousTestedSha` |
| Regression? | `regression{isRegression,newFailures,fixedSinceLastRun,progress,repeatedFailure}` |
| Wie reproduzieren? | `reproduce{clone,commit,steps,stageCommands}` |
| Empfohlene Korrektur? | `recommendedFix`, `likelyRootCause`, `confidence` |
| Welche Tests müssen danach bestehen? | `testsToRerun{stages,failedTests,mustStayGreen}` |

Kein Rohlog, kein Repository-Abdruck, keine persönlichen Daten: Fehlerzeilen
sind gefiltert, Listen begrenzt (der Digest bleibt unter ~20 kB).

**Arena (Reparatur)** liest `test-reports/latest-arena-task.md` — derselbe Lauf,
aber als Auftrag formuliert (Abschnitt 5). Der Weg dorthin ist automatisch:

```
Test rot → Analyse → latest-chatgpt.json  →  (ChatGPT entscheidet & formuliert)
                  ↘ latest-arena-task.md  →  Arena repariert → Push → …
```

**Automatische Kanäle (alle offiziell, nichts erfunden):**

1. **Check-Annotationen** (`::error::`/`::warning::` mit Stufe + erster
   Fehlerzeile) — direkt im PR/Commit sichtbar.
2. **Strukturierter PR-Kommentar** mit Marker `<!-- lpai-autonomous-report -->`,
   Stufentabelle, fehlgeschlagenen Tests, Analyse-Kategorie, Stop-Grund.
3. **Artefakte** `lpai-ai-handoff` (Digest + Auftrag), `lpai-test-reports`
   (Reports + State), `lpai-e2e-artifacts` (Screenshots, Traces).
4. **`npm run feedback:pull`** holt beides in den Arbeitsbaum
   (`test-reports/inbox/`, inkl. `BRIEF.md`, `ARENA-TASK.md`, `pr-comment.md`).
5. **Start des Testlaufs aus Arena heraus** über die offizielle Workflow-API:
   `gh workflow run "Autonomous test (Windows runner)"` bzw.
   `repository_dispatch` — beide Trigger sind vorhanden.

**Die verbleibende Grenze — exakt benannt:** GitHub kann keinen *neuen*
Arena-Agentenlauf starten, und ChatGPT kann sich nicht selbst einen Testlauf
auslösen; dafür gibt es (Stand dieses Projekts) keine öffentliche,
dokumentierte Schnittstelle. Der Kreislauf ist daher automatisch bis zum
fertigen, maschinenlesbaren Auftrag:

```
Push → Windows-Test → Report + Analyse → Digest/Auftrag → Artefakt + Kommentar
     → feedback:pull → [eine Übergabe an ChatGPT/Arena] → reparieren → Push
```

Der letzte Anstoß — „jetzt reparieren“ bzw. „hier ist der Digest“ — ist der
einzige verbleibende manuelle Moment. Er wird bewusst **nicht** durch
nachgestellte Automatik ersetzt (kein erfundener Endpunkt, kein Fake-Trigger).
Von den manuellen Schritten der ursprünglichen Liste entfallen damit:
ZIP herunterladen/entpacken, kopieren, Kommandos tippen, Tests starten, Logs
kopieren, aus dem Report einen Prompt bauen. Übrig bleibt **eine** Übergabe:
Digest/Auftrag an die zentrale Instanz geben.

## 8. Reparaturzyklus und Sicherheitsgrenzen

`scripts/autonomous/guards.mjs` entscheidet nach jedem Lauf, ob automatisch
weitergearbeitet werden darf. Ein Zyklus ist eine Folge von `FAIL`-Runden über
Fix-Commits hinweg; ein `PASS` setzt alles zurück (`attempts = 0`,
`fingerprints = []`, letzter guter Stand = dieser Commit).

| Stop-Grund | Bedingung |
| --- | --- |
| `max_attempts_reached` | mehr als `--max-attempts` (Standard 3, `LPAI_MAX_FIX_ATTEMPTS`) Runden |
| `repeated_failure` | derselbe Fehler-Fingerprint ≥ 3 Mal (Fix wirkt nicht) |
| `infrastructure_error` | eine Stufe ist `INFRASTRUCTURE_ERROR` |
| `ollama_unavailable` | `--require-ollama`, aber kein Server |
| `tests_regressed` | neue fehlschlagende Stufen **oder** eine gewachsene Fehlermenge gegenüber der Vorrunde |
| `unknown_cause` | die Analyse liefert keine belastbare Ursache (Kategorie `unknown`, Konfidenz ≤ 0,1) — keine Rateänderung |
| `dangerous_change` | ab der zweiten Runde Änderungen an Workflows, Autonomie-Skripten, Runner-Skripten oder Playwright-Konfiguration |

Bei einem Stop wird **nicht** weitergearbeitet: Der Report erklärt warum, der
Lauf markiert die Stufen, der Workflow kann ein `needs-human`-Issue eröffnen.
Jede Runde ist über `cycle-state.json` und die zeitgestempelten Reports
nachvollziehbar.

Regressionen: Der Reparaturauftrag verlangt für echte Fehler einen
Reproduktionstest, und die Stufen „unit/integration“ halten die bestehenden
Tests grün — es gibt keinen Zustand, in dem ein Fix einen bestehenden Test
brechen darf, ohne dass der Lauf rot wird.

## 9. Sicherheit des selbst-gehosteten Runners

* Der Runner akzeptiert **nur Jobs aus diesem Repository** (Repo-Ebene), und
  das Workflow-Job hat zusätzlich `if: github.repository == '…'`.
* **Keine** `pull_request`/`pull_request_target`-Trigger für den
  self-hosted-Job: ein Fork-PR könnte sonst beliebigen Code auf dem PC
  ausführen. Fork-PRs laufen ausschließlich auf GitHub-Runnern
  (`pull-request-ci.yml`).
* Es werden **keine Secrets** in den Job injiziert; der Standard-Token ist
  schreibberechtigt nur für PR-Kommentar/Issue.
* Jeder Testprozess bekommt einen **Wegwerf-Datenordner** unter `%TEMP%`
  (`LPAI_DATA_DIR`) — `%APPDATA%\lpai` (Produktivdaten) wird nie gelesen oder
  geschrieben; die Analyse arbeitet auf einer **Kopie** von `config.json`/DB.
* Der Lauf startet nie die installierte App und veröffentlicht nichts; er
  arbeitet ausschließlich im Arbeitsverzeichnis des Runners.
* Vor jeder Electron-Stufe werden eigene, verwaiste `electron.exe`-Prozesse
  beendet (nur solche unter `node_modules\electron`) — keine fremden Prozesse.
* Die Analyse ruft das lokale Modell mit `keepAlive: 0`-Semantik auf, damit
  kein Modell dauerhaft im RAM bleibt.

## 10. Testdaten

* Isolation über `LPAI_DATA_DIR` (vom Orchestrator und vom E2E-Harness gesetzt),
* Electron-`userData` folgt demselben Ordner (Fensterzustand,
  Single-Instance-Lock),
* Memory-/Kontext-Tests arbeiten auf dem temporären Ordner,
* Aufräumen: temporäre Ordner werden am Ende jedes Laufs entfernt.

## 11. Fehlersuche

| Symptom | Ursache / Abhilfe |
| --- | --- |
| kein Lauf startet | Runner offline (`Actions → Runners`), Labels `self-hosted, Windows, X64, lpai-test` prüfen; `install-runner.ps1` erneut ausführen |
| `e2e` ist `INFRASTRUCTURE_ERROR` | Electron-Dist fehlt (`npm ci` + `npm run rebuild:native`) oder es läuft kein interaktiver Desktop (Session 0 → `-Mode Task`) |
| `smoke` ist `INFRASTRUCTURE_ERROR` | dito; die Stufe braucht ein echtes Fenster |
| `ollama` ist `SKIP` | Ollama nicht erreichbar/kein Modell — Absicht (kein PASS). `ollama serve`, Modell ziehen, `--require-ollama` für Pflicht |
| `npm ci` bricht ab | Node älter als 22 oder install-Skripte von npm blockiert (`npm approve-scripts electron better-sqlite3`) |
| Binding lädt nicht | `npm run rebuild:native` (fällt offline auf `@electron/rebuild` zurück) |
| Analyse sagt „KI nicht nötig“ | Regeln waren eindeutig — gewollt; `npm run analyze:failure` erzwingt einen Modellaufruf nicht sinnlos |

## 12. Neue Stufe ergänzen

1. Funktion `stageX()` in `scripts/autonomous-test.mjs` nach dem Muster von
   `stageSmoke()`/`stageE2e()` (`stage(name, {...})`, `markStage()`,
   `infra`-Muster für Umgebungsfehler).
2. In `main()` in die Reihenfolge einhängen und im Voraussetzungs-Zweig
   mitführen.
3. In `tests/autonomy.test.ts` aufnehmen, damit Stufenliste und
   Stop-Regeln nicht auseinanderlaufen.

## 13. Was die E2E-Stufe wirklich prüft

`tests/e2e/*.spec.ts` startet die **gebaute** App als echtes Electron über
Playwright (`_electron.launch`), gegen einen gescripteten OpenAI-kompatiblen
Provider (deterministisch, kein Modell nötig) oder — in der Live-Spezifikation —
gegen das echte lokale Ollama. Jeder Lauf bekommt einen Wegwerf-Datenordner.

| Datei | Szenarien |
| --- | --- |
| `startup.spec.ts` | App startet, Fenster sichtbar, Renderer lädt, Preload-Bridge vollständig, unbekannte IPC-Methode wird blockiert, echter IPC-Roundtrip (`app.info`), SQLite antwortet, sauberer Shutdown mit Exitcode 0 |
| `chat.spec.ts` | Antwort ist exakt der Modelltext, Streaming rendert schrittweise, Stop bricht wirklich ab (kein Weiterlaufen), Provider-Fehler wird ehrlich gemeldet statt erfunden, **"Hallo"** als Alltagsszenario, Frage nach den Arbeitsbedingungen ohne interne Marker |
| `memory-context.spec.ts` | "remember that …" landet in der DB und im nächsten Prompt, **"Merke dir: Ich mag kurze Antworten."** inkl. Abruf danach, Memory überlebt den Neustart, Konversationshistorie nur in derselben Konversation, passende Memory rankt vor unpassender, **"Erkläre mir Quantenphysik." bleibt frei von persönlichem Kontext**, alte Konversation nach Neustart wiederfindbar (`conversations.search`) |
| `tasks.spec.ts` | **"Was habe ich noch offen?"** — jeder Chat-Zug ist ein Task, nichts bleibt aktiv hängen, Task-Record überlebt den Neustart, Absturz mitten im Lauf → beim Start als `paused` wiederfindbar (Crash-Recovery) |
| `real-ollama.spec.ts` | echtes Modell antwortet in vertretbarer Zeit; die Antwort enthält keinen internen Kontext (keine Marker, kein Kontext-Dump); ohne erreichbaren Server ist die Stufe SKIP, nie PASS |

Bewusste Regeln: `retries: 0` (ein Retry würde einen echten Fehler verstecken),
`workers: 1` (16-GB-Rechner, ein Electron + höchstens ein Modell), Traces und
Screenshots nur bei Fehlschlag, und jede Assertion über Modelltext läuft über
`bubbleText()` — damit ein späteres UI-Element im Bubble nicht als "falsche
Antwort" durchgeht.
