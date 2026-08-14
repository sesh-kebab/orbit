import type { OrbitApi } from "../shared/types.js";

declare global {
    interface Window {
        orbit: OrbitApi;
        orbitSnapshot?: { onScene(cb: (scene: string) => void): void };
    }
}

export {};
