import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { cn } from "./utils/cn";
// Import the multi-device cloud intelligence layer
import { smartAISearch, generateAICustomQuestion } from "./aiService";

type MoodId = "happy" | "depressed" | "sleepy" | "angry" | "romantic";
type Screen = "home" | "entry" | "year" | "ai";
type SyncState = "locked" | "loading" | "ready" | "saving" | "saved" | "error";

type MoodOption = {
  id: MoodId;
  label: string;
  color: string;
  glow: string;
  description: string;
};

type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
  addedAt: string;
};

type DiaryEntry = {
  id: string;
  date: string;
  title: string;
  mood: MoodId;
  bodyHtml: string;
  dailyWin: string;
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
};

type VaultData = {
  version: 1;
  updatedAt: string;
  entries: DiaryEntry[];
};

type GitHubConfig = {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
};

type EncryptedVaultFile = {
  kind: "moonlit-diary-encrypted-vault";
  version: 1;
  crypto: {
    name: "AES-GCM";
    kdf: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
};

const MOODS: MoodOption[] = [
  { id: "happy", label: "Happy", color: "from-amber-400 to-orange-500", glow: "shadow-amber-500/20", description: "Feeling positive, energetic, or accomplished" },
  { id: "depressed", label: "Low", color: "from-blue-500 to-indigo-600", glow: "shadow-blue-500/20", description: "Feeling down, tired, anxious, or heavy" },
  { id: "sleepy", label: "Chill", color: "from-teal-400 to-emerald-600", glow: "shadow-teal-500/20", description: "Calm, peaceful, lazy, or ready to rest" },
  { id: "angry", label: "Frustrated", color: "from-rose-500 to-red-600", glow: "shadow-rose-500/20", description: "Irritated, stressed, or holding intense tension" },
  { id: "romantic", label: "Deep", color: "from-purple-500 to-pink-600", glow: "shadow-purple-500/20", description: "Loving, reflective, nostalgic, or deeply connected" },
];

// Helper to create safe unique IDs without external library overhead
function createId() {
  return Math.random().toString(36).substring(2, 11);
}

// Inline component to turn [1st july 2026] text formats into active link anchors
interface AIResponseRendererProps {
  text: string;
  onDateClick: (isoDateStr: string) => void;
}

function parseReadableDateToISO(readableDate: string): string {
  const clean = readableDate.toLowerCase().trim();
  const match = clean.match(/^(\d{1,2})(?:st|nd|rd|th)\s+([a-z]+)\s+(\d{4})$/);
  
  if (!match) return readableDate;
  
  const day = match[1].padStart(2, "0");
  const monthName = match[2];
  const year = match[3];
  
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12"
  };
  
  const month = months[monthName] || "01";
  return `${year}-${month}-${day}`;
}

export function AIResponseRenderer({ text, onDateClick }: AIResponseRendererProps) {
  const dateRegex = /(\[\d{1,2}(?:st|nd|rd|th)\s+[a-zA-Z]+\s+\d{4}\])/gi;
  const parts = text.split(dateRegex);

  return (
    <>
      {parts.map((part, index) => {
        if (dateRegex.test(part)) {
          const rawReadableDate = part.replace(/[\[\]]/g, "");
          const isoDate = parseReadableDateToISO(rawReadableDate);
          
          return (
            <button
              key={index}
              onClick={() => onDateClick(isoDate)}
              className="inline-block font-bold text-cyan-400 hover:text-cyan-300 underline mx-0.5 align-baseline cursor-pointer bg-transparent border-none p-0 focus:outline-none transition-colors"
              type="button"
            >
              {rawReadableDate}
            </button>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

export default function App() {
  // Navigation & Primary System Core States
  const [screen, setScreen] = useState<Screen>("home");
  const [password, setPassword] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("locked");
  const [vaultData, setVaultData] = useState<VaultData | null>(null);

  // Active Context Cache Management
  const [currentDate, setCurrentDate] = useState("");
  const [currentTitle, setCurrentTitle] = useState("");
  const [currentMood, setCurrentMood] = useState<MoodId>("happy");
  const [currentBodyHtml, setCurrentBodyHtml] = useState("");
  const [currentDailyWin, setCurrentDailyWin] = useState("");
  const [currentAttachments, setCurrentAttachments] = useState<Attachment[]>([]);

  // Filtering, Analysis & Intelligence States
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [aiPromptQuestion, setAiPromptQuestion] = useState("What's on your mind today? Let it all flow out.");
  const [aiAnswer, setAiAnswer] = useState("");
  const [isSearchingAI, setIsSearchingAI] = useState(false);

  // Reference elements for handling responsive focus locks
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dedicated config configuration layer locked to GitHub directly via env/pre-build settings
  const githubConfig: GitHubConfig = useMemo(() => ({
    owner: "SrijanYadav", 
    repo: "my-moonlit-vault-data", 
    branch: "main",
    path: "vault.json",
    token: import.meta.env.VITE_GITHUB_TOKEN || ""
  }), []);

  // Fetch contextual writing questions generated dynamically using past diary entry context strings
  useEffect(() => {
    if (vaultData && vaultData.entries.length > 0) {
      generateAICustomQuestion(vaultData.entries).then((promptText) => {
        setAiPromptQuestion(promptText);
      });
    }
  }, [vaultData]);

  // Encryption helper modules using standard internal window sub-crypto layers
  async function deriveKey(pass: string, saltBytes: Uint8Array, iterations: number): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(pass),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptData(plainText: string, pass: string): Promise<EncryptedVaultFile> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const iterations = 100000;
    const key = await deriveKey(pass, salt, iterations);
    const encoder = new TextEncoder();
    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plainText)
    );
    return {
      kind: "moonlit-diary-encrypted-vault",
      version: 1,
      crypto: {
        name: "AES-GCM",
        kdf: "PBKDF2",
        hash: "SHA-256",
        iterations,
        salt: btoa(String.fromCharCode(...salt)),
        iv: btoa(String.fromCharCode(...iv)),
      },
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer))),
    };
  }

  async function decryptData(encryptedFile: EncryptedVaultFile, pass: string): Promise<string> {
    const salt = new Uint8Array(atob(encryptedFile.crypto.salt).split("").map((c) => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(encryptedFile.crypto.iv).split("").map((c) => c.charCodeAt(0)));
    const ciphertext = new Uint8Array(atob(encryptedFile.ciphertext).split("").map((c) => c.charCodeAt(0)));
    const key = await deriveKey(pass, salt, encryptedFile.crypto.iterations);
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decryptedBuffer);
  }

  // Repository data loading modules
  async function loadVault() {
    if (!password.trim()) return;
    setSyncState("loading");
    try {
      const url = `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${githubConfig.path}?ref=${githubConfig.branch}`;
      const headers: HeadersInit = { Accept: "application/vnd.github.v3+json" };
      if (githubConfig.token) {
        headers["Authorization"] = `token ${githubConfig.token}`;
      }
      const res = await fetch(url, { headers, cache: "no-store" });
      if (res.status === 404) {
        const initialVault: VaultData = { version: 1, updatedAt: new Date().toISOString(), entries: [] };
        setVaultData(initialVault);
        setSyncState("ready");
        return;
      }
      if (!res.ok) throw new Error("Could not contact GitHub storage backend container repo");
      const fileMeta = await res.json();
      const rawText = decodeURIComponent(escape(atob(fileMeta.content.replace(/\s/g, ""))));
      const encryptedFile: EncryptedVaultFile = JSON.parse(rawText);
      const decryptedText = await decryptData(encryptedFile, password);
      setVaultData(JSON.parse(decryptedText));
      setSyncState("ready");
    } catch (e) {
      console.error(e);
      setSyncState("error");
    }
  }

  async function saveVault(updatedData: VaultData) {
    if (syncState === "locked" || !password.trim()) return;
    setSyncState("saving");
    try {
      const plainText = JSON.stringify(updatedData);
      const encryptedFile = await encryptData(plainText, password);
      const contentString = btoa(unescape(encodeURIComponent(JSON.stringify(encryptedFile))));
      const url = `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${githubConfig.path}`;
      const headers: HeadersInit = { Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" };
      if (githubConfig.token) {
        headers["Authorization"] = `token ${githubConfig.token}`;
      }
      const metaRes = await fetch(`${url}?ref=${githubConfig.branch}`, { headers, cache: "no-store" });
      let sha = "";
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        sha = metaData.sha;
      }
      const putRes = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message: `Sync updates - ${new Date().toISOString()}`,
          content: contentString,
          branch: githubConfig.branch,
          sha: sha || undefined,
        }),
      });
      if (!putRes.ok) throw new Error("Failed to write updated package layer securely into Git branch streams.");
      setVaultData(updatedData);
      setSyncState("saved");
      setTimeout(() => setSyncState("ready"), 2500);
    } catch (e) {
      console.error(e);
      setSyncState("error");
    }
  }

  // Active workspace execution navigation handlers
  function openEntry(dateString: string) {
    const existing = vaultData?.entries.find((e) => e.date === dateString);
    setCurrentDate(dateString);
    if (existing) {
      setCurrentTitle(existing.title);
      setCurrentMood(existing.mood);
      setCurrentBodyHtml(existing.bodyHtml);
      setCurrentDailyWin(existing.dailyWin || "");
      setCurrentAttachments(existing.attachments || []);
    } else {
      setCurrentTitle("");
      setCurrentMood("happy");
      setCurrentBodyHtml("");
      setCurrentDailyWin("");
      setCurrentAttachments([]);
    }
    setScreen("entry");
    setTimeout(() => editorRef.current?.focus(), 50);
  }

  function commitActiveEntry() {
    if (!vaultData || !currentDate) return;
    const cleanHtml = sanitizeTextContent(currentBodyHtml);
    const existingIndex = vaultData.entries.findIndex((e) => e.date === currentDate);
    const entriesCopy = [...vaultData.entries];
    const targetEntry: DiaryEntry = {
      id: existingIndex >= 0 ? entriesCopy[existingIndex].id : createId(),
      date: currentDate,
      title: currentTitle.trim() || "Untitled Reflection",
      mood: currentMood,
      bodyHtml: cleanHtml,
      dailyWin: currentDailyWin.trim(),
      attachments: currentAttachments,
      createdAt: existingIndex >= 0 ? entriesCopy[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) {
      entriesCopy[existingIndex] = targetEntry;
    } else {
      entriesCopy.push(targetEntry);
      entriesCopy.sort((a, b) => b.date.localeCompare(a.date));
    }
    const updatedVault: VaultData = { ...vaultData, updatedAt: new Date().toISOString(), entries: entriesCopy };
    saveVault(updatedVault);
    setScreen("home");
  }

  function discardEntryChanges() {
    setScreen("home");
  }

  // Smart Query Handler via Groq API Framework Cloud Pipelines
  async function handleAISearchSubmit(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim() || !vaultData) return;

    setIsSearchingAI(true);
    setAiAnswer("");

    try {
      const reasoningResult = await smartAISearch(searchQuery, vaultData.entries);
      setAiAnswer(reasoningResult);
    } catch (err) {
      setAiAnswer("An error occurred executing cognitive parsing on repository blocks.");
    } finally {
      setIsSearchingAI(false);
    }
  }

  // Core formatting layout properties computed values
  const structuredMetrics = useMemo(() => {
    if (!vaultData) return { totalWords: 0, streak: 0, count: 0 };
    let totalWords = 0;
    vaultData.entries.forEach((e) => {
      const text = e.bodyHtml.replace(/<\/?[^>]+(>|$)/g, "");
      totalWords += text.trim().split(/\s+/).filter(Boolean).length;
    });
    let currentStreak = 0;
    const sortedDates = [...vaultData.entries].map((e) => e.date).sort((a, b) => b.localeCompare(a));
    if (sortedDates.length > 0) {
      const todayStr = new Date().toISOString().split("T")[0];
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split("T")[0];
      if (sortedDates[0] === todayStr || sortedDates[0] === yesterdayStr) {
        currentStreak = 1;
        let checkDate = new Date(sortedDates[0]);
        for (let i = 1; i < sortedDates.length; i++) {
          checkDate.setDate(checkDate.getDate() - 1);
          const expected = checkDate.toISOString().split("T")[0];
          if (sortedDates[i] === expected) {
            currentStreak++;
          } else if (sortedDates[i] < expected) {
            break;
          }
        }
      }
    }
    return { totalWords, streak: currentStreak, count: vaultData.entries.length };
  }, [vaultData]);

  const filteredTimelineEntries = useMemo(() => {
    if (!vaultData) return [];
    return vaultData.entries.filter((entry) => {
      if (screen === "year") {
        return entry.date.startsWith(`${selectedYear}-`);
      }
      const cleanBody = entry.bodyHtml.replace(/<\/?[^>]+(>|$)/g, "").toLowerCase();
      const query = searchQuery.toLowerCase();
      return (
        entry.title.toLowerCase().includes(query) ||
        entry.date.includes(query) ||
        cleanBody.includes(query) ||
        (entry.dailyWin && entry.dailyWin.toLowerCase().includes(query))
      );
    });
  }, [vaultData, searchQuery, selectedYear, screen]);

  const groupedYearOverview = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      name: new Date(2000, i, 1).toLocaleString("default", { month: "long" }),
      index: String(i + 1).padStart(2, "0"),
      days: [] as { date: string; entry?: DiaryEntry }[],
    }));
    months.forEach((m) => {
      const daysInMonth = new Date(selectedYear, Number(m.index), 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dStr = String(d).padStart(2, "0");
        const dateKey = `${selectedYear}-${m.index}-${dStr}`;
        const found = vaultData?.entries.find((e) => e.date === dateKey);
        m.days.push({ date: dateKey, entry: found });
      }
    });
    return months;
  }, [vaultData, selectedYear]);

  // Document attachment media encoding pipelines
  function handleFileSelection(e: ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    filesToAttachments(e.target.files)
      .then((newAttachments) => {
        setCurrentAttachments((prev) => [...prev, ...newAttachments]);
      })
      .catch((err) => alert(err.message))
      .finally(() => {
        if (fileInputRef.current) fileInputRef.current.value = "";
      });
  }

  function removeAttachment(id: string) {
    setCurrentAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // HTML Rich Input Action Scripts
  function applyTextStyle(command: string, value = "") {
    document.execCommand(command, false, value);
    if (editorRef.current) {
      setCurrentBodyHtml(editorRef.current.innerHTML);
    }
  }

  if (syncState === "locked") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4 relative overflow-hidden font-sans">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-600/10 rounded-full blur-3xl animate-pulse delay-700" />
        <div className="w-full max-w-md p-8 rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl relative z-10 text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-tr from-purple-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            <svg className="w-8 h-8 text-white animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight mb-2">Moonlit Vault</h1>
          <p className="text-sm text-slate-400 mb-8">Decentralized Multi-Device Personal Journal Layer</p>
          <div className="space-y-4">
            <input
              type="password"
              placeholder="Enter Private Encryption Key..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadVault()}
              className="w-full px-5 py-4 rounded-xl bg-slate-900/80 border border-white/10 text-white placeholder-slate-500 text-center focus:outline-none focus:border-purple-500 transition-all shadow-inner focus:ring-1 focus:ring-purple-500"
            />
            <button
              onClick={loadVault}
              disabled={!password.trim()}
              className="w-full py-4 rounded-xl font-bold text-white bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 active:scale-[0.99] transition-all shadow-lg shadow-purple-900/30 disabled:opacity-40 disabled:pointer-events-none"
            >
              Decrypt Vault Space
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (syncState === "loading") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-white font-sans">
        <div className="relative w-20 h-20 mb-6">
          <div className="absolute inset-0 rounded-full border-4 border-purple-500/20" />
          <div className="absolute inset-0 rounded-full border-4 border-t-purple-500 animate-spin" />
        </div>
        <p className="text-sm tracking-widest uppercase text-purple-400 font-semibold animate-pulse">Syncing with GitHub File Systems...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col relative overflow-x-hidden selection:bg-purple-500/30 selection:text-white font-sans">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[300px] bg-gradient-to-b from-purple-900/10 to-transparent blur-3xl pointer-events-none" />

      {/* Primary Workspace Navigation Shell Banner */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-slate-950/80 backdrop-blur-md px-4 py-4 max-w-7xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => { setScreen("home"); setSearchQuery(""); setAiAnswer(""); }}>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-500 to-cyan-500 flex items-center justify-center shadow-md shadow-purple-500/10">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight text-white">Moonlit Vault</h2>
            <div className="flex items-center gap-1.5">
              <span className={cn("w-2 h-2 rounded-full", syncState === "ready" || syncState === "saved" ? "bg-emerald-400 animate-pulse" : "bg-amber-400 animate-bounce")} />
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                {syncState === "ready" && "Secured Serverless Live"}
                {syncState === "saving" && "Encrypting Storage Payload..."}
                {syncState === "saved" && "Changes Pushed to GitHub"}
                {syncState === "error" && "Database Network Sync Failure"}
              </span>
            </div>
          </div>
        </div>

        <nav className="flex items-center gap-2">
          <button
            onClick={() => { setScreen("home"); setSearchQuery(""); setAiAnswer(""); }}
            className={cn("p-2.5 rounded-xl transition-all", screen === "home" ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:bg-white/5 hover:text-slate-200")}
            title="Dashboard Overview"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </button>
          <button
            onClick={() => setScreen("year")}
            className={cn("p-2.5 rounded-xl transition-all", screen === "year" ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:bg-white/5 hover:text-slate-200")}
            title="Yearly Matrix View"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 002-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
          <button
            onClick={() => setScreen("ai")}
            className={cn("p-2.5 rounded-xl transition-all", screen === "ai" ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:bg-white/5 hover:text-slate-200")}
            title="AI Cognitive Engine Search"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </button>
          <button
            onClick={() => { setVaultData(null); setPassword(""); setSyncState("locked"); }}
            className="p-2.5 rounded-xl text-rose-400 hover:bg-rose-500/10 transition-all ml-2"
            title="Lock Vault File"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </button>
        </nav>
      </header>

      {/* Main Container Viewport Stage */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 relative z-10">
        {screen === "home" && (
          <div className="space-y-8 animate-fadeIn">
            {/* Context Analytical Statistical Dash */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-5 rounded-2xl border border-white/5 bg-white/5 shadow-sm backdrop-blur-md">
                <p className="text-xs font-semibold uppercase text-slate-400 tracking-wider mb-1">Total Reflections</p>
                <p className="text-3xl font-black text-white">{structuredMetrics.count}</p>
              </div>
              <div className="p-5 rounded-2xl border border-white/5 bg-white/5 shadow-sm backdrop-blur-md">
                <p className="text-xs font-semibold uppercase text-slate-400 tracking-wider mb-1">Current Writing Streak</p>
                <p className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-500">{structuredMetrics.streak} {structuredMetrics.streak === 1 ? "Day" : "Days"}</p>
              </div>
              <div className="p-5 rounded-2xl border border-white/5 bg-white/5 shadow-sm backdrop-blur-md">
                <p className="text-xs font-semibold uppercase text-slate-400 tracking-wider mb-1">Total Encrypted Words</p>
                <p className="text-3xl font-black text-white">{structuredMetrics.totalWords.toLocaleString()}</p>
              </div>
              <button
                onClick={() => openEntry(new Date().toISOString().split("T")[0])}
                className="p-5 rounded-2xl bg-gradient-to-tr from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white font-bold flex flex-col justify-between shadow-lg shadow-purple-900/20 group relative overflow-hidden text-left"
              >
                <div className="absolute top-0 right-0 p-8 bg-white/10 rounded-full blur-xl translate-x-4 -translate-y-4 group-hover:scale-125 transition-all" />
                <span className="text-xs uppercase tracking-wider opacity-80">Capture Today</span>
                <div className="flex items-center gap-2 mt-4 text-lg font-black">
                  <span>Write Reflection</span>
                  <svg className="w-5 h-5 transform group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </div>
              </button>
            </div>

            {/* Standard Keywords Inline Filter Panel */}
            <div className="relative">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0x" />
              </svg>
              <input
                type="text"
                placeholder="Search index keywords, headings, timestamps..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-4 rounded-xl bg-white/5 border border-white/5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-all backdrop-blur-md text-sm"
              />
            </div>

            {/* Vertical History Feed Log View */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Chronological Archive Flow</h3>
                {searchQuery && <span className="text-xs text-slate-500">Found {filteredTimelineEntries.length} matching logs</span>}
              </div>

              {filteredTimelineEntries.length === 0 ? (
                <div className="text-center py-16 rounded-2xl border border-dashed border-white/5 bg-white/[0.01]">
                  <svg className="w-10 h-10 mx-auto mb-3 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0a2 2 0 01-2 2H6a2 2 0 01-2-2m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-4M4 13h4m1.5 8h3.5c.83 0 1.5-.67 1.5-1.5V17M10 5l2 2 2-2" />
                  </svg>
                  <p className="text-slate-400 text-sm font-medium">No decrypted logs fit your current navigation filters.</p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredTimelineEntries.map((entry) => {
                    const mood = MOODS.find((m) => m.id === entry.mood) || MOODS[0];
                    const plainBody = entry.bodyHtml.replace(/<\/?[^>]+(>|$)/g, "");
                    const formattedDisplayDate = new Date(entry.date).toLocaleDateString("en-US", {
                      year: "numeric", month: "short", day: "numeric"
                    });
                    return (
                      <div
                        key={entry.id}
                        onClick={() => openEntry(entry.date)}
                        className="group p-5 rounded-2xl border border-white/5 bg-slate-900/40 hover:bg-slate-900/80 hover:border-white/10 transition-all cursor-pointer flex flex-col justify-between relative shadow-sm hover:shadow-md"
                      >
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-xs font-mono font-semibold text-slate-500 tracking-tight group-hover:text-slate-400 transition-colors">{formattedDisplayDate}</span>
                            <div className={cn("w-2.5 h-2.5 rounded-full bg-gradient-to-tr shadow-sm", mood.color, mood.glow)} title={mood.label} />
                          </div>
                          <h4 className="text-base font-bold text-white group-hover:text-purple-400 transition-colors mb-2 line-clamp-1">{entry.title}</h4>
                          <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed mb-4">{plainBody || "Empty reflection context..."}</p>
                        </div>
                        {entry.dailyWin && (
                          <div className="mt-2 pt-3 border-t border-white/5 flex items-start gap-2 text-[11px] text-amber-400/90 leading-tight">
                            <span className="mt-0.5">🏆</span>
                            <span className="line-clamp-1 italic">{entry.dailyWin}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {screen === "year" && (
          <div className="space-y-8 animate-fadeIn">
            {/* Year View Slider Controller Selector */}
            <div className="flex items-center justify-between p-4 rounded-2xl border border-white/5 bg-white/5 backdrop-blur-md">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Yearly Matrix Landscape</h3>
              <div className="flex items-center gap-4">
                <button onClick={() => setSelectedYear((y) => y - 1)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white">◀</button>
                <span className="text-xl font-black text-white tracking-wider font-mono">{selectedYear}</span>
                <button onClick={() => setSelectedYear((y) => y + 1)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white">▶</button>
              </div>
            </div>

            {/* Matrix Block Rendering Grid */}
            <div className="space-y-6">
              {groupedYearOverview.map((month) => {
                const filledCount = month.days.filter((d) => d.entry).length;
                return (
                  <div key={month.index} className="p-4 rounded-2xl border border-white/5 bg-slate-900/20 space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-300 tracking-wide">{month.name}</span>
                      <span className="text-slate-500 font-mono font-medium">{filledCount} Logs captured</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {month.days.map((day) => {
                        const mId = day.entry?.mood;
                        const matchedMood = mId ? MOODS.find((m) => m.id === mId) : null;
                        const dayNum = day.date.split("-")[2];
                        return (
                          <div
                            key={day.date}
                            onClick={() => openEntry(day.date)}
                            className={cn(
                              "w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-mono font-bold cursor-pointer transition-all border",
                              day.entry 
                                ? `bg-gradient-to-tr text-white border-transparent shadow-sm ${matchedMood?.color}`
                                : "bg-white/[0.02] text-slate-600 border-white/5 hover:border-slate-700 hover:text-slate-400"
                            )}
                            title={day.entry ? `[${day.date}] ${day.entry.title}` : `No entry for ${day.date}`}
                          >
                            {dayNum}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {screen === "ai" && (
          <div className="space-y-8 animate-fadeIn">
            {/* Context Header Info Block */}
            <div className="p-6 rounded-3xl border border-purple-500/10 bg-gradient-to-br from-purple-950/20 to-transparent relative overflow-hidden">
              <div className="absolute -right-10 -top-10 w-40 h-40 bg-purple-500/10 rounded-full blur-2xl" />
              <h3 className="text-lg font-black text-white mb-1 flex items-center gap-2">
                <span>Cognitive Timeline Logic Interface</span>
                <span className="px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-400 text-[10px] font-bold uppercase tracking-wider">Llama 3.1 8B</span>
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
                Unlike primitive keyword searches, this layer performs semantic temporal deductions over your complete encrypted journal history. It decodes mixed languages (Hinglish), converts shorthand slang, and extracts direct objective conclusions across chronological timelines.
              </p>
            </div>

            {/* Smart Intelligent Chat Input Stage */}
            <form onSubmit={handleAISearchSubmit} className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Ask timeline questions: 'When did I catch up with X?', 'What was my mindset around last July?'..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-5 pr-16 py-5 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 text-sm shadow-inner backdrop-blur-md"
                />
                <button
                  type="submit"
                  disabled={isSearchingAI || !searchQuery.trim()}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white transition-all disabled:opacity-40 disabled:pointer-events-none shadow-md"
                >
                  {isSearchingAI ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  )}
                </button>
              </div>
            </form>

            {/* AI Answer Visualization Display Block */}
            {aiAnswer && (
              <div className="p-5 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md shadow-inner animate-slideUp">
                <h4 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-3 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  AI Cognitive Brain Conclusion
                </h4>
                <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                  <AIResponseRenderer 
                    text={aiAnswer} 
                    onDateClick={(isoDateStr) => {
                      // Seamless redirection back into deep entry vault workspace state structures
                      openEntry(isoDateStr);
                    }} 
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {screen === "entry" && (
          <div className="grid lg:grid-cols-3 gap-8 items-start animate-fadeIn">
            {/* Left Multi-Field Secondary Meta Details */}
            <div className="space-y-6 lg:col-span-1">
              {/* Dynamic Contextual Brain Prompt Card Box */}
              <div className="p-5 rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-900/20 shadow-sm backdrop-blur-md">
                <div className="flex items-center gap-2 mb-2 text-xs font-bold uppercase tracking-wider text-purple-400">
                  <span>Assistant Writing Prompt</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed italic">"{aiPromptQuestion}"</p>
              </div>

              {/* Immutable Navigation Context Title Banner */}
              <div className="p-5 rounded-2xl border border-white/5 bg-slate-900/40 space-y-4">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Reflection File Stamp</label>
                  <input
                    type="date"
                    value={currentDate}
                    onChange={(e) => setCurrentDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm font-mono font-bold text-slate-300 focus:outline-none focus:border-purple-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Vibe Alignment Spectrum</label>
                  <div className="space-y-2">
                    {MOODS.map((m) => {
                      const isSelected = currentMood === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setCurrentMood(m.id)}
                          className={cn(
                            "w-full px-4 py-3 rounded-xl text-left text-xs font-bold transition-all border flex items-center justify-between group",
                            isSelected
                              ? `bg-gradient-to-r text-white border-transparent shadow-md ${m.color}`
                              : "bg-slate-950 text-slate-400 border-white/5 hover:border-white/10 hover:text-slate-200"
                          )}
                        >
                          <div className="flex flex-col">
                            <span>{m.label}</span>
                            <span className={cn("text-[10px] font-normal mt-0.5 max-w-[200px] line-clamp-1", isSelected ? "text-white/80" : "text-slate-500 group-hover:text-slate-400")}>{m.description}</span>
                          </div>
                          {isSelected && <span className="text-sm">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Core Execution Operations Bar Container */}
              <div className="p-4 rounded-2xl border border-white/5 bg-slate-900/40 grid grid-cols-2 gap-3">
                <button
                  onClick={discardEntryChanges}
                  className="py-3 px-4 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 text-slate-300 active:scale-[0.98] transition-all text-center"
                >
                  Discard Changes
                </button>
                <button
                  onClick={commitActiveEntry}
                  className="py-3 px-4 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white shadow-md active:scale-[0.98] transition-all text-center"
                >
                  Save Reflection
                </button>
              </div>
            </div>

            {/* Right Rich Editor Core Flow Workspace Stage */}
            <div className="lg:col-span-2 space-y-6">
              <input
                type="text"
                placeholder="Name your reflection headspace..."
                value={currentTitle}
                onChange={(e) => setCurrentTitle(e.target.value)}
                className="w-full bg-transparent border-b border-white/5 pb-3 text-2xl font-black text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 transition-colors tracking-tight"
              />

              {/* Rich-Text Control Actions Toolbelt */}
              <div className="flex flex-wrap items-center gap-1 p-2 rounded-xl border border-white/5 bg-slate-900/60 backdrop-blur-md">
                <button type="button" onClick={() => applyTextStyle("bold")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white font-bold text-sm min-w-[32px]">B</button>
                <button type="button" onClick={() => applyTextStyle("italic")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white italic text-sm min-w-[32px]">I</button>
                <button type="button" onClick={() => applyTextStyle("underline")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white underline text-sm min-w-[32px]">U</button>
                <button type="button" onClick={() => applyTextStyle("strikeThrough")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white line-through text-sm min-w-[32px]">S</button>
                <div className="w-px h-4 bg-white/10 mx-1" />
                <button type="button" onClick={() => applyTextStyle("insertUnorderedList")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white text-xs font-bold">● List</button>
                <button type="button" onClick={() => applyTextStyle("insertOrderedList")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white text-xs font-bold">1. List</button>
                <div className="w-px h-4 bg-white/10 mx-1" />
                <button type="button" onClick={() => { const link = prompt("Enter complete destination target URL:"); if (link) applyTextStyle("createLink", link); }} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white text-xs font-bold">Link</button>
                <button type="button" onClick={() => applyTextStyle("unlink")} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-rose-400 text-xs font-bold">Unlink</button>
              </div>

              {/* HTML Target Canvas Interactive Field */}
              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={(e) => setCurrentBodyHtml(e.currentTarget.innerHTML)}
                dangerouslySetInnerHTML={{ __html: currentBodyHtml }}
                className="w-full min-h-[350px] p-6 rounded-2xl bg-white/[0.01] border border-white/5 focus:outline-none focus:border-white/10 transition-colors text-slate-200 text-base leading-relaxed overflow-y-auto placeholder:text-slate-600 focus:ring-1 focus:ring-white/5"
                placeholder="Begin unrolling your stream of consciousness safely inside this isolated sandboxed canvas field area..."
                style={{ outline: "none" }}
              />

              {/* Dedicated Focus Section: The Daily Win */}
              <div className="p-5 rounded-2xl border border-amber-500/10 bg-amber-500/[0.01] space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-widest text-amber-400/90 flex items-center gap-1">
                  <span>🏆 Main Win Matrix Objective</span>
                </label>
                <input
                  type="text"
                  placeholder="What went right? If nothing else, what single micro win anchor defined today?"
                  value={currentDailyWin}
                  onChange={(e) => setCurrentDailyWin(e.target.value)}
                  className="w-full bg-transparent border-b border-white/5 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/40 transition-colors"
                />
              </div>

              {/* Media Stream Vault Attachment Grid Management Modules */}
              <div className="p-5 rounded-2xl border border-white/5 bg-slate-900/20 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Secure Embedded Attachments</h4>
                    <p className="text-[10px] text-slate-500 mt-0.5">Media assets are compiled directly into your encrypted bundle payload stream</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-200 transition-colors"
                  >
                    Attach Media
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelection}
                    className="hidden"
                    accept="image/*,application/pdf"
                  />
                </div>

                {currentAttachments.length === 0 ? (
                  <p className="text-xs text-slate-600 italic py-2">No documents, receipts, or photos embedded inside this timeline node element yet.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {currentAttachments.map((file) => (
                      <div key={file.id} className="p-3 rounded-xl bg-slate-950 border border-white/5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-slate-300 truncate" title={file.name}>{file.name}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5 font-mono">{formatBytes(file.size)} • {file.type.split("/")[1]?.toUpperCase() || "BIN"}</p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {file.type.startsWith("image/") && (
                            <a href={file.dataUrl} target="_blank" rel="noreferrer" className="p-1.5 rounded-md hover:bg-white/5 text-slate-400 hover:text-cyan-400 transition-colors" title="View asset file">
                              👁
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => removeAttachment(file.id)}
                            className="p-1.5 rounded-md hover:bg-rose-500/10 text-slate-500 hover:text-rose-400 transition-colors"
                            title="Strip file from entry node"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {currentAttachments.length > 0 && (
                  <div className="text-[10px] font-mono text-slate-500 text-right pt-1">
                    Combined Asset Array Footprint: {formatBytes(totalAttachmentBytes(currentAttachments))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Low-level text sanitization layout filters
function sanitizeTextContent(dirtyHtml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(dirtyHtml, "text/html");
  const template = doc.body;

  const allowedTags = ["B", "I", "U", "STRIKE", "UL", "OL", "LI", "A", "BR", "DIV", "P", "SPAN"];
  const allElements = template.querySelectorAll("*");

  allElements.forEach((element) => {
    if (!allowedTags.includes(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    const attributes = Array.from(element.attributes);
    attributes.forEach((attribute) => {
      if (element.tagName === "A" && attribute.name === "href") {
        return;
      }
      element.removeAttribute(attribute.name);
    });

    if (element.tagName === "A") {
      const href = element.getAttribute("href") ?? "";
      if (href && !/^(https?:|mailto:|tel:|#)/i.test(href)) {
        element.removeAttribute("href");
      }
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer");
    }
  });

  return template.innerHTML;
}

function totalAttachmentBytes(attachments: Attachment[]) {
  return attachments.reduce((total, attachment) => total + attachment.size, 0);
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** power;
  return `${size.toFixed(size >= 10 || power === 0 ? 0 : 1)} ${units[power]}`;
}

function filesToAttachments(files: FileList) {
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<Attachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              id: createId(),
              name: file.name,
              type: file.type || "application/octet-stream",
              size: file.size,
              dataUrl: String(reader.result),
              addedAt: new Date().toISOString(),
            });
          };
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        })
    );
}
