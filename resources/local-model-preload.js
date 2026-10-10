'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ssnLocalModelHost', {
    onCommand(callback) {
        ipcRenderer.on('ssapp:local-model-host-command', (_event, command) => callback(command));
    },
    send(message) {
        ipcRenderer.send('ssapp:local-model-host-event', message);
    }
});
