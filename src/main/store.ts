import { EventEmitter } from "node:events";
import type { OrbitState, Settings } from "../shared/types.js";

/**
 * Single source of truth in the main process. The renderer only ever receives
 * immutable snapshots of this, pushed on a short interval so that streaming
 * deltas don't flood the IPC channel.
 */
export class Store extends EventEmitter {
    private state: OrbitState;
    private dirty = false;
    private timer: NodeJS.Timeout | undefined;

    constructor(settings: Settings) {
        super();
        this.state = {
            runtime: "starting",
            chatOpen: false,
            orbitBusy: false,
            messages: [],
            agents: [],
            requests: [],
            settings,
            models: [],
            schedules: [],
            memories: [],
            openItems: [],
            history: [],
            usage: { inputTokens: 0, outputTokens: 0, agentsRun: 0, toolCalls: 0 },
            personaPath: "",
            lastInteractionAt: Date.now(),
        };
    }

    get(): OrbitState {
        return this.state;
    }

    update(mutate: (state: OrbitState) => void): void {
        mutate(this.state);
        this.schedule();
    }

    /** Push immediately — used for user-visible transitions that must feel instant. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.dirty = false;
        this.emit("state", this.state);
    }

    private schedule(): void {
        if (this.dirty) return;
        this.dirty = true;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.dirty = false;
            this.emit("state", this.state);
        }, 60);
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.removeAllListeners();
    }
}
