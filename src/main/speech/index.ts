/**
 * Dictation: microphone in, chat message out.
 *
 * There is no transcription service configured for this app and no local
 * engine on the machine, but macOS ships one. Electron cannot call it, so a
 * small Swift helper (orbit-speech.swift) owns both the microphone and the
 * recogniser and streams JSON lines back here.
 *
 * The helper is compiled on demand rather than checked in as a binary: the
 * source is a hundred lines, swiftc is on every Mac with the command line
 * tools, and a compiled artefact in git would be unreviewable. The result is
 * cached in userData and rebuilt only when the source changes.
 */

import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DictationEvent, DictationSupport } from "../../shared/types.js";
import SWIFT_SOURCE from "./orbit-speech.swift?raw";

/**
 * Stapled into the helper's __TEXT segment so macOS has a purpose string to
 * show. Without these the TCC check kills the process instead of asking.
 */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.orbit.speech</string>
  <key>CFBundleName</key><string>Orbit Dictation</string>
  <key>NSMicrophoneUsageDescription</key><string>Orbit listens while you hold the mic button so you can talk to it instead of typing.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Orbit turns what you say into a chat message. Recognition runs on this Mac.</string>
</dict>
</plist>
`;

/** Long enough for a considered sentence, short enough not to squat on the mic. */
const MAX_UTTERANCE_MS = 180_000;
/**
 * If the helper has not said "ready" by now, macOS is almost certainly showing
 * a permission sheet. The UI is told so it can explain the wait.
 */
const PERMISSION_HINT_MS = 2500;

let compiled: string | undefined;
let compileFailure: string | undefined;
let building: Promise<string> | undefined;
let active: Session | undefined;
/**
 * Bumped on every start and every cancel, so a start that is still waiting on
 * the compiler knows it has been superseded and drops its binary on the floor.
 */
let startSeq = 0;

interface Session {
    child: ChildProcessWithoutNullStreams;
    emit: (event: DictationEvent) => void;
    hintTimer?: NodeJS.Timeout;
    capTimer?: NodeJS.Timeout;
    /** Set once a final transcript or error has been reported. */
    settled: boolean;
}

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Everything here runs through async spawn rather than spawnSync. Building the
 * helper takes seconds, and a synchronous child would freeze the whole app —
 * timers, IPC, the buddy's animation — while it linked.
 */
function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ status: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

function speechDir(): string {
    return join(app.getPath("userData"), "speech");
}

function swiftcPath(): Promise<string | undefined> {
    if (existsSync("/usr/bin/swiftc")) return Promise.resolve("/usr/bin/swiftc");
    return run("/usr/bin/which", ["swiftc"], 10_000).then(({ stdout }) => {
        const path = stdout.trim();
        return path && existsSync(path) ? path : undefined;
    });
}

/**
 * Build the helper if this exact source has not been built before. Resolves to
 * the binary's path, or rejects with something the user can act on. Concurrent
 * callers share one build.
 */
function ensureHelper(): Promise<string> {
    if (compiled && existsSync(compiled)) return Promise.resolve(compiled);
    if (compileFailure) return Promise.reject(new Error(compileFailure));
    building ??= buildHelper().finally(() => {
        building = undefined;
    });
    return building;
}

async function buildHelper(): Promise<string> {
    if (process.platform !== "darwin") {
        throw new Error(refuse("Dictation uses macOS speech recognition, which isn't available here."));
    }
    const swiftc = await swiftcPath();
    if (!swiftc) {
        throw new Error(
            refuse(
                "Dictation needs Apple's command line tools to build its speech helper. Run `xcode-select --install` and try again.",
            ),
        );
    }

    // The plist is stapled into the binary, so a change to it — the bundle id
    // the microphone grant is keyed on, say — has to force a rebuild too.
    const digest = createHash("sha256")
        .update(SWIFT_SOURCE)
        .update(INFO_PLIST)
        .digest("hex")
        .slice(0, 12);
    const dir = speechDir();
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, `orbit-speech-${digest}`);
    if (existsSync(binary)) {
        compiled = binary;
        return binary;
    }

    const source = join(dir, `orbit-speech-${digest}.swift`);
    const plist = join(dir, `orbit-speech-${digest}.plist`);
    writeFileSync(source, SWIFT_SOURCE, "utf8");
    writeFileSync(plist, INFO_PLIST, "utf8");

    console.log("[orbit] building the dictation helper");
    const build = await run(
        swiftc,
        [
            "-O",
            "-o",
            binary,
            source,
            "-framework",
            "Speech",
            "-framework",
            "AVFoundation",
            // Staple the purpose strings into the executable itself; a bare
            // binary has no bundle for macOS to read them from.
            "-Xlinker",
            "-sectcreate",
            "-Xlinker",
            "__TEXT",
            "-Xlinker",
            "__info_plist",
            "-Xlinker",
            plist,
        ],
        180_000,
    );
    if (build.status !== 0 || !existsSync(binary)) {
        const detail = (build.stderr || build.stdout).trim().slice(-600);
        throw new Error(refuse(`Couldn't build the dictation helper.${detail ? `\n${detail}` : ""}`));
    }

    // An ad-hoc signature gives the helper a stable identity, so the microphone
    // grant survives a restart instead of being asked for every launch.
    await run("/usr/bin/codesign", ["-s", "-", "--force", binary], 60_000);

    compiled = binary;
    return binary;
}

/** Remember a hard failure so we don't re-run swiftc on every mic press. */
function refuse(message: string): string {
    compileFailure = message;
    return message;
}

/** Can this machine dictate at all? Answered without touching the microphone. */
export async function dictationSupport(): Promise<DictationSupport> {
    try {
        const binary = await ensureHelper();
        const probe = await run(binary, ["--probe"], 20_000);
        const line = probe.stdout.trim().split("\n").at(-1) ?? "";
        const parsed = JSON.parse(line) as { supported?: boolean; onDevice?: boolean };
        return { available: parsed.supported === true, onDevice: parsed.onDevice === true };
    } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

export function isDictating(): boolean {
    return active !== undefined;
}

/**
 * Open the microphone. Events stream to `emit` until a `final`, `error` or
 * `cancelled` arrives, after which the session is over.
 */
export function startDictation(emit: (event: DictationEvent) => void): void {
    if (active) return;
    const seq = ++startSeq;

    void ensureHelper().then(
        (binary) => {
            // A cancel (or another start) landed while the helper was building.
            if (seq !== startSeq || active) return;
            launch(binary, emit);
        },
        (error: unknown) => {
            if (seq !== startSeq) return;
            emit({
                type: "error",
                code: "unavailable",
                message: error instanceof Error ? error.message : String(error),
            });
        },
    );
}

function launch(binary: string, emit: (event: DictationEvent) => void): void {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const session: Session = { child, emit, settled: false };
    active = session;

    session.hintTimer = setTimeout(() => {
        if (active === session && !session.settled) emit({ type: "waiting" });
    }, PERMISSION_HINT_MS);
    session.capTimer = setTimeout(() => cancelDictation(), MAX_UTTERANCE_MS);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            let event: DictationEvent;
            try {
                event = JSON.parse(line) as DictationEvent;
            } catch {
                continue;
            }
            if (event.type === "ready" && session.hintTimer) clearTimeout(session.hintTimer);
            if (event.type === "final" || event.type === "error") session.settled = true;
            emit(event);
        }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => console.error("[orbit] dictation:", chunk.trim()));

    child.on("error", (error) => {
        if (active !== session) return;
        finish(session, { type: "error", code: "spawn-failed", message: error.message });
    });

    child.on("close", () => {
        if (active !== session) return;
        // A helper that died without a verdict was killed by TCC or crashed;
        // either way the user needs to hear something rather than watching the
        // panel sit in "transcribing" forever.
        finish(
            session,
            session.settled
                ? undefined
                : {
                      type: "error",
                      code: "stopped",
                      message:
                          "Dictation stopped before it heard anything. Check Privacy & Security › Microphone and Speech Recognition.",
                  },
        );
    });
}

/** Finish the utterance and take whatever the recogniser has. */
export function stopDictation(): void {
    if (!active) return;
    try {
        active.child.stdin.write("stop\n");
    } catch {
        cancelDictation();
    }
}

/** Throw the utterance away. Also aborts a start that is still compiling. */
export function cancelDictation(): void {
    startSeq += 1;
    const session = active;
    if (!session) return;
    session.settled = true;
    try {
        session.child.stdin.write("cancel\n");
    } catch {
        /* already gone */
    }
    setTimeout(() => {
        if (!session.child.killed) session.child.kill("SIGKILL");
    }, 500);
    finish(session, { type: "cancelled" });
}

function finish(session: Session, event?: DictationEvent): void {
    if (session.hintTimer) clearTimeout(session.hintTimer);
    if (session.capTimer) clearTimeout(session.capTimer);
    if (active === session) active = undefined;
    if (event) session.emit(event);
}
