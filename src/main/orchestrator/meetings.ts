import { z } from "zod";

/**
 * Per-meeting heads-up, five minutes out.
 *
 * The useful part is not the reminder — the calendar already does that — it is
 * arriving with the right thing in hand. What that is depends almost entirely
 * on the shape of the meeting: a 1:1 is about the two of you and what is
 * outstanding between you, an all-hands is about not being surprised it exists.
 * Everything here is pure so the judgement can be reasoned about and tested
 * without a calendar, a clock, or an agent.
 */

/** How long before a meeting starts the heads-up lands. */
export const HEADS_UP_LEAD_MS = 5 * 60 * 1000;

/**
 * A heads-up that arrives after the meeting has already begun is worse than
 * none. Anything armed later than this into the lead window is dropped.
 */
export const HEADS_UP_MIN_LEAD_MS = 30 * 1000;

/** Nobody has this many real meetings; past it, something has gone wrong. */
export const MAX_ARMED_MEETINGS = 24;

export type MeetingShape = "one-on-one" | "standup" | "small-group" | "broadcast" | "solo";

/** One calendar event, reduced to what the shape and the prep depend on. */
export interface Meeting {
    id: string;
    subject: string;
    /** Epoch millis. */
    start: number;
    end?: number;
    /**
     * Everyone invited *except* the user. Counting the user in was the obvious
     * off-by-one here: a 1:1 has two people in the room and one other person.
     */
    others: string[];
    isRecurring?: boolean;
    organizer?: string;
    location?: string;
    /** Whatever the agenda field held, if anything. */
    agenda?: string;
}

const MeetingSchema = z.object({
    id: z.string().min(1),
    subject: z.string().default("(no subject)"),
    start: z.union([z.string(), z.number()]),
    end: z.union([z.string(), z.number()]).optional(),
    others: z.array(z.string()).default([]),
    isRecurring: z.boolean().optional(),
    organizer: z.string().optional(),
    location: z.string().optional(),
    agenda: z.string().optional(),
});

/** Subjects that mean "recurring team sync" whatever the attendee count says. */
const STANDUP_WORDS =
    /\b(stand[\s-]?up|scrum|daily sync|daily huddle|huddle|team sync|sync[\s-]?up|weekly sync|check[\s-]?in)\b/i;

/** Above this many other people, nobody is expecting you to speak. */
const BROADCAST_FROM = 8;

/**
 * What kind of meeting this is, which is the only input the prep depth needs.
 *
 * Order matters and is deliberate: exactly one other person is a 1:1 even when
 * it recurs and is called a sync, because the prep that helps is still "what is
 * outstanding between you two".
 */
export function classifyMeeting(meeting: Pick<Meeting, "subject" | "others" | "isRecurring" | "end" | "start">): MeetingShape {
    const others = meeting.others.length;
    if (others === 0) return "solo";
    if (others === 1) return "one-on-one";
    if (others >= BROADCAST_FROM) return "broadcast";
    if (isStandupLike(meeting)) return "standup";
    return "small-group";
}

/**
 * A recurring team sync, by name or by shape. A short recurring meeting with a
 * handful of people is a standup whatever it has been called.
 */
export function isStandupLike(
    meeting: Pick<Meeting, "subject" | "isRecurring" | "start" | "end">,
): boolean {
    if (STANDUP_WORDS.test(meeting.subject)) return true;
    if (!meeting.isRecurring) return false;
    const minutes = meeting.end ? (meeting.end - meeting.start) / 60_000 : undefined;
    return minutes !== undefined && minutes > 0 && minutes <= 30;
}

/** Does this shape justify going and looking things up, or just a reminder? */
export function wantsPrep(shape: MeetingShape): boolean {
    return shape === "one-on-one" || shape === "standup" || shape === "small-group";
}

/** When the heads-up for a meeting should fire. */
export function headsUpAt(meeting: Pick<Meeting, "start">): number {
    return meeting.start - HEADS_UP_LEAD_MS;
}

/**
 * The meetings still worth arming a timer for: the heads-up is far enough ahead
 * to be useful, and near enough that a timer is the right tool.
 */
export function armableMeetings(meetings: Meeting[], now: number, withinMs: number): Meeting[] {
    return meetings
        .filter((meeting) => {
            const at = headsUpAt(meeting);
            return at - now >= HEADS_UP_MIN_LEAD_MS && at - now <= withinMs;
        })
        .sort((a, b) => a.start - b.start)
        .slice(0, MAX_ARMED_MEETINGS);
}

// MARK: - When to look at the calendar again

/**
 * How often the calendar is re-read while the day still has meetings in it.
 * Frequent on purpose: this is the only thing that notices a meeting added
 * after the last scan.
 */
export const ACTIVE_RESCAN_MS = 45 * 60 * 1000;

/**
 * The same question, asked of a day that has already run out of meetings.
 * Something can still be added, so the answer is not "never", but re-asking
 * every 45 minutes buys nothing: anything added lands well outside the arming
 * horizon and will be picked up with hours to spare.
 */
export const IDLE_RESCAN_MS = 2 * 60 * 60 * 1000;

/** Weekends are mostly empty and the user does not want to hear about them. */
export const WEEKEND_RESCAN_MS = 4 * 60 * 60 * 1000;

/** Nothing is gained by scanning more often than this, whatever the maths says. */
export const MIN_RESCAN_MS = 5 * 60 * 1000;

/** Local hour the quiet window opens. Nothing is scheduled after this. */
export const QUIET_FROM_HOUR = 22;

/** Local time the quiet window closes, as hour and minute. */
export const QUIET_UNTIL_HOUR = 6;
export const QUIET_UNTIL_MINUTE = 30;

/**
 * Is this moment inside the overnight window where reading the calendar is
 * pure waste? Wraps midnight, hence the `||`.
 */
export function inQuietHours(at: number): boolean {
    const date = new Date(at);
    const minutes = date.getHours() * 60 + date.getMinutes();
    return minutes >= QUIET_FROM_HOUR * 60 || minutes < QUIET_UNTIL_HOUR * 60 + QUIET_UNTIL_MINUTE;
}

export function isWeekend(at: number): boolean {
    const day = new Date(at).getDay();
    return day === 0 || day === 6;
}

/** The next moment the quiet window is over, in local time. */
export function quietWindowEnd(at: number): number {
    const end = new Date(at);
    end.setHours(QUIET_UNTIL_HOUR, QUIET_UNTIL_MINUTE, 0, 0);
    if (end.getTime() <= at) end.setDate(end.getDate() + 1);
    return end.getTime();
}

/**
 * How long to wait before reading the calendar again.
 *
 * The scan is not free — it is a whole agent run against a calendar API — and
 * a fixed cadence spent one Saturday firing twenty-nine times at an empty day,
 * including every hour between midnight and seven. So the interval is derived
 * from what the last scan actually found:
 *
 * - a day with meetings still ahead of it keeps the frequent cadence, because
 *   that is the case where a late addition matters;
 * - a day with nothing left, and a weekend, back off hard;
 * - the overnight window is skipped outright, unless a meeting is genuinely
 *   scheduled inside it;
 * - and none of that is allowed to push the next scan past the moment the next
 *   known meeting becomes armable, so backing off can never lose a heads-up
 *   that was already on the books.
 *
 * A scan that could not read the calendar at all is deliberately *not* treated
 * as an empty day. An empty day is evidence the cadence can relax; a blind scan
 * is evidence of nothing except that something is broken, and the retry cadence
 * for that is the caller's `blindMs`, held flat so the run that discovers the
 * fix is not also slowed down.
 *
 * Pure: `now` and the plan in, milliseconds out.
 */
export function nextCalendarScanDelay(
    now: number,
    plan: MeetingPlan,
    horizonMs: number,
    blindMs: number,
): number {
    if (!plan.ok) return Math.max(MIN_RESCAN_MS, blindMs);

    const upcoming = plan.meetings
        .map((meeting) => meeting.start)
        .filter((start) => start > now)
        .sort((a, b) => a - b);
    const nextStart = upcoming[0];

    const base =
        nextStart === undefined
            ? isWeekend(now)
                ? WEEKEND_RESCAN_MS
                : IDLE_RESCAN_MS
            : isWeekend(now)
              ? Math.min(WEEKEND_RESCAN_MS, ACTIVE_RESCAN_MS * 2)
              : ACTIVE_RESCAN_MS;

    let at = now + base;

    // Overnight: skip to the far side, unless something is actually on the
    // calendar before then and would go unarmed if we slept through it.
    if (inQuietHours(now)) {
        const wake = quietWindowEnd(now);
        if (nextStart === undefined || nextStart > wake) at = Math.max(at, wake);
    }

    // The arming cap. A meeting becomes armable once its heads-up is within the
    // horizon; scanning later than that moment is how a back-off drops one.
    if (nextStart !== undefined) {
        const armableAt = headsUpAt({ start: nextStart }) - horizonMs;
        if (armableAt > now) at = Math.min(at, armableAt);
    }

    return Math.max(MIN_RESCAN_MS, at - now);
}

/** One line for the bubble: the whole point, in the width available. */
export function headsUpLine(meeting: Meeting, shape: MeetingShape): string {
    const minutes = Math.max(1, Math.round((meeting.start - Date.now()) / 60_000));
    const who =
        shape === "one-on-one"
            ? ` with ${meeting.others[0]}`
            : shape === "broadcast"
              ? ` (${meeting.others.length} people)`
              : "";
    return `⏰ ${minutes} min: ${meeting.subject}${who}`;
}

/**
 * The brief handed to the prep agent, tuned to the shape.
 *
 * Deliberately prescriptive about *length*: prep that arrives five minutes
 * before a meeting is only read if it can be read in those five minutes.
 */
export function prepBriefFor(meeting: Meeting, shape: MeetingShape, context: string): string {
    const when = new Date(meeting.start).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
    const head = [
        `The user has "${meeting.subject}" at ${when}, starting in about five minutes.`,
        meeting.location ? `Location: ${meeting.location}.` : "",
        meeting.others.length > 0 ? `Other attendees: ${meeting.others.join(", ")}.` : "",
        meeting.agenda ? `Agenda as invited: ${meeting.agenda}` : "",
    ]
        .filter(Boolean)
        .join(" ");

    const body = shapeInstructions(meeting, shape);

    return [
        head,
        context ? `\n<what_orbit_is_already_tracking>\n${context}\n</what_orbit_is_already_tracking>` : "",
        `\n${body}`,
        [
            "\nRules:",
            "- At most 5 short lines. This is read standing up, on the way to a meeting.",
            "- Only things that are actually outstanding. Do not pad, do not summarise the invite back.",
            "- If you find nothing worth raising, reply with exactly: NOTHING TO REPORT",
        ].join("\n"),
    ]
        .filter(Boolean)
        .join("\n");
}

function shapeInstructions(meeting: Meeting, shape: MeetingShape): string {
    switch (shape) {
        case "one-on-one": {
            const person = meeting.others[0] ?? "the other attendee";
            return [
                `This is a 1:1 with ${person}. Surface what is live between the two of them:`,
                `- Anything Orbit is tracking that involves ${person} specifically.`,
                `- Open threads: unanswered mail or chat from ${person}, and anything the user owes them.`,
                `- Commitments either of them made that have not landed.`,
                `Check recent mail and chat with ${person} if you can. Name the thing, not the category.`,
            ].join("\n");
        }
        case "standup":
            return [
                "This is a recurring team sync. Keep it to what the user has to say out loud:",
                "- Parking-lot items and anything they flagged to raise here.",
                "- What they said they would do since the last one, and whether it happened.",
                "- Anything blocking them that the team can unblock.",
            ].join("\n");
        case "small-group":
            return [
                "This is a small working meeting. Moderate depth:",
                "- The agenda, in one line, if there is one.",
                "- Any decision that is waiting on the user specifically.",
                "- One thing they should have read before walking in, if there is one.",
            ].join("\n");
        default:
            // Broadcast and solo never get here — they are reminder-only, and
            // spending an agent on them is exactly the noise this avoids.
            return "Give the reminder and the topic. Do not look anything up.";
    }
}

/**
 * The brief for the daily calendar scan.
 *
 * Asks for JSON and nothing else, because the answer is parsed rather than
 * read. Kept strict about the attendee list: the count is what the whole
 * feature keys off, and "everyone except the user" is easy to get wrong.
 */
export const CALENDAR_SCAN_TEMPLATE = `
List the user's calendar meetings for the rest of today, using whatever calendar tool you have.

Reply with a JSON array and absolutely nothing else — no prose, no markdown fence, no explanation.

Each element:
{
  "id": "the event id, or any stable unique string",
  "subject": "the meeting subject",
  "start": "ISO 8601 start time with offset",
  "end": "ISO 8601 end time with offset",
  "others": ["display names of every attendee EXCEPT the user themselves"],
  "isRecurring": true or false,
  "organizer": "display name of the organiser",
  "location": "location or joining method, omit if none",
  "agenda": "the invite body, trimmed to one or two sentences, omit if empty"
}

Rules:
- Only meetings that have not started yet.
- Skip all-day events, and skip anything the user has declined.
- "others" excludes the user. A 1:1 therefore has exactly one entry.
- If there are none, reply with exactly: []
- If you have no way to read the calendar at all — no calendar tool, nothing signed in,
  a refused token — do NOT reply []. Say so in one plain sentence instead, naming what
  you tried and what failed. An empty array means "the calendar is clear", and claiming
  that when you cannot see it is the worst answer you can give.
`.trim();

/** Why a scan produced no usable plan. */
export type CalendarProblem =
    /** There is no calendar to read: nothing signed in, no tool, auth refused. */
    | "no-calendar"
    /** Something answered, but not with a day's meetings. */
    | "unreadable";

/**
 * The outcome of one calendar scan.
 *
 * The whole point of this type is the distinction it forces at every call site:
 * "the calendar says you have nothing on" and "I could not read your calendar"
 * are opposite facts, and for weeks both arrived as an empty array.
 */
export type MeetingPlan =
    | { ok: true; meetings: Meeting[] }
    | { ok: false; problem: CalendarProblem; detail: string };

/**
 * Phrases that mean the calendar could not be reached at all.
 *
 * Only consulted once a reply has failed to be a meeting list, so these need to
 * separate "no calendar" from "some other kind of nonsense" — not from real
 * data.
 */
const NO_CALENDAR_SIGNS: RegExp[] = [
    /\bno\b[^.]{0,30}\bcalendar (tool|access|source|server|integration|mcp)/i,
    /\bno\b[^.]{0,20}\btool (is )?available\b/i,
    /\bno account is signed[\s-]?in\b/i,
    /\b(is )?not signed[\s-]?in\b/i,
    /\bsign(ed)? in(to)?\b[^.]{0,40}\b(outlook|calendar|microsoft|account)\b/i,
    /\b(can(no|')?t|cannot|unable to|failed to)\b[^.]{0,60}\b(calendar|meetings)\b/i,
    /\b(calendar|outlook|graph)\b[^.]{0,40}\b(unavailable|not (available|configured|connected|accessible))\b/i,
    /\bAADSTS\d+/i,
    /\bconditional access\b/i,
    /\btoken\b[^.]{0,20}\b(blocked|expired|invalid|denied)\b/i,
    /\b(authentication|authorisation|authorization)\b[^.]{0,20}\b(failed|required|error|denied)\b/i,
    /\bnot (authenticated|authorised|authorized)\b/i,
];

/**
 * Does this reply describe a calendar that could not be read?
 *
 * Pure and exported so the judgement can be argued with in a test rather than
 * inferred from an app that only reproduces it once every forty-five minutes.
 */
export function describesNoCalendarAccess(reply: string): boolean {
    const text = reply.trim();
    if (!text) return false;
    return NO_CALENDAR_SIGNS.some((sign) => sign.test(text));
}

/**
 * Read the scan agent's reply as either a day's meetings or a reason there are
 * none to be had.
 *
 * On 23 August the scan agent did the honest thing. It had tried Outlook (no
 * account signed in), Apple Calendar (no store) and Graph (conditional access
 * refused the token), and it said so — explicitly refusing to reply `[]`
 * "because that would falsely imply no meetings". The old parser searched the
 * whole reply for the outermost brackets, found the `[]` inside that very
 * sentence, and recorded a clear day. The one run that told the truth was the
 * one most confidently misread.
 *
 * So the array has to *be* the reply, exactly as a watcher's sentinel has to be
 * its whole reply. The single exception is a populated array with prose around
 * it: prose wrapped around real meetings is an agent being chatty, whereas
 * prose wrapped around an empty array is an agent explaining itself.
 */
export function readMeetingPlan(reply: string, now: number = Date.now()): MeetingPlan {
    const text = reply.trim();
    if (!text) {
        return { ok: false, problem: "unreadable", detail: "The scan came back empty." };
    }

    const whole = parseArray(wholeReplyArray(text));
    if (whole) return { ok: true, meetings: collectMeetings(whole, now) };

    const embedded = parseArray(embeddedArray(text));
    if (embedded && embedded.length > 0) {
        return { ok: true, meetings: collectMeetings(embedded, now) };
    }

    return {
        ok: false,
        problem: describesNoCalendarAccess(text) ? "no-calendar" : "unreadable",
        detail: summarise(text),
    };
}

/**
 * The meeting list, or an empty one however the scan failed.
 *
 * Kept for callers that genuinely only want the meetings. Anything that acts on
 * "there are none" should read the plan instead, because this cannot tell the
 * two apart — which is the entire bug.
 */
export function parseMeetingPlan(reply: string, now: number = Date.now()): Meeting[] {
    const plan = readMeetingPlan(reply, now);
    return plan.ok ? plan.meetings : [];
}

/** What to tell the user, once, when there is no calendar to read. */
export function calendarUnavailableMessage(detail: string): string {
    return [
        "I can't see your calendar, so treat any quiet day from me as unknown rather than clear.",
        detail ? `The scan said: ${detail}` : "",
        "Sign in to Outlook, or point me at a calendar MCP server, and heads-ups start again on their own.",
    ]
        .filter(Boolean)
        .join(" ");
}

function collectMeetings(raw: unknown[], now: number): Meeting[] {
    const meetings: Meeting[] = [];
    for (const entry of raw) {
        const parsed = MeetingSchema.safeParse(entry);
        if (!parsed.success) continue;
        const start = toEpoch(parsed.data.start);
        if (start === undefined || start < now) continue;
        const end = parsed.data.end === undefined ? undefined : toEpoch(parsed.data.end);
        meetings.push({
            ...parsed.data,
            start,
            end,
            others: parsed.data.others.map((name) => name.trim()).filter(Boolean),
        });
    }
    return meetings.sort((a, b) => a.start - b.start);
}

function parseArray(json: string | undefined): unknown[] | undefined {
    if (json === undefined) return undefined;
    try {
        const raw: unknown = JSON.parse(json);
        return Array.isArray(raw) ? raw : undefined;
    } catch {
        return undefined;
    }
}

/** The reply, when the reply is nothing but an array — fence allowed. */
function wholeReplyArray(reply: string): string | undefined {
    const text = stripFence(reply);
    return text.startsWith("[") && text.endsWith("]") ? text : undefined;
}

/** The outermost `[...]` anywhere in a reply. Only trusted when it has content. */
function embeddedArray(reply: string): string | undefined {
    const text = stripFence(reply);
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return undefined;
    return text.slice(start, end + 1);
}

/** Unwrap one ```json fence, which is the one bit of decoration agents add. */
function stripFence(reply: string): string {
    const text = reply.trim();
    const fenced = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
    return (fenced ? fenced[1] : text).trim();
}

/** The first sentence of an explanation, short enough to sit in an open item. */
function summarise(reply: string): string {
    const flat = reply.replace(/\s+/g, " ").trim();
    const stop = flat.search(/[.!?](\s|$)/);
    const first = stop === -1 ? flat : flat.slice(0, stop + 1);
    return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

function toEpoch(value: string | number): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
