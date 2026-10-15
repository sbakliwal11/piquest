"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, Camera, CheckCircle2, Clock3, GraduationCap, History, ImagePlus,
  Lightbulb, ListOrdered, LoaderCircle, LogOut, MessagesSquare, Plus, Sparkles,
  X, ChevronLeft, FileText, ListChecks, Trash2, CheckSquare
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { createBrowserSupabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import type { LearningSolution } from "@/lib/types";

type Mode = "clue" | "approach" | "solve" | "easy";
type HistoryRow = {
  id: string;
  question_text: string;
  subject: string;
  difficulty: string;
  solution_snapshot: LearningSolution;
  created_at: string;
};

const modes: { id: Mode; title: string; subtitle: string; icon: typeof Lightbulb }[] = [
  { id: "clue", title: "Give me a clue", subtitle: "A hint, not the answer", icon: Lightbulb },
  { id: "approach", title: "How do I do this?", subtitle: "Explain it like a friend", icon: MessagesSquare },
  { id: "solve", title: "Solve the problem", subtitle: "Reveal logical steps", icon: ListOrdered },
  { id: "easy", title: "Detailed solution", subtitle: "Very Easy + key lesson", icon: BookOpen },
];

function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{children}</ReactMarkdown></div>;
}

export default function HomePage() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [diagramErrorMessage, setDiagramErrorMessage] = useState("");
  const [solution, setSolution] = useState<LearningSolution | null>(null);
  const [shownQuestion, setShownQuestion] = useState("");
  const [selectedMode, setSelectedMode] = useState<Mode>("clue");
  const [openSteps, setOpenSteps] = useState<number[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [manageHistory, setManageHistory] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) {
        setSession(data.session);
        setAuthReady(true);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  const currentUsername = session?.user?.user_metadata?.username || username || "Student";

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
      setAuthError("Choose a username with 3–24 letters, numbers or underscores.");
      return;
    }
    if (password.length < 8) {
      setAuthError("Use a password with at least 8 characters.");
      return;
    }
    setAuthBusy(true);
    const emailAlias = `${cleanUsername}@users.stepwise.invalid`;
    try {
      if (authMode === "register") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: emailAlias,
          password,
          options: { data: { username: cleanUsername } },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setAuthNotice("Your account may have been created, but Supabase is still asking for email confirmation. In Supabase, turn off Confirm email, then try logging in.");
        } else {
          if (!data.user) {
            throw new Error("Account creation returned a session without a user. Please try again.");
          }
          await supabase.from("profiles").upsert({ id: data.user.id, username: cleanUsername });
          setAuthNotice("Account created. Welcome to Stepwise!");
        }
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: emailAlias,
          password,
        });
        if (signInError) throw signInError;
        if (data.user) {
          await supabase.from("profiles").upsert({ id: data.user.id, username: cleanUsername });
        }
      }
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Could not authenticate. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function onFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (JPG, PNG or WEBP).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Please use an image smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageFile(file);
      setImageDataUrl(String(reader.result));
    };
    reader.onerror = () => setError("We couldn't read that image. Please try another one.");
    reader.readAsDataURL(file);
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    setError("");
    setDiagramErrorMessage("");
    if (!imageDataUrl) {
      setError("Please upload a clear image of one complete Maths or Physics question.");
      return;
    }
    setLoading(true);
    setSolution(null);
    setOpenSteps([]);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session has expired. Please log in again.");
      const response = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageDataUrl }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Couldn't solve this question. Please try again.");
      setSolution(result.solution);
      setDiagramErrorMessage(result.diagramError ? (result.diagramErrorMessage || "Here is the solution. There was some problem in generating the diagram. Please try again later if you want the diagram.") : "");
      setShownQuestion(result.questionText || "Question from uploaded image");
      setSelectedMode("clue");
      setImageFile(null);
      setImageDataUrl(null);
      if (fileInput.current) fileInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    setHistoryOpen(true);
    setManageHistory(false);
    setSelectedHistoryIds([]);
    setHistoryBusy(true);
    const { data, error: historyError } = await supabase
      .from("question_history")
      .select("id, question_text, subject, difficulty, solution_snapshot, created_at")
      .order("created_at", { ascending: false })
      .limit(40);
    if (historyError) setError("Couldn't load history: " + historyError.message);
    setHistoryRows((data || []) as HistoryRow[]);
    setHistoryBusy(false);
  }

  function toggleHistorySelection(id: string) {
    setSelectedHistoryIds(old => old.includes(id) ? old.filter(item => item !== id) : [...old, id]);
  }

  async function deleteSelectedHistory() {
    if (!selectedHistoryIds.length || deleteBusy) return;
    const confirmed = window.confirm(`Delete ${selectedHistoryIds.length} selected history item${selectedHistoryIds.length === 1 ? "" : "s"}? This cannot be undone.`);
    if (!confirmed) return;
    setDeleteBusy(true);
    const { error: deleteError } = await supabase.from("question_history").delete().in("id", selectedHistoryIds);
    if (deleteError) {
      setError("Couldn't delete selected history: " + deleteError.message);
    } else {
      setHistoryRows(rows => rows.filter(row => !selectedHistoryIds.includes(row.id)));
      setSelectedHistoryIds([]);
      if (historyRows.length === selectedHistoryIds.length) setManageHistory(false);
    }
    setDeleteBusy(false);
  }

  function openPastQuestion(row: HistoryRow) {
    setSolution(row.solution_snapshot);
    setDiagramErrorMessage(row.solution_snapshot.diagramStatus === "error" ? "Here is the solution. There was some problem in generating the diagram. Please try again later if you want the diagram." : "");
    setShownQuestion(row.question_text);
    setSelectedMode("clue");
    setOpenSteps([]);
    setHistoryOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSolution(null);
    setShownQuestion("");
  }

  if (!authReady) {
    return <main className="app-shell"><div className="loading"><LoaderCircle className="spin" /> Loading Stepwise…</div></main>;
  }

  if (!session) {
    return (
      <main className="app-shell">
        <div className="auth-wrap">
          <div className="brand" style={{ marginBottom: 22 }}>
            <div className="brand-mark"><GraduationCap size={23} /></div>
            <span>Stepwise</span>
          </div>
          <div className="auth-card">
            <div className="eyebrow"><Sparkles size={14} /> LEARN BY UNDERSTANDING</div>
            <h1 style={{ fontSize: "2.15rem" }}>{authMode === "register" ? "Start learning smarter." : "Welcome back."}</h1>
            <p className="muted">{authMode === "register" ? "Create an account to keep your questions and revisit them anytime." : "Log in to continue learning from where you left off."}</p>
            <form onSubmit={handleAuth}>
              <label className="field-label" htmlFor="username">Username</label>
              <input id="username" className="field" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="e.g. physics_learner" required minLength={3} maxLength={24} />
              <label className="field-label" htmlFor="password">Password</label>
              <input id="password" className="field" type="password" autoComplete={authMode === "register" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
              <p className="small-note">Use a username you can remember. This early version does not collect an email address, so password recovery is not available.</p>
              {authError && <div className="error">{authError}</div>}
              {authNotice && <div className="success">{authNotice}</div>}
              <button className="button button-primary full" type="submit" disabled={authBusy}>
                {authBusy ? <LoaderCircle size={18} className="spin" /> : null}
                {authMode === "register" ? "Create free account" : "Log in"}
              </button>
            </form>
            <p style={{ textAlign: "center", marginBottom: 0 }}>
              <span className="muted">{authMode === "register" ? "Already have an account?" : "New to Stepwise?"} </span>
              <button className="auth-switch" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); setAuthNotice(""); }}>
                {authMode === "register" ? "Log in" : "Create account"}
              </button>
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><GraduationCap size={23} /></div><span>Stepwise</span></div>
        <div className="top-actions">
          <button className="button button-secondary button-small" onClick={loadHistory}><History size={16} /><span className="optional-label">History</span></button>
          <button className="button button-quiet button-small" onClick={signOut}><LogOut size={16} /><span className="optional-label">Log out</span></button>
        </div>
      </header>

      <div className="page">
        {!solution && (
          <>
            <section className="hero">
              <div className="eyebrow"><Sparkles size={14} /> YOUR PERSONAL PROBLEM-SOLVING GUIDE</div>
              <h1>Learn how to solve.<br /><span>Not just what to answer.</span></h1>
              <p>Hi {currentUsername}. Bring a Maths or Physics question, and we&apos;ll help you build the reasoning to solve it yourself.</p>
            </section>
            <form className="panel" onSubmit={submitQuestion}>
              <label className="question-label">Upload a picture of your question</label>
              <p className="muted" style={{ marginTop: -4, marginBottom: 14 }}>Upload one clear image showing one complete Maths or Physics question, including all text, diagrams, values and answer choices. Do not upload multiple questions or separate fragments of one question.</p>
              <div className="input-tools">
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden onChange={onFileSelected} />
                <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onFileSelected} />
                <button className="button button-secondary" type="button" onClick={() => fileInput.current?.click()}><ImagePlus size={18} /> Upload image</button>
                <button className="button button-secondary" type="button" onClick={() => cameraInput.current?.click()}><Camera size={18} /> Take photo</button>
                {imageFile && <button className="button button-quiet button-small" type="button" onClick={() => { setImageFile(null); setImageDataUrl(null); if(fileInput.current) fileInput.current.value=""; if(cameraInput.current) cameraInput.current.value=""; }}><X size={15} /> Remove</button>}
              </div>
              {imageFile && <div className="file-name"><FileText size={15} style={{ display: "inline", verticalAlign: "middle", marginRight: 5 }} />{imageFile.name}</div>}
              {imageDataUrl && <img src={imageDataUrl} alt="Selected question preview" style={{ display: "block", maxHeight: 210, maxWidth: "100%", marginTop: 14, borderRadius: 12, border: "1px solid #e5e7eb" }} />}
              {error && <div className="error">{error}</div>}
              <div className="submit-row">
                <span className="small-note">Clear photos work best. JPG, PNG or WEBP · Maximum image size: 5 MB.</span>
                <button className="button button-primary" type="submit" disabled={loading || !imageDataUrl}>
                  {loading ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
                  {loading ? "Understanding question…" : "Help me learn"}
                </button>
              </div>
            </form>
            {loading && <div className="loading"><LoaderCircle size={22} className="spin" /><p>Reading the question and preparing your learning guide. This can take a little while.</p></div>}
          </>
        )}

        {solution && (
          <section>
            <button className="button button-quiet button-small" onClick={() => { setSolution(null); setError(""); setDiagramErrorMessage(""); setOpenSteps([]); }}><ChevronLeft size={16} /> New question</button>
            <div style={{ marginTop: 20 }} className="section-head">
              <div>
                <div className="eyebrow"><CheckCircle2 size={14} /> YOUR LEARNING GUIDE</div>
                <h1 style={{ fontSize: "clamp(1.7rem, 4vw, 2.5rem)" }}>Let&apos;s work it out.</h1>
                <div className="meta-row"><span className="pill">{solution.subject || "Subject"}</span><span className="pill">{solution.classLevel || "School level"}</span><span className="pill">Difficulty: {solution.difficulty || "Estimated"}</span></div>
              </div>
            </div>
            <div className="question-summary"><strong>Question</strong><br />{shownQuestion}</div>
            <div className="mode-grid">
              {modes.map(mode => {
                const Icon = mode.icon;
                return <button key={mode.id} className={`mode-button ${selectedMode === mode.id ? "active" : ""}`} onClick={() => setSelectedMode(mode.id)}>
                  <Icon size={21} /><div>{mode.title}</div><span>{mode.subtitle}</span>
                </button>;
              })}
            </div>
            <div className="content-card">
              {selectedMode === "clue" && <>
                <h2><Lightbulb size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />A small hint to get you started</h2>
                <Markdown>{solution.clue}</Markdown>
              </>}
              {selectedMode === "approach" && <>
                <h2><MessagesSquare size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Think it through like a friend</h2>
                <Markdown>{solution.approach}</Markdown>
              </>}
              {selectedMode === "solve" && <>
                <h2><ListOrdered size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Step-by-step solution</h2>
                <p className="muted">Open one logical step at a time. Each idea, equation, and calculation is shown separately so you can follow the reasoning without a wall of text.</p>
                <div className="step-list">
                  {solution.steps.map((step, index) => {
                    const isOpen = openSteps.includes(index);
                    return <div className="step" key={`${index}-${step.title}`}>
                      <button className="step-toggle" onClick={() => setOpenSteps(old => isOpen ? old.filter(i => i !== index) : [...old, index])}>
                        <span className="plus-badge">{isOpen ? "−" : "+"}</span>
                        <span className="step-title"><span className="muted" style={{ display: "block", fontSize: ".72rem", marginBottom: 3 }}>STEP {index + 1}</span>{step.title}</span>
                      </button>
                      {isOpen && <div className="step-content"><Markdown>{step.explanation}</Markdown></div>}
                    </div>;
                  })}
                </div>
                {solution.veryEasy.answer && <div className="final-answer"><h3>Final answer</h3><Markdown>{solution.veryEasy.answer}</Markdown></div>}
              </>}
              {selectedMode === "easy" && <>
                <h2><BookOpen size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Very Easy explanation</h2>
                <p>{solution.veryEasy.intro}</p>
                {solution.veryEasy.sections.map((section, i) => <section key={i}><h3 style={{ marginTop: 22 }}>{section.title}</h3><Markdown>{section.content}</Markdown></section>)}
                <div className="lesson"><h3>Key lesson learned</h3><Markdown>{solution.veryEasy.keyLesson}</Markdown></div>
                {solution.veryEasy.answer && <div style={{ marginTop: 18 }}><h3>Final answer</h3><Markdown>{solution.veryEasy.answer}</Markdown></div>}
              </>}
            </div>
            {Array.isArray(solution.diagrams) && solution.diagrams.length > 0 && <section className="diagram-gallery" style={{ marginTop: 22 }}>
              <h2 style={{ marginBottom: 10 }}><ImagePlus size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Diagram{solution.diagrams.length === 1 ? "" : "s"} for this question</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16 }}>
                {solution.diagrams.map((diagram, index) => <figure key={diagram.id || index} style={{ margin: 0, padding: 12, border: "1px solid var(--border, #e2e8f0)", borderRadius: 14, background: "var(--card, #fff)" }}>
                  <img src={diagram.imageUrl} alt={diagram.alt || `Diagram ${index + 1}`} loading="lazy" style={{ display: "block", width: "100%", height: "auto", borderRadius: 8 }} />
                  <figcaption className="small-note" style={{ marginTop: 8 }}>{diagram.alt || `Diagram ${index + 1}`}</figcaption>
                </figure>)}
              </div>
            </section>}
            {diagramErrorMessage && <div role="status" className="diagram-error-message" style={{ marginTop: 16, padding: 14, border: "1px solid #f0d5a8", borderRadius: 12, background: "#fff8eb", color: "#754c12", lineHeight: 1.5 }}>{diagramErrorMessage}</div>}
            <div style={{ textAlign: "center", marginTop: 22 }}><button className="button button-primary" onClick={() => { setSolution(null); setShownQuestion(""); setError(""); setDiagramErrorMessage(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Plus size={18} /> Try another question</button></div>
          </section>
        )}
        <footer className="footer">Stepwise helps you learn the reasoning. Always check important exam answers against your textbook or teacher.</footer>
      </div>

      {historyOpen && <div className="history-panel" onClick={() => setHistoryOpen(false)}>
        <aside className="history-drawer" onClick={e => e.stopPropagation()}>
          <div className="section-head"><div><h2><Clock3 size={20} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Your question history</h2><p className="small-note">Your past questions are private to your account.</p></div><div className="history-actions">{historyRows.length > 0 && <button className={`button button-small ${manageHistory ? "button-primary" : "button-secondary"}`} onClick={() => { setManageHistory(value => !value); setSelectedHistoryIds([]); }} title={manageHistory ? "Finish managing history" : "Manage history"}>{manageHistory ? <CheckSquare size={16} /> : <ListChecks size={16} />}<span>{manageHistory ? "Done" : "Manage"}</span></button>}<button className="button button-quiet button-small" onClick={() => setHistoryOpen(false)} aria-label="Close history"><X size={16} /></button></div></div>
          {manageHistory && historyRows.length > 0 && <div className="history-manage-bar"><span>{selectedHistoryIds.length} selected</span><button className="button button-danger button-small" disabled={!selectedHistoryIds.length || deleteBusy} onClick={deleteSelectedHistory}><Trash2 size={15} />{deleteBusy ? "Deleting…" : "Delete selected"}</button></div>}
          {historyBusy ? <div className="loading"><LoaderCircle size={20} className="spin" /> Loading history…</div> : historyRows.length === 0 ? <div className="loading">No saved questions yet. Your solved questions will appear here.</div> : historyRows.map(row => <div key={row.id} className={`history-item ${selectedHistoryIds.includes(row.id) ? "history-item-selected" : ""}`}>
            <div className="history-row-content">{manageHistory && <input className="history-checkbox" type="checkbox" aria-label={`Select history item: ${row.question_text.slice(0, 60)}`} checked={selectedHistoryIds.includes(row.id)} onChange={() => toggleHistorySelection(row.id)} />}<button className="history-open-button" onClick={() => manageHistory ? toggleHistorySelection(row.id) : openPastQuestion(row)}><strong>{row.question_text.slice(0, 145)}{row.question_text.length > 145 ? "…" : ""}</strong><div className="meta-row"><span className="pill">{row.subject}</span><span className="pill">{row.difficulty}</span></div><div className="small-note" style={{ marginTop: 8 }}>{new Date(row.created_at).toLocaleString()}</div></button></div>
          </div>)}
        </aside>
      </div>}
    </main>
  );
}
