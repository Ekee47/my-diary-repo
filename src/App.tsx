import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode, useCallback, type TouchEvent as ReactTouchEvent } from "react";
import { cn } from "./utils/cn";
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

// Attachment: either local (held as File object + object URL for preview) or persisted in media repo
type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  addedAt: string;
  // NEW unsaved attachment - raw File kept in memory for fast upload, objectUrl for preview:
  file?: File;             // Raw File object (not serializable, lost on page reload)
  objectUrl?: string;      // URL.createObjectURL(file) - instant preview, revoked on cleanup
  // Fallback for old entries that stored base64 dataUrl:
  dataUrl?: string;
  // Saved to GitHub media repo:
  mediaUrl?: string;       // Direct load URL (raw GitHub URL or download_url)
  mediaPath?: string;      // API path within repo
  mediaSha?: string;       // Blob SHA for updates
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
  // Optional separate media repo (if blank, uses same main repo in a /media/ folder)
  mediaOwner: string;
  mediaRepo: string;
  mediaBranch: string;
  mediaPath: string; // e.g., "media" or "attachments"
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

type DraftEntry = {
  dateKey: string;
  title: string;
  mood: MoodId;
  bodyHtml: string;
  dailyWin: string;
  attachments: Attachment[];
  savedAt: string;
};

const CONFIG_STORAGE_KEY = "moonlit-diary-github-config-v2";
const DRAFT_STORAGE_KEY = "moonlit-diary-draft-v2";
const PBKDF2_ITERATIONS = 210_000;
const DEFAULT_CONFIG: GitHubConfig = {
  owner: "",
  repo: "",
  branch: "main",
  path: "data/moonlit-diary-vault.json",
  token: "",
  mediaOwner: "",
  mediaRepo: "",
  mediaBranch: "main",
  mediaPath: "media",
};

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB per file (we compress anyway)

const MOODS: MoodOption[] = [
  { id: "happy", label: "Happy", color: "#f8c74a", glow: "rgba(248, 199, 74, 0.42)", description: "Bright, grateful, energized" },
  { id: "depressed", label: "Depressed", color: "#5da8ff", glow: "rgba(93, 168, 255, 0.36)", description: "Heavy, quiet, low battery" },
  { id: "sleepy", label: "Sleepy", color: "#a78bfa", glow: "rgba(167, 139, 250, 0.4)", description: "Slow, soft, tired mind" },
  { id: "angry", label: "Angry", color: "#ff5b6c", glow: "rgba(255, 91, 108, 0.38)", description: "Hot, restless, intense" },
  { id: "romantic", label: "Romantic", color: "#ff7ac8", glow: "rgba(255, 122, 200, 0.42)", description: "Tender, dreamy, connected" },
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

function parseReadableDateToISO(readableDate: string): string | null {
  const clean = readableDate.toLowerCase().trim();
  const match = clean.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/);
  const simpleMatch = match || clean.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
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

export function AIResponseRenderer({ text, onDateClick }: AIResponseRendererProps) {
  const dateRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s+(\d{4})\b/gi;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = dateRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`t-${keyIndex++}`}>{text.slice(lastIndex, match.index)}</span>);
    }

    const rawReadableDate = match[0];
    const isoDate = parseReadableDateToISO(rawReadableDate);

    if (isoDate) {
      parts.push(
        <button
          key={`d-${keyIndex++}`}
          onClick={() => onDateClick(isoDate)}
          className="inline font-bold text-cyan-400 hover:text-cyan-300 hover:underline mx-0.5 cursor-pointer bg-transparent border-0 p-0 underline"
          style={{ color: '#22d3ee', fontWeight: 'bold' }}
          title={`Open entry for ${isoDate}`}
        >
          {rawReadableDate}
        </button>
      );
    } else {
      parts.push(<span key={`d-${keyIndex++}`}>{rawReadableDate}</span>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${keyIndex++}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts.length > 0 ? parts : text}</>;
}

function getMediaConfig(config: GitHubConfig): { owner: string; repo: string; branch: string; basePath: string } {
  return {
    owner: config.mediaOwner?.trim() || config.owner,
    repo: config.mediaRepo?.trim() || config.repo,
    branch: config.mediaBranch?.trim() || config.branch,
    basePath: (config.mediaPath?.trim() || "media").replace(/^\/+|\/+$/g, ""),
  };
}

function mediaRawUrlBase(config: GitHubConfig): string {
  const m = getMediaConfig(config);
  return `https://raw.githubusercontent.com/${encodeURIComponent(m.owner)}/${encodeURIComponent(m.repo)}/${encodeURIComponent(m.branch)}`;
}

function mediaApiUrl(config: GitHubConfig, filePath: string): string {
  const m = getMediaConfig(config);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(m.owner)}/${encodeURIComponent(m.repo)}/contents/${encodedPath}`;
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
  // Cache for resolved media blob URLs
  const mediaCacheRef = useRef<Map<string, string>>(new Map());
  const [, setMediaCacheVersion] = useState(0);

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
      if (!cleanedConfig.token) throw new Error("Add a GitHub token with Contents read and write access.");
      if (!nextPassphrase.trim()) throw new Error("Add the passphrase that unlocks your diary vault.");

      const remote = await fetchGitHubVaultFile(cleanedConfig);
      let nextVault = createEmptyVault();
      let nextSha = remote.sha;

      if (remote.exists && remote.text.trim()) {
        const parsed = JSON.parse(remote.text) as EncryptedVaultFile | VaultData;
        nextVault = await openVaultFile(parsed, nextPassphrase);
      } else {
        const encrypted = await encryptVault(nextVault, nextPassphrase);
        const created = await putGitHubVaultFile(cleanedConfig, encrypted, null, "Create encrypted Moonlit Diary vault");
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
      if (!remote.exists || !remote.text.trim()) throw new Error("The vault file was not found on GitHub.");
      const parsed = JSON.parse(remote.text) as EncryptedVaultFile | VaultData;
      const nextVault = await openVaultFile(parsed, passphrase);
      setVault(nextVault);
      setRemoteSha(remote.sha);
      setSyncState("ready");
      // Clear media cache on reload
      mediaCacheRef.current.forEach(url => URL.revokeObjectURL(url));
      mediaCacheRef.current.clear();
      setMediaCacheVersion(v => v + 1);
    } catch (error) {
      setSyncState("error");
      setSyncError(getErrorMessage(error));
    }
  }

  async function persistVault(nextVault: VaultData, commitMessage: string) {
    if (!config || !passphrase) throw new Error("Unlock your GitHub vault before saving.");
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

  async function resolveMediaUrl(att: Attachment): Promise<string> {
    // Instant sources — no network needed
    if (att.objectUrl) return att.objectUrl;
    if (att.dataUrl) return att.dataUrl;
    if (att.mediaUrl) return att.mediaUrl;
    if (!att.mediaPath || !config) throw new Error("Attachment has no media path or local source");

    // Check our blob URL cache
    const cached = mediaCacheRef.current.get(att.id);
    if (cached) return cached;

    // Fetch from GitHub API and create a blob URL
    const response = await fetch(mediaApiUrl(config, att.mediaPath), {
      headers: githubHeaders(config),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}: Failed to load ${att.name}`);
    const data = await response.json() as { content?: string; encoding?: string };
    if (!data.content) throw new Error("No content returned from GitHub");

    const binary = base64ToBytes(data.content.replace(/\s/g, ""));
    const blob = new Blob([binary], { type: att.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    mediaCacheRef.current.set(att.id, url);
    setMediaCacheVersion(v => v + 1);
    return url;
  }

  function getCachedMediaUrl(att: Attachment): string | null {
    if (att.objectUrl) return att.objectUrl;
    if (att.dataUrl) return att.dataUrl;
    if (att.mediaUrl) return att.mediaUrl;
    return mediaCacheRef.current.get(att.id) ?? null;
  }

  async function uploadAttachmentToMediaRepo(
    fileOrDataUrl: File | string,  // File object (fast) or fallback dataUrl string (legacy)
    dateKey: string,
    attId: string,
    attName: string,
    attType: string,
    config: GitHubConfig,
  ): Promise<{ mediaUrl: string; mediaPath: string; mediaSha: string | null }> {
    const m = getMediaConfig(config);
    const safeName = attName.replace(/[^a-zA-Z0-9_.-]/g, "_");

    // Get base64 content - fast path uses ArrayBuffer directly, no FileReader needed
    let base64Content: string;
    if (fileOrDataUrl instanceof File) {
      const buffer = await fileOrDataUrl.arrayBuffer();
      base64Content = arrayBufferToBase64(buffer);
    } else {
      // Legacy dataUrl fallback
      base64Content = fileOrDataUrl.split(",")[1] ?? fileOrDataUrl;
    }

    const ext = safeName.includes(".") ? "" : getExtensionFromMime(attType);
    const filePath = `${m.basePath}/${dateKey}/${attId.slice(0, 8)}_${safeName}${ext}`;

    const apiUrl = mediaApiUrl(config, filePath);

    // Check if already exists
    let existingSha: string | null = null;
    try {
      const headResp = await fetch(apiUrl, { headers: githubHeaders(config) });
      if (headResp.ok) {
        const existing = await headResp.json() as { sha?: string };
        existingSha = existing.sha ?? null;
      }
    } catch { /* doesn't exist yet */ }

    const body: { message: string; content: string; branch: string; sha?: string } = {
      message: `Upload ${attName} for ${dateKey}`,
      content: base64Content,
      branch: m.branch,
    };
    if (existingSha) body.sha = existingSha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: githubHeaders(config),
      body: JSON.stringify(body),
    });

    if (!putResp.ok) {
      const errText = await githubErrorMessage(putResp);
      throw new Error(`Failed to upload ${attName}: ${errText}`);
    }

    const data = await putResp.json() as { content?: { sha?: string; download_url?: string } };
    const rawUrl = `${mediaRawUrlBase(config)}/${filePath}`;

    return {
      mediaUrl: data.content?.download_url || rawUrl,
      mediaPath: filePath,
      mediaSha: data.content?.sha ?? existingSha,
    };
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
    // Revoke all object URLs
    mediaCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    mediaCacheRef.current.clear();
  }

  function closeLightbox() {
    setLightboxAttachments(null);
    setLightboxIndex(0);
  }

  function goToPrevLightboxItem() {
    if (!lightboxAttachments) return;
    setLightboxIndex((p) => (p > 0 ? p - 1 : lightboxAttachments.length - 1));
  }

  function goToNextLightboxItem() {
    if (!lightboxAttachments) return;
    setLightboxIndex((p) => (p < lightboxAttachments.length - 1 ? p + 1 : 0));
  }

  function openLightboxForAttachments(attachments: Attachment[], startIndex: number) {
    setLightboxAttachments(attachments);
    setLightboxIndex(startIndex);
    // Pre-resolve URLs
    attachments.forEach(att => {
      if (!getCachedMediaUrl(att)) {
        resolveMediaUrl(att).catch(() => {});
      }
    });
  }

  async function saveEntry(entry: DiaryEntry) {
    clearDraft(entry.date);

    // Build optimistic entry with dataUrls available for immediate display
    const optimisticEntry: DiaryEntry = { ...entry };
    const entries = vault.entries.filter(i => i.date !== entry.date);
    const optimisticVault: VaultData = {
      ...vault,
      updatedAt: new Date().toISOString(),
      entries: [...entries, optimisticEntry].sort((a, b) => a.date.localeCompare(b.date)),
    };

    setVault(optimisticVault);
    setSelectedDate(entry.date);
    setVisibleMonth(keyToDate(entry.date));
    setScreen("home");

    // Background save: upload media first, then save tiny vault
    (async () => {
      try {
        setSyncState("saving");
        setSyncError("");
        if (!config) throw new Error("Vault not configured");

        // Upload all new local attachments (File object preferred, dataUrl as fallback for old entries)
        const savedAttachments: Attachment[] = [];
        for (let i = 0; i < entry.attachments.length; i++) {
          const att = entry.attachments[i];
          if (att.file || att.dataUrl) {
            const uploadSource = att.file ?? att.dataUrl!;
            const uploaded = await uploadAttachmentToMediaRepo(
              uploadSource,
              entry.date,
              att.id,
              att.name,
              att.type,
              config,
            );
            savedAttachments.push({
              id: att.id,
              name: att.name,
              type: att.type,
              size: att.size,
              addedAt: att.addedAt,
              mediaUrl: uploaded.mediaUrl,
              mediaPath: uploaded.mediaPath,
              mediaSha: uploaded.mediaSha ?? undefined,
            });
          } else {
            savedAttachments.push(att);
          }
        }

        const compactEntry: DiaryEntry = { ...entry, attachments: savedAttachments };
        const allEntries = vault.entries.filter(i => i.date !== entry.date);
        const nextVault: VaultData = {
          ...vault,
          updatedAt: new Date().toISOString(),
          entries: [...allEntries, compactEntry].sort((a, b) => a.date.localeCompare(b.date)),
        };

        const encrypted = await encryptVault(nextVault, passphrase);
        const saved = await putGitHubVaultFile(config, encrypted, remoteSha, `Save diary entry for ${entry.date}`);
        setVault(nextVault);
        setRemoteSha(saved.sha);
        setSyncState("saved");
      } catch (error) {
        console.error("Background save failed:", error);
        setSyncState("error");
        setSyncError(getErrorMessage(error));
      }
    })();
  }

  async function deleteEntry(dateKey: string) {
    clearDraft(dateKey);
    const nextVault: VaultData = {
      ...vault,
      updatedAt: new Date().toISOString(),
      entries: vault.entries.filter(e => e.date !== dateKey),
    };
    setVault(nextVault);
    setSelectedDate(dateKey);
    setVisibleMonth(keyToDate(dateKey));
    setScreen("home");
    (async () => {
      try {
        setSyncState("saving");
        await persistVault(nextVault, `Delete diary entry for ${dateKey}`);
      } catch (error) {
        console.error("Delete failed:", error);
      }
    })();
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
          onYear={() => { setYearView(keyToDate(selectedDate).getFullYear()); setScreen("year"); }}
          onAIScreen={() => { setSelectedAITag(null); setScreen("ai"); }}
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
              syncState={syncState}
              onBack={() => setScreen("home")}
              onSave={saveEntry}
              onDelete={deleteEntry}
              onOpenLightbox={openLightboxForAttachments}
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
              onJumpToEntry={(dateKey) => openEntry(dateKey)}
            />
          ) : null}
        </main>
      </div>

      {lightboxAttachments && (
        <LightboxViewer
          attachments={lightboxAttachments}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onPrev={goToPrevLightboxItem}
          onNext={goToNextLightboxItem}
          resolveAttachmentUrl={resolveMediaUrl}
          getAttachmentUrl={getCachedMediaUrl}
        />
      )}
    </div>
  );
}

// =================== UNLOCK SCREEN ===================
function UnlockScreen({
  initialConfig, syncState, syncError, onUnlock,
}: {
  initialConfig: GitHubConfig;
  syncState: SyncState;
  syncError: string;
  onUnlock: (c: GitHubConfig, p: string, remember: boolean) => Promise<void>;
}) {
  const [draftConfig, setDraftConfig] = useState(initialConfig);
  const [passphrase, setPassphrase] = useState("");
  const [rememberConfig, setRememberConfig] = useState(true);
  const [showMediaConfig, setShowMediaConfig] = useState(false);
  const isLoading = syncState === "loading" || syncState === "saving";

  function updateConfig(field: keyof GitHubConfig, value: string) {
    setDraftConfig(c => ({ ...c, [field]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await onUnlock(draftConfig, passphrase, rememberConfig);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#02030a] text-slate-100">
      <AmbientBackdrop />
      <main className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl items-center gap-10 px-5 py-10 lg:grid-cols-[0.95fr_1.05fr] lg:px-10">
        <section className="animate-screen-in space-y-8">
          <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-cyan-100/80 shadow-2xl shadow-cyan-950/30 backdrop-blur-xl">
            <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.9)]" />
            Encrypted GitHub file diary — media stored separately
          </div>
          <div className="space-y-5">
            <p className="text-sm uppercase tracking-[0.55em] text-fuchsia-200/50">Moonlit</p>
            <h1 className="max-w-3xl text-6xl font-semibold tracking-[-0.08em] text-white sm:text-7xl lg:text-8xl">
              Your private night journal.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300/80">
              A dark, calendar-first diary with rich writing, media attachments, encrypted GitHub storage, and AI-powered insights. Photos & videos are stored as separate files (no more 500 errors).
            </p>
          </div>
          <div className="grid max-w-2xl gap-3 text-sm text-slate-300/75 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">Tiny vault file</p>
              <p className="mt-2 text-slate-400">Vault stays kilobytes. Media lives in separate files.</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">No more 500 errors</p>
              <p className="mt-2 text-slate-400">Upload large videos; vault.json stays fast.</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur-xl">
              <p className="text-cyan-100">Auto-save drafts</p>
              <p className="mt-2 text-slate-400">Never lose writing again.</p>
            </div>
          </div>
        </section>

        <section className="animate-float-in rounded-[2rem] border border-white/10 bg-slate-950/70 p-5 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:p-7">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm uppercase tracking-[0.35em] text-cyan-200/50">Vault access</p>
              <h2 className="text-3xl font-semibold tracking-tight text-white">Open your GitHub diary</h2>
              <p className="text-sm leading-6 text-slate-400">
                Your diary text is encrypted before saving to GitHub. Attachments are uploaded as individual files (they can optionally go to a separate media repo).
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="GitHub owner"><input value={draftConfig.owner} onChange={e => updateConfig("owner", e.target.value)} placeholder="your-username" className="field-input" /></Field>
              <Field label="Main diary repo"><input value={draftConfig.repo} onChange={e => updateConfig("repo", e.target.value)} placeholder="my-diary" className="field-input" /></Field>
              <Field label="Branch"><input value={draftConfig.branch} onChange={e => updateConfig("branch", e.target.value)} placeholder="main" className="field-input" /></Field>
              <Field label="Vault file path"><input value={draftConfig.path} onChange={e => updateConfig("path", e.target.value)} placeholder="data/moonlit-diary-vault.json" className="field-input" /></Field>
            </div>

            <Field label="GitHub token (Contents read/write)">
              <input type="password" value={draftConfig.token} onChange={e => updateConfig("token", e.target.value)} placeholder="Fine-grained token" className="field-input" />
            </Field>

            <button type="button" onClick={() => setShowMediaConfig(v => !v)} className="text-xs text-cyan-300/80 hover:text-cyan-200 underline">
              {showMediaConfig ? "▾ Hide" : "▸"} Optional: separate media repository (recommended for lots of videos)
            </button>

            {showMediaConfig && (
              <div className="grid gap-3 sm:grid-cols-2 rounded-2xl border border-cyan-500/20 bg-cyan-950/20 p-4">
                <Field label="Media repo owner"><input value={draftConfig.mediaOwner} onChange={e => updateConfig("mediaOwner", e.target.value)} placeholder="(leave blank = same as diary owner)" className="field-input" /></Field>
                <Field label="Media repo name"><input value={draftConfig.mediaRepo} onChange={e => updateConfig("mediaRepo", e.target.value)} placeholder="my-diary-media" className="field-input" /></Field>
                <Field label="Media branch"><input value={draftConfig.mediaBranch} onChange={e => updateConfig("mediaBranch", e.target.value)} placeholder="main" className="field-input" /></Field>
                <Field label="Media folder path"><input value={draftConfig.mediaPath} onChange={e => updateConfig("mediaPath", e.target.value)} placeholder="media" className="field-input" /></Field>
                <p className="sm:col-span-2 text-xs text-slate-400 leading-relaxed">
                  If left blank, attachments are uploaded to a <code className="text-cyan-300">media/</code> folder in your main diary repo. Either way, your vault.json stays small.
                </p>
              </div>
            )}

            <Field label="Diary passphrase">
              <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="Only this unlocks the encrypted vault" className="field-input" />
            </Field>

            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-slate-300">
              <input type="checkbox" checked={rememberConfig} onChange={e => setRememberConfig(e.target.checked)} className="h-4 w-4 accent-cyan-300" />
              Remember these GitHub details on this device.
            </label>

            {syncError ? <SyncError message={syncError} compact /> : null}

            <button type="submit" disabled={isLoading}
              className="group relative w-full overflow-hidden rounded-2xl bg-cyan-200 px-5 py-4 text-sm font-semibold uppercase tracking-[0.26em] text-slate-950 shadow-2xl shadow-cyan-500/25 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
              <span className="relative z-10">{isLoading ? "Opening vault..." : "Unlock diary"}</span>
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/60 to-transparent transition duration-700 group-hover:translate-x-full" />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function TopBar({ syncState, currentScreen, onHome, onYear, onAIScreen, onNewEntry, onSync, onLock }: {
  syncState: SyncState; currentScreen: Screen;
  onHome: () => void; onYear: () => void; onAIScreen: () => void; onNewEntry: () => void; onSync: () => void; onLock: () => void;
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
        <button type="button" onClick={onHome} className={cn("nav-button", currentScreen === "home" && "bg-white/10 text-white")}>Calendar</button>
        <button type="button" onClick={onAIScreen} className={cn("nav-button relative overflow-hidden group", currentScreen === "ai" && "bg-cyan-500/10 border-cyan-400/30 text-cyan-200")}>
          <span className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 to-fuchsia-500/10 opacity-50" />
          <span className="relative flex items-center gap-1">✨ AI Hub</span>
        </button>
        <button type="button" onClick={onYear} className={cn("nav-button", currentScreen === "year" && "bg-white/10 text-white")}>Year in pixels</button>
        <button type="button" onClick={onNewEntry} className="nav-button-primary">New entry</button>
        <button type="button" onClick={onSync} className="nav-button">Sync</button>
        <button type="button" onClick={onLock} className="nav-button text-rose-300/80 hover:bg-rose-500/10">Lock</button>
      </div>
    </header>
  );
}

function SyncBadge({ state }: { state: SyncState }) {
  const labels: Record<SyncState, string> = { locked: "Locked", loading: "Loading", ready: "Ready", saving: "Saving", saved: "Saved", error: "Needs attention" };
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium uppercase tracking-[0.22em] text-slate-300">
      <span className={cn("h-2 w-2 rounded-full", state === "error" ? "bg-rose-400" : "bg-cyan-300", (state === "loading" || state === "saving") && "animate-pulse")} />
      {labels[state]}
    </span>
  );
}

// =================== HOME VIEW ===================
function HomeView({
  entryByDate, selectedDate, visibleMonth, onSelectDate, onVisibleMonthChange, onOpenEntry,
}: {
  entryByDate: Map<string, DiaryEntry>;
  selectedDate: string; visibleMonth: Date;
  onSelectDate: (d: string) => void;
  onVisibleMonthChange: (d: Date) => void;
  onOpenEntry: (d: string) => void;
}) {
  const selectedEntry = entryByDate.get(selectedDate);
  const monthEntries = [...entryByDate.values()].filter(e => {
    const d = keyToDate(e.date);
    return d.getFullYear() === visibleMonth.getFullYear() && d.getMonth() === visibleMonth.getMonth();
  });
  const monthLabel = new Intl.DateTimeFormat("en", { month: "long" }).format(visibleMonth);
  const yearLabel = visibleMonth.getFullYear();
  const hasDraft = useMemo(() => loadDraft(selectedDate) !== null, [selectedDate]);
  const entryTags = useMemo(() => selectedEntry ? extractTopicsAndTags(selectedEntry.bodyHtml, selectedEntry.title) : [], [selectedEntry]);

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
            <p className="max-w-2xl text-sm leading-6 text-slate-400">Pick a day, write your entry.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onVisibleMonthChange(addMonths(visibleMonth, -1))} className="round-button">Prev</button>
            <button type="button" onClick={() => onVisibleMonthChange(keyToDate(dateToKey(new Date())))} className="round-button">Today</button>
            <button type="button" onClick={() => onVisibleMonthChange(addMonths(visibleMonth, 1))} className="round-button">Next</button>
          </div>
        </div>
        <MonthlyCalendar visibleMonth={visibleMonth} selectedDate={selectedDate} entryByDate={entryByDate} onSelectDate={onSelectDate} onOpenEntry={onOpenEntry} />
      </div>

      <aside className="animate-float-in space-y-4">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Selected day</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">{formatDateLong(selectedDate)}</h2>

          {selectedEntry ? (
            <div className="mt-5 space-y-4">
              <div className="flex flex-wrap gap-2 items-center">
                <MoodChip mood={selectedEntry.mood} />
                <span className="text-xs px-2.5 py-1 rounded-full bg-cyan-500/10 text-cyan-300/90 border border-cyan-400/20">{detectSentimentLabel(selectedEntry.bodyHtml)}</span>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Title</p>
                <p className="mt-2 text-xl font-semibold text-white">{selectedEntry.title}</p>
              </div>
              {entryTags.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-slate-500 mb-1.5">Auto Tags</p>
                  <div className="flex flex-wrap gap-1">
                    {entryTags.map(t => <span key={t} className="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-slate-300">#{t}</span>)}
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
                <p className="text-sm text-amber-100/90 flex items-center gap-2"><span className="text-amber-300">📝</span> You have an unsaved draft for this day</p>
              </div>
              <button type="button" onClick={() => onOpenEntry(selectedDate)} className="w-full nav-button-primary justify-center py-4">Continue Editing Draft</button>
            </div>
          ) : (
            <div className="mt-5 rounded-3xl border border-dashed border-white/15 bg-black/20 p-5 text-sm leading-6 text-slate-400">
              No entry yet.
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
            <p className="max-w-[10rem] text-right text-sm leading-6 text-slate-400">written days saved</p>
          </div>
        </section>
        <MoodLegend />
      </aside>
    </section>
  );
}

function MonthlyCalendar({ visibleMonth, selectedDate, entryByDate, onSelectDate, onOpenEntry }: {
  visibleMonth: Date; selectedDate: string; entryByDate: Map<string, DiaryEntry>;
  onSelectDate: (d: string) => void; onOpenEntry: (d: string) => void;
}) {
  const cells = buildMonthCells(visibleMonth);
  const todayKey = dateToKey(new Date());
  return (
    <div className="mt-8">
      <div className="grid grid-cols-7 gap-2 px-1 text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 sm:gap-3">
        {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="mt-3 grid grid-cols-7 gap-2 sm:gap-3">
        {cells.map(cell => {
          const entry = entryByDate.get(cell.dateKey);
          const mood = entry ? MOOD_BY_ID[entry.mood] : null;
          const isSelected = cell.dateKey === selectedDate;
          const isToday = cell.dateKey === todayKey;
          const hasDraft = !entry && loadDraft(cell.dateKey) !== null;
          return (
            <button key={cell.dateKey} type="button"
              onClick={() => onSelectDate(cell.dateKey)}
              onDoubleClick={() => onOpenEntry(cell.dateKey)}
              className={cn(
                "group relative aspect-square overflow-hidden rounded-[1.35rem] border text-left transition duration-300",
                cell.inCurrentMonth ? "border-white/10 bg-white/[0.035] hover:bg-white/[0.07]" : "border-white/[0.04] bg-white/[0.015] text-slate-600",
                isSelected && "scale-[1.02] border-cyan-200/70 bg-cyan-100/10 shadow-[0_0_40px_rgba(34,211,238,0.18)]",
                isToday && "ring-1 ring-fuchsia-200/40",
              )}
              style={isSelected && mood ? { boxShadow: `0 0 44px ${mood.glow}` } : undefined}
            >
              <span className="absolute inset-x-3 top-3 flex items-center justify-between">
                <span className={cn("text-lg font-medium", cell.inCurrentMonth ? "text-slate-200" : "text-slate-600")}>{cell.day}</span>
                {isToday && <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300 shadow-[0_0_12px_rgba(244,114,182,0.9)]" />}
              </span>
              {entry ? (
                <span className="absolute bottom-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full" style={{ backgroundColor: mood?.color, boxShadow: `0 0 18px ${mood?.glow}` }} />
              ) : hasDraft ? (
                <span className="absolute bottom-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.5)] animate-pulse" title="Unsaved draft" />
              ) : null}
              {entry && <span className="absolute inset-x-3 bottom-8 hidden truncate text-xs text-slate-400 opacity-0 transition group-hover:block group-hover:opacity-100 lg:block" title={entry.title}>{entry.title}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =================== ENTRY EDITOR ===================
function EntryEditor({
  dateKey, entry, syncState, onBack, onSave, onDelete, onOpenLightbox,
}: {
  dateKey: string;
  entry?: DiaryEntry;
  syncState: SyncState;
  onBack: () => void;
  onSave: (e: DiaryEntry) => Promise<void>;
  onDelete: (d: string) => Promise<void>;
  onOpenLightbox: (atts: Attachment[], idx: number) => void;
}) {
  const existingDraft = useMemo(() => loadDraft(dateKey), [dateKey]);
  const [title, setTitle] = useState(existingDraft?.title ?? entry?.title ?? "");
  const [mood, setMood] = useState<MoodId>(existingDraft?.mood ?? entry?.mood ?? "happy");
  const [bodyHtml, setBodyHtml] = useState(existingDraft?.bodyHtml ?? entry?.bodyHtml ?? "");
  const [dailyWin, setDailyWin] = useState(existingDraft?.dailyWin ?? entry?.dailyWin ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(existingDraft?.attachments ?? entry?.attachments ?? []);
  const [localError, setLocalError] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [aiPrompt, setAIPrompt] = useState<string | null>(null);
  const activeMood = MOOD_BY_ID[mood];

  const isSaving = syncState === "saving" || isWorking;

  const computedTags = useMemo(() => extractTopicsAndTags(bodyHtml, title), [bodyHtml, title]);

  const currentDraftState = JSON.stringify({ title, mood, bodyHtml, dailyWin, attachments });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedDraft, setLastSavedDraft] = useState("");

  useEffect(() => { setHasUnsavedChanges(currentDraftState !== lastSavedDraft); }, [currentDraftState, lastSavedDraft]);
  useEffect(() => {
    const initial = JSON.stringify({ title, mood, bodyHtml, dailyWin, attachments });
    setLastSavedDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft every 1 second
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const t = setTimeout(() => {
      const draft: DraftEntry = { dateKey, title, mood, bodyHtml, dailyWin, attachments, savedAt: new Date().toISOString() };
      saveDraft(draft);
      setLastSavedDraft(currentDraftState);
      setHasUnsavedChanges(false);
    }, 1000);
    return () => clearTimeout(t);
  }, [dateKey, title, mood, bodyHtml, dailyWin, attachments, hasUnsavedChanges, currentDraftState]);

  async function triggerAIPrompt() {
    setAIPrompt("Consulting your timeline memory...");
    try {
      // We don't have all entries here, but we can pass the current one
      const customQuestion = await generateAICustomQuestion(entry ? [entry] : []);
      setAIPrompt(customQuestion);
    } catch {
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
    if (!window.confirm("Delete this diary entry?")) return;
    setLocalError("");
    setIsWorking(true);
    try { await onDelete(dateKey); } catch (error) { setLocalError(getErrorMessage(error)); } finally { setIsWorking(false); }
  }

  const handleBack = useCallback(() => {
    if (title.trim() || bodyHtml.trim() || dailyWin.trim() || attachments.length > 0) {
      const draft: DraftEntry = { dateKey, title, mood, bodyHtml, dailyWin, attachments, savedAt: new Date().toISOString() };
      saveDraft(draft);
    }
    onBack();
  }, [dateKey, title, mood, bodyHtml, dailyWin, attachments, onBack]);

  return (
    <section className="grid animate-screen-in gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-[2rem] border border-white/10 bg-slate-950/65 p-4 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={handleBack} className="round-button w-fit">Back to calendar</button>
          <div className="flex items-center gap-2">
            {entry ? <button type="button" onClick={handleDelete} disabled={isSaving} className="danger-button">Delete</button> : null}
            <button type="button" onClick={handleSave} disabled={isSaving} className="nav-button-primary py-3">
              {isSaving ? "Saving to cloud..." : "Save entry"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          {hasUnsavedChanges ? (
            <span className="flex items-center gap-1.5 text-amber-400/70"><span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />Draft auto-saving...</span>
          ) : (
            <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400/50" />Draft saved</span>
          )}
          <span className="ml-2 text-slate-600">Media uploads in background after you click Save.</span>
        </div>

        <div className="mt-4 rounded-2xl border border-cyan-500/10 bg-gradient-to-r from-cyan-950/20 to-fuchsia-950/20 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-semibold tracking-wide text-cyan-200">AI Writing Assistant</h4>
              <p className="text-xs text-slate-400 mt-0.5">Stuck? Get a personalized reflection prompt.</p>
            </div>
            <button type="button" onClick={triggerAIPrompt} className="px-3 py-1.5 rounded-xl bg-cyan-400 text-slate-950 font-medium text-xs hover:bg-cyan-300 shadow transition shrink-0">
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

          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Give today a title"
            className="w-full border-none bg-transparent text-4xl font-semibold tracking-[-0.06em] text-white outline-none placeholder:text-slate-700 sm:text-6xl" />

          <RichTextEditor value={bodyHtml} onChange={setBodyHtml} />

          {computedTags.length > 0 && (
            <div className="pt-2">
              <span className="text-xs uppercase tracking-widest text-slate-500 block mb-2">Auto Topics</span>
              <div className="flex flex-wrap gap-1.5">
                {computedTags.map(tag => <span key={tag} className="text-xs px-3 py-1 rounded-full bg-white/[0.04] border border-white/10 text-cyan-200/90">#{tag}</span>)}
              </div>
            </div>
          )}
        </div>

        {localError ? <SyncError message={localError} compact /> : null}
      </div>

      <aside className="space-y-4">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood</p>
          <p className="mt-3 text-sm leading-6 text-slate-400">Pick the color for this day.</p>
          <div className="mt-5 grid gap-2">
            {MOODS.map(item => (
              <button key={item.id} type="button" onClick={() => setMood(item.id)}
                className={cn("group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition",
                  item.id === mood ? "border-white/30 bg-white/[0.09]" : "border-white/10 bg-black/20 hover:bg-white/[0.055]")}>
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
          <textarea value={dailyWin} onChange={e => setDailyWin(e.target.value)} placeholder="One small productive thing, lesson, or gain from today..."
            rows={5}
            className="mt-4 min-h-36 w-full resize-none rounded-3xl border border-white/10 bg-black/25 p-4 text-sm leading-6 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-200/50 focus:bg-black/35" />
        </section>

        <AttachmentPanel
          attachments={attachments}
          onChange={setAttachments}
          onOpenLightbox={onOpenLightbox}
        />
      </aside>
    </section>
  );
}

function RichTextEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) editorRef.current.innerHTML = value;
  }, [value]);

  function runCommand(cmd: string, val?: string) {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val);
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
        {!htmlToText(value) && !isFocused && <div className="pointer-events-none absolute left-5 top-5 text-slate-600">Start writing what happened today...</div>}
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

function ToolbarButton({ label, onClick, strong, italic, underline }: { label: string; onClick: () => void; strong?: boolean; italic?: boolean; underline?: boolean; }) {
  return (
    <button type="button"
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      className={cn("rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-200/40 hover:bg-cyan-200/10 hover:text-white",
        strong && "font-black", italic && "italic", underline && "underline")}>
      {label}
    </button>
  );
}

function AttachmentPanel({ attachments, onChange, onOpenLightbox }: {
  attachments: Attachment[];
  onChange: (atts: Attachment[]) => void;
  onOpenLightbox: (atts: Attachment[], idx: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");
  const totalBytes = attachments.reduce((t, a) => t + a.size, 0);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    setError("");

    const oversized: string[] = [];
    Array.from(files).forEach(f => { if (f.size > MAX_FILE_SIZE_BYTES) oversized.push(`${f.name} (${formatBytes(f.size)})`); });
    if (oversized.length > 0) {
      setError(`These exceed 500MB: ${oversized.join(", ")}`);
      event.target.value = "";
      return;
    }

    // Instant: create object URLs for preview, hold raw File for upload later.
    // No FileReader, no encoding, no compression — just instant.
    const newAtts: Attachment[] = Array.from(files).map(f => fileToAttachment(f));
    onChange([...attachments, ...newAtts]);
    event.target.value = "";
  }

  return (
    <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl">
      <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleFileChange} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Attachments</p>
          <p className="mt-3 text-sm leading-6 text-slate-400">Photos & videos up to 500MB. Added instantly, uploaded to your media repo in background when you click Save. No waiting.</p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()} className="round-button shrink-0">
          Add
        </button>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-400">
        {attachments.length} file{attachments.length === 1 ? "" : "s"} / {formatBytes(totalBytes)}
      </div>

      {totalBytes > 100 * 1024 * 1024 && (
        <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100/80">
          ⚠️ Total is {formatBytes(totalBytes)}. Upload happens in the background after you click Save — you can navigate away immediately.
        </p>
      )}

      {error ? <SyncError message={error} compact /> : null}

      <div className="mt-4 grid gap-3">
        {attachments.map((att, idx) => {
          // Priority: objectUrl (new files) > mediaUrl (saved cloud) > dataUrl (legacy)
          const previewSrc = att.objectUrl ?? att.mediaUrl ?? att.dataUrl ?? null;
          const isCloud = !!att.mediaUrl && !att.objectUrl && !att.file;
          const isPendingUpload = (!!att.file || !!att.objectUrl) && !att.mediaUrl;

          return (
            <div key={att.id} className="overflow-hidden rounded-3xl border border-white/10 bg-black/25">
              <button type="button" onClick={() => onOpenLightbox(attachments, idx)} className="block w-full aspect-video bg-slate-900 relative group cursor-zoom-in">
                {previewSrc ? (
                  att.type.startsWith("image/") ? (
                    <img src={previewSrc} alt={att.name} className="h-full w-full object-cover transition group-hover:opacity-80" />
                  ) : att.type.startsWith("video/") ? (
                    <video src={previewSrc} className="h-full w-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">📎 {att.name}</div>
                  )
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">☁️ Will upload on save</div>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition opacity-0 group-hover:opacity-100">
                  <span className="bg-black/70 backdrop-blur px-3 py-1.5 rounded-full text-xs text-white font-medium">Click to view fullscreen</span>
                </span>
                {isCloud && <span className="absolute top-2 right-2 bg-black/60 backdrop-blur text-[10px] text-cyan-300 px-2 py-0.5 rounded-full border border-cyan-500/30">☁️ Saved</span>}
                {isPendingUpload && <span className="absolute top-2 right-2 bg-black/60 backdrop-blur text-[10px] text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30">⏫ Uploads on Save</span>}
              </button>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{att.name}</p>
                  <p className="text-xs text-slate-500">{formatBytes(att.size)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {previewSrc && (
                    <a href={previewSrc} download={att.name} onClick={e => e.stopPropagation()}
                      className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-100">
                      Download
                    </a>
                  )}
                  <button type="button" onClick={() => {
                    if (att.objectUrl) URL.revokeObjectURL(att.objectUrl);
                    onChange(attachments.filter(i => i.id !== att.id));
                  }}
                    className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 transition hover:border-rose-300/40 hover:bg-rose-400/10 hover:text-rose-100">
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// =================== FAST FILE HANDLING (no compression) ===================
// Files are kept as raw File objects in memory — no encoding until upload.
// Upload uses arrayBuffer() + chunked base64 encoding — fastest possible path.

function fileToAttachment(file: File): Attachment {
  // Create an instant object URL for preview — no FileReader, no encoding, instant.
  const objectUrl = URL.createObjectURL(file);
  return {
    id: createId(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: new Date().toISOString(),
    file,        // keep raw File reference for upload
    objectUrl,   // instant preview URL
  };
}

/**
 * Convert ArrayBuffer to base64 in chunks to avoid call stack overflows on large files.
 * This is much faster than going via FileReader.readAsDataURL (which also adds the data: prefix overhead).
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// =================== YEAR PIXELS ===================
function YearPixelsView({ year, entryByDate, onYearChange, onBack, onOpenEntry }: {
  year: number; entryByDate: Map<string, DiaryEntry>;
  onYearChange: (y: number) => void; onBack: () => void; onOpenEntry: (d: string) => void;
}) {
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => new Date(year, i, 1)), [year]);
  const writtenDays = [...entryByDate.values()].filter(e => keyToDate(e.date).getFullYear() === year).length;
  return (
    <section className="animate-screen-in space-y-5">
      <div className="rounded-[2rem] border border-white/10 bg-slate-950/65 p-5 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <p className="text-sm uppercase tracking-[0.5em] text-fuchsia-200/50">Year in pixels</p>
            <h1 className="text-6xl font-semibold tracking-[-0.08em] text-white sm:text-8xl">{year}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onBack} className="round-button">Back</button>
            <button type="button" onClick={() => onYearChange(year - 1)} className="round-button">Prev</button>
            <button type="button" onClick={() => onYearChange(new Date().getFullYear())} className="round-button">This year</button>
            <button type="button" onClick={() => onYearChange(year + 1)} className="round-button">Next</button>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-4 py-2">{writtenDays} written days</span>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {months.map(md => <MonthPixelPanel key={md.toISOString()} monthDate={md} entryByDate={entryByDate} onOpenEntry={onOpenEntry} />)}
      </div>
      <MoodLegend />
    </section>
  );
}

function MonthPixelPanel({ monthDate, entryByDate, onOpenEntry }: { monthDate: Date; entryByDate: Map<string, DiaryEntry>; onOpenEntry: (d: string) => void }) {
  const monthName = new Intl.DateTimeFormat("en", { month: "long" }).format(monthDate);
  const cells = buildMonthCells(monthDate);
  return (
    <section className="rounded-[1.7rem] border border-white/10 bg-white/[0.035] p-4 backdrop-blur-2xl hover:bg-white/[0.055] transition">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{monthName}</h2>
        <span className="text-xs text-slate-500">{monthDate.getFullYear()}</span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {cells.map(cell => {
          const entry = entryByDate.get(cell.dateKey);
          const mood = entry ? MOOD_BY_ID[entry.mood] : null;
          return (
            <button key={cell.dateKey} type="button" onClick={() => onOpenEntry(cell.dateKey)}
              title={formatDateLong(cell.dateKey) + (entry ? ` - ${entry.title}` : "")}
              className={cn("aspect-square rounded-full transition duration-300 hover:scale-150 hover:ring-2 hover:ring-cyan-100/60", cell.inCurrentMonth ? "opacity-100" : "opacity-20")}
              style={{ backgroundColor: mood?.color ?? "rgba(148, 163, 184, 0.2)", boxShadow: mood ? `0 0 16px ${mood.glow}` : "none" }}
            />
          );
        })}
      </div>
    </section>
  );
}

// =================== AI HUB ===================
function AIIntelligenceView({ entries, initialTagFilter, onJumpToEntry }: {
  entries: DiaryEntry[]; initialTagFilter: string | null;
  onJumpToEntry: (d: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(initialTagFilter);
  const [aiAnswer, setAiAnswer] = useState("");
  const [isSearchingAI, setIsSearchingAI] = useState(false);

  const globalTopicCloud = useMemo(() => {
    const freq: Record<string, number> = {};
    entries.forEach(e => extractTopicsAndTags(e.bodyHtml, e.title).forEach(t => { freq[t] = (freq[t] || 0) + 1; }));
    return Object.entries(freq).map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
  }, [entries]);

  const expandedTerms = useMemo(() => {
    const q = searchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (q.length === 0) return [];
    const terms = new Set<string>(q);
    q.forEach(word => {
      if (SEMANTIC_DICTIONARY[word]) SEMANTIC_DICTIONARY[word].forEach(s => terms.add(s));
      Object.entries(SEMANTIC_DICTIONARY).forEach(([key, syns]) => { if (syns.includes(word)) terms.add(key); });
    });
    return Array.from(terms);
  }, [searchQuery]);

  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      const body = htmlToText(e.bodyHtml).toLowerCase();
      const title = e.title.toLowerCase();
      if (activeTag) {
        const tags = extractTopicsAndTags(e.bodyHtml, e.title);
        if (!tags.includes(activeTag)) return false;
      }
      if (expandedTerms.length > 0) {
        return expandedTerms.some(t => body.includes(t) || title.includes(t) || e.date.includes(t));
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [entries, expandedTerms, activeTag]);

  const moods = useMemo(() => {
    const t: Record<MoodId, number> = { happy: 0, depressed: 0, sleepy: 0, angry: 0, romantic: 0 };
    entries.forEach(e => { t[e.mood]++; });
    return t;
  }, [entries]);
  const maxMood = Math.max(...Object.values(moods), 1);

  async function handleAISubmit(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearchingAI(true);
    setAiAnswer("Thinking through your timeline...");
    try {
      const res = await smartAISearch(searchQuery, entries);
      setAiAnswer(res);
    } catch (err) {
      setAiAnswer(`Error: ${getErrorMessage(err)}`);
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
          <p className="text-sm text-slate-400 max-w-2xl">Ask natural questions. Dates in AI responses are clickable!</p>
        </div>

        <form onSubmit={handleAISubmit} className="rounded-2xl border border-white/10 bg-black/40 px-4 py-3 flex items-center gap-3">
          <span className="text-xl">🔍</span>
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder='Try "When did I go to the beach?"'
            className="w-full bg-transparent outline-none border-none text-slate-100 placeholder:text-slate-600 text-base pr-2" />
          {searchQuery && <button type="button" onClick={() => { setSearchQuery(""); setAiAnswer(""); }} className="text-xs text-slate-500 hover:text-white px-1">Clear</button>}
          <button type="submit" disabled={isSearchingAI || !searchQuery.trim()}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-fuchsia-600 text-white font-medium text-xs hover:opacity-90 disabled:opacity-40">
            {isSearchingAI ? "Thinking..." : "Ask AI"}
          </button>
        </form>

        {expandedTerms.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs text-slate-400 bg-white/[0.02] p-2.5 rounded-xl border border-white/5">
            <span className="text-cyan-400/70 font-mono">Matches:</span>
            {expandedTerms.map(t => <span key={t} className="px-2 py-0.5 rounded bg-cyan-950/40 border border-cyan-800/30 text-cyan-300">{t}</span>)}
          </div>
        )}

        {activeTag && (
          <div className="flex items-center justify-between bg-fuchsia-950/20 border border-fuchsia-500/20 px-4 py-2 rounded-xl text-sm text-fuchsia-200">
            <span>Filtered by <strong>#{activeTag}</strong></span>
            <button type="button" onClick={() => setActiveTag(null)} className="text-xs uppercase underline hover:text-white">Remove</button>
          </div>
        )}

        {aiAnswer && (
          <div className="p-5 rounded-2xl border border-fuchsia-500/20 bg-gradient-to-br from-cyan-950/30 to-fuchsia-950/30 shadow-xl backdrop-blur-xl animate-fade-in">
            <h4 className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-2">AI Conclusion — click dates to jump to entry:</h4>
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
              <AIResponseRenderer text={aiAnswer} onDateClick={onJumpToEntry} />
            </p>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <h3 className="text-xs uppercase tracking-[0.2em] text-slate-400 font-semibold">Matched Entries ({filteredEntries.length})</h3>
          </div>
          {filteredEntries.length > 0 ? (
            <div className="space-y-2.5 max-h-[32rem] overflow-y-auto pr-1">
              {filteredEntries.map(item => {
                const opt = MOOD_BY_ID[item.mood];
                return (
                  <button key={item.id} type="button" onClick={() => onJumpToEntry(item.date)}
                    className="w-full text-left flex items-center justify-between gap-4 p-4 rounded-2xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] hover:border-cyan-400/30 transition group">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-cyan-300/80 bg-cyan-950/40 border border-cyan-900/50 px-2 py-0.5 rounded">{item.date}</span>
                        <h4 className="font-medium text-white truncate group-hover:text-cyan-200">{item.title}</h4>
                      </div>
                      <p className="text-xs text-slate-400 truncate max-w-xl">{htmlToText(item.bodyHtml)}</p>
                    </div>
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: opt.color, boxShadow: `0 0 12px ${opt.glow}` }} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-slate-500 text-sm">No entries found.</div>
          )}
        </div>
      </div>

      <aside className="space-y-4 animate-float-in">
        <section className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-5 shadow-2xl shadow-black/30 backdrop-blur-2xl space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood Distribution</p>
          </div>
          <div className="space-y-3 pt-2">
            {MOODS.map(m => {
              const count = moods[m.id] || 0;
              const pct = (count / maxMood) * 100;
              return (
                <div key={m.id} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-white font-medium flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />{m.label}</span>
                    <span className="text-slate-500">{count}</span>
                  </div>
                  <div className="h-2 bg-black/40 rounded-full overflow-hidden border border-white/5">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: m.color, boxShadow: `0 0 10px ${m.glow}` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl space-y-4">
          <p className="text-xs uppercase tracking-[0.35em] text-fuchsia-200/50">Topic Cloud</p>
          {globalTopicCloud.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {globalTopicCloud.map(tag => (
                <button key={tag.text} type="button" onClick={() => setActiveTag(activeTag === tag.text ? null : tag.text)}
                  className={cn("text-xs px-2.5 py-1 rounded-xl border transition",
                    activeTag === tag.text ? "bg-fuchsia-500/20 border-fuchsia-400 text-fuchsia-200" : "bg-black/30 border-white/10 text-slate-300 hover:border-cyan-400/40 hover:bg-white/5")}>
                  #{tag.text} <span className="text-[10px] opacity-40 ml-0.5">({tag.count})</span>
                </button>
              ))}
            </div>
          ) : <p className="text-xs text-slate-500 italic">No topics yet.</p>}
        </section>
        <MoodLegend />
      </aside>
    </div>
  );
}

// =================== SHARED COMPONENTS ===================
function MoodLegend() {
  return (
    <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl">
      <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/50">Mood colors</p>
      <div className="mt-4 grid gap-3">
        {MOODS.map(m => (
          <div key={m.id} className="flex items-center gap-3 text-sm text-slate-300">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: m.color, boxShadow: `0 0 16px ${m.glow}` }} />
            <span className="font-medium text-white">{m.label}</span>
            <span className="text-slate-500">{m.description}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MoodChip({ mood }: { mood: MoodId }) {
  const opt = MOOD_BY_ID[mood];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 py-2 text-sm text-slate-200">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: opt.color, boxShadow: `0 0 16px ${opt.glow}` }} />
      {opt.label}
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
    <div className={cn("rounded-2xl border border-rose-300/20 bg-rose-500/10 text-sm leading-6 text-rose-100 shadow-2xl shadow-rose-950/20 backdrop-blur-xl",
      compact ? "mt-4 px-4 py-3" : "mb-5 px-5 py-4")}>
      {message}
    </div>
  );
}

function AmbientBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="aurora-orb aurora-orb-a" />
      <div className="aurora-orb aurora-orb-b" />
      <div className="aurora-orb aurora-orb-c" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_32%),linear-gradient(180deg,rgba(2,3,10,0)_0%,rgba(2,3,10,0.72)_78%,#02030a_100%)]" />
      <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:72px_72px]" />
    </div>
  );
}

function LightboxViewer({
  attachments, currentIndex, onClose, onPrev, onNext,
  resolveAttachmentUrl, getAttachmentUrl,
}: {
  attachments: Attachment[]; currentIndex: number; onClose: () => void; onPrev: () => void; onNext: () => void;
  resolveAttachmentUrl: (att: Attachment) => Promise<string>;
  getAttachmentUrl: (att: Attachment) => string | null;
}) {
  const current = attachments[currentIndex];
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  const [url, setUrl] = useState<string | null>(() => current ? (getAttachmentUrl(current)) : null);
  const [loading, setLoading] = useState(!url);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    const cached = getAttachmentUrl(current);
    if (cached) { setUrl(cached); setLoading(false); setError(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    resolveAttachmentUrl(current)
      .then(u => { if (!cancelled) { setUrl(u); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(getErrorMessage(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [current, getAttachmentUrl, resolveAttachmentUrl]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev();
      if (e.key === "ArrowRight") onNext();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onPrev, onNext]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  function handleTouchStart(e: ReactTouchEvent) { touchStartX.current = e.changedTouches[0].screenX; touchEndX.current = null; }
  function handleTouchMove(e: ReactTouchEvent) { touchEndX.current = e.changedTouches[0].screenX; }
  function handleTouchEnd() {
    if (!touchStartX.current || !touchEndX.current) return;
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) > 50) { diff > 0 ? onNext() : onPrev(); }
    touchStartX.current = null; touchEndX.current = null;
  }

  function download() {
    if (!url) return;
    const a = document.createElement("a"); a.href = url; a.download = current.name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in"
      onClick={onClose} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent">
        <button type="button" onClick={e => { e.stopPropagation(); onClose(); }}
          className="flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 px-4 py-2 text-white backdrop-blur-md">
          <span className="text-lg leading-none">←</span><span className="text-sm font-medium">Back</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-white/70 text-sm font-mono bg-black/40 px-3 py-1.5 rounded-full backdrop-blur-md">{currentIndex + 1} / {attachments.length}</span>
          <button type="button" onClick={e => { e.stopPropagation(); download(); }} disabled={!url}
            className="flex items-center gap-2 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 px-4 py-2 text-cyan-100 backdrop-blur-md disabled:opacity-40">
            <span>⬇</span><span className="text-sm font-medium">Download</span>
          </button>
        </div>
      </div>

      {attachments.length > 1 && (
        <>
          <button type="button" onClick={e => { e.stopPropagation(); onPrev(); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 h-12 w-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white text-2xl backdrop-blur-md">‹</button>
          <button type="button" onClick={e => { e.stopPropagation(); onNext(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 h-12 w-12 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white text-2xl backdrop-blur-md">›</button>
        </>
      )}

      <div className="absolute bottom-4 left-0 right-0 z-10 text-center px-4">
        <p className="text-white/80 text-sm truncate max-w-2xl mx-auto bg-black/50 inline-block px-4 py-2 rounded-full backdrop-blur-md">
          {current.name} <span className="text-white/50 ml-2 text-xs">({formatBytes(current.size)})</span>
        </p>
      </div>

      <div className="relative max-w-[95vw] max-h-[80vh] flex items-center justify-center" onClick={e => e.stopPropagation()}>
        {loading ? <div className="text-white/70 text-lg animate-pulse">Loading from media repo...</div>
          : error ? <div className="text-rose-400 text-center p-8"><p className="text-lg mb-2">⚠️ Failed to load</p><p className="text-sm text-rose-300/70">{error}</p></div>
          : current.type.startsWith("image/") && url ? <img src={url} alt={current.name} className="max-w-full max-h-[80vh] object-contain select-none" draggable={false} />
          : current.type.startsWith("video/") && url ? <video src={url} controls autoPlay className="max-w-full max-h-[80vh] object-contain" onClick={e => e.stopPropagation()} />
          : url ? <div className="p-8 text-white/80 bg-white/10 rounded-2xl"><p className="text-center">Preview not available.</p></div>
          : null}
      </div>
    </div>
  );
}

// =================== CRYPTO / GITHUB HELPERS ===================
function createEmptyVault(): VaultData {
  return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
}

function loadStoredConfig(): GitHubConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<GitHubConfig>) };
  } catch { return null; }
}

function normalizeConfig(c: GitHubConfig): GitHubConfig {
  return {
    owner: c.owner.trim(),
    repo: c.repo.trim(),
    branch: c.branch.trim() || "main",
    path: c.path.trim().replace(/^\/+/, "") || DEFAULT_CONFIG.path,
    token: c.token.trim(),
    mediaOwner: c.mediaOwner?.trim() || "",
    mediaRepo: c.mediaRepo?.trim() || "",
    mediaBranch: c.mediaBranch?.trim() || "main",
    mediaPath: c.mediaPath?.trim() || "media",
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
    crypto: { name: "AES-GCM", kdf: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv) },
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
    } catch { throw new Error("Could not unlock the vault. Check your passphrase."); }
  }
  return normalizeVault(file);
}

function isEncryptedVaultFile(file: any): file is EncryptedVaultFile {
  return file && file.kind === "moonlit-diary-encrypted-vault";
}

function normalizeVault(vault: VaultData): VaultData {
  return {
    version: 1,
    updatedAt: vault.updatedAt || new Date().toISOString(),
    entries: Array.isArray(vault.entries) ? vault.entries.map(normalizeEntry) : [],
  };
}

function normalizeEntry(e: any): DiaryEntry {
  return {
    id: e.id || createId(),
    date: e.date,
    title: e.title || "Untitled",
    mood: (MOODS.find(m => m.id === e.mood)?.id) || "happy",
    bodyHtml: e.bodyHtml || "",
    dailyWin: e.dailyWin || "",
    attachments: Array.isArray(e.attachments) ? e.attachments.map((a: any) => normalizeAttachment(a)) : [],
    createdAt: e.createdAt || new Date().toISOString(),
    updatedAt: e.updatedAt || new Date().toISOString(),
  };
}

function normalizeAttachment(a: any): Attachment {
  return {
    id: a.id || createId(),
    name: a.name || "file",
    type: a.type || "application/octet-stream",
    size: typeof a.size === "number" ? a.size : 0,
    addedAt: a.addedAt || new Date().toISOString(),
    dataUrl: a.dataUrl,
    mediaUrl: a.mediaUrl,
    mediaPath: a.mediaPath,
    mediaSha: a.mediaSha,
  };
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function fetchGitHubVaultFile(config: GitHubConfig): Promise<{ exists: boolean; sha: string | null; text: string }> {
  const response = await fetch(gitHubVaultContentUrl(config), { headers: githubHeaders(config) });
  if (response.status === 404) return { exists: false, sha: null, text: "" };
  if (!response.ok) throw new Error(await githubErrorMessage(response));
  const data = await response.json() as { content?: string; encoding?: string; sha?: string; download_url?: string };
  if (data.content && data.encoding === "base64") return { exists: true, sha: data.sha ?? null, text: base64ToString(data.content.replace(/\s/g, "")) };
  if (data.download_url) {
    const r = await fetch(data.download_url, { headers: githubHeaders(config) });
    if (!r.ok) throw new Error(await githubErrorMessage(r));
    return { exists: true, sha: data.sha ?? null, text: await r.text() };
  }
  return { exists: true, sha: data.sha ?? null, text: "" };
}

async function putGitHubVaultFile(config: GitHubConfig, text: string, sha: string | null, message: string) {
  const body: any = { message, content: stringToBase64(text), branch: config.branch };
  if (sha) body.sha = sha;
  const response = await fetch(gitHubVaultContentUrl(config), { method: "PUT", headers: githubHeaders(config), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await githubErrorMessage(response));
  const data = await response.json() as { content?: { sha?: string } };
  return { sha: data.content?.sha ?? null };
}

function gitHubVaultContentUrl(config: GitHubConfig) {
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
    const data = await response.json() as { message?: string };
    return `GitHub ${response.status}: ${data.message ?? response.statusText}`;
  } catch { return `GitHub ${response.status}: ${response.statusText}`; }
}

function getExtensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  };
  return map[mime] || "";
}

function stringToBase64(value: string) { return bytesToBase64(new TextEncoder().encode(value)); }
function base64ToString(value: string) { return new TextDecoder().decode(base64ToBytes(value)); }

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dateToKey(date: Date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function keyToDate(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function extractTopicsAndTags(html: string, title: string): string[] {
  const text = `${title} ${htmlToText(html)}`.toLowerCase();
  const tags = new Set<string>();
  const hashMatches = text.match(/#\w+/g);
  if (hashMatches) hashMatches.forEach(m => tags.add(m.replace("#", "")));
  if (text.includes("alex")) tags.add("alex");
  if (text.includes("beach") || text.includes("ocean") || text.includes("sea")) tags.add("beach");
  if (text.includes("work") || text.includes("project") || text.includes("office")) tags.add("work");
  if (text.includes("gym") || text.includes("workout") || text.includes("run")) tags.add("fitness");
  if (text.includes("coding") || text.includes("code")) tags.add("dev");
  if (text.includes("family") || text.includes("home")) tags.add("family");
  return Array.from(tags);
}

function detectSentimentLabel(html: string): string {
  const t = htmlToText(html).toLowerCase();
  if (!t || t.length < 5) return "Neutral Focus";
  let pos = 0, heavy = 0;
  ["happy", "glad", "awesome", "great", "excited", "love", "win", "good", "proud", "grateful"].forEach(w => { if (t.includes(w)) pos++; });
  ["stressed", "tired", "sad", "depressed", "heavy", "overwhelmed", "anxious", "angry", "worry"].forEach(w => { if (t.includes(w)) heavy++; });
  if (pos > heavy) return "Energetic & Bright";
  if (heavy > pos) return "Reflective & Introspective";
  return "Balanced Reflection";
}

function addMonths(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function formatDateLong(key: string) {
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(keyToDate(key));
}

function buildMonthCells(monthDate: Date) {
  const y = monthDate.getFullYear(), m = monthDate.getMonth();
  const firstDay = new Date(y, m, 1);
  const gridStart = new Date(y, m, 1 - firstDay.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { date: d, dateKey: dateToKey(d), day: d.getDate(), inCurrentMonth: d.getMonth() === m };
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
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach(n => n.remove());
  const allowed = new Set(["A", "B", "BLOCKQUOTE", "BR", "DIV", "EM", "H1", "H2", "H3", "I", "LI", "OL", "P", "SPAN", "STRONG", "U", "UL"]);
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const els: Element[] = [];
  while (walker.nextNode()) els.push(walker.currentNode as Element);
  els.forEach(el => {
    if (!allowed.has(el.tagName)) {
      const w = document.createElement("span");
      w.innerHTML = el.innerHTML;
      el.replaceWith(...Array.from(w.childNodes));
      return;
    }
    Array.from(el.attributes).forEach(attr => {
      const n = attr.name.toLowerCase();
      const safeLink = el.tagName === "A" && ["href", "target", "rel"].includes(n);
      if (n.startsWith("on") || n === "style" || !safeLink) el.removeAttribute(attr.name);
    });
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      if (href && !/^(https?:|mailto:|tel:|#)/i.test(href)) el.removeAttribute("href");
      el.setAttribute("target", "_blank"); el.setAttribute("rel", "noreferrer");
    }
  });
  return tpl.innerHTML;
}

function totalAttachmentBytes(atts: Attachment[]) { return atts.reduce((t, a) => t + a.size, 0); }

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const p = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** p;
  return `${size.toFixed(size >= 10 || p === 0 ? 0 : 1)} ${units[p]}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

// Draft helpers
function saveDraft(draft: DraftEntry): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
}
function loadDraft(dateKey: string): DraftEntry | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftEntry;
    return d.dateKey === dateKey ? d : null;
  } catch { return null; }
}
function clearDraft(dateKey: string): void {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as DraftEntry;
      if (d.dateKey === dateKey) localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  } catch { /* ignore */ }
}
