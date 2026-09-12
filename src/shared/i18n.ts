/**
 * Minimal i18n for UI chrome (§47 general.language). Keyed by the English
 * string itself — missing translations fall back to English, so adding a
 * string never breaks the UI. The AI's answer language is handled separately
 * via the system prompt; this dictionary only covers app chrome.
 */
export const DE: Record<string, string> = {
  // navigation / shell
  Chat: 'Chat',
  Tasks: 'Aufgaben',
  Projects: 'Projekte',
  Memory: 'Erinnerungen',
  Skills: 'Fähigkeiten',
  Diagnostics: 'Diagnose',
  Settings: 'Einstellungen',
  'demo model only': 'nur Demo-Modell',
  'runtime model bound': 'Laufzeit-Modell verbunden',
  'working…': 'arbeitet…',
  'No project': 'Kein Projekt',
  Retry: 'Erneut versuchen',
  'not connected': 'nicht verbunden',
  // modes
  'Conversation — uses your runtime model directly': 'Unterhaltung — nutzt dein Laufzeit-Modell direkt',
  'Multi-step task execution with approved tools': 'Mehrstufige Aufgaben mit freigegebenen Werkzeugen',
  'Project-aware: inspect → edit → verify': 'Projektbezogen: prüfen → ändern → verifizieren',
  'Computer assistance on scoped folders': 'Computer-Assistent auf freigegebenen Ordnern',
  // chat panel
  'What should we do?': 'Was machen wir?',
  'Ask anything… (Enter to send, Shift+Enter for newline)': 'Frag etwas… (Enter sendt, Umschalt+Enter neue Zeile)',
  'Describe the task… e.g. "find why the build fails, fix it and verify"':
    'Beschreibe die Aufgabe… z. B. „Finde den Build-Fehler, behebe und verifiziere ihn“',
  Send: 'Senden',
  Stop: 'Stopp',
  'attach current screen (needs a vision-capable model)': 'Bildschirm anhängen (braucht Vision-Modell)',
  'attach a screen region (drag to select)': 'Bereich auswählen und anhängen (aufziehen)',
  'analyze a screen recording (needs ffmpeg + vision model)': 'Bildschirmaufnahme analysieren (braucht ffmpeg + Vision-Modell)',
  'stop dictation (voice → text)': 'Diktat beenden (Sprache → Text)',
  'dictate (push-to-talk; global hotkey also toggles)': 'Diktieren (Drücken-and-Sprechen; globaler Hotkey schaltet ebenfalls)',
  'read aloud (needs TTS backend)': 'vorlesen (braucht TTS-Backend)',
  '🔊 speak': '🔊 vorlesen',
  'screen attached — send to analyze with a vision model': 'Bildschirm angehängt — senden zur Analyse mit Vision-Modell',
  // permission dialog
  'Permission needed': 'Berechtigung erforderlich',
  Deny: 'Ablehnen',
  'Allow once': 'Einmal erlauben',
  'Allow for session': 'Für Sitzung erlauben',
  'Allow always': 'Immer erlauben',
  'This task wants to do something that needs your approval.': 'Diese Aufgabe möchte etwas tun, das deine Freigabe braucht.',
  dangerous: 'gefährlich',
  // wizard
  'Welcome — everything stays on this machine': 'Willkommen — alles bleibt auf diesem Rechner',
  'Install/start Ollama (ollama.com) and pull a model like': 'Ollama installieren/starten (ollama.com) und ein Modell laden wie',
  'for coding work, then click Re-scan. You can continue with the built-in demo model to explore the UI — it is explicitly labeled and not a real reasoning model.':
    'für Programmier-Arbeit, dann „Erneut scannen“ klicken. Du kannst mit dem eingebauten Demo-Modell weitermachen, um die UI zu erkunden — es ist eindeutig beschriftet und kein echtes Schlussfolgerungs-Modell.',
  'use demo model for now': 'vorläufig Demo-Modell verwenden',
  'Demo model will be bound to all roles. Swap any time in Settings → AI; this is not a permanent choice.':
    'Das Demo-Modell wird allen Rollen zugewiesen. Wechsel jederzeit in Einstellungen → KI; das ist keine endgültige Wahl.',
  'chat model': 'Chat-Modell',
  'coding model': 'Coding-Modell',
  "Vision and voice are optional and detected later on the health screen — nothing is promised that your models can't do.":
    'Vision und Sprache sind optional und werden später auf dem Gesundheits-Screen erkannt — es wird nichts versprochen, das deine Modelle nicht können.',
  'Local Personal AI runs with a runtime model you choose (Ollama or any local OpenAI-compatible server). Data lives in:':
    'Local Personal AI läuft mit einem Laufzeit-Modell deiner Wahl (Ollama oder ein lokaler OpenAI-kompatibler Server). Daten liegen in:',
  'Local-first · your model · your machine': 'Lokal zuerst · dein Modell · dein Rechner',
  'Ask normally — "mach das schneller", "guck mal warum das nicht geht". Pick Agent or Coding mode for tool work; the AI plans, uses approved tools, and verifies what it changed.':
    'Frag einfach normal — „mach das schneller“, „guck mal warum das nicht geht“. Für Tool-Arbeit Agent- oder Coding-Modus wählen; die KI plant, nutzt freigegebene Tools und prüft, was sie geändert hat.',
  'No cloud account, no telemetry.': 'Kein Cloud-Konto, keine Telemetrie.',
  'File access starts empty — you grant folders explicitly.': 'Dateizugriff startet leer — Ordner wirst du explizit freigeben.',
  'You can change all of this in Settings later.': 'All das kannst du später in den Einstellungen ändern.',
  'Local model provider': 'Lokaler Modell-Provider',
  'No provider detected.': 'Kein Provider gefunden.',
  'Re-scan': 'Erneut scannen',
  'Runtime model selection': 'Laufzeit-Modell wählen',
  'No chat-capable models found — go back and re-scan, or enable the demo model.':
    'Keine Chat-Modelle gefunden — zurück und erneut scannen, oder das Demo-Modell nutzen.',
  Permissions: 'Berechtigungen',
  'You can grant folders under Settings → Tools and at every confirmation dialog.':
    'Ordner freigibst du unter Einstellungen → Werkzeuge und bei jeder Rückfrage.',
  'Performance profile': 'Leistungsprofil',
  'Auto-switching stays enabled: the app steps down under pressure regardless.':
    'Automatischer Wechsel bleibt aktiv: Bei Druck reduziert die App trotzdem.',
  'Start using the app': 'Loslegen',
  Next: 'Weiter',
  Back: 'Zurück',
  // panels
  'Every agent action is a recoverable task with visible phases.':
    'Jede Agent-Aktion ist eine wiederherstellbare Aufgabe mit sichtbaren Phasen.',
  'No tasks yet — switch to Agent or Coding mode and ask for something.':
    'Noch keine Aufgaben — wechsle in den Agent- oder Coding-Modus und frag etwas.',
  'Reusable procedures — learned from confirmed workflows or added by you. Skills never bypass permissions.':
    'Wiederverwendbare Abläufe — gelernt aus bestätigten Workflows oder von dir angelegt. Fähigkeiten umgehen nie Berechtigungen.',
  'Nothing learned yet. Confirm useful corrections while working and candidates show up here.':
    'Noch nichts gelernt. Bestätige nützliche Korrekturen bei der Arbeit, Kandidaten erscheinen hier.',
  'Projects & knowledge': 'Projekte & Wissen',
  'record(s)': 'Eintrag/Einträge',
  // drag & drop / external file open
  'Drop files to import': 'Dateien zum Importieren ablegen',
  'Text, Markdown, PDF, DOCX, code — the AI can use them afterwards': 'Text, Markdown, PDF, DOCX, Code — die KI nutzt sie anschließend',
  'Dropped items are not files on disk.': 'Die abgelegten Elemente sind keine Dateien auf der Festplatte.',
  'Choose folder': 'Ordner auswählen',
  'Use this folder': 'Diesen Ordner verwenden',
  'Choose file': 'Datei auswählen',
  Import: 'Importieren',
  'Import failed': 'Import fehlgeschlagen',
  Updated: 'Aktualisiert',
  Imported: 'Importiert',
  chunks: 'Chunks',
  'Import file…': 'Datei importieren…',
  // settings cards
  'AI providers & models': 'KI-Provider & Modelle',
  'Model roles': 'Modell-Rollen',
  'Tools & permissions': 'Werkzeuge & Berechtigungen',
  'Filesystem roots': 'Dateisystem-Wurzeln',
  'Memory & learning': 'Erinnerungen & Lernen',
  'Vision & voice': 'Sehen & Stimme',
  'Internet (optional layer — core never needs it)': 'Internet (optionale Ebene — der Kern braucht sie nie)',
  'Overlay & prompt assistant': 'Overlay & Prompt-Assistent',
  Performance: 'Leistung',
  'Extensions (modular capabilities, §42)': 'Erweiterungen (modulare Fähigkeiten, §42)',
  General: 'Allgemein',
  'Diagnostics & data': 'Diagnose & Daten',
  // general card additions
  Language: 'Sprache',
  Theme: 'Erscheinungsbild',
  'Start with Windows': 'Mit Windows starten',
  'Start hidden to tray': 'Versteckt im Infobereich starten',
  'Close button minimizes to tray': 'Schließen-Minimieren in den Infobereich',
  'Autostart, tray and window behaviour apply after restart.': 'Autostart, Infobereich und Fenster verhalten sich erst nach Neustart.',
  // diagnostics panel
  'Health, resource usage and recoverability — without digging through logs.':
    'Gesundheit, Ressourcennutzung und Wiederherstellbarkeit — ohne Log-Suche.',
  'Export diagnostics': 'Diagnose exportieren',
  'Run self-tests': 'Selbsttests ausführen',
  'Recent log': 'Letzte Protokolle',
  'open log folder': 'Protokordordner öffnen',
  // misc buttons
  Add: 'Hinzufügen',
  Remove: 'Entfernen',
  Refresh: 'Aktualisieren',
  'Show overlay': 'Overlay anzeigen',
  'Hide overlay': 'Overlay verstecken',
  'Reload from disk': 'Von Festplatte neu laden',
  // startup & tray
  Open: 'Öffnen',
  'Show/hide overlay': 'Overlay ein-/ausblenden',
  Quit: 'Beenden',
  'Continue →': 'Weiter →',
  'Resume (rerun)': 'Fortsetzen (erneut ausführen)',
  Discard: 'Verwerfen',
  cancel: 'Abbrechen',
  'no extensions': 'keine Erweiterungen',
};

export function tr(lang: string, en: string): string {
  if (!lang.toLowerCase().startsWith('de')) return en;
  return DE[en] ?? en;
}
