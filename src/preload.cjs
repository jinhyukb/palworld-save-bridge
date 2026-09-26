const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = (action, args) => ipcRenderer.invoke("psb:action", action, args);
contextBridge.exposeInMainWorld("bridge", {
  state: () => invoke("state"),
  pickInput: (kind) => invoke("pickInput", { kind }),
  importPath: (path) => invoke("import", { path }),
  dropFile: (file) => invoke("import", { path: webUtils.getPathForFile(file) }),
  selectWorld: (candidateId) => invoke("selectWorld", { candidateId }),
  pickOutput: () => invoke("pickOutput"),
  pickLocal: () => invoke("pickLocal"),
  convert: (options) => invoke("convert", options),
  apply: (options) => invoke("apply", options),
  history: () => invoke("history"),
  restore: (id) => invoke("restore", { id }),
  open: (kind, id) => invoke("open", { kind, id }),
  cancel: () => invoke("cancel"),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("psb:progress", listener);
    return () => ipcRenderer.removeListener("psb:progress", listener);
  },
});
