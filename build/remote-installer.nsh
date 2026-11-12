; SC-Remote installer additions: the background service (remote access from startup, also at the sign-in
; screen), the app in the tray for whoever signs in, and, on a first install, the window that sets this PC's password.
;  - Silent install: "SC-Remote-Setup.exe" /S  (remote access stays off until someone opens the app and clicks
;    "Configurar o acesso remoto…", or runs: "<install dir>\resources\service\ScreenShareRemoteService.exe" configure)

!macro customCheckAppRunning
  ; the service keeps the agent running: stop it so the files can be replaced, then close any open app windows
  IfFileExists "$INSTDIR\resources\service\ScreenShareRemoteService.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\service\ScreenShareRemoteService.exe" stop'
    Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "ScreenShareRemoteHelper.exe"'
  Pop $0
  Sleep 800
!macroend

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\ScreenShareRemoteService.exe" install'
  Pop $0
  ${if} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "O serviço do ${PRODUCT_NAME} não pôde ser configurado (código $0). / The ${PRODUCT_NAME} service could not be set up (code $0)." /SD IDOK
  ${endIf}
  ; the app sits in the tray for everyone who signs in (this PC's ID and state, quick access)
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --background'
  ; first install: choose this PC's password (an update keeps the current settings)
  IfSilent +2
    ExecWait '"$INSTDIR\resources\service\ScreenShareRemoteService.exe" configure-if-needed'
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    nsExec::Exec '"$INSTDIR\resources\service\ScreenShareRemoteService.exe" stop'
    Pop $0
  ${else}
    nsExec::ExecToLog '"$INSTDIR\resources\service\ScreenShareRemoteService.exe" uninstall'
    Pop $0
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${endIf}
!macroend
