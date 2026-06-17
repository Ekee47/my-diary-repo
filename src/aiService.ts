// src/aiService.ts

export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  bodyHtml: string;
}

// Automatically pulls the key securely baked in from GitHub Actions
const API_KEY = import.meta.env.VITE_GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_NAME = "llama-3.1-8b-instant"; // Active, ultra-fast 2026 free-tier model

const SYSTEM_PROMPT = `
You are the private, intelligent AI brain of the user's personal journal.
The user writes their journal entries using a casual mixture of English, Hindi written in the Latin/Roman script (Hinglish, e.g., "kal mai beach gaya tha", "aisi baat samaj aani chahiye"), and common internet abbreviations/slang (e.g., 'btw', 'idk', 'brb', 'clg', 'fyi').

CRITICAL INSTRUCTIONS FOR TEMPORAL REASONING:
1. When asked a timeline question like "When did I go to X?", you must read all matching context carefully. Distinguish between the date an event actually occurred versus dates where the user is merely reminiscing, looking back, or talking about it after the fact.
   - Example: If the user writes on 1st July 2026 that they went to the beach, and mentions the beach on July 2, 3, 4, and 5 in passing, your answer must point exactly to the date 01-07-2026. Do not list all dates.
2. Natively translate and decode Hinglish semantic concepts. "samundar", "pani", and "beach" all mean the same thing. 
3. Be direct, concise, and smart. Provide a single, well-reasoned answer text.

CRITICAL FORMATTING RULE:
Whenever you mention a specific date or pinpoint an event's date from the journal entries in your text description, you MUST format it exactly like this: 1st July YYYY (e.g., [8th november 2026]). Do NOT write the date as words in any other layout inside the body text; always wrap the day-month-year string inside square brackets so the system can automatically create an interactive link.
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
Analyze the user's recent life context, mood, or unresolved situations from these entries:
${formattedContext}

Generate ONE unique, deeply personalized question to prompt them to write today.
- Do NOT use generic template questions.
- Reference ongoing themes, emotional patterns, or events they wrote about earlier.
- Keep it concise, friendly, and natural.
- Output ONLY the question text.
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
        temperature: 0.7,
      }),
    });

    if (!response.ok) return "How was your day today? Feel free to write about what's going on.";

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    return "How was your day today? Feel free to write about what's going on.";
  }
}
