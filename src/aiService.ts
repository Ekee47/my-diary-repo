// src/aiService.ts
export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  bodyHtml: string;
}

// Automatically pulls the key securely baked in from GitHub Actions
// Note: import.meta.env may be typed differently depending on tooling; keep it resilient.
const API_KEY = (import.meta as any).env?.VITE_GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_NAME = "llama-3.1-8b-instant"; // Active, ultra-fast 2026 free-tier model

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
Ekansh writes their journal entries using a casual mixture of English, Hindi written in the Latin/Roman script (Hinglish, e.g., "kal mai beach gaya tha", "aisi baat samaj aani chahiye"), and common internet abbreviations/slang (e.g., 'btw', 'idk', 'brb', 'clg', 'fyi').

You MUST follow privacy-first behavior: never ask for secrets, passwords, or anything outside the journal content.

LANGUAGE UNDERSTANDING:
- Natively translate and decode Hinglish semantic concepts. (Examples: "samundar" = "beach"; "pani" = "water").
- Infer intent behind slang/abbrev.

TEMPORAL REASONING:
- When asked "When did I…", point to the exact journal date when the event actually happened.
- Do not list multiple dates unless the user truly asks for them.

DATE FORMATTING RULE (hard requirement):
Whenever you mention a specific date from the journal, format it exactly like: [1st july 2026], [2nd august 2025], [23rd june 2026]
(lowercase month, correct ordinal suffix st/nd/rd/th, wrapped in square brackets).

OUTPUT STYLE:
- Be direct, smart, and specific.
- Don't waffle. Don't say "I'm still thinking".
`;

/**
 * Helper: clean HTML into readable plain text for the AI prompt
 */
function cleanHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ordinalSuffix(day: number) {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  if (day % 10 === 1) return "st";
  if (day % 10 === 2) return "nd";
  if (day % 10 === 3) return "rd";
  return "th";
}

function isoToReadableDate(iso: string) {
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const [yearRaw, monthRaw, dayRaw] = iso.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!year || !month || !day || month < 1 || month > 12) return iso;
  return `${day}${ordinalSuffix(day)} ${months[month - 1]} ${year}`;
}

/* ==========================================================================
   1. AI SMART SEARCH — rewritten so the response is NEVER blank
   ========================================================================== */
export async function smartAISearch(query: string, entries: DiaryEntry[]): Promise<string> {
  if (!API_KEY) {
    return "AI Error: VITE_GROQ_API_KEY is missing in your GitHub Actions Secrets configuration.";
  }
  if (!query.trim()) {
    return "Type a question above and I'll dig through your saved entries.";
  }
  if (!entries.length) {
    return "Your vault is empty — write a few entries first, then I'll be able to search them.";
  }

  const sortedEntries = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
  const allowedDateList = sortedEntries
    .map((e) => `${e.date} => [${isoToReadableDate(e.date)}]`)
    .join("\n");
  const formattedContext = sortedEntries
    .map(
      (e) => `
ENTRY_DATE_ISO: ${e.date}
CLICKABLE_DATE: [${isoToReadableDate(e.date)}]
TITLE: ${e.title}
ENTRY_TEXT:
${cleanHtmlToText(e.bodyHtml)}
`
    )
    .join("\n\n--- ENTRY BREAK ---\n\n");

  const prompt = `
User Query:
"${query}"

You are searching the user's saved diary entries.
CRITICAL RULES:
- Answer ONLY using the saved entries below.
- Never invent dates, events, or details.
- You may ONLY mention dates from this allowed list:
${allowedDateList}

DATE OUTPUT RULE:
- Whenever you mention a date, copy the exact CLICKABLE_DATE format from the entry.
- Example: [1st july 2026]
- Do NOT output fake dates.
- Do NOT use a date unless the matching entry clearly supports the answer.

LANGUAGE UNDERSTANDING:
- Understand English, Hinglish, Roman Hindi, slang, abbreviations.
- Examples:
- "samundar", "beach", "sea", "ocean" can be related.
- "dost", "friend", "yaar" can be related.
- "kaam", "office", "project", "work" can be related.
- "clg", "college", "padhai", "study" can be related.

ANSWER STYLE:
- If one exact entry matches, give one direct answer with its clickable date.
- If multiple entries truly match, list up to 3 strongest matches.
- If no exact match exists, say: "I couldn't find that in your saved entries."
- ALWAYS respond with at least one full sentence — never return an empty string.

SAVED JOURNAL ENTRIES:

${formattedContext}
`;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return `AI Response Error (${response.status}): ${errData?.error?.message || "Failed to communicate with Groq servers."}`;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    // Robust fallback: if for any reason the model returned empty content,
    // surface a friendly explanation instead of showing a blank box.
    if (typeof content !== "string" || content.trim().length === 0) {
      return "I couldn't extract a confident answer from your entries for that query. Try rephrasing with a different keyword or a date hint.";
    }

    return content.trim();
  } catch (error) {
    console.error("Groq AI Error:", error);
    return "Failed to dispatch request. Check your internet connection or browser console logs.";
  }
}

/* ==========================================================================
   2. AI DYNAMIC WRITING ASSISTANT
   ========================================================================== */
export async function generateAICustomQuestion(entries: DiaryEntry[]): Promise<string> {
  if (!API_KEY || entries.length === 0) {
    return "What's on your mind today? Tell me how your day went.";
  }
  const recentEntries = entries.slice(-5);
  const formattedContext = recentEntries
    .map((e) => `[Date: ${e.date}]\nEntry: ${cleanHtmlToText(e.bodyHtml)}`)
    .join("\n\n---\n\n");
  const prompt = `
You are an emotionally intelligent journaling companion.
Read the journal excerpts (old + recent). Think privately about:
- What's the strongest recurring theme right now?
- What is the most emotionally relevant part in the newest entries?
- What detail is clearly present in the excerpts (person/place/event/feeling)?

Hard output rules (follow exactly):
- Output EXACTLY ONE line.
- Question ends with a question mark. it should be an interrogative sentence, and if assertion is there then should be started after 1 line gap.
- Start with "QUESTION:" and maybe "ASSERTION:".
- Question length: 5-20 words.
- Assertion length: 30-50 words.
- The text must be ONLY the question and maybe the assertion (no extra labels beyond the prefix).
- It must be answerable from the excerpts (no random topics).
- Use Hinglish only if the excerpts use Hinglish vibe; otherwise use English.
- Do NOT mention you are an AI.
- Never use generic prompts like "How was your day?".

JOURNAL EXCERPTS:
${formattedContext}
`;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.85,
      }),
    });
    if (!response.ok) return "How was your day today? Feel free to write about what's going on.";
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return "How was your day today? Feel free to write about what's going on.";
    }
    return content.trim();
  } catch (error) {
    return "How was your day today? Feel free to write about what's going on.";
  }
}

/* ==========================================================================
   3. LEGACY TAG GENERATOR (kept so old saves still work — but the UI no
   longer auto-attaches tags. The new manual #tag system replaces it.)
   ========================================================================== */
export async function generateAITags(title: string, bodyHtml: string): Promise<string[]> {
  if (!API_KEY) return [];
  const prompt = `
Read this journal entry and extract 3-7 short, meaningful topic tags (people, places, themes, emotions, activities).
Title: ${title}
Body: ${cleanHtmlToText(bodyHtml)}
Rules: lowercase, single words or short phrases, no #, no generic words like "day" or "thing".
Output ONLY a comma-separated list.`;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return [];
    return content
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 7);
  } catch {
    return [];
  }
}

/* ==========================================================================
   4. EMOTION ASSESSMENT — human-aware rewrite

   The previous rule-based label was too generic ("Reflective & Introspective"
   for nearly everything negative). This new prompt forces the model to think
   like an actual person reading the entry: name the dominant emotion, not a
   vibe category. Examples below show the full emotional range we want.
   ========================================================================== */
export async function assessEntryEmotion(input: {
  title?: string;
  bodyHtml: string;
  date?: string;
}): Promise<string> {
  if (!API_KEY) return "AI unavailable";

  const cleanText = cleanHtmlToText(input.bodyHtml);
  const title = input.title?.trim() || "Untitled";

  if (!cleanText && !title) return "Neutral";

  const prompt = `
You are an emotionally intelligent friend reading someone's private diary.
Ekansh writes in casual English, Hinglish, and Roman Hindi (e.g. "she broke up with me", "bahut udaas hu", "aaj mood off tha").

Read the entry carefully and identify the ACTUAL dominant emotion the writer is feeling.
Not the topic, not the activity — the FEELING.

Rules:
- Output EXACTLY ONE short label, 2 to 5 words.
- The label must describe a real human emotion, not a literary vibe.
- Be specific. "Sad and heartbroken" beats "Reflective & Introspective".
- Capture nuance: mixed feelings, intensity, energy level.
- DO NOT say "Reflective & Introspective" unless the entry is genuinely introspective with no stronger emotion.
- DO NOT say "Neutral" or "Balanced" unless the entry is truly emotionally flat.
- DO NOT explain, give advice, or output JSON.

Examples of GOOD labels (range of emotions):
- Heartbroken and empty
- Angry and betrayed
- Anxious and overwhelmed
- Quietly devastated
- Frustrated and exhausted
- Lonely and restless
- Hopeful but scared
- Grieving and numb
- Embarrassed and small
- Elated and buzzing
- Proud and relieved
- Grateful and grounded
- Confused and shut down
- Restless and impatient
- Burnt out and done
- Tender and nostalgic
- Panicking inside
- Depressed and heavy
- Disappointed and withdrawn
- Excited and giddy
- Calm and at peace
- Bittersweet and tired
- Drained and unmotivated
- Happy and silly
- Furious and disrespected

Diary date: ${input.date || "unknown"}
Title: ${title}
Entry:
${cleanText}

Your answer (one short label, nothing else):
`;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          {
            role: "system",
            content:
              "You are an emotionally precise classifier. Output only a short, specific human emotion label — never generic categories like 'Reflective & Introspective' or 'Balanced'.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.55,
        max_tokens: 30,
      }),
    });
    if (!response.ok) return "AI unavailable";
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;

    if (typeof raw !== "string" || raw.trim().length === 0) {
      return "Processing emotion…";
    }

    return raw
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, "")
      .split("\n")[0]
      .replace(/^label:\s*/i, "")
      .slice(0, 70);
  } catch {
    return "AI unavailable";
  }
}
