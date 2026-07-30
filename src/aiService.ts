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

const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || "";
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = import.meta.env.VITE_GROQ_MODEL || "llama-3.1-8b-instant";
const GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL || "gemini-1.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
The user writes journal entries using casual English, Hindi written in Latin/Roman script (Hinglish), and internet abbreviations/slang.

CRITICAL INSTRUCTIONS FOR TEMPORAL REASONING:
1. When asked a timeline question, distinguish the date an event actually occurred from later entries where the user is remembering or mentioning it.
2. Natively translate Hinglish concepts. "samundar", "pani", and "beach" can refer to the same semantic area.
3. Be direct, concise, and smart. If multiple entries match, synthesize them instead of stopping at the first one.

CRITICAL FORMATTING RULE:
Whenever you mention a specific date or pinpoint an event's date from the journal entries, format it exactly like this: [1st july 2026], [2nd august 2025], [23rd june 2026]. Use lowercase month names, correct ordinal suffixes, and square brackets.
`;

const INDEX_SYSTEM_PROMPT = `
You create compact, high-recall search indexes for personal diary entries.
Capture facts, people, places, events, activities, emotions, conflicts, decisions, timelines, and Hinglish/slang meanings.
Return only valid JSON. Do not include markdown.
`;

export async function generateSearchIndex(entry: Pick<DiaryEntry, "date" | "title" | "bodyHtml" | "dailyWin">, contentHash: string): Promise<AISearchIndex> {
  if (!GROQ_API_KEY) {
    throw new Error("VITE_GROQ_API_KEY is missing. Groq is required for diary indexing.");
  }

  const entryText = cleanText(entry.bodyHtml);
  const prompt = `
Create a durable search index for this diary entry.

Date: ${entry.date}
Title: ${entry.title || "Untitled entry"}
Daily win: ${entry.dailyWin || "None"}
Entry text:
${entryText}

Return this exact JSON shape:
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
      { role: "system", content: INDEX_SYSTEM_PROMPT },
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

export async function smartAISearch(query: string, entries: DiaryEntry[]): Promise<string> {
  if (!GROQ_API_KEY) {
    return "AI Error: VITE_GROQ_API_KEY is missing in your GitHub Actions Secrets configuration.";
  }

  const formattedContext = entries
    .map((entry) => {
      if (entry.aiSearchIndex) {
        const index = entry.aiSearchIndex;
        return [
          `[Date: ${entry.date} | Title: ${entry.title}]`,
          `Index summary: ${index.summary}`,
          `People: ${index.people.join(", ") || "none"}`,
          `Places: ${index.places.join(", ") || "none"}`,
          `Events: ${index.events.join(", ") || "none"}`,
          `Topics: ${index.topics.join(", ") || "none"}`,
          `Emotions: ${index.emotions.join(", ") || "none"}`,
          `Keywords: ${index.keywords.join(", ") || "none"}`,
        ].join("\n");
      }

      return `[Date: ${entry.date} | Title: ${entry.title}]\nDaily win: ${entry.dailyWin || "None"}\nEntry text: ${cleanText(entry.bodyHtml)}`;
    })
    .join("\n\n---\n\n");

  const prompt = `
User Query: "${query}"

Below are ALL available diary memory indexes. They are compact, but they cover the full journal history. Do not stop at the first match; compare all entries and identify every relevant date before answering.

${formattedContext || "No entries yet."}

Based on the rules, deduce the exact answer to the user's query.
`;

  try {
    return await groqChat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      0.2,
    );
  } catch (error) {
    console.error("Groq AI Error:", error);
    return getAIErrorMessage(error, "Failed to dispatch request. Check your internet connection or browser console logs.");
  }
}

export async function generateAICustomQuestion(entries: DiaryEntry[]): Promise<string> {
  const fallback = "Start with the one thing your mind keeps circling today, then tell me what you think it is really asking from you.";
  if (!GEMINI_API_KEY || entries.length === 0) {
    return fallback;
  }

  const recentEntries = entries.slice(-5);
  const formattedContext = recentEntries
    .map((entry) => `[Date: ${entry.date}]\nEntry: ${cleanText(entry.bodyHtml)}`)
    .join("\n\n---\n\n");

  const prompt = `
Analyze the user's recent life context, mood, or unresolved situations from these entries:
${formattedContext}

Generate ONE deeply personalized writing prompt for today.
- Think like a sharp, emotionally intelligent diary companion with its own judgment.
- Prefer a brief assertion plus a question.
- Notice contradictions, avoided feelings, repeated people, unresolved choices, energy shifts, and hidden wins.
- Decode Hinglish, slang, and casual writing naturally.
- Keep it friendly, specific, and under 32 words.
- Output ONLY the prompt text.
`;

  try {
    return await geminiText(prompt, 0.7);
  } catch (error) {
    console.error("Gemini prompt generation error:", error);
    return fallback;
  }
}

export async function generateAITopicTags(
  entry: Pick<DiaryEntry, "title" | "bodyHtml">,
  relatedEntries: DiaryEntry[] = [],
): Promise<string[]> {
  if (!GEMINI_API_KEY) return [];

  const currentText = cleanText(entry.bodyHtml);
  if (`${entry.title} ${currentText}`.trim().length < 18) return [];

  const recentContext = relatedEntries
    .slice(-6)
    .map((relatedEntry) => `[${relatedEntry.date}] ${relatedEntry.title}: ${cleanText(relatedEntry.bodyHtml).slice(0, 500)}`)
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
    const rawContent = await geminiText(prompt, 0.25);
    const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
    if (!Array.isArray(parsed)) return [];
    return normalizeTags(parsed.filter((tag): tag is string => typeof tag === "string")).slice(0, 8);
  } catch (error) {
    console.error("Gemini AI tagging error:", error);
    return [];
  }
}

async function groqChat(messages: Array<{ role: "system" | "user"; content: string }>, temperature: number): Promise<string> {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Groq ${response.status}: ${errData?.error?.message || "Failed to communicate with Groq servers."}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function geminiText(prompt: string, temperature: number): Promise<string> {
  const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
      },
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Gemini ${response.status}: ${errData?.error?.message || "Failed to communicate with Gemini servers."}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim() || "";
}

function cleanText(html: string) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return text.replace(/\s+/g, " ").trim();
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

function getAIErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
