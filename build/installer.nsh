; Custom NSIS include (auto-discovered from buildResources by electron-builder).
;
; Goal: "start the app by opening one thing" — double-click a document with
; this app chosen in Explorer's "Open with…" list and the exe launches with
; the path in argv (consumed by src/main/launchFiles.ts -> knowledge import).
;
; Why not `fileAssociations` in electron-builder.yml: the bundled
; FileAssociation.nsh overwrites `Software\Classes\<.ext>` — it would STEAL
; the default handler for .txt/.json/... from the user's current apps. This
; registers an Application-scoped entry instead: we show up in the
; "Open with" menu via SupportedTypes, defaults stay untouched. SHELL_CONTEXT
; mirrors per-user vs perMachine exactly like the built-in macros; the hooks
; are invoked from installSection.nsh / uninstaller.nsh via !ifmacrodef.

!macro LPAI_ADD_SUPPORTED_TYPE EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" `${EXT}` ""
!macroend

!macro registerFileAssociations
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${APP_PRODUCT_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\InstallPath" "" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open" "" "Open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" "$appExe $\"%1$\""
  ; the formats our §12 importers actually parse (lower-case value names;
  ; Explorer queries the exact string it uses for the file's suffix)
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".txt"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".md"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".markdown"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".log"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".json"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".csv"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".tsv"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".html"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".htm"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".pdf"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".docx"
  ; upper-case variants too — SupportedTypes matching is case-sensitive
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".TXT"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".MD"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".PDF"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".DOCX"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".JSON"
  !insertmacro LPAI_ADD_SUPPORTED_TYPE ".CSV"
!macroend

!macro unregisterFileAssociations
  ; only ever our own Application key — other apps' handlers untouched
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!macroend
