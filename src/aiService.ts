// src/aiService.ts

export interface AISearchIndex {
  provider: "groq";
  contentHash: string;
  summary: string;
  people: string[];
  places: string[];
  events: string[];
  topics: string[];
  emotions: string[];
  keywords: string[];
  createdAt: string;
}

export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  bodyHtml: string;
  dailyWin?: string;
  aiSearchIndex?: AISearchIndex | null;
  aiSearchIndexStatus?: "pending" | "indexed" | "failed";
  aiSearchIndexError?: string;
}

// Automatically pulls the keys securely baked in from GitHub Actions
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || "";
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${import.meta.env.VITE_GEMINI_MODEL || "gemini-1.5-flash"}:generateContent`;
const GROQ_MODEL_NAME = import.meta.env.VITE_GROQ_MODEL || "llama-3.1-8b-instant"; // Active, ultra-fast 2026 free-tier model

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
The user writes their journal entries using a casual mixture of English, Hindi written in the Latin/Roman script (Hinglish, e.g., "kal mai beach gaya tha", "aisi baat samaj aani chahiye"), and common internet abbreviations/slang (e.g., 'btw', 'idk', 'brb', 'clg', 'fyi').

CRITICAL INSTRUCTIONS FOR TEMPORAL REASONING:
1. When asked a timeline question like "When did I go to X?", you must read all matching context carefully. Distinguish between the date an event actually occurred versus dates where the user is merely reminiscing, looking back, or talking about it after the fact.
   - Example: If the user writes on 1st July 2026 that they went to the beach, and mentions the beach on July 2, 3, 4, and 5 in passing, your answer must point exactly to the date 1st july 2026. Do not list all dates.
2. Natively translate and decode Hinglish semantic concepts. "samundar", "pani", and "beach" all mean the same thing. 
3. Be direct, concise, and smart. Provide a single, well-reasoned answer text.

CRITICAL FORMATTING RULE:
Whenever you mention a specific date or pinpoint an event's date from the journal entries in your text description, you MUST format it exactly like this: [1st july 2026], [2nd august 2025], [23rd june 2026] (always use lowercase for the month, add the correct ordinal suffix like st, nd, rd, th to the day number, and wrap the entire string in square brackets). 
Do NOT write dates as plain text numbers; always use this bracketed text format so the system can automatically create an interactive link.
`;

const SEARCH_INDEX_SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
The user writes their journal entries using a casual mixture of English, Hindi written in the Latin/Roman script (Hinglish, e.g., "kal mai beach gaya tha", "aisi baat samaj aani chahiye"), and common internet abbreviations/slang (e.g., 'btw', 'idk', 'brb', 'clg', 'fyi').

Create a compact search index for one diary entry.
Return ONLY valid JSON matching the requested shape. No markdown.
`;

/**
 * 0. AI SEARCH INDEX GENERATION
 */
export async function generateSearchIndex(
  entry: Pick<DiaryEntry, "date" | "title" | "bodyHtml" | "dailyWin">,
  contentHash: string,
): Promise<AISearchIndex> {
  if (!GROQ_API_KEY) {
    throw new Error("VITE_GROQ_API_KEY is missing in your GitHub Actions Secrets configuration.");
  }

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, " ").replace(/\s+/g, " ").trim();
  const currentText = cleanText(entry.bodyHtml);

  const prompt = `
Create a compact search index for this diary entry.

Date: ${entry.date}
Title: ${entry.title || "Untitled"}
Daily win: ${entry.dailyWin || "None"}
Entry text: ${currentText}

Return ONLY this JSON shape:
{
  "summary": "2-4 sentence factual summary",
  "people": ["person names or relationship labels"],
  "places": ["places"],
  "events": ["important events or actions"],
  "topics": ["lowercase topic labels"],
  "emotions": ["emotions or moods"],
  "keywords": ["search terms, synonyms, Hinglish translations"]
}
`;

  const rawContent = await groqChat(
    [
      { role: "system", content: SEARCH_INDEX_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    0.15,
  );

  const parsed = parseJsonObject(rawContent);
  return {
    provider: "groq",
    contentHash,
    summary: coerceString(parsed.summary).slice(0, 1400),
    people: coerceStringArray(parsed.people).slice(0, 20),
    places: coerceStringArray(parsed.places).slice(0, 20),
    events: coerceStringArray(parsed.events).slice(0, 24),
    topics: normalizeTags(coerceStringArray(parsed.topics)).slice(0, 24),
    emotions: normalizeTags(coerceStringArray(parsed.emotions)).slice(0, 16),
    keywords: normalizeKeywords(coerceStringArray(parsed.keywords)).slice(0, 50),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 1. AI SMART SEARCH
 */
export async function smartAISearch(query: string, entries: DiaryEntry[]): Promise<string> {
  if (!GROQ_API_KEY) {
    return "AI Error: VITE_GROQ_API_KEY is missing in your GitHub Actions Secrets configuration.";
  }

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, "");

  const formattedContext = entries
    .map((e) => {
      if (e.aiSearchIndex) {
        const index = e.aiSearchIndex;
        return `[Date: ${e.date} | Title: ${e.title}]\nEntry text: ${[
          index.summary,
          ...index.people,
          ...index.places,
          ...index.events,
          ...index.topics,
          ...index.emotions,
          ...index.keywords,
        ].filter(Boolean).join(" | ")}`;
      }

      return `[Date: ${e.date} | Title: ${e.title}]\nEntry text: ${cleanText(e.bodyHtml)}`;
    })
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
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL_NAME,
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
  if (!GEMINI_API_KEY || entries.length === 0) {
    return "Start with the one thing your mind keeps circling today, then tell me what you think it is really asking from you.";
  }

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, "");
  
  const recentEntries = entries.slice(-5);
  const formattedContext = recentEntries
    .map((e) => `[Date: ${e.date}]\nEntry: ${cleanText(e.bodyHtml)}`)
    .join("\n\n---\n\n");

  const prompt = `
Analyze the user's recent life context, mood, or unresolved situations from these entries:
${formattedContext}

Generate ONE deeply personalized writing prompt for today.
- Think like a sharp, emotionally intelligent diary companion with its own judgment.
- Prefer a brief assertion plus a question, for example: "It sounds like X keeps returning. What do you think Y is trying to teach you?"
- Notice contradictions, avoided feelings, repeated people, unresolved choices, energy shifts, and hidden wins.
- Do NOT ask lazy prompts like "are you still thinking about it?" or "how was your day?"
- Decode Hinglish, slang, and casual writing naturally.
- Keep it friendly, specific, and under 32 words.
- Output ONLY the prompt text.
`;

  try {
    const content = await geminiText(SYSTEM_PROMPT, prompt, 0.7);
    return content;
  } catch (error) {
    return "Your recent entries seem to be pointing at something unfinished. What part of it needs honesty instead of more overthinking?";
  }
}

/**
 * 3. AI TOPIC TAGGING
 */
export async function generateAITopicTags(
  entry: Pick<DiaryEntry, "title" | "bodyHtml">,
  relatedEntries: DiaryEntry[] = [],
): Promise<string[]> {
  if (!GEMINI_API_KEY) return [];

  const cleanText = (html: string) => html.replace(/<\/?[^>]+(>|$)/g, " ").replace(/\s+/g, " ").trim();
  const currentText = cleanText(entry.bodyHtml);
  if (`${entry.title} ${currentText}`.trim().length < 18) return [];

  const recentContext = relatedEntries
    .slice(-6)
    .map((e) => `[${e.date}] ${e.title}: ${cleanText(e.bodyHtml).slice(0, 500)}`)
    .join("\n");

  const prompt = `
Create topic-cloud tags for this diary entry.

Current entry title: ${entry.title || "Untitled"}
Current entry text: ${currentText}

Recent diary context for recurring themes:
${recentContext || "No extra context."}

Rules:
- Return 4 to 8 meaningful tags.
- Tags must capture real themes, people, places, emotions, situations, or activities.
- Decode Hinglish and slang: "padhai" => study, "samundar/pani" => beach/water, "tension" => anxiety, "pyaar" => love.
- Prefer tags like relationship, college, work-stress, beach, coding, family, anxiety, goals, self-worth, money, health.
- Avoid useless words like today, diary, feeling, went, good, bad, thing.
- Use lowercase kebab-case only.
- Output ONLY a JSON array of strings. No markdown.
`;

  try {
    const rawContent = await geminiText(SYSTEM_PROMPT, prompt, 0.25);
    const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"))
      .filter(Boolean)
      .slice(0, 8);
  } catch (error) {
    console.error("Gemini AI Tagging Error:", error);
    return [];
  }
}

async function groqChat(messages: Array<{ role: "system" | "user"; content: string }>, temperature: number): Promise<string> {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL_NAME,
      messages,
      temperature,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`AI Response Error (${response.status}): ${errData?.error?.message || "Failed to communicate with Groq servers."}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function geminiText(systemPrompt: string, prompt: string, temperature: number): Promise<string> {
  const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature,
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to communicate with Gemini servers.");
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim() || "";
}

function parseJsonObject(rawContent: string): Record<string, unknown> {
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function coerceString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function coerceStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeTags(tags: string[]) {
  return tags
    .map((tag) => tag.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"))
    .filter(Boolean);
}

function normalizeKeywords(keywords: string[]) {
  return keywords
    .map((keyword) => keyword.toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, " "))
    .filter(Boolean);
}
