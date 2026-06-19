// src/aiService.ts

export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  bodyHtml: string;
}

// Automatically pulls the key securely baked in from GitHub Actions
const API_KEY = (import.meta as any).env?.VITE_GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_NAME = "llama-3.1-8b-instant"; // Active, ultra-fast 2026 free-tier model

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
Ekansh writes their journal entries using a casual mixture of English, Hindi written in the Latin/Roman script 
(Hinglish, e.g., "kal mai beach gaya tha", "aisi baat samaj aani chahiye"), and common internet abbreviations/slang 
(e.g., 'btw', 'idk', 'brb', 'clg', 'fyi').

You MUST follow privacy-first behavior: never ask for secrets, passwords, or anything outside the journal content.

LANGUAGE UNDERSTANDING:
- Natively translate and decode Hinglish semantic concepts. (Examples: "samundar" = "beach"; "pani" = "water").
- Infer intent behind slang/abbrev.

TEMPORAL REASONING:
- When asked “When did I…”, point to the exact journal date when the event actually happened.
- Do not list multiple dates unless the user truly asks for them.

DATE FORMATTING RULE (hard requirement):
Whenever you mention a specific date from the journal, format it exactly like: [1st july 2026], [2nd august 2025], 
[23rd june 2026]
(lowercase month, correct ordinal suffix st/nd/rd/th, wrapped in square brackets).

OUTPUT STYLE:
- Be direct, smart, and specific.
- Don’t waffle. Don’t say "I’m still thinking".
`;

/**
 * 1. AI SMART SEARCH
 */
export async function smartAISearch(query: string, entries: DiaryEntry[]): Promise<string> {
  if (!API_KEY) {
    return "AI Error: VITE_GROQ_API_KEY is missing in your GitHub Actions Secrets configuration.";
  }

  const cleanText = (html: string) =>
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<\/?[^>]+(>|$)/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

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
      "july", "august", "september", "october", "november", "december"
    ];
    const [yearRaw, monthRaw, dayRaw] = iso.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!year || !month || !day || month < 1 || month > 12) return iso;
    return `${day}${ordinalSuffix(day)} ${months[month - 1]} ${year}`;
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
${cleanText(e.bodyHtml)}
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
- If no exact match exists, say: "I couldn’t find that in your saved entries."

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
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return `AI Response Error (${response.status}): ${errData?.error?.message || "Failed to communicate with Groq servers."}`;
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Groq AI Error:", error);
    return "Failed to dispatch request. Check your internet connection or browser console logs.";
  }
}

/**
 * 2. AI DYNAMIC WRITING ASSISTANT
 */
export async function generateAICustomQuestion(entries: DiaryEntry[]): Promise<string> {
  if (!API_KEY || entries.length === 0) {
    return "What's on your mind today? Tell me how your day went.";
  }

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, "");

  const recentEntries = entries.slice(-5);
  const formattedContext = recentEntries
    .map((e) => `[Date: ${e.date}]\nEntry: ${cleanText(e.bodyHtml)}`)
    .join("\n\n---\n\n");

  const prompt = `
You are an emotionally intelligent journaling companion.

Read the journal excerpts (old + recent). Think privately about:
- What’s the strongest recurring theme right now?
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
    return data.choices[0].message.content;
  } catch (error) {
    return "How was your day today? Feel free to write about what's going on.";
  }
}

/**
 * PURE AI EMOTION ASSESSMENT
 */
export async function assessEntryEmotion(input: {
  title?: string;
  bodyHtml: string;
  date?: string;
}): Promise<string> {
  if (!API_KEY) return "AI unavailable";

  const cleanText = input.bodyHtml
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const title = input.title?.trim() || "Untitled";

  if (!cleanText && !title) return "Neutral";

  const prompt = `
You are an AI emotional assessment engine for a private diary app.

Analyze this journal entry like a thoughtful emotional intelligence system.
You understand English, Hinglish, Hindi written in Roman script, slang, abbreviations, sarcasm, mixed emotions, 
and indirect emotional cues.

Diary date: ${input.date || "unknown"}
Title: ${title}
Entry:
${cleanText}

Your task:
Return ONLY one short AI assessment label, 1 to 6 words max.

The label should capture the user's real emotional state, not just positive/negative sentiment.

Examples:
- Anxious but hopeful
- Quietly overwhelmed
- Angry and restless
- Joyful and energized
- Emotionally drained
- Romantic and nostalgic
- Confused but curious
- Hurt yet reflective
- Hyper and chaotic
- Calm and grounded
- Lonely and tired
- Proud but exhausted

Rules:
- Do NOT explain.
- Do NOT give advice.
- Do NOT diagnose mental health conditions.
- Do NOT output JSON.
- Output only the final assessment label.
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
              "You are a concise emotional intelligence classifier for private journal entries. Output only a short emotional assessment label.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.25,
        max_tokens: 40,
      }),
    });

    if (!response.ok) return "AI unavailable";

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "Neutral";

    return raw
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, "")
      .split("\n")[0]
      .slice(0, 70);
  } catch {
    return "AI unavailable";
  }
}
