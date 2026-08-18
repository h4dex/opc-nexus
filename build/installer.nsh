!macro customInstall
  CreateShortCut "$SMPROGRAMS\Quest.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--quest-only" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "Quest"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Quest.lnk"
!macroend
