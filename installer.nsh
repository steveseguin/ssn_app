!include "nsDialogs.nsh"
!include "MUI2.nsh"

!define SSAPP_REG_KEY "Software\SocialStream"
!define SSAPP_PATH_HELPER_TARGET "$INSTDIR\resources\installer-user-path.ps1"
!define SSAPP_FIREWALL_HELPER_TARGET "$INSTDIR\resources\installer-firewall.ps1"

Var AddToPathCheckbox
Var AddToPathSelection
Var InstallAiTtsModelsCheckbox
Var InstallAiTtsModelsSelection
Var InstallerHint
Var InstallerProgressHints

!macro customInit
    ; Pick two different hints once per run; no timers or extra installer pages.
    Push $0
    System::Call 'kernel32::GetTickCount() i.r0'
    IntOp $0 $0 & 0x7fffffff
    IntOp $0 $0 % 10
    Call GetInstallerHint
    StrCpy $InstallerProgressHints "$InstallerHint"
    IntOp $0 $0 + 3
    IntOp $0 $0 % 10
    Call GetInstallerHint
    StrCpy $InstallerProgressHints "$InstallerProgressHints$\r$\n$\r$\n$InstallerHint$\r$\n$\r$\nFinishing setup may open Windows PowerShell and ask for permission to add the app's firewall rule. No typing is needed."
    Pop $0

    ; Default to "do not modify PATH" unless the user opted in before.
    StrCpy $AddToPathSelection 0
    ClearErrors
    ReadRegStr $0 HKCU "${SSAPP_REG_KEY}" "PathEntry"
    IfErrors 0 +2
        StrCpy $0 ""
    StrCmp $0 "" +2 0
        StrCpy $AddToPathSelection 1

    ; Default to installing local AI/TTS models unless the user opted out before.
    StrCpy $InstallAiTtsModelsSelection 1
    ClearErrors
    ReadRegStr $0 HKCU "${SSAPP_REG_KEY}" "InstallAiTtsModels"
    IfErrors +3 0
    StrCmp $0 "0" 0 +2
        StrCpy $InstallAiTtsModelsSelection 0
!macroend

!macro customPageAfterChangeDir
    Page custom AddToPathPageCreate AddToPathPageLeave
    Page custom AiTtsModelsPageCreate AiTtsModelsPageLeave
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowInstallerHints
!macroend

Function GetInstallerHint
    ${Switch} $0
        ${Case} 0
            StrCpy $InstallerHint "Tip: export your app settings after making changes, so you have a backup."
            ${Break}
        ${Case} 1
            StrCpy $InstallerHint "Tip: test one chat source first, then add the rest of your streaming platforms."
            ${Break}
        ${Case} 2
            StrCpy $InstallerHint "Tip: send a test chat message before going live to check that your setup is ready."
            ${Break}
        ${Case} 3
            StrCpy $InstallerHint "Tip: separate app sessions can keep different shows' settings and sources apart."
            ${Break}
        ${Case} 4
            StrCpy $InstallerHint "Tip: use a source's mute control if its capture page is playing unwanted audio."
            ${Break}
        ${Case} 5
            StrCpy $InstallerHint "Tip: YouTube groups can check for live streams and activate their chat sources."
            ${Break}
        ${Case} 6
            StrCpy $InstallerHint "Tip: group controls let you hide, mute, or reload all capture pages in that group."
            ${Break}
        ${Case} 7
            StrCpy $InstallerHint "Tip: give each app session a clear name so it is easy to find the right setup."
            ${Break}
        ${Case} 8
            StrCpy $InstallerHint "Tip: check your chat layout in your streaming software before starting a broadcast."
            ${Break}
        ${Case} 9
            StrCpy $InstallerHint "Tip: if a source stops connecting, try its reload control before recreating it."
            ${Break}
    ${EndSwitch}
FunctionEnd

!macro customHeader
    ; electron-builder hides the details list. Use that free space for readable
    ; hints while preserving the status line and progress bar above it.
    Function ShowInstallerHints
        Push $0
        Push $1
        Push $2
        Push $3
        Push $4
        Push $5
        System::Alloc 16
        Pop $0
        System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.Log, p r0)'
        System::Call 'user32::MapWindowPoints(p 0, p $mui.InstFilesPage, p r0, i 2)'
        System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
        System::Free $0
        IntOp $3 $3 - $1
        IntOp $4 $4 - $2
        System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "$InstallerProgressHints", i 0x50000000, i r1, i r2, i r3, i r4, p $mui.InstFilesPage, p 0, p 0, p 0) p.r5'
        SendMessage $mui.InstFilesPage.Text ${WM_GETFONT} 0 0 $0
        SendMessage $5 ${WM_SETFONT} $0 1
        Pop $5
        Pop $4
        Pop $3
        Pop $2
        Pop $1
        Pop $0
    FunctionEnd
!macroend

Function AddToPathPageCreate
    !insertmacro MUI_HEADER_TEXT "Command-line access" "Optional: launch the app from a terminal"
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error 0 +2
        Abort

    ${NSD_CreateLabel} 0 0 100% 24u "Usually open the app from a shortcut? Leave this option unchecked."
    Pop $0

    ${NSD_CreateCheckbox} 0 32u 100% 12u "Add Social Stream Ninja to my PATH"
    Pop $AddToPathCheckbox
    ${NSD_SetState} $AddToPathCheckbox $AddToPathSelection
    ${NSD_OnClick} $AddToPathCheckbox AddToPathSelectionChanged

    ${NSD_CreateLabel} 0 52u 100% 28u "This lets you launch the app by typing its command from any folder. It can conflict with anti-cheat software in some games."
    Pop $0

    ${NSD_CreateLabel} 0 88u 100% 24u "Setup uses Windows PowerShell to apply this choice. Turning it off removes the app's previous PATH entry, if any."
    Pop $0

    ${NSD_CreateLabel} 0 120u 100% 20u "Tip: export and save your app settings before updating."
    Pop $0

    nsDialogs::Show
FunctionEnd

Function AddToPathPageLeave
    ${NSD_GetState} $AddToPathCheckbox $AddToPathSelection
FunctionEnd

Function AddToPathSelectionChanged
    Pop $0
    Call AddToPathPageLeave
FunctionEnd

Function AiTtsModelsPageCreate
    !insertmacro MUI_HEADER_TEXT "Local text-to-speech voices" "Choose whether to include the voice model files"
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error 0 +2
        Abort

    ${NSD_CreateLabel} 0 0 100% 24u "These optional files let the app generate speech on your computer."
    Pop $0

    ${NSD_CreateCheckbox} 0 28u 100% 12u "Include local voice models (recommended; uses more disk space)"
    Pop $InstallAiTtsModelsCheckbox
    ${NSD_SetState} $InstallAiTtsModelsCheckbox $InstallAiTtsModelsSelection
    ${NSD_OnClick} $InstallAiTtsModelsCheckbox AiTtsModelsSelectionChanged

    ${NSD_CreateLabel} 0 46u 100% 28u "Leave this checked to keep local voices available. If unchecked, reinstall with this enabled to use them later."
    Pop $0

    ${NSD_CreateLabel} 0 82u 100% 24u "During setup, PowerShell windows may appear. No typing is needed. Windows may ask for administrator permission to set up firewall access."
    Pop $0

    ${NSD_CreateLabel} 0 112u 100% 28u "The firewall rule allows incoming connections to this app on private and public networks. Your firewall stays on."
    Pop $0

    nsDialogs::Show
FunctionEnd

Function AiTtsModelsPageLeave
    ${NSD_GetState} $InstallAiTtsModelsCheckbox $InstallAiTtsModelsSelection
FunctionEnd

Function AiTtsModelsSelectionChanged
    Pop $0
    Call AiTtsModelsPageLeave
FunctionEnd

!macro AddInstallerHelperFiles
    Push $0
    StrCpy $0 $OUTDIR
    SetOutPath "$INSTDIR\resources"
    File "/oname=installer-user-path.ps1" "${PROJECT_DIR}\scripts\installer-user-path.ps1"
    File "/oname=installer-firewall.ps1" "${PROJECT_DIR}\scripts\installer-firewall.ps1"
    SetOutPath "$0"
    Pop $0
!macroend

!macro customFiles_x64
    !insertmacro AddInstallerHelperFiles
!macroend

!macro customFiles_ia32
    !insertmacro AddInstallerHelperFiles
!macroend

!macro customFiles_arm64
    !insertmacro AddInstallerHelperFiles
!macroend

!macro RemoveAiTtsModelFiles
    RMDir /r "$INSTDIR\resources\app.asar.unpacked\Kokoro-82M-ONNX"
    RMDir /r "$INSTDIR\resources\app\Kokoro-82M-ONNX"
    RMDir /r "$INSTDIR\resources\Kokoro-82M-ONNX"
!macroend

Function RunPathHelper
    Exch $0
    Push $1
    Push $2

    StrCpy $1 "${SSAPP_PATH_HELPER_TARGET}"
    IfFileExists "$1" 0 missing_helper
    SetDetailsPrint both
    DetailPrint "Applying your PATH choice with Windows PowerShell..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1" -Mode $0 -InstallDir "$INSTDIR" -Selected "$AddToPathSelection"' $2
    Goto cleanup

    missing_helper:
        StrCpy $2 1

    cleanup:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Function un.RunPathHelper
    Exch $0
    Push $1
    Push $2

    StrCpy $1 "${SSAPP_PATH_HELPER_TARGET}"
    IfFileExists "$1" 0 missing_helper
    SetDetailsPrint both
    DetailPrint "Removing the app's PATH entry with Windows PowerShell..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1" -Mode $0 -InstallDir "$INSTDIR" -Selected "0"' $2
    Goto cleanup

    missing_helper:
        StrCpy $2 1

    cleanup:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Function RunFirewallHelper
    Exch $0
    Push $1
    Push $2

    StrCpy $1 "${SSAPP_FIREWALL_HELPER_TARGET}"
    IfFileExists "$1" 0 missing_helper
    SetDetailsPrint both
    DetailPrint "Setting up firewall access. PowerShell may ask for permission..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1" -Mode "$0" -AppPath "$INSTDIR\${PRODUCT_FILENAME}.exe"' $2
    Goto check_result

    missing_helper:
        StrCpy $2 1

    check_result:
    StrCmp $2 0 cleanup
    IfSilent cleanup
    MessageBox MB_OK|MB_ICONEXCLAMATION "Social Stream Ninja was installed, but its firewall rule could not be added or checked.$\r$\n$\r$\nYou can still open the app. Features that receive incoming connections may need firewall approval later."

    cleanup:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Function un.RunFirewallHelper
    Exch $0
    Push $1
    Push $2

    StrCpy $1 "${SSAPP_FIREWALL_HELPER_TARGET}"
    IfFileExists "$1" 0 missing_helper
    SetDetailsPrint both
    DetailPrint "Removing the app's firewall rule. PowerShell may ask for permission..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1" -Mode "$0" -AppPath "$INSTDIR\${PRODUCT_FILENAME}.exe"' $2
    Goto check_result

    missing_helper:
        StrCpy $2 1

    check_result:
    StrCmp $2 0 cleanup
    IfSilent cleanup
    MessageBox MB_OK|MB_ICONEXCLAMATION "Social Stream Ninja was removed, but its Windows Firewall rule could not be removed. You can remove it later in Windows Security."

    cleanup:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

!macro customInstall
    IfSilent 0 +6
    ClearErrors
    ReadRegStr $0 HKCU "${SSAPP_REG_KEY}" "PathEntry"
    IfErrors 0 +2
        StrCpy $0 ""
    StrCmp $0 "" +2 0
        StrCpy $AddToPathSelection 1
    Push "install"
    Call RunPathHelper
    DetailPrint "Saving your local text-to-speech voice choice..."
    WriteRegStr HKCU "${SSAPP_REG_KEY}" "InstallAiTtsModels" "$InstallAiTtsModelsSelection"
    StrCmp $InstallAiTtsModelsSelection 1 ai_tts_models_done 0
        DetailPrint "Removing optional voice model files, as requested..."
        !insertmacro RemoveAiTtsModelFiles
    ai_tts_models_done:
    Push "install"
    Call RunFirewallHelper
    DetailPrint "Setup steps finished."
!macroend

!macro customUnInstall
    Push "uninstall"
    Call un.RunPathHelper
    ; The old uninstaller runs during upgrades. Keep the valid rule so updates do
    ; not cause an unnecessary elevation prompt, then verify it after extraction.
    ${ifNot} ${isUpdated}
        Push "uninstall"
        Call un.RunFirewallHelper
    ${endif}
!macroend
