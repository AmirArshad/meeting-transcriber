; Custom NSIS installer script for Meeting Transcriber
; Adds progress messages during installation

; Progress messages for better UX during install
!macro customInstall
  DetailPrint "Extracting AI components..."
  DetailPrint "This may take 5-10 minutes on older hardware."
  DetailPrint "Please be patient while files are being extracted."
!macroend

; Initialize on launch
!macro customInit
  ; Nothing special needed on init
!macroend
