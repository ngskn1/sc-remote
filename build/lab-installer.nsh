; ScreenShare Remote (lab edition) installer additions.
;  - A lab-setup.json next to the installer makes this PC a lab PC: the background service is registered and
;    started (it runs the agent before anyone signs in). Without one, only the member app is installed.
;  - Re-running a newer installer on a lab PC keeps it a lab PC (and a new lab-setup.json moves it to that lab).
;  - Silent install for many PCs:  "ScreenShare-Remote-Setup.exe" /S   (with lab-setup.json in the same folder)

!macro customCheckAppRunning
  ; the service keeps the agent running: stop it so the files can be replaced, then close any open app windows
  IfFileExists "$INSTDIR\resources\lab\ScreenShareRemoteService.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\lab\ScreenShareRemoteService.exe" stop'
    Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "ScreenShare Remote.exe"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "ScreenShareRemoteHelper.exe"'
  Pop $0
  Sleep 800
!macroend

!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\lab\ScreenShareRemoteService.exe" install-if-needed "$EXEDIR\lab-setup.json"'
  Pop $0
  ${if} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "The ScreenShare Remote service could not be set up (code $0). See the admin guide." /SD IDOK
  ${endIf}
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    ; updating: the new version's installer starts the service again
    nsExec::Exec '"$INSTDIR\resources\lab\ScreenShareRemoteService.exe" stop'
    Pop $0
  ${else}
    nsExec::ExecToLog '"$INSTDIR\resources\lab\ScreenShareRemoteService.exe" uninstall'
    Pop $0
  ${endIf}
!macroend
