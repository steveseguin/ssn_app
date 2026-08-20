!include "nsDialogs.nsh"

!define SSAPP_REG_KEY "Software\SocialStream"
!define SSAPP_PATH_HELPER_TARGET "$INSTDIR\resources\installer-user-path.ps1"
!define SSAPP_FIREWALL_HELPER_TARGET "$INSTDIR\resources\installer-firewall.ps1"

Var AddToPathCheckbox
Var AddToPathSelection
Var InstallAiTtsModelsCheckbox
Var InstallAiTtsModelsSelection

!macro customInit
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
!macroend

Function AddToPathPageCreate
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error 0 +2
        Abort

    ${NSD_CreateLabel} 0 0 100% 24u "Optional setup step: add Social Stream Ninja install folder to your user PATH."
    Pop $0

    ${NSD_CreateCheckbox} 0 32u 100% 12u "Add install directory to PATH (can conflict with anti-cheat in some games)"
    Pop $AddToPathCheckbox
    ${NSD_SetState} $AddToPathCheckbox $AddToPathSelection

    nsDialogs::Show
FunctionEnd

Function AddToPathPageLeave
    ${NSD_GetState} $AddToPathCheckbox $AddToPathSelection
FunctionEnd

Function AiTtsModelsPageCreate
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error 0 +2
        Abort

    ${NSD_CreateLabel} 0 0 100% 24u "Optional setup step: install the local AI / TTS voice models."
    Pop $0

    ${NSD_CreateCheckbox} 0 32u 100% 12u "Install local AI / TTS models (recommended; uses extra disk space)"
    Pop $InstallAiTtsModelsCheckbox
    ${NSD_SetState} $InstallAiTtsModelsCheckbox $InstallAiTtsModelsSelection

    ${NSD_CreateLabel} 0 54u 100% 28u "Uncheck this to save space. Local text-to-speech voices will not work until you reinstall with this enabled."
    Pop $0

    nsDialogs::Show
FunctionEnd

Function AiTtsModelsPageLeave
    ${NSD_GetState} $InstallAiTtsModelsCheckbox $InstallAiTtsModelsSelection
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
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1" -Mode "$0" -AppPath "$INSTDIR\${PRODUCT_FILENAME}.exe"' $2
    Goto check_result

    missing_helper:
        StrCpy $2 1

    check_result:
    StrCmp $2 0 cleanup
    IfSilent cleanup
    MessageBox MB_OK|MB_ICONEXCLAMATION "Social Stream Ninja was installed, but Windows Firewall could not be updated. Windows may ask you to allow network access when the app starts."

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
    WriteRegStr HKCU "${SSAPP_REG_KEY}" "InstallAiTtsModels" "$InstallAiTtsModelsSelection"
    StrCmp $InstallAiTtsModelsSelection 1 ai_tts_models_done 0
        !insertmacro RemoveAiTtsModelFiles
    ai_tts_models_done:
    Push "install"
    Call RunFirewallHelper
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
