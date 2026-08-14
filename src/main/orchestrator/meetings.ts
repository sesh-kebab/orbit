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
`.trim();

/**
 * Pull the meeting list out of whatever the scan agent actually replied with.
 *
 * Agents are asked for bare JSON and mostly comply, but "mostly" is not a
 * parser. Anything that is not a well-formed meeting is dropped rather than
 * allowed to take the whole day's plan down with it.
 */
export function parseMeetingPlan(reply: string, now: number = Date.now()): Meeting[] {
    const json = extractJsonArray(reply);
    if (!json) return [];

    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];

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

/** The outermost `[...]` in a reply, fenced or not. */
function extractJsonArray(reply: string): string | undefined {
    const text = reply.trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return undefined;
    return text.slice(start, end + 1);
}

function toEpoch(value: string | number): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
