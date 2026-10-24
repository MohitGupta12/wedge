; Removes Wedge's Windows 11 right-click menu package on uninstall. It is installed for
; all users (see src/main/shellmenu.js), so removing it asks for admin approval.
!macro customUnInstall
  ExecWait `powershell.exe -NoProfile -WindowStyle Hidden -Command "if (Get-AppxPackage -Name Wedge.ShellMenu) { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile -Command Get-AppxPackage -AllUsers -Name Wedge.ShellMenu | Remove-AppxPackage -AllUsers' }"`
  DeleteRegKey HKCU "Software\Wedge\Shell"
!macroend
