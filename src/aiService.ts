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
- When asked “When did I…”, point to the exact journal date when the event actually happened.
- Do not list multiple dates unless the user truly asks for them.

DATE FORMATTING RULE (hard requirement):
Whenever you mention a specific date from the journal, format it exactly like: [1st july 2026], [2nd august 2025], [23rd june 2026]
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

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, "");

  const formattedContext = entries
    .map((e) => `[Date: ${e.date} | Title: ${e.title}]\nEntry text: ${cleanText(e.bodyHtml)}`)
    .join("\n\n---\n\n");

  const prompt = `
User Query: "${query}"

Below is the complete encrypted history of decrypted journal entries for context:
${formattedContext}

Based on the rules, deduce the exact answer to the user's query.
`;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
      }),
    });

    // Smart Error Catcher: Shows the real issue if the API fails
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
- Start with either "QUESTION:" or "ASSERT:".
- Total length: 30-50 words.
- The text must be ONLY the question OR the assertion (no extra labels beyond the prefix).
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
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
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

export async function generateAITags(title: string, bodyHtml: string): Promise<string[]> {
  if (!API_KEY) return [];
  const clean = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, "");
  const prompt = `
Read this journal entry and extract 3-7 short, meaningful topic tags (people, places, themes, emotions, activities).
Title: ${title}
Body: ${clean(bodyHtml)}

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
    return (data.choices[0].message.content as string)
      .split(",").map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean).slice(0, 7);
  } catch {
    return [];
  }
}


/**
 * PURE AI EMOTION ASSESSMENT
 * Uses Groq/Llama to understand the actual emotional tone of a journal entry.
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
You understand English, Hinglish, Hindi written in Roman script, slang, abbreviations, sarcasm, mixed emotions, and indirect emotional cues.

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
