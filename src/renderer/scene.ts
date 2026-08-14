type Listener = (scene: string) => void;

const listeners = new Set<Listener>();
let current = "";

/** Snapshot mode broadcasts scene names so panels can pose themselves. */
export function initScenes(): void {
    window.orbitSnapshot?.onScene((scene) => {
        current = scene;
        for (const listener of listeners) listener(scene);
    });
}

export function onScene(listener: Listener): () => void {
    listeners.add(listener);
    if (current) listener(current);
    return () => listeners.delete(listener);
}
