!include "nsDialogs.nsh"

Var AddToPathCheckbox
Var AddToPathSelection

!macro customInit
    ; Default to "do not modify PATH" unless the user opts in.
    StrCpy $AddToPathSelection 0
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
    ${NSD_SetState} $AddToPathCheckbox 0

    nsDialogs::Show
FunctionEnd

Function AddToPathPageLeave
    ${NSD_GetState} $AddToPathCheckbox $AddToPathSelection
FunctionEnd

!macro customInstall
    ; User did not opt in to PATH changes.
    StrCmp $AddToPathSelection 1 0 Done

    ReadEnvStr $0 "PATH"
    FileOpen $1 "$INSTDIR\path_backup.txt" a
    FileWrite $1 "$0$\r$\n"
    FileClose $1

    ; Check if INSTDIR already exists in PATH
    Push $0
    Push "$INSTDIR"
    Call StrContains
    Pop $R0
    StrCmp $R0 "" PathNotFound PathFound

    PathFound:
        ; INSTDIR already in PATH, don't add it again
        Goto Done

    PathNotFound:
        ; Add INSTDIR to PATH
        StrCmp "$0" "" EmptyPath
        StrCpy $0 "$0;$INSTDIR"
        Goto WritePath

    EmptyPath:
        StrCpy $0 "$INSTDIR"

    WritePath:
        WriteRegExpandStr HKCU "Environment" "PATH" $0
        SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

    Done:
!macroend
