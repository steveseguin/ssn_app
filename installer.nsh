!include "nsDialogs.nsh"

!define SSAPP_REG_KEY "Software\SocialStream"
!define SSAPP_PATH_HELPER_TARGET "$INSTDIR\resources\installer-user-path.ps1"

Var AddToPathCheckbox
Var AddToPathSelection

!macro customInit
    ; Default to "do not modify PATH" unless the user opted in before.
    StrCpy $AddToPathSelection 0
    ClearErrors
    ReadRegStr $0 HKCU "${SSAPP_REG_KEY}" "PathEntry"
    IfErrors 0 +2
        StrCpy $0 ""
    StrCmp $0 "" +2 0
        StrCpy $AddToPathSelection 1
!macroend

!macro customPageAfterChangeDir
    Page custom AddToPathPageCreate AddToPathPageLeave
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

!macro AddPathHelperFile
    Push $0
    StrCpy $0 $OUTDIR
    SetOutPath "$INSTDIR\resources"
    File "/oname=installer-user-path.ps1" "${PROJECT_DIR}\scripts\installer-user-path.ps1"
    SetOutPath "$0"
    Pop $0
!macroend

!macro customFiles_x64
    !insertmacro AddPathHelperFile
!macroend

!macro customFiles_ia32
    !insertmacro AddPathHelperFile
!macroend

!macro customFiles_arm64
    !insertmacro AddPathHelperFile
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
!macroend

!macro customUnInstall
    Push "uninstall"
    Call un.RunPathHelper
!macroend
