// src/aiService.ts
export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  bodyHtml: string;
}

const API_KEY = (import.meta as any).env?.VITE_GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_NAME = "llama-3.1-8b-instant";

/* ==========================================================================
   GLOBAL AI REQUEST QUEUE
   - One request at a time
   - Minimum 1100ms between requests (avoids Groq rate limits)
   - Auto-retry on 429 / 5xx with exponential backoff
   - Per-key in-flight dedup so identical requests don't fire twice
   ========================================================================== */
type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

class AIRequestQueue {
  private queue: QueueTask<any>[] = [];
  private processing = false;
  private lastRequestAt = 0;
  private readonly minGapMs = 1100;
  private inFlight = new Map<string, Promise<any>>();

  enqueue<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (key && this.inFlight.has(key)) {
      return this.inFlight.get(key)! as Promise<T>;
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ run: fn, resolve, reject });
      this.process();
    });
    if (key) {
      this.inFlight.set(key, promise);
      promise.finally(() => this.inFlight.delete(key));
    }
    return promise;
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const gap = Date.now() - this.lastRequestAt;
      if (gap < this.minGapMs) {
        await sleep(this.minGapMs - gap);
      }
      const task = this.queue.shift()!;
      this.lastRequestAt = Date.now();
      try {
        const result = await task.run();
        task.resolve(result);
      } catch (e) {
        task.reject(e);
      }
    }
    this.processing = false;
  }
}

const aiQueue = new AIRequestQueue();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ==========================================================================
   Low-level Groq call with retries
   ========================================================================== */
async function callGroq(
  body: Record<string, unknown>,
  { retries = 3 }: { retries?: number } = {},
): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 || response.status >= 500) {
        // Rate-limited or server error: wait and retry
        const backoff = 800 * Math.pow(2, attempt) + Math.random() * 400;
        await sleep(backoff);
        lastErr = new Error(`Groq ${response.status}`);
        continue;
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          `AI Response Error (${response.status}): ${errData?.error?.message || "Failed."}`,
        );
      }
      return await response.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(600 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("AI request failed.");
}

/* ==========================================================================
   Shared helpers
   ========================================================================== */
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
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
  ];
  const [yearRaw, monthRaw, dayRaw] = iso.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!year || !month || !day || month < 1 || month > 12) return iso;
  return `${day}${ordinalSuffix(day)} ${months[month - 1]} ${year}`;
}

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
The user writes in casual English, Hinglish (Roman Hindi), and internet slang.
NEVER ask for secrets or anything outside the journal content.
When mentioning a specific date, format it as: [1st july 2026] (lowercase month, ordinal suffix, square brackets).
Be direct, warm, and specific. Never waffle.
`.trim();

/* ==========================================================================
   1) SMART SEARCH — much more forgiving, name/keyword aware
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
`,
    )
    .join("\n\n--- ENTRY BREAK ---\n\n");

  const prompt = `
User Query:
"${query}"

You are searching the user's saved diary entries below.

SEARCH RULES (be GENEROUS, not strict):
- Search across TITLE, ENTRY_TEXT, and dates.
- Match names case-insensitively (e.g. "Alex", "alex", "ALEX" are the same).
- Match partial names too (e.g. "Sam" should match "Samantha", "Sammy").
- Understand Hinglish + English synonyms:
  * samundar / beach / sea / ocean / waves
  * dost / friend / yaar / buddy
  * kaam / office / work / job / project / meeting
  * clg / college / school / padhai / study / exam
  * pyaar / love / crush / girlfriend / boyfriend
  * udaas / sad / depressed / down / low
  * khush / happy / glad / excited
  * gym / workout / exercise / fitness
- If user mentions a person's name, find ANY entry that contains that name (full or partial).
- If user asks "when did I…", give the matching date(s).
- If the query is vague (e.g. "Alex"), summarize what you found about that subject.

DATE OUTPUT:
- Only use dates from this allowed list:
${allowedDateList}
- Format every date you mention exactly as [Nth month yyyy] (e.g. [3rd july 2026]).

ANSWER STYLE:
- Warm, direct, specific.
- If one entry matches, give one clear answer with its clickable date.
- If multiple match, list up to 3 strongest with their dates and a short reason.
- If truly nothing matches, say: "I couldn't find anything about that in your saved entries. Try a different keyword or check your spelling."
- NEVER return an empty answer. Always reply with at least one full sentence.

CRITICAL RULES:
- Answer ONLY using the saved entries below.
- Never invent dates, events, or details.
- You may ONLY mention dates from this allowed list:
${allowedDateList}

SAVED JOURNAL ENTRIES:
${formattedContext}
`.trim();

  try {
    const data = await aiQueue.enqueue(`search:${query}`, () =>
      callGroq({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 600,
      }),
    );

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return "I couldn't extract a confident answer from your entries for that query. Try rephrasing with a different keyword or a date hint.";
    }
    return content.trim();
  } catch (error: any) {
    console.error("Groq AI Error:", error);
    return `AI search failed: ${error?.message || "check your internet connection or API key."}`;
  }
}

/* ==========================================================================
   2) WRITING ASSISTANT — queued, retries built in
   ========================================================================== */
export async function generateAICustomQuestion(entries: DiaryEntry[]): Promise<string> {
 if (!API_KEY || entries.length === 0) {
 return "What's been taking up the most space in your mind recently?";
 }

 const now = new Date();
 const twelveMonthsAgo = new Date(now);
 twelveMonthsAgo.setMonth(now.getMonth() - 12);

 const sortedEntries = entries
 .slice()
 .sort((a, b) => a.date.localeCompare(b.date));

 const recentEnoughEntries = sortedEntries.filter((entry) => {
 const d = new Date(entry.date);
 return !Number.isNaN(d.getTime()) && d >= twelveMonthsAgo;
 });

 // If there is nothing from the last 12 months, don't drag up 1-2 year old memories.
 if (recentEnoughEntries.length === 0) {
 return "What's been taking up the most space in your mind recently?";
 }

 // Prefer newest entries only.
 const recentEntries = recentEnoughEntries.slice(-8);

 const formattedContext = recentEntries
 .map((e) => `[Date: ${e.date}]\nTitle: ${e.title}\nEntry: ${cleanHtmlToText(e.bodyHtml)}`)
 .join("\n\n---\n\n");

 const prompt = `
You are an emotionally intelligent journaling companion.

Use ONLY the recent journal excerpts below.
These entries are from roughly the last 6-12 months.

VERY IMPORTANT:
- Do NOT ask about very old events, people, or memories unless they are clearly mentioned inside these recent excerpts.
- only ask about events occured in past 6 months and mostly about the recent events unless i have mentioned some old memories or names recently
- Prefer what feels emotionally active right now.
- If an old memory appears in a recent entry, you may ask about it because it is currently relevant.
- strictly Do not randomly bring up 6-24 months old topics.
- for the dates dont see the date the day i wrote the entry but rather go with the dates i wrote the entry in. (the date mentioned in the entry)

Output rules:
- Output EXACTLY ONE question.
- Question must end with a question mark.
- 5-20 words.
- Make it specific to the recent excerpts.
- Use Hinglish only if the excerpts use Hinglish.
- Do NOT mention you are an AI.
- Avoid generic prompts like "How was your day?"

RECENT JOURNAL EXCERPTS:
${formattedContext}
`.trim();

 try {
 const data = await aiQueue.enqueue(`assist:${recentEntries[recentEntries.length - 1]?.date || "x"}`, () =>
 callGroq({
 model: MODEL_NAME,
 messages: [
 { role: "system", content: SYSTEM_PROMPT },
 { role: "user", content: prompt },
 ],
 temperature: 0.75,
 max_tokens: 80,
 }),
 );

 const content = data?.choices?.[0]?.message?.content;

 if (typeof content !== "string" || content.trim().length === 0) {
 return "What's been feeling most present in your life lately?";
 }

 return content
 .trim()
 .replace(/^QUESTION:\s*/i, "")
 .split("\n")[0]
 .trim();
 } catch {
 return "What's been feeling most present in your life lately?";
 }
}

/* ==========================================================================
   3) LEGACY TAG GENERATOR (still queued)
   ========================================================================== */
export async function generateAITags(title: string, bodyHtml: string): Promise<string[]> {
  if (!API_KEY) return [];
  const prompt = `
Read this journal entry and extract 3-7 short topic tags.
Title: ${title}
Body: ${cleanHtmlToText(bodyHtml)}
Rules: lowercase, single words/short phrases, no #, no generic words like "day" or "thing".
Output ONLY a comma-separated list.`.trim();

  try {
    const data = await aiQueue.enqueue(null, () =>
      callGroq({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 100,
      }),
    );
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
   4) EMOTION ASSESSMENT — human-aware, queued, retried, robust
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

  // Fast heuristic so we ALWAYS show something useful even if the AI fails
  const fallbackLabel = quickHeuristicEmotion(`${title} ${cleanText}`);

  const prompt = `
You are an emotionally intelligent friend reading someone's private diary.
The writer uses casual English, Hinglish, and Roman Hindi (e.g. "she broke up with me", "bahut udaas hu", "aaj mood off tha", "soo sad", "khush hu").

Read the entry carefully. Name the ACTUAL dominant emotion the writer is feeling.
NOT the topic, NOT the activity — the FEELING underneath.

CRITICAL RULES:
- Output EXACTLY ONE label, 2 to 5 words.
- It MUST be a real human emotion (sad, heartbroken, angry, excited, anxious, lonely, happy, jealous, proud, ashamed, hopeful, etc).
- Be specific and honest. If someone wrote "she broke up with me, i am so sad" → "Heartbroken and devastated", NOT "Reflective".
- NEVER output "Reflective & Introspective" unless there is genuinely no emotion stronger than calm reflection.
- NEVER output "Neutral" or "Balanced" unless the entry is truly flat.
- No JSON, no quotes, no explanation. Just the label.

GOOD EXAMPLES:
- Heartbroken and empty
- Crushed and lonely
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
- Jealous and insecure
- Guilty and conflicted

Diary date: ${input.date || "unknown"}
Title: ${title}
Entry:
${cleanText}

Your answer (one short label, nothing else):
`.trim();

  try {
    const data = await aiQueue.enqueue(`assess:${input.date}:${title}`, () =>
      callGroq({
        model: MODEL_NAME,
        messages: [
          {
            role: "system",
            content:
              "You are an emotionally precise classifier. Output only a short, specific human emotion label (2-5 words). Never generic categories like 'Reflective & Introspective' or 'Balanced'.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 30,
      }),
    );

    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return fallbackLabel;
    }

    const cleaned = raw
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, "")
      .split("\n")[0]
      .replace(/^label:\s*/i, "")
      .slice(0, 70);

    // Reject obviously bad outputs (the old generic vibe)
    if (/^reflective\s*&?\s*introspective$/i.test(cleaned)) return fallbackLabel;
    if (!cleaned) return fallbackLabel;
    return cleaned;
  } catch {
    return fallbackLabel;
  }
}

/* Quick keyword-based emotion guess (used as resilient fallback). */
function quickHeuristicEmotion(text: string): string {
  const t = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));

  if (has("broke up", "breakup", "break up", "she left", "he left", "heartbroken", "heart broken", "dumped"))
    return "Heartbroken and empty";
  if (has("so sad", "soo sad", "very sad", "udaas", "depressed", "crying", "rona", "tears"))
    return "Sad and heavy";
  if (has("angry", "furious", "gussa", "pissed", "rage", "hate"))
    return "Angry and tense";
  if (has("anxious", "anxiety", "panic", "nervous", "scared", "darr"))
    return "Anxious and on edge";
  if (has("lonely", "alone", "akela", "no one"))
    return "Lonely and quiet";
  if (has("excited", "can't wait", "cant wait", "yay", "amazing", "awesome", "best day"))
    return "Excited and buzzing";
  if (has("happy", "khush", "great day", "wonderful", "smiled", "smiling", "joyful"))
    return "Happy and light";
  if (has("tired", "exhausted", "drained", "burnt out", "thak gaya"))
    return "Drained and tired";
  if (has("grateful", "thankful", "blessed", "shukar"))
    return "Grateful and grounded";
  if (has("proud", "achieved", "accomplished", "finally did"))
    return "Proud and relieved";
  if (has("confused", "don't know", "dont know", "samajh nahi"))
    return "Confused and uncertain";
  if (has("missed", "miss her", "miss him", "missing"))
    return "Tender and missing them";
  return "Processing emotions";
}
