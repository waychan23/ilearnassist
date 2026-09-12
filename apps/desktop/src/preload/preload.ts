import { contextBridge, ipcRenderer } from "electron";
import { PANEL_CHANNELS, type PanelApi, type PanelState } from "../shared/panelApi.js";

/**
 * The whole surface the panel page is allowed to touch.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so this is not a convenience
 * wrapper around a `require` the page still has — it is the only thing that crosses. The
 * page gets eight named commands and a subscription, and no way to reach the filesystem,
 * the process table or the server's stdio. That matters more here than in most Electron
 * apps because the panel renders a URL and paths that come from the main process, and a
 * page without ambient authority cannot be talked into doing something with them.
 */

const api: PanelApi = {
  getState: () => ipcRenderer.invoke(PANEL_CHANNELS.getState) as Promise<PanelState>,
  start: () => ipcRenderer.invoke(PANEL_CHANNELS.start) as Promise<PanelState>,
  stop: () => ipcRenderer.invoke(PANEL_CHANNELS.stop) as Promise<PanelState>,
  // The boolean is validated on the other side rather than trusted here: this bridge is the
  // boundary, and `contextIsolation` is worth nothing if what crosses it is taken at face
  // value.
  shareOnLan: (on) => ipcRenderer.invoke(PANEL_CHANNELS.shareOnLan, on) as Promise<PanelState>,
  // No argument: the folder is chosen in a native dialog the page cannot see or steer, so
  // there is no path for page script to propose and nothing to validate.
  chooseDataDir: () => ipcRenderer.invoke(PANEL_CHANNELS.chooseDataDir) as Promise<PanelState>,
  openApp: () => ipcRenderer.invoke(PANEL_CHANNELS.openApp) as Promise<void>,
  openInBrowser: () => ipcRenderer.invoke(PANEL_CHANNELS.openInBrowser) as Promise<void>,
  revealDataDir: () => ipcRenderer.invoke(PANEL_CHANNELS.revealDataDir) as Promise<void>,
  quit: () => ipcRenderer.invoke(PANEL_CHANNELS.quit) as Promise<void>,

  onStateChange: (listener) => {
    // The raw event object is dropped rather than forwarded: it carries `sender` and
    // `ports`, and handing those to page script would undo the isolation above.
    const handler = (_event: unknown, state: PanelState): void => listener(state);
    ipcRenderer.on(PANEL_CHANNELS.stateChanged, handler);
    return () => {
      ipcRenderer.removeListener(PANEL_CHANNELS.stateChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld("panel", api);
