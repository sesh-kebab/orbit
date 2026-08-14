/** Turn a raw tool call into a short line a human can skim. */
export function describeToolCall(
    toolName: string,
    args: Record<string, unknown> | undefined,
): string {
    const get = (key: string): string | undefined => {
        const value = args?.[key];
        return typeof value === "string" ? value : undefined;
    };
    const base = (path?: string): string | undefined =>
        path ? path.split("/").filter(Boolean).slice(-2).join("/") : undefined;

    const name = toolName.toLowerCase();

    if (name.includes("bash") || name.includes("shell") || name.includes("powershell")) {
        const command = get("command") ?? get("cmd");
        return command ? `$ ${clip(command, 70)}` : "running a command";
    }
    if (name === "view" || name.includes("read")) {
        return `reading ${base(get("path") ?? get("file_path")) ?? "a file"}`;
    }
    if (name === "edit" || name === "create" || name.includes("write") || name.includes("str_replace")) {
        return `editing ${base(get("path") ?? get("file_path")) ?? "a file"}`;
    }
    if (name === "grep" || name.includes("search_code")) {
        return `searching for ${clip(get("pattern") ?? get("query") ?? "", 40) || "something"}`;
    }
    if (name === "glob") {
        return `finding ${clip(get("pattern") ?? "", 40) || "files"}`;
    }
    if (name.includes("fetch")) {
        return `fetching ${clip(get("url") ?? "a page", 50)}`;
    }
    if (name.includes("web_search")) {
        return `searching the web`;
    }
    if (name === "task" || name.includes("agent")) {
        return `delegating: ${clip(get("description") ?? get("name") ?? "", 40) || "a subtask"}`;
    }
    if (name.includes("sql")) {
        return "querying a database";
    }
    if (name.includes("todo")) {
        return "updating its plan";
    }
    return toolName.replace(/[_-]/g, " ");
}

export function clip(value: string, limit: number): string {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** First sentence or so of a long agent message, for the activity feed. */
export function summarise(text: string, limit = 110): string {
    return clip(text.replace(/^#+\s*/gm, "").replace(/[*`_]/g, ""), limit);
}

/** Rough age of a timestamp, for lines the model reads rather than renders. */
export function elapsed(since: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - since) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
}
