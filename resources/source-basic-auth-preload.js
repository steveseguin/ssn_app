'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverSignIn', {
    submit: (username, password) => ipcRenderer.send('source-basic-auth-response', { username, password }),
    cancel: () => ipcRenderer.send('source-basic-auth-response', null)
});
