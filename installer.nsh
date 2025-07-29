!macro customInstall
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