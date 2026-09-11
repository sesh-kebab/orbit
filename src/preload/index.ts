import { contextBridge, ipcRenderer } from "electron";
import type { DictationEvent, OrbitApi, OrbitState, Settings } from "../shared/types.js";

const api: OrbitApi = {
    getState: () => ipcRenderer.invoke("orbit:getState"),
    onState: (cb) => {
        const listener = (_event: unknown, state: OrbitState): void => cb(state);
        ipcRenderer.on("orbit:state", listener);
        return () => ipcRenderer.off("orbit:state", listener);
    },
    send: (prompt: string) => ipcRenderer.invoke("orbit:send", prompt),
    abort: () => ipcRenderer.invoke("orbit:abort"),
    answerRequest: (requestId, optionId, freeform) =>
        ipcRenderer.invoke("orbit:answerRequest", requestId, optionId, freeform),
    cancelAgent: (agentId) => ipcRenderer.invoke("orbit:cancelAgent", agentId),
    clearFinished: () => ipcRenderer.invoke("orbit:clearFinished"),
    poke: () => ipcRenderer.invoke("orbit:poke"),
    dismissBubble: () => ipcRenderer.invoke("orbit:dismissBubble"),
    setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke("orbit:setSettings", patch),
    chooseWorkspace: () => ipcRenderer.invoke("orbit:chooseWorkspace"),
    setChatOpen: (open: boolean) => ipcRenderer.invoke("orbit:setChatOpen", open),
    moveWindow: (dx: number, dy: number) => ipcRenderer.invoke("orbit:moveWindow", dx, dy),
    resizeWindow: (dx: number, dy: number) => ipcRenderer.invoke("orbit:resizeWindow", dx, dy),
    softRestart: () => ipcRenderer.invoke("orbit:softRestart"),
    setIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke("orbit:setIgnoreMouse", ignore),
    setScheduleEnabled: (id: string, enabled: boolean) =>
        ipcRenderer.invoke("orbit:setScheduleEnabled", id, enabled),
    setScheduleArchived: (id: string, archived: boolean) =>
        ipcRenderer.invoke("orbit:setScheduleArchived", id, archived),
    runScheduleNow: (id: string) => ipcRenderer.invoke("orbit:runScheduleNow", id),
    deleteSchedule: (id: string) => ipcRenderer.invoke("orbit:deleteSchedule", id),
    forgetMemory: (id: string) => ipcRenderer.invoke("orbit:forgetMemory", id),
    resolveOpenItem: (id: string) => ipcRenderer.invoke("orbit:resolveOpenItem", id),
    markArtifactOpened: (activityId: string) => ipcRenderer.invoke("orbit:markArtifactOpened", activityId),
    openPersona: () => ipcRenderer.invoke("orbit:openPersona"),
    inspectPaths: (paths: string[]) => ipcRenderer.invoke("orbit:inspectPaths", paths),
    openPath: (path: string) => ipcRenderer.invoke("orbit:openPath", path),
    revealPath: (path: string) => ipcRenderer.invoke("orbit:revealPath", path),
    openUrl: (url: string) => ipcRenderer.invoke("orbit:openUrl", url),
    dictationSupport: () => ipcRenderer.invoke("orbit:dictationSupport"),
    startDictation: () => ipcRenderer.invoke("orbit:startDictation"),
    stopDictation: () => ipcRenderer.invoke("orbit:stopDictation"),
    cancelDictation: () => ipcRenderer.invoke("orbit:cancelDictation"),
    onDictation: (cb) => {
        const listener = (_event: unknown, payload: DictationEvent): void => cb(payload);
        ipcRenderer.on("orbit:dictation", listener);
        return () => ipcRenderer.off("orbit:dictation", listener);
    },
    quit: () => ipcRenderer.invoke("orbit:quit"),
};

contextBridge.exposeInMainWorld("orbit", api);

/** Snapshot mode drives the UI into specific states for visual verification. */
contextBridge.exposeInMainWorld("orbitSnapshot", {
    onScene: (cb: (scene: string) => void) => {
        ipcRenderer.on("orbit:snapshotScene", (_event, scene: string) => cb(scene));
    },
});
