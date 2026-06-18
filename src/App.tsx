import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode, useCallback, type TouchEvent as ReactTouchEvent } from "react";
import { cn } from "./utils/cn";
// Import the multi-device cloud intelligence layer
import { smartAISearch, generateAICustomQuestion } from "./aiService";

type MoodId = "happy" | "depressed" | "sleepy" | "angry" | "romantic" | "crazy";
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
  payload: string;
};

// Draft storage for auto-save functionality
type DraftEntry = {
  dateKey: string;
  title: string;
  mood: MoodId;
  bodyHtml: string;
  dailyWin: string;
  attachments: Attachment[];
  savedAt: string;
};

const CONFIG_STORAGE_KEY = "moonlit-diary-github-config-v1";
const DRAFT_STORAGE_KEY = "moonlit-diary-draft-v1";
const PBKDF2_ITERATIONS = 210_000;
const DEFAULT_CONFIG: GitHubConfig = {
  owner: "",
  repo: "",
  branch: "main",
  path: "data/moonlit-diary-vault.json",
  token: "",
};
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB limit

const MOODS: MoodOption[] = [
  { id: "happy", label: "Happy", color: "#f8c74a", glow: "rgba(248, 199, 74, 0.42)", description: "Bright, grateful, energized" },
  { id: "depressed", label: "Depressed", color: "#5da8ff", glow: "rgba(93, 168, 255, 0.36)", description: "Heavy, quiet, low battery" },
  { id: "sleepy", label: "Sleepy", color: "#a78bfa", glow: "rgba(167, 139, 250, 0.4)", description: "Slow, soft, tired mind" },
  { id: "angry", label: "Angry", color: "#ff5b6c", glow: "rgba(255, 91, 108, 0.38)", description: "Hot, restless, intense" },
  { id: "romantic", label: "Romantic", color: "#ff7ac8", glow: "rgba(255, 122, 200, 0.42)", description: "Tender, dreamy, connected" },
  { id: "crazy", label: "Crazyy", color: "#33e0a1", glow: "rgba(51, 224, 161, 0.45)", description: "Wild, hyper, unpredictable" },
];

const MOOD_BY_ID = MOODS.reduce<Record<MoodId, MoodOption>>((acc, mood) => {
  acc[mood.id] = mood;
  return acc;
}, {} as Record<MoodId, MoodOption>);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const SEMANTIC_DICTIONARY: Record<string, string[]> = {
  beach: ["ocean", "sea", "waves", "sand", "coast", "shore", "water", "vacation", "island"],
  alex: ["friend", "buddy", "partner", "mate", "brother"],
  work: ["project", "office", "meeting", "boss", "task", "deadline", "coding", "client"],
  fitness: ["gym", "workout", "run", "training", "exercise", "health", "lift"],
  happy: ["glad", "joy", "awesome", "great", "excited", "wonderful", "smiled"],
  stressed: ["overwhelmed", "tired", "busy", "heavy", "anxious", "pressure"],
};

interface AIResponseRendererProps {
  text: string;
  onDateClick: (isoDateStr: string) => void;
}

/**
 * Converts text like "1st july 2026" into standard "2026-07-01"
 */
function parseReadableDateToISO(readableDate: string): string | null {
  const clean = readableDate.toLowerCase().trim();
  
  // Match patterns like "1st july 2026", "2nd march 2025", "15th december 2024"
  const match = clean.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/);
  if (!match) {
    // Try matching with just space (without ordinal suffix)
    const simpleMatch = clean.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
    if (!simpleMatch) return null;
    const day = simpleMatch[1].padStart(2, '0');
    const monthName = simpleMatch[2];
    const year = simpleMatch[3];
    
    const months: Record<string, string> = {
      january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03', 
      april: '04', apr: '04', may: '05', june: '06', jun: '06',
      july: '07', jul: '07', august: '08', aug: '08', september: '09', sep: '09', sept: '09', 
      october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12'
    };
    
    const month = months[monthName];
    if (!month) return null;
    const maxDays = new Date(parseInt(year), parseInt(month), 0).getDate();
    const dayNum = Math.min(parseInt(day), maxDays);
    return `${year}-${month}-${String(dayNum).padStart(2, '0')}`;
  }
  
  const day = match[1].padStart(2, '0');
  const monthName = match[2];
  const year = match[3];
  
  const months: Record<string, string> = {
    january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03', 
    april: '04', apr: '04', may: '05', june: '06', jun: '06',
    july: '07', jul: '07', august: '08', aug: '08', september: '09', sep: '09', sept: '09', 
    october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12'
  };
  
  const month = months[monthName];
  if (!month) return null;
  const maxDays = new Date(parseInt(year), parseInt(month), 0).getDate();
  const dayNum = Math.min(parseInt(day), maxDays);
  return `${year}-${month}-${String(dayNum).padStart(2, '0')}`;
}

/**
 * Renders AI response text, turning readable date strings into clickable system buttons
 */
export function AIResponseRenderer({ text, onDateClick }: AIResponseRendererProps) {
  // Pattern to match dates in formats like "1st july 2026", "2nd March 2025", "15th december 2024"
  const dateRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s+(\d{4})\b/gi;
  
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = dateRegex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(<span key={`text-${keyIndex++}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    
    const rawReadableDate = match[0];
    const isoDate = parseReadableDateToISO(rawReadableDate);
    
    if (isoDate) {
      parts.push(
        <button
          key={`date-${keyIndex++}`}
          onClick={() => onDateClick(isoDate)}
          className="inline-block font-bold text-cyan-400 hover:text-cyan-300 hover:underline mx-0.5 align-baseline transition-colors cursor-pointer"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: '#22d3ee',
            fontWeight: 'bold',
            cursor: 'pointer',
            textDecoration: 'underline'
          }}
          title={`Click to open entry for ${isoDate}`}
        >
          {rawReadableDate}
        </button>
      );
    } else {
      parts.push(<span key={`date-${keyIndex++}`}>{rawReadableDate}</span>);
    }
    
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(<span key={`text-${keyIndex++}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts.length > 0 ? parts : text}</>;
}


export default function App() {
  const storedConfig = useMemo(loadStoredConfig, []);
  const todayKey = useMemo(() => dateToKey(new Date()), []);
  const [config, setConfig] = useState<GitHubConfig | null>(storedConfig);
  const [passphrase, setPassphrase] = useState("");
  const [vault, setVault] = useState<VaultData>(() => createEmptyVault());
  const [remoteSha, setRemoteSha] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("locked");
  const [syncError, setSyncError] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [editingDate, setEditingDate] = useState(todayKey);
  const [visibleMonth, setVisibleMonth] = useState(() => keyToDate(todayKey));
  const [yearView, setYearView] = useState(() => keyToDate(todayKey).getFullYear());
  const [selectedAITag, setSelectedAITag] = useState<string | null>(null);
  const [lightboxAttachments, setLightboxAttachments] = useState<Attachment[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const entryByDate = useMemo(() => {
    const map = new Map<string, DiaryEntry>();
    vault.entries.forEach((entry) => map.set(entry.date, entry));
    return map;
  }, [vault.entries]);

  async function unlockVault(nextConfig: GitHubConfig, nextPassphrase: string, rememberConfig: boolean) {
    const cleanedConfig = normalizeConfig(nextConfig);
    setSyncError("");
    setSyncState("loading");

    try {
      if (!cleanedConfig.owner || !cleanedConfig.repo || !cleanedConfig.branch || !cleanedConfig.path) {
        throw new Error("Add your GitHub owner, repo, branch, and vault file path.");
      }

      if (!cleanedConfig.token) {
        throw new Error("Add a GitHub token with Contents read and write access.");
      }

      if (!nextPassphrase.trim()) {
        throw new Error("Add the passphrase that unlocks your diary vault.");
      }

      const remote = await fetchGitHubVaultFile(cleanedConfig);
      let nextVault = createEmptyVault();
      let nextSha = remote.sha;

      if (remote.exists && remote.text.trim()) {
        const parsed = JSON.parse(remote.text) as EncryptedVaultFile | VaultData;
        nextVault = await openVaultFile(parsed, nextPassphrase);
      } else {
        const encrypted = await encryptVault(nextVault, nextPassphrase);
        const created = await putGitHubVaultFile(
          cleanedConfig,
          encrypted,
          null,
          "Create encrypted Moonlit Diary vault",
        );
        nextSha = created.sha;
      }

      if (rememberConfig) {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cleanedConfig));
      } else {
        localStorage.removeItem(CONFIG_STORAGE_KEY);
      }

      setConfig(cleanedConfig);
      setPassphrase(nextPassphrase);
      setVault(nextVault);
      setRemoteSha(nextSha);
      setSyncState("ready");
      setIsUnlocked(true);
      setScreen("home");
    } catch (error) {
      setSyncState("error");
      setSyncError(getErrorMessage(error));
    }
  }

  async function reloadVault() {
    if (!config || !passphrase) return;
    setSyncError("");
    setSyncState("loading");

    try {
      const remote = await fetchGitHubVaultFile(config);
      if (!remote.exists || !remote.text.trim()) {
        throw new Error("The vault file was not found on GitHub.");
      }

      const parsed = JSON.parse(remote.text) as EncryptedVaultFile | VaultData;
      const nextVault = await openVaultFile(parsed, passphrase);
      setVault(nextVault);
      setRemoteSha(remote.sha);
      setSyncState("ready");
    } catch (error) {
      setSyncState("error");
      setSyncError(getErrorMessage(error));
    }
  }

  async function persistVault(nextVault: VaultData, commitMessage: string) {
    if (!config || !passphrase) {
      throw new Error("Unlock your GitHub vault before saving.");
    }

    setSyncError("");
    setSyncState("saving");

    try {
      const encrypted = await encryptVault(nextVault, passphrase);
      const saved = await putGitHubVaultFile(config, encrypted, remoteSha, commitMessage);
      setVault(nextVault);
      setRemoteSha(saved.sha);
      setSyncState("saved");
    } catch (error) {
      setSyncState("error");
      setSyncError(getErrorMessage(error));
      throw error;
    }
  }

  function openLightbox(attachments: Attachment[], startIndex: number) {
    setLightboxAttachments(attachments);
    setLightboxIndex(startIndex);
  }

  function closeLightbox() {
    setLightboxAttachments(null);
    setLightboxIndex(0);
  }

  function goToPrevLightboxItem() {
    if (!lightboxAttachments) return;
    setLightboxIndex((prev) => (prev > 0 ? prev - 1 : lightboxAttachments.length - 1));
  }

  function goToNextLightboxItem() {
    if (!lightboxAttachments) return;
    setLightboxIndex((prev) => (prev < lightboxAttachments.length - 1 ? prev + 1 : 0));
  }

  async function saveEntry(entry: DiaryEntry) {
    // Clear draft when entry is explicitly saved
    clearDraft(entry.date);
    
    const entries = vault.entries.filter((item) => item.date !== entry.date);
    const nextVault: VaultData = {
      ...vault,
      updatedAt: new Date().toISOString(),
      entries: [...entries, entry].sort((a, b) => a.date.localeCompare(b.date)),
    };

    // Optimistically update the local vault state immediately so UI reflects the save
    setVault(nextVault);
    setSelectedDate(entry.date);
    setVisibleMonth(keyToDate(entry.date));
    setScreen("home");

    // Perform the actual GitHub save in the background
    // Don't await here - let it complete in background while user can navigate
    persistVault(nextVault, `Save diary entry for ${entry.date}`).catch((error) => {
      console.error("Background save failed:", error);
      // Error is already displayed via syncError/syncState
    });
  }

  async function deleteEntry(dateKey: string) {
    // Clear draft when entry is deleted
    clearDraft(dateKey);
    
    const nextVault: VaultData = {
      ...vault,
      updatedAt: new Date().toISOString(),
      entries: vault.entries.filter((entry) => entry.date !== dateKey),
    };

    // Optimistically update and navigate
    setVault(nextVault);
    setSelectedDate(dateKey);
    setVisibleMonth(keyToDate(dateKey));
    setScreen("home");

    // Delete in background
    persistVault(nextVault, `Delete diary entry for ${dateKey}`).catch((error) => {
      console.error("Background delete failed:", error);
    });
  }

  function openEntry(dateKey: string) {
    setEditingDate(dateKey);
    setSelectedDate(dateKey);
    setVisibleMonth(keyToDate(dateKey));
    setScreen("entry");
  }

  function lockVault() {
    setVault(createEmptyVault());
    setPassphrase("");
    setRemoteSha(null);
    setSyncState("locked");
    setSyncError("");
    setIsUnlocked(false);
    setScreen("home");
  }

  if (!isUnlocked) {
    return (
      <UnlockScreen
        initialConfig={config ?? DEFAULT_CONFIG}
        syncState={syncState}
        syncError={syncError}
        onUnlock={unlockVault}
      />
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#03040a] text-slate-100">
      <AmbientBackdrop />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <TopBar
          syncState={syncState}
          currentScreen={screen}
          onHome={() => setScreen("home")}
          onYear={() => {
            setYearView(keyToDate(selectedDate).getFullYear());
            setScreen("year");
          }}
          onAIScreen={() => {
            setSelectedAITag(null);
            setScreen("ai");
          }}
          onNewEntry={() => openEntry(todayKey)}
          onSync={reloadVault}
          onLock={lockVault}
        />

        {syncError ? <SyncError message={syncError} /> : null}

        <main className="flex-1 pb-8">
          {screen === "home" ? (
            <HomeView
              entryByDate={entryByDate}
              selectedDate={selectedDate}
              visibleMonth={visibleMonth}
              onSelectDate={setSelectedDate}
              onVisibleMonthChange={setVisibleMonth}
              onOpenEntry={openEntry}
            />
          ) : null}

          {screen === "entry" ? (
            <EntryEditor
              key={editingDate}
              dateKey={editingDate}
              entry={entryByDate.get(editingDate)}
              entryByDate={entryByDate}
              syncState={syncState}
              onBack={() => setScreen("home")}
              onSave={saveEntry}
              onDelete={deleteEntry}
              onOpenLightbox={openLightbox}
            />
          ) : null}

          {screen === "year" ? (
            <YearPixelsView
              year={yearView}
              entryByDate={entryByDate}
              onYearChange={setYearView}
              onBack={() => setScreen("home")}
              onOpenEntry={openEntry}
            />
          ) : null}

          {screen === "ai" ? (
            <AIIntelligenceView
              entries={vault.entries}
              initialTagFilter={selectedAITag}
              onJumpToEntry={(dateKey) => {
                openEntry(dateKey);
              }}
            />
          ) : null}
        </main>
      </div>

      {/* Lightbox Viewer */}
      {lightboxAttachments && (
        <LightboxViewer
          attachments={lightboxAttachments}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onPrev={goToPrevLightboxItem}
          onNext={goToNextLightboxItem}
        />
      )}
    </div>
  );
}

// Draft management functions
function saveDraft(draft: DraftEntry): void {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch (e) {
    console.warn("Failed to save draft to localStorage:", e);
  }
}

function loadDraft(dateKey: string): DraftEntry | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as DraftEntry;
    // Only return draft if it matches the requested date
    return draft.dateKey === dateKey ? draft : null;
  } catch {
    return null;
  }
}

function clearDraft(dateKey: string): void {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw) {
      const draft = JSON.parse(raw) as DraftEntry;
      if (draft.dateKey === dateKey) {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore errors when clearing draft
  }
}

function UnlockScreen({
  initialConfig,
  syncState,
  syncError,
  onUnlock,
}: {
  initialConfig: GitHubConfig;
  syncState: SyncState;
  syncError: string;
  onUnlock: (config: GitHubConfig, passphrase: string, rememberConfig: boolean) => Promise<void>;
}) {
  const [draftConfig, setDraftConfig] = useState(initialConfig);
  const [passphrase, setPassphrase] = useState("");
  const [rememberConfig, setRememberConfig] = useState(true);
  const isLoading = syncState === "loading" || syncState === "saving";

  function updateConfig(field: keyof GitHubConfig, value: string) {
    setDraftConfig((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onUnlock(draftConfig, passphrase, rememberConfig);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#02030a] text-slate-100">
      <AmbientBackdrop />
      <main className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl items-center gap-10 px-5 py-10 lg:grid-cols-[0.95fr_1.05fr] lg:px-10">
        <section className="animate-screen-in space-y-8">
          <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-cyan-100/80 shadow-2xl shadow-cyan-950/30 backdrop-blur-xl">
            <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />
            Encrypted GitHub file diary
          </div>

          <div className="space-y-5">
            <p className="text-sm uppercase tracking-[0.55em] text-fuchsia-200/50">Moonlit</p>
            <h1 className="max-w-3xl text-6xl font-semibold tracking-[-0.08em] text-white sm:text-7xl lg:text-8xl">
              Your private night journal.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300/80">
              A dark, calendar-first diary with rich writing, media attachments, encrypted GitHub storage, and a full year mood map.
            </p>
          </div>

          <div className="grid max-w-2xl gap-3 text-sm text-slate-300/75 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">Calendar front</p>
              <p className="mt-2 text-slate-400">A dot appears on every saved day.</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">Rich entries</p>
              <p className="mt-2 text-slate-400">Headings, bold, italic, underline, lists, links.</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">Mood pixels</p>
              <p className="mt-2 text-slate-400">A full year colored by how you felt.</p>
            </div>
          </div>
        </section>

        <section className="animate-float-in rounded-[2rem] border border-white/10 bg-slate-950/70 p-5 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:p-7">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm uppercase tracking-[0.35em] text-cyan-200/50">Vault access</p>
              <h2 className="text-3xl font-semibold tracking-tight text-white">Open your GitHub diary file</h2>
              <p className="text-sm leading-6 text-slate-400">
                Your diary entries and attachments are encrypted before they are saved to the GitHub file below. The passphrase is never stored by this app.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="GitHub owner">
                <input
                  value={draftConfig.owner}
                  onChange={(event) => updateConfig("owner", event.target.value)}
                  placeholder="your-username"
                  className="field-input"
                />
              </Field>
              <Field label="Repository">
                <input
                  value={draftConfig.repo}
                  onChange={(event) => updateConfig("repo", event.target.value)}
                  placeholder="my-diary-repo"
                  className="field-input"
                />
              </Field>
              <Field label="Branch">
                <input
                  value={draftConfig.branch}
                  onChange={(event) => updateConfig("branch", event.target.value)}
                  placeholder="main"
                  className="field-input"
                />
              </Field>
              <Field label="Vault file path">
                <input
                  value={draftConfig.path}
                  onChange={(event) => updateConfig("path", event.target.value)}
                  placeholder="data/moonlit-diary-vault.json"
                  className="field-input"
                />
              </Field>
            </div>

            <Field label="GitHub token">
              <input
                type="password"
                value={draftConfig.token}
                onChange={(event) => updateConfig("token", event.target.value)}
                placeholder="Fine-grained token with Contents read/write"
                className="field-input"
              />
            </Field>

            <Field label="Diary passphrase">
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Only this opens the encrypted vault"
                className="field-input"
              />
            </Field>

            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={rememberConfig}
                onChange={(event) => setRememberConfig(event.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              Remember GitHub details on this device. Diary data still stays in the GitHub vault file.
            </label>

            {syncError ? <SyncError message={syncError} compact /> : null}

            <button
              type="submit"
              disabled={isLoading}
              className="group relative w-full overflow-hidden rounded-2xl bg-cyan-200 px-5 py-4 text-sm font-semibold uppercase tracking-[0.26em] text-slate-950 shadow-2xl shadow-cyan-500/25 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="relative z-10">{isLoading ? "Opening vault..." : "Unlock diary"}</span>
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/60 to-transparent transition duration-700 group-hover:translate-x-full" />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function TopBar({
  syncState,
  currentScreen,
  onHome,
  onYear,
  onAIScreen,
  onNewEntry,
  onSync,
  onLock,
}: {
  syncState: SyncState;
  currentScreen: Screen;
  onHome: () => void;
  onYear: () => void;
  onAIScreen: () => void;
  onNewEntry: () => void;
  onSync: () => void;
  onLock: () => void;
}) {
  return (
    <header className="mb-5 flex flex-col gap-4 rounded-[1.8rem] border border-white/10 bg-white/[0.035] px-4 py-4 shadow-2xl shadow-black/30 backdrop-blur-2xl sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <button type="button" onClick={onHome} className="group flex items-center gap-4 text-left">
        <span className="relative grid h-12 w-12 place-items-center overflow-hidden rounded-2xl border border-cyan-200/20 bg-cyan-200/10 shadow-[0_0_40px_rgba(34,211,238,0.18)]">
          <span className="absolute h-9 w-9 rounded-full bg-cyan-300/20 blur-xl transition group-hover:bg-fuchsia-300/25" />
          <span className="relative h-5 w-5 rounded-full border border-cyan-100/70 bg-slate-950 shadow-[inset_-6px_0_0_rgba(255,255,255,0.75)]" />
        </span>
        <span>
          <span className="block text-xs uppercase tracking-[0.38em] text-cyan-100/50">Moonlit</span>
          <span className="block text-2xl font-semibold tracking-[-0.04em] text-white">Diary Vault</span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <SyncBadge state={syncState} />
        <button type="button" onClick={onHome} className={cn("nav-button", currentScreen === "home" && "bg-white/10 text-white")}>
          Calendar
        </button>
        <button type="button" onClick={onAIScreen} className={cn("nav-button relative overflow-hidden group", currentScreen === "ai" && "bg-cyan-500/10 border-cyan-400/30 text-cyan-200")}>
          <span className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 to-fuchsia-500/10 opacity-50" />
          <span className="relative flex items-center gap-1">✨ AI Hub</span>
        </button>
        <button type="button" onClick={onYear} className={cn("nav-button", currentScreen === "year" && "bg-white/10 text-white")}>
          Year in pixels
        </button>
        <button type="button" onClick={onNewEntry} className="nav-button-primary">
          New entry
        </button>
        <button type="button" onClick={onSync} className="nav-button">
          Sync
        </button>
        <button type="button" onClick={onLock} className="nav-button text-rose-300/80 hover:bg-rose-500/10">
          Lock
        </button>
      </div>
    </header>
  );
}

function SyncBadge({ state }: { state: SyncState }) {
  const labelByState: Record<SyncState, string> = {
    locked: "Locked",
    loading: "Loading",
    ready: "Ready",
    saving: "Saving",
    saved: "Saved",
    error: "Needs attention",
  };

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium uppercase tracking-[0.22em] text-slate-300">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          state === "error" ? "bg-rose-400" : "bg-cyan-300",
          state === "loading" || state === "saving" ? "animate-pulse" : "",
        )}
      />
      {labelByState[state]}
    </span>
  );
}

function HomeView({
  entryByDate,
  selectedDate,
  visibleMonth,
  onSelectDate,
  onVisibleMonthChange,
  onOpenEntry,
}: {
  entryByDate: Map<string, DiaryEntry>;
  selectedDate: string;
  visibleMonth: Date;
  onSelectDate: (dateKey: string) => void;
  onVisibleMonthChange: (date: Date) => void;
  onOpenEntry: (dateKey: string) => void;
}) {
  const selectedEntry = entryByDate.get(selectedDate);
  const monthEntries = [...entryByDate.values()].filter((entry) => {
    const date = keyToDate(entry.date);
    return date.getFullYear() === visibleMonth.getFullYear() && date.getMonth() === visibleMonth.getMonth();
  });
  const monthLabel = new Intl.DateTimeFormat("en", { month: "long" }).format(visibleMonth);
  const yearLabel = visibleMonth.getFullYear();

  // Check if there's a draft for the selected date
  const hasDraft = useMemo(() => {
    const draft = loadDraft(selectedDate);
    return draft !== null && (
      draft.title.trim() || 
      draft.bodyHtml.trim() || 
      draft.dailyWin.trim() ||
      draft.attachments.length > 0
    );
  }, [selectedDate]);

  // Dynamic tag compiler for current highlighted entry
  const entryTags = useMemo(() => {
    if (!selectedEntry) return [];
    return extractTopicsAndTags(selectedEntry.bodyHtml, selectedEntry.title);
  }, [selectedEntry]);

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="animate-screen-in rounded-[2rem] border border-white/10 bg-slate-950/60 p-4 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <p className="text-sm uppercase tracking-[0.5em] text-cyan-200/50">Monthly calendar</p>
            <div>
              <h1 className="text-5xl font-semibold tracking-[-0.07em] text-white sm:text-7xl">{monthLabel}</h1>
              <p className="mt-1 text-xl text-slate-400">{yearLabel}</p>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-slate-400">
              Pick a day, write your entry, and the calendar marks it with the saved mood color.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, -1))}
              className="round-button"
              aria-label="Previous month"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => onVisibleMonthChange(keyToDate(dateToKey(new Date())))}
              className="round-button"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => onVisibleMonthChange(addMonths(visibleMonth, 1))}
              className="round-button"
              aria-label="Next month"
            >
              Next
            </button>
          </div>
        </div>

        <MonthlyCalendar
          visibleMonth={visibleMonth}
          selectedDate={selectedDate}
          entryByDate={entryByDate}
          onSelectDate={(dateKey) => {
            onSelectDate(dateKey);
            const date = keyToDate(dateKey);
            if (date.getMonth() !== visibleMonth.getMonth() || date.getFullYear() !== visibleMonth.getFullYear()) {
              onVisibleMonthChange(date);
            }
          }}
          onOpenEntry={onOpenEntry}
        />
      </div>

      <aside className="animate-float-in space-y-4">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Selected day</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">{formatDateLong(selectedDate)}</h2>

          {selectedEntry ? (
            <div className="mt-5 space-y-4">
              <div className="flex flex-wrap gap-2 items-center">
                <MoodChip mood={selectedEntry.mood} />
                <span className="text-xs px-2.5 py-1 rounded-full bg-cyan-500/10 text-cyan-300/90 border border-cyan-400/20">
                  {detectSentimentLabel(selectedEntry.bodyHtml)}
                </span>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Title</p>
                <p className="mt-2 text-xl font-semibold text-white">{selectedEntry.title}</p>
              </div>
              
              {entryTags.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-slate-500 mb-1.5">Auto Tags</p>
                  <div className="flex flex-wrap gap-1">
                    {entryTags.map(t => (
                      <span key={t} className="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-slate-300">
                        {t.startsWith("#") ? t : `#${t}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Daily win</p>
                <p className="mt-2 leading-6 text-slate-300">{selectedEntry.dailyWin || "No daily win added yet."}</p>
              </div>
              <p className="line-clamp-4 text-sm leading-6 text-slate-400">{htmlToText(selectedEntry.bodyHtml) || "Entry body is empty."}</p>
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-400">
                <span>{selectedEntry.attachments.length} attachment{selectedEntry.attachments.length === 1 ? "" : "s"}</span>
                <span>{formatBytes(totalAttachmentBytes(selectedEntry.attachments))}</span>
              </div>
            </div>
          ) : hasDraft ? (
            <div className="mt-5 space-y-4">
              <div className="rounded-3xl border border-amber-300/20 bg-amber-500/10 p-4">
                <p className="text-sm text-amber-100/90 flex items-center gap-2">
                  <span className="text-amber-300">📝</span>
                  You have an unsaved draft for this day
                </p>
              </div>
              <button type="button" onClick={() => onOpenEntry(selectedDate)} className="mt-2 w-full nav-button-primary justify-center py-4 bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-amber-400/30 hover:from-amber-500/30 hover:to-orange-500/30">
                Continue Editing Draft
              </button>
            </div>
          ) : (
            <div className="mt-5 rounded-3xl border border-dashed border-white/15 bg-black/20 p-5 text-sm leading-6 text-slate-400">
              No entry yet. Make this day visible in your calendar by saving a mood and a few lines.
            </div>
          )}

          <button type="button" onClick={() => onOpenEntry(selectedDate)} className="mt-5 w-full nav-button-primary justify-center py-4">
            {selectedEntry ? "Edit entry" : hasDraft ? "Continue draft" : "Write entry"}
          </button>
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">This month</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-white">{monthEntries.length}</p>
            </div>
            <p className="max-w-[10rem] text-right text-sm leading-6 text-slate-400">written day{monthEntries.length === 1 ? "" : "s"} saved to GitHub</p>
          </div>
        </section>

        <MoodLegend />
      </aside>
    </section>
  );
}

function MonthlyCalendar({
  visibleMonth,
  selectedDate,
  entryByDate,
  onSelectDate,
  onOpenEntry,
}: {
  visibleMonth: Date;
  selectedDate: string;
  entryByDate: Map<string, DiaryEntry>;
  onSelectDate: (dateKey: string) => void;
  onOpenEntry: (dateKey: string) => void;
}) {
  const cells = buildMonthCells(visibleMonth);
  const todayKey = dateToKey(new Date());

  return (
    <div className="mt-8">
      <div className="grid grid-cols-7 gap-2 px-1 text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 sm:gap-3">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-7 gap-2 sm:gap-3">
        {cells.map((cell) => {
          const entry = entryByDate.get(cell.dateKey);
          const mood = entry ? MOOD_BY_ID[entry.mood] : null;
          const isSelected = cell.dateKey === selectedDate;
          const isToday = cell.dateKey === todayKey;
          const hasDraft = !entry && loadDraft(cell.dateKey) !== null;

          return (
            <button
              key={cell.dateKey}
              type="button"
              onClick={() => onSelectDate(cell.dateKey)}
              onDoubleClick={() => onOpenEntry(cell.dateKey)}
              className={cn(
                "group relative aspect-square overflow-hidden rounded-[1.35rem] border text-left transition duration-300",
                cell.inCurrentMonth ? "border-white/10 bg-white/[0.035] hover:bg-white/[0.07]" : "border-white/[0.04] bg-white/[0.015] text-slate-600",
                isSelected ? "scale-[1.02] border-cyan-200/70 bg-cyan-100/10 shadow-[0_0_40px_rgba(34,211,238,0.18)]" : "",
                isToday ? "ring-1 ring-fuchsia-200/40" : "",
              )}
              style={isSelected && mood ? { boxShadow: `0 0 44px ${mood.glow}` } : undefined}
            >
              <span className="absolute inset-x-3 top-3 flex items-center justify-between">
                <span className={cn("text-lg font-medium", cell.inCurrentMonth ? "text-slate-200" : "text-slate-600")}>{cell.day}</span>
                {isToday ? <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300 shadow-[0_0_12px_rgba(244,114,182,0.9)]" /> : null}
              </span>

              {entry ? (
                <span
                  className="absolute bottom-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full transition duration-300 group-hover:scale-150"
                  style={{ backgroundColor: mood?.color, boxShadow: `0 0 18px ${mood?.glow}` }}
                />
              ) : hasDraft ? (
                <span
                  className="absolute bottom-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.5)] transition duration-300 group-hover:scale-150 animate-pulse"
                  title="Unsaved draft"
                />
              ) : null}

              {entry ? (
                <span
                  className="absolute inset-x-3 bottom-8 hidden truncate text-xs text-slate-400 opacity-0 transition group-hover:block group-hover:opacity-100 lg:block"
                  title={entry.title}
                >
                  {entry.title}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EntryEditor({
  dateKey,
  entry,
  entryByDate,
  syncState,
  onBack,
  onSave,
  onDelete,
  onOpenLightbox,
}: {
  dateKey: string;
  entry?: DiaryEntry;
  entryByDate: Map<string, DiaryEntry>;
  syncState: SyncState;
  onBack: () => void;
  onSave: (entry: DiaryEntry) => Promise<void>;
  onDelete: (dateKey: string) => Promise<void>;
  onOpenLightbox: (attachments: Attachment[], startIndex: number) => void;
}) {
  // Load existing draft or use entry data
  const existingDraft = useMemo(() => loadDraft(dateKey), [dateKey]);
  
  const [title, setTitle] = useState(existingDraft?.title ?? entry?.title ?? "");
  const [mood, setMood] = useState<MoodId>(existingDraft?.mood ?? entry?.mood ?? "happy");
  const [bodyHtml, setBodyHtml] = useState(existingDraft?.bodyHtml ?? entry?.bodyHtml ?? "");
  const [dailyWin, setDailyWin] = useState(existingDraft?.dailyWin ?? entry?.dailyWin ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(existingDraft?.attachments ?? entry?.attachments ?? []);
  const [localError, setLocalError] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [aiPrompt, setAIPrompt] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedDraft, setLastSavedDraft] = useState<string>("");
  
  const isSaving = syncState === "saving" || isWorking;
  const activeMood = MOOD_BY_ID[mood];
  const autoSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const computedTags = useMemo(() => {
    return extractTopicsAndTags(bodyHtml, title);
  }, [bodyHtml, title]);

  // Track if we have unsaved changes compared to last draft save
  const currentDraftState = JSON.stringify({ title, mood, bodyHtml, dailyWin, attachments });
  
  useEffect(() => {
    setHasUnsavedChanges(currentDraftState !== lastSavedDraft);
  }, [currentDraftState, lastSavedDraft]);

  // Initialize lastSavedDraft when existing draft or entry is loaded
  useEffect(() => {
    const initialState = JSON.stringify({ title, mood, bodyHtml, dailyWin, attachments });
    setLastSavedDraft(initialState);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save draft to localStorage every second when there are changes
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    
    autoSaveIntervalRef.current = setTimeout(() => {
      const draft: DraftEntry = {
        dateKey,
        title,
        mood,
        bodyHtml,
        dailyWin,
        attachments,
        savedAt: new Date().toISOString(),
      };
      saveDraft(draft);
      setLastSavedDraft(currentDraftState);
      setHasUnsavedChanges(false);
    }, 1000);

    return () => {
      if (autoSaveIntervalRef.current) {
        clearTimeout(autoSaveIntervalRef.current);
      }
    };
  }, [dateKey, title, mood, bodyHtml, dailyWin, attachments, hasUnsavedChanges, currentDraftState]);

  // FIXED STEP 4 LOGIC: Replaced local template mocks with real dynamic Llama 3 contextual generations
  async function triggerAIPrompt() {
    setAIPrompt("Consulting your timeline memory...");
    try {
      const allEntries = Array.from(entryByDate.values());
      const customQuestion = await generateAICustomQuestion(allEntries);
      setAIPrompt(customQuestion);
    } catch (err) {
      setAIPrompt("What's on your mind today? Tell me how your day went.");
    }
  }

  async function handleSave() {
    setLocalError("");
    setIsWorking(true);

    try {
      const now = new Date().toISOString();
      const nextEntry: DiaryEntry = {
        id: entry?.id ?? createId(),
        date: dateKey,
        title: title.trim() || "Untitled entry",
        mood,
        bodyHtml: sanitizeHtml(bodyHtml).trim(),
        dailyWin: dailyWin.trim(),
        attachments,
        createdAt: entry?.createdAt ?? now,
        updatedAt: now,
      };

      await onSave(nextEntry);
    } catch (error) {
      setLocalError(getErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleDelete() {
    if (!entry) return;
    const confirmed = window.confirm("Delete this diary entry from the GitHub vault file?");
    if (!confirmed) return;

    setLocalError("");
    setIsWorking(true);
    try {
      await onDelete(dateKey);
    } catch (error) {
      setLocalError(getErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  // Warn user before navigating away with unsaved changes
  const handleBack = useCallback(() => {
    // Save draft immediately before going back
    if (title.trim() || bodyHtml.trim() || dailyWin.trim() || attachments.length > 0) {
      const draft: DraftEntry = {
        dateKey,
        title,
        mood,
        bodyHtml,
        dailyWin,
        attachments,
        savedAt: new Date().toISOString(),
      };
      saveDraft(draft);
    }
    onBack();
  }, [dateKey, title, mood, bodyHtml, dailyWin, attachments, onBack]);

  return (
    <section className="grid animate-screen-in gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-[2rem] border border-white/10 bg-slate-950/65 p-4 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={handleBack} className="round-button w-fit">
            Back to calendar
          </button>
          <div className="flex items-center gap-2">
            {entry ? (
              <button type="button" onClick={handleDelete} disabled={isSaving} className="danger-button">
                Delete
              </button>
            ) : null}
            <button type="button" onClick={handleSave} disabled={isSaving} className="nav-button-primary py-3">
              {isSaving ? "Saving..." : "Save entry"}
            </button>
          </div>
        </div>

        {/* Auto-save indicator */}
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          {hasUnsavedChanges ? (
            <span className="flex items-center gap-1.5 text-amber-400/70">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              Draft auto-saving...
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/50" />
              Draft saved
            </span>
          )}
        </div>

        {/* AI Prompt Journaling Assistant Panel widget */}
        <div className="mt-4 rounded-2xl border border-cyan-500/10 bg-gradient-to-r from-cyan-950/20 to-fuchsia-950/20 p-4 relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 text-xs text-cyan-400/40 pointer-events-none font-mono">ASSISTANT v1.1</div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-semibold tracking-wide text-cyan-200">Privacy-First AI Writing Assistant</h4>
              <p className="text-xs text-slate-400 mt-0.5">Stuck with writer's block? Tap to construct a dynamic, personalized question reflection.</p>
            </div>
            <button 
              type="button" 
              onClick={triggerAIPrompt} 
              className="px-3 py-1.5 rounded-xl bg-cyan-400 text-slate-950 font-medium text-xs hover:bg-cyan-300 shadow transition shrink-0"
            >
              Generate Prompt
            </button>
          </div>
          {aiPrompt && (
            <div className="mt-3 bg-black/40 rounded-xl p-3 border border-white/5 animate-fade-in text-sm text-slate-200 italic leading-relaxed">
              "{aiPrompt}"
            </div>
          )}
        </div>

        <div className="mt-6 space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <MoodChip mood={mood} />
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-sm text-slate-400">{formatDateLong(dateKey)}</span>
            <span className="text-xs text-cyan-300/70 bg-cyan-500/5 px-3 py-1 rounded-full border border-cyan-500/10">
              AI Assessment: {detectSentimentLabel(bodyHtml)}
            </span>
          </div>

          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Give today a title"
            className="w-full border-none bg-transparent text-4xl font-semibold tracking-[-0.06em] text-white outline-none placeholder:text-slate-700 sm:text-6xl"
          />

          <RichTextEditor value={bodyHtml} onChange={setBodyHtml} />

          {/* Extracted Topic clouds list display area */}
          {computedTags.length > 0 && (
            <div className="pt-2">
              <span className="text-xs uppercase tracking-widest text-slate-500 block mb-2">Auto-Attached Topics & Clouds</span>
              <div className="flex flex-wrap gap-1.5">
                {computedTags.map(tag => (
                  <span key={tag} className="text-xs px-3 py-1 rounded-full bg-white/[0.04] border border-white/10 text-cyan-200/90">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {localError ? <SyncError message={localError} compact /> : null}
      </div>

      <aside className="space-y-4">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood</p>
          <p className="mt-3 text-sm leading-6 text-slate-400">Pick the color that will light up this day in the calendar and year view.</p>
          <div className="mt-5 grid gap-2">
            {MOODS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMood(item.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition duration-300",
                  item.id === mood ? "border-white/30 bg-white/[0.09]" : "border-white/10 bg-black/20 hover:bg-white/[0.055]",
                )}
              >
                <span className="h-4 w-4 rounded-full" style={{ backgroundColor: item.color, boxShadow: `0 0 18px ${item.glow}` }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-white">{item.label}</span>
                  <span className="block truncate text-xs text-slate-500">{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-2xl" style={{ boxShadow: `0 0 38px ${activeMood.glow}` }}>
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Daily win</p>
          <textarea
            value={dailyWin}
            onChange={(event) => setDailyWin(event.target.value)}
            placeholder="One small productive thing, lesson, or gain from today..."
            rows={5}
            className="mt-4 min-h-36 w-full resize-none rounded-3xl border border-white/10 bg-black/25 p-4 text-sm leading-6 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/50 focus:bg-black/35"
          />
        </section>

        <AttachmentPanel attachments={attachments} onChange={setAttachments} onOpenLightbox={onOpenLightbox} />
      </aside>
    </section>
  );
}

function RichTextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, [value]);

  function runCommand(command: string, commandValue?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, commandValue);
    onChange(editorRef.current?.innerHTML ?? "");
  }

  function addLink() {
    const url = window.prompt("Paste the link URL");
    if (!url) return;
    runCommand("createLink", url);
  }

  return (
    <div className="overflow-hidden rounded-[1.6rem] border border-white/10 bg-black/25">
      <div className="flex flex-wrap gap-2 border-b border-white/10 bg-white/[0.035] p-3">
        <ToolbarButton label="P" onClick={() => runCommand("formatBlock", "P")} />
        <ToolbarButton label="H1" onClick={() => runCommand("formatBlock", "H1")} />
        <ToolbarButton label="H2" onClick={() => runCommand("formatBlock", "H2")} />
        <ToolbarButton label="B" onClick={() => runCommand("bold")} strong />
        <ToolbarButton label="I" onClick={() => runCommand("italic")} italic />
        <ToolbarButton label="U" onClick={() => runCommand("underline")} underline />
        <ToolbarButton label="List" onClick={() => runCommand("insertUnorderedList")} />
        <ToolbarButton label="Number" onClick={() => runCommand("insertOrderedList")} />
        <ToolbarButton label="Quote" onClick={() => runCommand("formatBlock", "BLOCKQUOTE")} />
        <ToolbarButton label="Link" onClick={addLink} />
        <ToolbarButton label="Clear" onClick={() => runCommand("removeFormat")} />
      </div>

      <div className="relative">
        {!htmlToText(value) && !isFocused ? (
          <div className="pointer-events-none absolute left-5 top-5 text-slate-600">Start writing what happened today...</div>
        ) : null}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={() => onChange(editorRef.current?.innerHTML ?? "")}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          className="diary-prose min-h-[24rem] px-5 py-5 text-base leading-8 text-slate-200 outline-none sm:min-h-[30rem]"
        />
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  strong,
  italic,
  underline,
}: {
  label: string;
  onClick: () => void;
  strong?: boolean;
  italic?: boolean;
  underline?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      className={cn(
        "rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-200/40 hover:bg-cyan-200/10 hover:text-white",
        strong ? "font-black" : "",
        italic ? "italic" : "",
        underline ? "underline" : "",
      )}
    >
      {label}
    </button>
  );
}

function AttachmentPanel({ attachments, onChange, onOpenLightbox }: { attachments: Attachment[]; onChange: (attachments: Attachment[]) => void; onOpenLightbox: (attachments: Attachment[], startIndex: number) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState("");
  const totalBytes = totalAttachmentBytes(attachments);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    setError("");

    // Validate file sizes (500MB limit per file)
    const oversizedFiles: string[] = [];
    Array.from(files).forEach(file => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        oversizedFiles.push(`${file.name} (${formatBytes(file.size)})`);
      }
    });

    if (oversizedFiles.length > 0) {
      setError(`These files exceed the 500MB limit: ${oversizedFiles.join(", ")}`);
      event.target.value = "";
      return;
    }

    setIsLoading(true);
    setLoadingProgress("Preparing to load files...");

    try {
      const nextAttachments = await filesToAttachments(files, (progress) => {
        setLoadingProgress(progress);
      });
      onChange([...attachments, ...nextAttachments]);
    } catch (readError) {
      setError(getErrorMessage(readError));
    } finally {
      setIsLoading(false);
      setLoadingProgress("");
      event.target.value = "";
    }
  }

  return (
    <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
      <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleFileChange} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Attachments</p>
          <p className="mt-3 text-sm leading-6 text-slate-400">Attach photos or videos. Click media to view fullscreen. For reliable GitHub saves, keep total under ~75MB (base64 adds overhead).</p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={isLoading} className="round-button shrink-0">
          {isLoading ? "Loading..." : "Add"}
        </button>
      </div>

      {loadingProgress && (
        <div className="mt-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-200/80 animate-pulse">
          {loadingProgress}
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-400">
        {attachments.length} file{attachments.length === 1 ? "" : "s"} / {formatBytes(totalBytes)}
      </div>

      {totalBytes > 50 * 1024 * 1024 ? (
        <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100/80">
          ⚠️ GitHub API has a ~100MB limit per file after base64 encoding. Files over ~75MB raw (or 500MB total) may fail to save.
          {totalBytes > 75 * 1024 * 1024 ? (
            <strong className="block mt-1 text-rose-300">
              ⚠️ Current attachments total {formatBytes(totalBytes)} which may cause GitHub save errors (HTTP 500). Consider removing larger videos.
            </strong>
          ) : null}
        </p>
      ) : null}

      {error ? <SyncError message={error} compact /> : null}

      <div className="mt-4 grid gap-3">
        {attachments.map((attachment, idx) => (
          <div key={attachment.id} className="overflow-hidden rounded-3xl border border-white/10 bg-black/25">
            <button
              type="button"
              onClick={() => onOpenLightbox(attachments, idx)}
              className="block w-full aspect-video bg-slate-900 relative group cursor-zoom-in"
            >
              {attachment.type.startsWith("image/") ? (
                <img src={attachment.dataUrl} alt={attachment.name} className="h-full w-full object-cover transition group-hover:opacity-80" />
              ) : (
                <video src={attachment.dataUrl} className="h-full w-full object-cover" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition opacity-0 group-hover:opacity-100">
                <span className="bg-black/70 backdrop-blur px-3 py-1.5 rounded-full text-xs text-white font-medium">
                  Click to view fullscreen
                </span>
              </span>
            </button>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{attachment.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(attachment.size)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={attachment.dataUrl}
                  download={attachment.name}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 transition hover:border-rose-300/40 hover:bg-rose-400/10 hover:text-rose-100"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function YearPixelsView({
  year,
  entryByDate,
  onYearChange,
  onBack,
  onOpenEntry,
}: {
  year: number;
  entryByDate: Map<string, DiaryEntry>;
  onYearChange: (year: number) => void;
  onBack: () => void;
  onOpenEntry: (dateKey: string) => void;
}) {
  const months = useMemo(() => Array.from({ length: 12 }, (_, monthIndex) => new Date(year, monthIndex, 1)), [year]);
  const writtenDays = [...entryByDate.values()].filter((entry) => keyToDate(entry.date).getFullYear() === year).length;

  return (
    <section className="animate-screen-in space-y-5">
      <div className="rounded-[2rem] border border-white/10 bg-slate-950/65 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <p className="text-sm uppercase tracking-[0.5em] text-fuchsia-200/50">Year in pixels</p>
            <h1 className="text-6xl font-semibold tracking-[-0.08em] text-white sm:text-8xl">{year}</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-400">
              Every dot is a day. Saved entries glow with the mood you chose, so the year becomes a private emotional map.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onBack} className="round-button">
              Back
            </button>
            <button type="button" onClick={() => onYearChange(year - 1)} className="round-button">
              Prev year
            </button>
            <button type="button" onClick={() => onYearChange(new Date().getFullYear())} className="round-button">
              This year
            </button>
            <button type="button" onClick={() => onYearChange(year + 1)} className="round-button">
              Next year
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-4 py-2">{writtenDays} written day{writtenDays === 1 ? "" : "s"}</span>
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-4 py-2">Click any pixel to open that date</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {months.map((monthDate) => (
          <MonthPixelPanel key={monthDate.toISOString()} monthDate={monthDate} entryByDate={entryByDate} onOpenEntry={onOpenEntry} />
        ))}
      </div>

      <MoodLegend />
    </section>
  );
}

function MonthPixelPanel({
  monthDate,
  entryByDate,
  onOpenEntry,
}: {
  monthDate: Date;
  entryByDate: Map<string, DiaryEntry>;
  onOpenEntry: (dateKey: string) => void;
}) {
  const monthName = new Intl.DateTimeFormat("en", { month: "long" }).format(monthDate);
  const cells = buildMonthCells(monthDate);

  return (
    <section className="rounded-[1.7rem] border border-white/10 bg-white/[0.035] p-4 backdrop-blur-2xl transition duration-300 hover:bg-white/[0.055]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{monthName}</h2>
        <span className="text-xs text-slate-500">{monthDate.getFullYear()}</span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {cells.map((cell) => {
          const entry = entryByDate.get(cell.dateKey);
          const mood = entry ? MOOD_BY_ID[entry.mood] : null;
          return (
            <button
              key={cell.dateKey}
              type="button"
              onClick={() => onOpenEntry(cell.dateKey)}
              title={`${formatDateLong(cell.dateKey)}${entry ? ` - ${entry.title}` : ""}`}
              className={cn(
                "aspect-square rounded-full transition duration-300 hover:scale-150 hover:ring-2 hover:ring-cyan-100/60",
                cell.inCurrentMonth ? "opacity-100" : "opacity-20",
              )}
              style={{
                backgroundColor: mood?.color ?? "rgba(148, 163, 184, 0.2)",
                boxShadow: mood ? `0 0 16px ${mood.glow}` : "none",
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

/* ==========================================================================
   AI INTELLIGENCE VIEW: SEMANTIC SEARCH WITH CLICKABLE DATES
   ========================================================================== */
function AIIntelligenceView({
  entries,
  initialTagFilter,
  onJumpToEntry,
}: {
  entries: DiaryEntry[];
  initialTagFilter: string | null;
  onJumpToEntry: (dateKey: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(initialTagFilter);
  
  // States for AI response with clickable dates
  const [aiAnswer, setAiAnswer] = useState("");
  const [isSearchingAI, setIsSearchingAI] = useState(false);

  const globalTopicCloud = useMemo(() => {
    const frequencyMap: Record<string, number> = {};
    entries.forEach((item) => {
      const extracted = extractTopicsAndTags(item.bodyHtml, item.title);
      extracted.forEach((t) => {
        frequencyMap[t] = (frequencyMap[t] || 0) + 1;
      });
    });
    return Object.entries(frequencyMap)
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count);
  }, [entries]);

  const expandedTerms = useMemo(() => {
    const queries = searchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (queries.length === 0) return [];
    
    const terms = [...queries];
    queries.forEach(q => {
      if (SEMANTIC_DICTIONARY[q]) {
        terms.push(...SEMANTIC_DICTIONARY[q]);
      }
      Object.entries(SEMANTIC_DICTIONARY).forEach(([key, synonyms]) => {
        if (synonyms.includes(q) && !terms.includes(key)) {
          terms.push(key);
        }
      });
    });
    return Array.from(new Set(terms));
  }, [searchQuery]);

  const filteredEntries = useMemo(() => {
    return entries.filter((item) => {
      const bodyClean = htmlToText(item.bodyHtml).toLowerCase();
      const titleClean = item.title.toLowerCase();
      const dateString = item.date;

      if (activeTag) {
        const itemTags = extractTopicsAndTags(item.bodyHtml, item.title);
        if (!itemTags.includes(activeTag)) return false;
      }

      if (expandedTerms.length > 0) {
        return expandedTerms.some(
          (term) =>
            bodyClean.includes(term) ||
            titleClean.includes(term) ||
            dateString.includes(term)
        );
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [entries, expandedTerms, activeTag]);

  const emotionalDistribution = useMemo(() => {
    const tallies: Record<MoodId, number> = { happy: 0, depressed: 0, sleepy: 0, angry: 0, romantic: 0, crazy: 0 };
    entries.forEach((e) => {
      if (tallies[e.mood] !== undefined) tallies[e.mood]++;
    });
    return tallies;
  }, [entries]);

  const maxDistributionCount = Math.max(...Object.values(emotionalDistribution), 1);

  // EXECUTION FUNCTION: Sends search query + journal history directly to the Llama 3 processor
  async function handleAISubmit(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearchingAI(true);
    setAiAnswer("Thinking through your timeline memory...");
    try {
      const response = await smartAISearch(searchQuery, entries);
      setAiAnswer(response);
    } catch (err) {
      setAiAnswer("Error analyzing diary entries. Ensure VITE_GROQ_API_KEY is configured in GitHub.");
    } finally {
      setIsSearchingAI(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] animate-screen-in">
      <div className="rounded-[2rem] border border-white/10 bg-slate-950/60 p-4 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6 space-y-6">
        
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.5em] text-cyan-200/50">Semantic Intelligence</p>
          <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Vault Search & Deep Analytics</h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Type natural questions or timeline queries. Hit the **Ask AI Brain** button to prompt Llama 3 to traverse dates and language gaps natively. Dates in AI responses are clickable!
          </p>
        </div>

        {/* Input box form element overlay wrapper */}
        <form onSubmit={handleAISubmit} className="relative rounded-2xl border border-white/10 bg-black/40 px-4 py-3 flex items-center gap-3 shadow-inner focus-within:border-cyan-400/50 transition">
          <span className="text-xl text-slate-500">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder='Try asking "When did I go to the beach?" or "entries mentioning Alex"...'
            className="w-full bg-transparent outline-none border-none text-slate-100 placeholder:text-slate-600 text-base pr-2"
          />
          {searchQuery && (
            <button type="button" onClick={() => { setSearchQuery(""); setAiAnswer(""); }} className="text-xs text-slate-500 hover:text-white px-1">
              Clear
            </button>
          )}
          <button
            type="submit"
            disabled={isSearchingAI || !searchQuery.trim()}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-fuchsia-600 text-white font-medium text-xs hover:opacity-90 transition shrink-0 disabled:opacity-40"
          >
            {isSearchingAI ? "Thinking..." : "Ask AI Brain"}
          </button>
        </form>

        {/* Dynamic expansion status indicators */}
        {expandedTerms.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center text-xs text-slate-400 bg-white/[0.02] p-2.5 rounded-xl border border-white/5">
            <span className="text-cyan-400/70 font-mono">Concept expansion matches:</span>
            {expandedTerms.map((t) => (
              <span key={t} className="px-2 py-0.5 rounded bg-cyan-950/40 border border-cyan-800/30 text-cyan-300">
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Selected tag constraint badge overlay */}
        {activeTag && (
          <div className="flex items-center justify-between bg-fuchsia-950/20 border border-fuchsia-500/20 px-4 py-2 rounded-xl text-sm text-fuchsia-200">
            <span>Filtering workspace to only entries matching topic: <strong>#{activeTag}</strong></span>
            <button type="button" onClick={() => setActiveTag(null)} className="text-xs uppercase tracking-wider underline hover:text-white">
              Remove Filter
            </button>
          </div>
        )}

        {/* REASONED AI RESPONSE BLOCK: Renders summary card with CLICKABLE DATES */}
        {aiAnswer && (
          <div className="p-5 rounded-2xl border border-fuchsia-500/20 bg-gradient-to-br from-cyan-950/30 to-fuchsia-950/30 shadow-xl backdrop-blur-xl animate-fade-in">
            <h4 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-2 flex items-center gap-2">
              <span>AI Cognitive Brain Conclusion</span>
              <span className="text-cyan-400/50 text-[10px]">(Click any date to jump to that entry)</span>
            </h4>
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap font-sans">
              <AIResponseRenderer text={aiAnswer} onDateClick={onJumpToEntry} />
            </p>
          </div>
        )}

        {/* Filter Output List Area */}
        <div className="space-y-3">
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <h3 className="text-xs uppercase tracking-[0.2em] text-slate-400 font-semibold">Matched Entries Output ({filteredEntries.length})</h3>
            <span className="text-xs text-slate-600">Click entry row to jump instantly to document layout editor</span>
          </div>

          {filteredEntries.length > 0 ? (
            <div className="space-y-2.5 max-h-[32rem] overflow-y-auto pr-1">
              {filteredEntries.map((item) => {
                const option = MOOD_BY_ID[item.mood];
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onJumpToEntry(item.date)}
                    className="w-full text-left flex items-center justify-between gap-4 p-4 rounded-2xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] hover:border-cyan-400/30 transition duration-200 group"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono tracking-wider text-cyan-300/80 bg-cyan-950/40 border border-cyan-900/50 px-2 py-0.5 rounded">
                          {item.date}
                        </span>
                        <h4 className="font-medium text-white truncate group-hover:text-cyan-200 transition">
                          {item.title}
                        </h4>
                      </div>
                      <p className="text-xs text-slate-400 truncate max-w-xl">
                        {htmlToText(item.bodyHtml)}
                      </p>
                    </div>
                    
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-500 hidden sm:inline">
                        {detectSentimentLabel(item.bodyHtml)}
                      </span>
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: option?.color, boxShadow: `0 0 12px ${option?.glow}` }} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-slate-500 text-sm">
              No entries found matching the given parameters. Try revising your text query strings or toggle active filter tags.
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-4 animate-float-in">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl space-y-4">
          <div className="flex items-center justify-between">
  <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood Graph</p>
  <span className="text-[10px] text-slate-500">{entries.length} entries</span>
</div>

          <div className="space-y-3 pt-2">
            {MOODS.map((m) => {
              const count = emotionalDistribution[m.id] || 0;
              const normalizedPct = (count / maxDistributionCount) * 100;
              return (
                <div key={m.id} className="space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-white font-medium flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
                      {m.label}
                    </span>
                    <span className="text-slate-500">{count} {count === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <div className="h-2 bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${normalizedPct}%`,
                        backgroundColor: m.color,
                        boxShadow: `0 0 10px ${m.glow}`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-fuchsia-200/50">Automatic Topic Cloud</p>
            <p className="text-xs text-slate-400 mt-1">Click a generated keyword bubble to lock filters to that specific cluster category theme.</p>
          </div>

          {globalTopicCloud.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {globalTopicCloud.map((tag) => (
                <button
                  key={tag.text}
                  type="button"
                  onClick={() => setActiveTag(activeTag === tag.text ? null : tag.text)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-xl border transition duration-150",
                    activeTag === tag.text
                      ? "bg-fuchsia-500/20 border-fuchsia-400 text-fuchsia-200 shadow"
                      : "bg-black/30 border-white/10 text-slate-300 hover:border-cyan-400/40 hover:bg-white/5"
                  )}
                >
                  #{tag.text} <span className="text-[10px] opacity-40 ml-0.5">({tag.count})</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 italic">Insufficient terminology mapped in entries to render cloud profiles yet.</p>
          )}
        </section>

        <MoodLegend />
      </aside>
    </div>
  );
}

function MoodLegend() {
  return (
    <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl">
      <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood colors</p>
      <div className="mt-4 grid gap-3">
        {MOODS.map((mood) => (
          <div key={mood.id} className="flex items-center gap-3 text-sm text-slate-300">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: mood.color, boxShadow: `0 0 16px ${mood.glow}` }} />
            <span className="font-medium text-white">{mood.label}</span>
            <span className="text-slate-500">{mood.description}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MoodChip({ mood }: { mood: MoodId }) {
  const option = MOOD_BY_ID[mood];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 py-2 text-sm text-slate-200">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: option.color, boxShadow: `0 0 16px ${option.glow}` }} />
      {option.label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-medium uppercase tracking-[0.24em] text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function SyncError({ message, compact }: { message: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-rose-300/20 bg-rose-500/10 text-sm leading-6 text-rose-100 shadow-2xl shadow-rose-950/20 backdrop-blur-xl",
        compact ? "mt-4 px-4 py-3" : "mb-5 px-5 py-4",
      )}
    >
      {message}
    </div>
  );
}

function AmbientBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="aurora-orb aurora-orb-a" />
      <div className="aurora-orb aurora-orb-b" />
      <div className="aurora-orb aurora-orb-c" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_32%),linear-gradient(180deg,rgba(2,3,10,0)_0%,rgba(2,3,10,0.72)_78%,#02030a_100%)]" />
      <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:72px_72px]" />
    </div>
  );
}

function createEmptyVault(): VaultData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

function loadStoredConfig(): GitHubConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<GitHubConfig>) };
  } catch {
    return null;
  }
}

function normalizeConfig(config: GitHubConfig): GitHubConfig {
  return {
    owner: config.owner.trim(),
    repo: config.repo.trim(),
    branch: config.branch.trim() || "main",
    path: config.path.trim().replace(/^\/+/, "") || DEFAULT_CONFIG.path,
    token: config.token.trim(),
  };
}

async function encryptVault(vault: VaultData, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(vault));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const file: EncryptedVaultFile = {
    kind: "moonlit-diary-encrypted-vault",
    version: 1,
    crypto: {
      name: "AES-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(new Uint8Array(encrypted)),
  };

  return JSON.stringify(file, null, 2);
}

async function openVaultFile(file: EncryptedVaultFile | VaultData, passphrase: string): Promise<VaultData> {
  if (isEncryptedVaultFile(file)) {
    const salt = base64ToBytes(file.crypto.salt);
    const iv = base64ToBytes(file.crypto.iv);
    const encrypted = base64ToBytes(file.payload);
    const key = await deriveVaultKey(passphrase, salt, file.crypto.iterations);

    try {
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
      return normalizeVault(JSON.parse(new TextDecoder().decode(decrypted)) as VaultData);
    } catch {
      throw new Error("Could not unlock the vault. Check your passphrase.");
    }
  }

  return normalizeVault(file);
}

function isEncryptedVaultFile(file: EncryptedVaultFile | VaultData): file is EncryptedVaultFile {
  return "kind" in file && file.kind === "moonlit-diary-encrypted-vault";
}

function normalizeVault(vault: VaultData): VaultData {
  return {
    version: 1,
    updatedAt: vault.updatedAt || new Date().toISOString(),
    entries: Array.isArray(vault.entries) ? vault.entries : [],
  };
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const saltBuffer = new Uint8Array(salt).buffer as ArrayBuffer;
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function fetchGitHubVaultFile(config: GitHubConfig): Promise<{ exists: boolean; sha: string | null; text: string }> {
  const response = await fetch(gitHubContentUrl(config), {
    headers: githubHeaders(config),
  });

  if (response.status === 404) {
    return { exists: false, sha: null, text: "" };
  }

  if (!response.ok) {
    throw new Error(await githubErrorMessage(response));
  }

  const data = (await response.json()) as { content?: string; encoding?: string; sha?: string; download_url?: string };
  if (data.content && data.encoding === "base64") {
    return { exists: true, sha: data.sha ?? null, text: base64ToString(data.content.replace(/\s/g, "")) };
  }

  if (data.download_url) {
    const rawResponse = await fetch(data.download_url, { headers: githubHeaders(config) });
    if (!rawResponse.ok) {
      throw new Error(await githubErrorMessage(rawResponse));
    }
    return { exists: true, sha: data.sha ?? null, text: await rawResponse.text() };
  }

  return { exists: true, sha: data.sha ?? null, text: "" };
}

async function putGitHubVaultFile(
  config: GitHubConfig,
  text: string,
  sha: string | null,
  message: string,
): Promise<{ sha: string | null }> {
  const body: { message: string; content: string; branch: string; sha?: string } = {
    message,
    content: stringToBase64(text),
    branch: config.branch,
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(gitHubContentUrl(config), {
    method: "PUT",
    headers: githubHeaders(config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await githubErrorMessage(response));
  }

  const data = (await response.json()) as { content?: { sha?: string } };
  return { sha: data.content?.sha ?? null };
}

function gitHubContentUrl(config: GitHubConfig) {
  const encodedPath = config.path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`;
}

function githubHeaders(config: GitHubConfig): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { message?: string };
    return `GitHub ${response.status}: ${data.message ?? response.statusText}`;
  } catch {
    return `GitHub ${response.status}: ${response.statusText}`;
  }
}

function stringToBase64(value: string) {
  return bytesToBase64(new TextEncoder().encode(value));
}

function base64ToString(value: string) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function dateToKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function keyToDate(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function extractTopicsAndTags(html: string, title: string): string[] {
  const combinedText = `${title} ${htmlToText(html)}`.toLowerCase();
  const foundTags = new Set<string>();

  const hashMatches = combinedText.match(/#\w+/g);
  if (hashMatches) {
    hashMatches.forEach((match) => foundTags.add(match.replace("#", "")));
  }

  if (combinedText.includes("alex")) foundTags.add("alex");
  if (combinedText.includes("beach") || combinedText.includes("ocean") || combinedText.includes("sea")) foundTags.add("beach");
  if (combinedText.includes("work") || combinedText.includes("project") || combinedText.includes("office")) foundTags.add("work");
  if (combinedText.includes("gym") || combinedText.includes("workout") || combinedText.includes("run")) foundTags.add("fitness");
  if (combinedText.includes("coding") || combinedText.includes("code") || combinedText.includes("app")) foundTags.add("dev");
  if (combinedText.includes("family") || combinedText.includes("home") || combinedText.includes("parents")) foundTags.add("family");

  return Array.from(foundTags);
}

function detectSentimentLabel(html: string): string {
  const plainText = htmlToText(html).toLowerCase();
  if (!plainText || plainText.length < 5) return "Neutral Focus";

  let positiveScore = 0;
  let heavyScore = 0;

  const positiveWords = ["happy", "glad", "awesome", "great", "excited", "love", "win", "good", "proud", "grateful"];
  const heavyWords = ["stressed", "tired", "sad", "depressed", "heavy", "overwhelmed", "anxious", "angry", "worry"];

  positiveWords.forEach(w => { if (plainText.includes(w)) positiveScore++; });
  heavyWords.forEach(w => { if (plainText.includes(w)) heavyScore++; });

  if (positiveScore > heavyScore) return "Energetic & Bright";
  if (heavyScore > positiveScore) return "Reflective & Introspective";
  return "Balanced Reflection";
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function formatDateLong(key: string) {
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(keyToDate(key));
}

function buildMonthCells(monthDate: Date) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    return {
      date,
      dateKey: dateToKey(date),
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === month,
    };
  });
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((node) => node.remove());

  const allowedTags = new Set(["A", "B", "BLOCKQUOTE", "BR", "DIV", "EM", "H1", "H2", "H3", "I", "LI", "OL", "P", "SPAN", "STRONG", "U", "UL"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element);
  }

  elements.forEach((element) => {
    if (!allowedTags.has(element.tagName)) {
      const wrapper = document.createElement("span");
      wrapper.innerHTML = element.innerHTML;
      element.replaceWith(...Array.from(wrapper.childNodes));
      return;
    }

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const isSafeLinkAttribute = element.tagName === "A" && ["href", "target", "rel"].includes(name);
      if (name.startsWith("on") || name === "style" || !isSafeLinkAttribute) {
        element.removeAttribute(attribute.name);
      }
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

function filesToAttachments(files: FileList, onProgress?: (progress: string) => void): Promise<Attachment[]> {
  const fileArray = Array.from(files);
  const totalSize = fileArray.reduce((sum, f) => sum + f.size, 0);
  
  // For large files, show progress
  if (totalSize > 10 * 1024 * 1024 && onProgress) {
    onProgress(`Loading ${fileArray.length} file(s)...`);
  }
  
  return Promise.all(
    fileArray.map(
      (file) =>
        new Promise<Attachment>((resolve, reject) => {
          if (file.size > MAX_FILE_SIZE_BYTES) {
            reject(new Error(`${file.name} exceeds the 500MB limit.`));
            return;
          }
          
          const reader = new FileReader();
          
          // Show progress for individual large files
          if (file.size > 50 * 1024 * 1024 && onProgress) {
            onProgress(`Loading ${file.name} (${formatBytes(file.size)})...`);
          }
          
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
        }),
    ),
  );
}

function LightboxViewer({
  attachments,
  currentIndex,
  onClose,
  onPrev,
  onNext,
}: {
  attachments: Attachment[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const currentAttachment = attachments[currentIndex];
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev();
      if (e.key === "ArrowRight") onNext();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrev, onNext]);

  // Cleanup body scroll lock when unmounting
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  function handleTouchStart(e: ReactTouchEvent) {
    touchStartX.current = e.changedTouches[0].screenX;
    touchEndX.current = null;
  }

  function handleTouchMove(e: ReactTouchEvent) {
    touchEndX.current = e.changedTouches[0].screenX;
  }

  function handleTouchEnd() {
    if (!touchStartX.current || !touchEndX.current) return;
    const diff = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50;

    if (Math.abs(diff) > minSwipeDistance) {
      if (diff > 0) {
        // Swiped left -> next
        onNext();
      } else {
        // Swiped right -> prev
        onPrev();
      }
    }
    touchStartX.current = null;
    touchEndX.current = null;
  }

  function downloadCurrent() {
    const link = document.createElement("a");
    link.href = currentAttachment.dataUrl;
    link.download = currentAttachment.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  if (!currentAttachment) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 px-4 py-2 text-white transition backdrop-blur-md"
        >
          <span className="text-lg leading-none">←</span>
          <span className="text-sm font-medium">Back</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-white/70 text-sm font-mono bg-black/40 px-3 py-1.5 rounded-full backdrop-blur-md">
            {currentIndex + 1} / {attachments.length}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadCurrent();
            }}
            className="flex items-center gap-2 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 px-4 py-2 text-cyan-100 transition backdrop-blur-md"
          >
            <span className="text-sm">⬇</span>
            <span className="text-sm font-medium">Download</span>
          </button>
        </div>
      </div>

      {/* Navigation arrows */}
      {attachments.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white text-2xl transition backdrop-blur-md md:h-14 md:w-14"
            aria-label="Previous"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white text-2xl transition backdrop-blur-md md:h-14 md:w-14"
            aria-label="Next"
          >
            ›
          </button>
        </>
      )}

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-0 right-0 z-10 text-center px-4">
        <p className="text-white/80 text-sm truncate max-w-2xl mx-auto bg-black/50 inline-block px-4 py-2 rounded-full backdrop-blur-md">
          {currentAttachment.name} <span className="text-white/50 ml-2 text-xs">({formatBytes(currentAttachment.size)})</span>
        </p>
      </div>

      {/* Media content */}
      <div
        className="relative max-w-[95vw] max-h-[80vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {currentAttachment.type.startsWith("image/") ? (
          <img
            src={currentAttachment.dataUrl}
            alt={currentAttachment.name}
            className="max-w-full max-h-[80vh] object-contain select-none"
            draggable={false}
          />
        ) : currentAttachment.type.startsWith("video/") ? (
          <video
            src={currentAttachment.dataUrl}
            controls
            autoPlay
            className="max-w-full max-h-[80vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="p-8 text-white/80 bg-white/10 rounded-2xl">
            <p className="text-center">Preview not available for this file type.</p>
            <p className="text-center text-sm mt-2 text-white/50">Use download button to save.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
