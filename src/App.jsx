import { useState, useEffect, useCallback, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const USERS_KEY = "settle_users_v1";
const SESSION_KEY = "settle_session_v1";

const getUsers = () => { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch { return {}; } };
const saveUsers = (u) => { try { localStorage.setItem(USERS_KEY, JSON.stringify(u)); } catch {} };
const getSession = () => { try { return localStorage.getItem(SESSION_KEY) || null; } catch { return null; } };
const setSession = (u) => { try { if (u) localStorage.setItem(SESSION_KEY, u); else localStorage.removeItem(SESSION_KEY); } catch {} };

const getUserData = (username) => {
  const users = getUsers();
  return users[username]?.data || DEFAULT_DATA();
};
const saveUserData = (username, data) => {
  const users = getUsers();
  if (!users[username]) return;
  users[username].data = data;
  saveUsers(users);
};

// Simple hash (not cryptographic — client-side only, for UX separation of users)
const hashPass = async (s) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s + "settle_salt_2024"));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT DATA
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_DATA = () => ({ income: "", expenses: [], debts: [], payments: [], spareHistory: [] });

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const fmt = (n) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n || 0);
const todayStr = () => new Date().toISOString().split("T")[0];
let _uid = Date.now();
const uid = () => String(++_uid);

const nextMonthSameDay = (dateStr) => {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split("T")[0];
};

const isPastOrThisMonth = (dateStr) => {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d <= new Date(now.getFullYear(), now.getMonth() + 1, 0);
};

const monthLabel = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });

// ─────────────────────────────────────────────────────────────────────────────
// PLAN ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const buildPlan = (debts, payments) => {
  const paidMap = {};
  payments.forEach((p) => { paidMap[p.debtId] = (paidMap[p.debtId] || 0) + Number(p.amount); });

  return debts
    .filter((d) => !d.settled)
    .map((d) => {
      const totalPaid = paidMap[d.id] || 0;
      const remaining = Math.max(0, Number(d.balance) - totalPaid);
      let dueThisMonth = false;
      let effectiveDate = d.dueDate;

      if (d.type === "deadline") {
        if (d.dueDate && isPastOrThisMonth(d.dueDate)) {
          effectiveDate = nextMonthSameDay(d.dueDate);
        }
        dueThisMonth = d.dueDate ? isPastOrThisMonth(effectiveDate || d.dueDate) : false;
      } else if (d.type === "plan") {
        dueThisMonth = true;
      }

      const priority = d.type === "deadline" ? 1 : d.type === "plan" ? 2 : 3;
      return { ...d, remaining, dueThisMonth, effectiveDate, priority, totalPaid };
    })
    .sort((a, b) => a.priority - b.priority || a.remaining - b.remaining);
};

const allocateSpare = (amount, plan) => {
  let pot = Number(amount);
  const allocs = [];
  for (const d of plan.filter((d) => d.remaining > 0)) {
    if (pot <= 0) break;
    const take = Math.min(pot, d.remaining);
    allocs.push({ debtId: d.id, name: d.name, amount: take });
    pot -= take;
  }
  return { allocations: allocs, leftover: pot };
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;500;600&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #f5f0e8;
    --bg2: #ede8de;
    --surface: #ffffff;
    --surface2: #faf8f4;
    --border: #d8d0c0;
    --border2: #c8bfae;
    --ink: #1a1814;
    --ink2: #4a4540;
    --muted: #8c8478;
    --accent: #2d5a3d;
    --accent-light: #e8f2ec;
    --red: #b83232;
    --red-light: #faeaea;
    --gold: #9a6b1a;
    --gold-light: #fdf4e3;
    --blue: #1a4a6b;
    --blue-light: #e8f0f8;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'Syne', sans-serif;
  }

  html, body { background: var(--bg); color: var(--ink); font-family: var(--sans); min-height: 100vh; }

  /* ── AUTH SCREEN ── */
  .auth-wrap {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  @media (max-width: 680px) {
    .auth-wrap { grid-template-columns: 1fr; }
    .auth-left { display: none; }
  }

  .auth-left {
    background: var(--accent);
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 4rem 3rem;
    position: relative;
    overflow: hidden;
  }

  .auth-left::before {
    content: '';
    position: absolute;
    top: -80px; right: -80px;
    width: 320px; height: 320px;
    border-radius: 50%;
    background: rgba(255,255,255,0.06);
  }

  .auth-left::after {
    content: '';
    position: absolute;
    bottom: -60px; left: -60px;
    width: 240px; height: 240px;
    border-radius: 50%;
    background: rgba(255,255,255,0.04);
  }

  .auth-brand {
    font-family: var(--serif);
    font-size: 3.5rem;
    color: #fff;
    line-height: 1;
    margin-bottom: 1rem;
  }

  .auth-brand em { font-style: italic; color: rgba(255,255,255,0.7); }

  .auth-tagline {
    font-size: 0.75rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.55);
    margin-bottom: 3rem;
  }

  .auth-pillars { display: flex; flex-direction: column; gap: 1.2rem; }

  .auth-pillar {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .auth-pillar-icon {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: rgba(255,255,255,0.15);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .auth-pillar-text { font-size: 0.8rem; color: rgba(255,255,255,0.75); line-height: 1.5; }
  .auth-pillar-text strong { color: #fff; display: block; font-size: 0.85rem; margin-bottom: 0.1rem; }

  .auth-right {
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem 2rem;
  }

  .auth-box {
    width: 100%;
    max-width: 360px;
  }

  .auth-title {
    font-family: var(--serif);
    font-size: 1.8rem;
    margin-bottom: 0.3rem;
    color: var(--ink);
  }

  .auth-subtitle { font-size: 0.75rem; color: var(--muted); margin-bottom: 2rem; letter-spacing: 0.05em; }

  .auth-toggle {
    display: flex;
    background: var(--bg2);
    border-radius: 4px;
    padding: 3px;
    margin-bottom: 1.5rem;
    gap: 3px;
  }

  .auth-toggle-btn {
    flex: 1;
    background: none;
    border: none;
    border-radius: 3px;
    font-family: var(--sans);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.5rem;
    cursor: pointer;
    color: var(--muted);
    transition: all 0.2s;
  }

  .auth-toggle-btn.active {
    background: var(--surface);
    color: var(--ink);
    box-shadow: 0 1px 4px rgba(0,0,0,0.12);
  }

  .field { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.9rem; }

  label {
    font-size: 0.65rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  input, select {
    background: var(--bg2);
    border: 1.5px solid var(--border);
    border-radius: 4px;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 0.9rem;
    padding: 0.65rem 0.75rem;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
    width: 100%;
  }

  input:focus, select:focus {
    border-color: var(--accent);
    background: #fff;
  }

  select option { background: #fff; }

  .btn {
    background: var(--accent);
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-family: var(--sans);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    padding: 0.7rem 1.4rem;
    text-transform: uppercase;
    transition: opacity 0.15s, transform 0.1s;
    white-space: nowrap;
  }

  .btn:hover { opacity: 0.88; transform: translateY(-1px); }
  .btn:active { transform: none; opacity: 1; }
  .btn.full { width: 100%; }
  .btn.ghost {
    background: none;
    border: 1.5px solid var(--border);
    color: var(--ink2);
  }
  .btn.ghost:hover { border-color: var(--accent); color: var(--accent); }
  .btn.red { background: var(--red); }
  .btn.gold { background: var(--gold); }
  .btn.sm { font-size: 0.65rem; padding: 0.35rem 0.7rem; }

  .auth-error {
    background: var(--red-light);
    border: 1px solid #e8b0b0;
    border-radius: 4px;
    color: var(--red);
    font-size: 0.75rem;
    padding: 0.6rem 0.75rem;
    margin-bottom: 1rem;
  }

  /* ── APP CHROME ── */
  .app-wrap { min-height: 100vh; display: flex; flex-direction: column; }

  .topbar {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 1.5rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    height: 56px;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .topbar-brand {
    font-family: var(--serif);
    font-size: 1.5rem;
    color: var(--accent);
    line-height: 1;
    margin-right: auto;
  }

  .topbar-user {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.08em;
  }

  .topbar-user strong { color: var(--ink2); }

  /* ── STATS ── */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  @media (max-width: 640px) { .stats { grid-template-columns: repeat(2, 1fr); } }

  .stat {
    padding: 1.2rem 1.5rem;
    border-right: 1px solid var(--border);
  }

  .stat:last-child { border-right: none; }

  .stat-label {
    font-size: 0.6rem;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 0.35rem;
  }

  .stat-value {
    font-family: var(--serif);
    font-size: 1.55rem;
    line-height: 1;
    color: var(--ink);
  }

  .stat-value.red { color: var(--red); }
  .stat-value.green { color: var(--accent); }
  .stat-value.gold { color: var(--gold); }
  .stat-value.blue { color: var(--blue); }

  /* ── TABS ── */
  .tabs {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    padding: 0 1.5rem;
    gap: 0;
    overflow-x: auto;
  }

  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    cursor: pointer;
    font-family: var(--sans);
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.1em;
    padding: 0.9rem 1rem;
    text-transform: uppercase;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    margin-bottom: -1px;
  }

  .tab:hover:not(.active) { color: var(--ink2); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

  /* ── MAIN ── */
  .main { flex: 1; padding: 2rem 1.5rem 5rem; max-width: 860px; margin: 0 auto; width: 100%; }

  .panel { animation: rise 0.2s ease; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .section-title {
    font-family: var(--serif);
    font-size: 1.4rem;
    color: var(--ink);
    margin-bottom: 0.25rem;
  }

  .section-sub {
    font-size: 0.72rem;
    color: var(--muted);
    margin-bottom: 1.25rem;
    line-height: 1.5;
  }

  /* ── CARDS ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  /* ── FORM GRID ── */
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(175px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  /* ── PLAN ITEMS ── */
  .plan-section-label {
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 1.25rem 0 0.5rem;
  }

  .plan-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: 0 6px 6px 0;
    padding: 1rem 1.25rem;
    margin-bottom: 2px;
    display: grid;
    grid-template-columns: 28px 1fr auto;
    gap: 0.75rem;
    align-items: center;
    transition: box-shadow 0.15s;
  }

  .plan-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .plan-item.p1 { border-left-color: var(--red); }
  .plan-item.p2 { border-left-color: var(--blue); }
  .plan-item.p3 { border-left-color: var(--gold); }

  .plan-num {
    font-family: var(--serif);
    font-size: 1.3rem;
    color: var(--border2);
    text-align: center;
  }

  .plan-name { font-weight: 500; font-size: 0.9rem; margin-bottom: 0.2rem; }
  .plan-meta { font-size: 0.65rem; color: var(--muted); display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }

  .plan-amount {
    font-family: var(--serif);
    font-size: 1.15rem;
    text-align: right;
    white-space: nowrap;
  }

  /* ── DEBT ROWS ── */
  .debt-row {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin-bottom: 4px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1rem;
    align-items: start;
    transition: box-shadow 0.15s;
  }

  .debt-row:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .debt-row.settled { opacity: 0.5; }

  .debt-name {
    font-family: var(--serif);
    font-size: 1.1rem;
    margin-bottom: 0.3rem;
  }

  .debt-meta { font-size: 0.65rem; color: var(--muted); display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.2rem; }

  /* ── BADGES ── */
  .badge {
    font-size: 0.55rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.15rem 0.45rem;
    border-radius: 2px;
    font-weight: 600;
  }

  .badge.deadline { background: var(--red-light); color: var(--red); }
  .badge.plan { background: var(--blue-light); color: var(--blue); }
  .badge.free { background: var(--gold-light); color: var(--gold); }
  .badge.settled { background: var(--accent-light); color: var(--accent); }

  /* ── PROGRESS ── */
  .progress-wrap { background: var(--bg2); border-radius: 2px; height: 3px; margin-top: 0.5rem; overflow: hidden; max-width: 200px; }
  .progress-fill { height: 100%; border-radius: 2px; background: var(--accent); transition: width 0.4s ease; }

  /* ── EXPENSE ROWS ── */
  .exp-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .exp-row:last-child { border-bottom: none; }

  .exp-total {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.7rem 0;
    border-top: 2px solid var(--border);
    font-size: 0.85rem;
    font-weight: 600;
  }

  /* ── ALLOC ROWS ── */
  .alloc-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .alloc-row:last-child { border-bottom: none; }

  /* ── ALERT ── */
  .alert {
    background: var(--accent-light);
    border: 1px solid #b8d4c0;
    border-radius: 4px;
    color: var(--accent);
    font-size: 0.78rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1.25rem;
    line-height: 1.5;
  }

  .empty {
    color: var(--muted);
    font-size: 0.8rem;
    text-align: center;
    padding: 2.5rem 1rem;
    border: 1.5px dashed var(--border);
    border-radius: 6px;
  }

  .divider { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }

  .inline { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

  /* payment history */
  .pay-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .pay-row:last-child { border-bottom: none; }
  .pay-sub { font-size: 0.62rem; color: var(--muted); margin-top: 0.1rem; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// AUTH SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // login | register
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    if (!username.trim() || !password) { setError("Please fill in all fields."); return; }
    if (username.trim().length < 3) { setError("Username must be at least 3 characters."); return; }
    setLoading(true);

    const users = getUsers();
    const key = username.trim().toLowerCase();
    const hashed = await hashPass(password);

    if (mode === "register") {
      if (password.length < 6) { setError("Password must be at least 6 characters."); setLoading(false); return; }
      if (password !== confirm) { setError("Passwords don't match."); setLoading(false); return; }
      if (users[key]) { setError("That username is already taken."); setLoading(false); return; }
      users[key] = { username: username.trim(), passwordHash: hashed, data: DEFAULT_DATA() };
      saveUsers(users);
      setSession(key);
      onLogin(key, username.trim());
    } else {
      if (!users[key]) { setError("No account found with that username."); setLoading(false); return; }
      if (users[key].passwordHash !== hashed) { setError("Incorrect password."); setLoading(false); return; }
      setSession(key);
      onLogin(key, users[key].username);
    }
    setLoading(false);
  };

  const handleKey = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="auth-wrap">
      <div className="auth-left">
        <div className="auth-brand">Settle<em>.</em></div>
        <div className="auth-tagline">Your debt command centre</div>
        <div className="auth-pillars">
          {[
            { icon: "📋", title: "Monthly action plan", desc: "Exactly what to pay, in what order, every month." },
            { icon: "🧮", title: "Smart allocation", desc: "Drop in spare cash and we tell you where every penny goes." },
            { icon: "📈", title: "Real progress tracking", desc: "Watch your remaining debt shrink over time." },
          ].map((p) => (
            <div key={p.title} className="auth-pillar">
              <div className="auth-pillar-icon">{p.icon}</div>
              <div className="auth-pillar-text"><strong>{p.title}</strong>{p.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="auth-right">
        <div className="auth-box">
          <div className="auth-title">{mode === "login" ? "Welcome back." : "Get started."}</div>
          <div className="auth-subtitle">{mode === "login" ? "Sign in to your Settle account." : "Create your account — it takes 30 seconds."}</div>

          <div className="auth-toggle">
            <button className={`auth-toggle-btn ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
            <button className={`auth-toggle-btn ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setError(""); }}>Create account</button>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <div className="field">
            <label>Username</label>
            <input
              autoFocus
              placeholder="your_username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKey}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKey}
            />
          </div>

          {mode === "register" && (
            <div className="field">
              <label>Confirm password</label>
              <input
                type="password"
                placeholder="••••••••"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={handleKey}
              />
            </div>
          )}

          <button className="btn full" onClick={submit} disabled={loading} style={{ marginTop: "0.5rem" }}>
            {loading ? "…" : mode === "login" ? "Sign In →" : "Create Account →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function Settle() {
  const [userKey, setUserKey] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("dashboard");

  // forms
  const [dForm, setDF] = useState({ name: "", balance: "", type: "plan", dueDate: "", monthlyAmount: "", notes: "" });
  const [eForm, setEF] = useState({ name: "", amount: "" });
  const [pForm, setPF] = useState({ debtId: "", amount: "", note: "" });
  const [spare, setSpare] = useState("");
  const [spareResult, setSpareResult] = useState(null);

  // check session on mount
  useEffect(() => {
    const sess = getSession();
    if (sess) {
      const users = getUsers();
      if (users[sess]) {
        setUserKey(sess);
        setDisplayName(users[sess].username);
        setData(getUserData(sess));
      } else {
        setSession(null);
      }
    }
  }, []);

  const handleLogin = (key, name) => {
    setUserKey(key);
    setDisplayName(name);
    setData(getUserData(key));
  };

  const handleLogout = () => {
    setSession(null);
    setUserKey(null);
    setDisplayName("");
    setData(null);
    setTab("dashboard");
  };

  const update = useCallback((partial) => {
    setData((prev) => {
      const next = { ...prev, ...partial };
      if (userKey) saveUserData(userKey, next);
      return next;
    });
  }, [userKey]);

  if (!userKey || !data) return (
    <>
      <style>{CSS}</style>
      <AuthScreen onLogin={handleLogin} />
    </>
  );

  // ── derived ───────────────────────────────────────────────────────────────
  const plan = buildPlan(data.debts, data.payments);

  const totalDebt = data.debts.filter((d) => !d.settled).reduce((s, d) => {
    const paid = data.payments.filter((p) => p.debtId === d.id).reduce((a, p) => a + Number(p.amount), 0);
    return s + Math.max(0, Number(d.balance) - paid);
  }, 0);

  const totalPaid = data.payments.reduce((s, p) => s + Number(p.amount), 0);
  const totalExpenses = data.expenses.reduce((s, e) => s + Number(e.amount), 0);
  const monthlyDebtCost = data.debts.filter((d) => d.type === "plan" && !d.settled).reduce((s, d) => s + Number(d.monthlyAmount || 0), 0);
  const freeMoney = Math.max(0, Number(data.income || 0) - totalExpenses - monthlyDebtCost);
  const thisMonthDue = plan.filter((d) => d.dueThisMonth).reduce((s, d) =>
    s + (d.type === "plan" ? Number(d.monthlyAmount || 0) : d.remaining), 0);

  // ── add debt ──────────────────────────────────────────────────────────────
  const addDebt = () => {
    if (!dForm.name || !dForm.balance) return;
    const debt = { id: uid(), ...dForm, balance: Number(dForm.balance), settled: false, createdAt: todayStr() };
    update({ debts: [...data.debts, debt] });
    setDF({ name: "", balance: "", type: "plan", dueDate: "", monthlyAmount: "", notes: "" });
  };

  const settleDebt = (id) => update({ debts: data.debts.map((d) => d.id === id ? { ...d, settled: !d.settled } : d) });

  const removeDebt = (id) => update({
    debts: data.debts.filter((d) => d.id !== id),
    payments: data.payments.filter((p) => p.debtId !== id),
  });

  // ── expenses ──────────────────────────────────────────────────────────────
  const addExpense = () => {
    if (!eForm.name || !eForm.amount) return;
    update({ expenses: [...data.expenses, { id: uid(), ...eForm, amount: Number(eForm.amount) }] });
    setEF({ name: "", amount: "" });
  };

  // ── payment ───────────────────────────────────────────────────────────────
  const logPayment = () => {
    if (!pForm.debtId || !pForm.amount) return;
    const debt = data.debts.find((d) => d.id === pForm.debtId);
    const prevPaid = data.payments.filter((p) => p.debtId === pForm.debtId).reduce((s, p) => s + Number(p.amount), 0);
    const newPaid = prevPaid + Number(pForm.amount);
    const payment = { id: uid(), ...pForm, amount: Number(pForm.amount), date: todayStr() };
    let debts = data.debts;
    if (debt && newPaid >= Number(debt.balance)) debts = data.debts.map((d) => d.id === pForm.debtId ? { ...d, settled: true } : d);
    update({ payments: [...data.payments, payment], debts });
    setPF({ debtId: "", amount: "", note: "" });
  };

  // ── spare cash ────────────────────────────────────────────────────────────
  const runSpare = () => { if (!spare) return; setSpareResult(allocateSpare(spare, plan)); };

  const confirmSpare = () => {
    if (!spareResult) return;
    const newPayments = spareResult.allocations.map((a) => ({
      id: uid(), debtId: a.debtId, amount: a.amount, note: "Spare cash", date: todayStr(),
    }));
    let debts = [...data.debts];
    newPayments.forEach((np) => {
      const d = debts.find((d) => d.id === np.debtId); if (!d) return;
      const prev = data.payments.filter((p) => p.debtId === np.debtId).reduce((s, p) => s + Number(p.amount), 0);
      if (prev + np.amount >= Number(d.balance)) debts = debts.map((dd) => dd.id === np.debtId ? { ...dd, settled: true } : dd);
    });
    update({
      payments: [...data.payments, ...newPayments],
      debts,
      spareHistory: [...data.spareHistory, { id: uid(), amount: Number(spare), date: todayStr(), allocations: spareResult.allocations, leftover: spareResult.leftover }],
    });
    setSpare(""); setSpareResult(null);
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="app-wrap">

        {/* TOPBAR */}
        <div className="topbar">
          <div className="topbar-brand">Settle.</div>
          <div className="topbar-user">Signed in as <strong>{displayName}</strong></div>
          <button className="btn ghost sm" onClick={handleLogout}>Sign out</button>
        </div>

        {/* STATS */}
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Remaining Debt</div>
            <div className={`stat-value ${totalDebt > 0 ? "red" : "green"}`}>{fmt(totalDebt)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Total Paid Off</div>
            <div className="stat-value green">{fmt(totalPaid)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Due This Month</div>
            <div className="stat-value gold">{fmt(thisMonthDue)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Free Money / mo</div>
            <div className={`stat-value ${freeMoney > 0 ? "blue" : "red"}`}>{fmt(freeMoney)}</div>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          {[
            { key: "dashboard", label: "📋 This Month" },
            { key: "debts", label: "💳 My Debts" },
            { key: "budget", label: "🏠 Budget" },
            { key: "pay", label: "✅ Log Payment" },
            { key: "spare", label: "💰 Spare Cash" },
          ].map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        <div className="main">

          {/* ── DASHBOARD ── */}
          {tab === "dashboard" && (
            <div className="panel">
              <div className="section-title">{monthLabel}</div>
              <div className="section-sub">Your structured action plan for this month. Do these, in this order.</div>

              {freeMoney > 0 && (
                <div className="alert">
                  💡 After bills and agreed debt payments, you have <strong>{fmt(freeMoney)}</strong> free each month. When extra cash comes in, use the <strong>Spare Cash</strong> tab to allocate it instantly.
                </div>
              )}

              {plan.length === 0 ? (
                <div className="empty">No debts yet — add them in the My Debts tab to build your plan.</div>
              ) : (
                <>
                  {plan.filter((d) => d.dueThisMonth).length > 0 && (
                    <>
                      <div className="plan-section-label">Action now — due this month</div>
                      {plan.filter((d) => d.dueThisMonth).map((d, i) => {
                        const monthly = d.type === "plan" ? Number(d.monthlyAmount || 0) : d.remaining;
                        const pct = Math.min(100, (d.totalPaid / Number(d.balance)) * 100);
                        return (
                          <div key={d.id} className={`plan-item p${d.priority}`}>
                            <div className="plan-num">{i + 1}</div>
                            <div>
                              <div className="plan-name">{d.name}</div>
                              <div className="plan-meta">
                                <span className={`badge ${d.type}`}>{d.type === "deadline" ? "deadline" : d.type === "plan" ? "payment plan" : "free"}</span>
                                {d.type === "plan" && <span>Monthly: {fmt(d.monthlyAmount)}</span>}
                                {d.type === "deadline" && d.effectiveDate && <span>Due: {d.effectiveDate}</span>}
                                <span>Remaining: {fmt(d.remaining)}</span>
                              </div>
                              <div className="progress-wrap"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                            </div>
                            <div className="plan-amount">{fmt(monthly)}</div>
                          </div>
                        );
                      })}
                    </>
                  )}

                  {plan.filter((d) => !d.dueThisMonth).length > 0 && (
                    <>
                      <div className="plan-section-label">On the horizon — next to tackle</div>
                      {plan.filter((d) => !d.dueThisMonth).map((d, i) => {
                        const pct = Math.min(100, (d.totalPaid / Number(d.balance)) * 100);
                        return (
                          <div key={d.id} className={`plan-item p${d.priority}`}>
                            <div className="plan-num">{i + 1}</div>
                            <div>
                              <div className="plan-name">{d.name}</div>
                              <div className="plan-meta">
                                <span className={`badge ${d.type}`}>{d.type}</span>
                                {d.dueDate && <span>Due: {d.dueDate}</span>}
                                <span>Remaining: {fmt(d.remaining)}</span>
                              </div>
                              <div className="progress-wrap"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                            </div>
                            <div className="plan-amount">{fmt(d.remaining)}</div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── DEBTS ── */}
          {tab === "debts" && (
            <div className="panel">
              <div className="card">
                <div className="section-title">Add a Debt</div>
                <div className="section-sub">Choose the type carefully — it determines how it appears in your monthly plan.</div>
                <div className="form-grid">
                  <div className="field">
                    <label>Debt name</label>
                    <input placeholder="e.g. Barclaycard" value={dForm.name} onChange={(e) => setDF({ ...dForm, name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Total balance (£)</label>
                    <input type="number" placeholder="0.00" value={dForm.balance} onChange={(e) => setDF({ ...dForm, balance: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Type</label>
                    <select value={dForm.type} onChange={(e) => setDF({ ...dForm, type: e.target.value })}>
                      <option value="deadline">Deadline — must pay by date</option>
                      <option value="plan">Payment Plan — agreed monthly</option>
                      <option value="free">Free — pay when I can</option>
                    </select>
                  </div>
                  {dForm.type === "deadline" && (
                    <div className="field">
                      <label>Deadline date</label>
                      <input type="date" value={dForm.dueDate} onChange={(e) => setDF({ ...dForm, dueDate: e.target.value })} />
                    </div>
                  )}
                  {dForm.type === "plan" && (
                    <div className="field">
                      <label>Monthly agreed (£)</label>
                      <input type="number" placeholder="0.00" value={dForm.monthlyAmount} onChange={(e) => setDF({ ...dForm, monthlyAmount: e.target.value })} />
                    </div>
                  )}
                  <div className="field">
                    <label>Notes (optional)</label>
                    <input placeholder="e.g. 0% until June" value={dForm.notes} onChange={(e) => setDF({ ...dForm, notes: e.target.value })} />
                  </div>
                </div>
                <button className="btn" onClick={addDebt}>+ Add Debt</button>
              </div>

              <div className="section-title" style={{ marginBottom: "0.75rem" }}>Your Debts</div>
              {data.debts.length === 0 ? (
                <div className="empty">No debts added yet.</div>
              ) : (
                data.debts.map((d) => {
                  const paid = data.payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + Number(p.amount), 0);
                  const remaining = Math.max(0, Number(d.balance) - paid);
                  const pct = Math.min(100, (paid / Number(d.balance)) * 100);
                  return (
                    <div key={d.id} className={`debt-row ${d.settled ? "settled" : ""}`}>
                      <div>
                        <div className="inline" style={{ marginBottom: "0.3rem" }}>
                          <span className="debt-name">{d.name}</span>
                          <span className={`badge ${d.settled ? "settled" : d.type}`}>{d.settled ? "settled ✓" : d.type}</span>
                        </div>
                        <div className="debt-meta">
                          <span>Balance: {fmt(d.balance)}</span>
                          <span>Paid: {fmt(paid)}</span>
                          <span>Remaining: {fmt(remaining)}</span>
                          {d.dueDate && <span>Due: {d.dueDate}</span>}
                          {d.monthlyAmount && <span>Monthly: {fmt(d.monthlyAmount)}</span>}
                          {d.notes && <span>📝 {d.notes}</span>}
                        </div>
                        <div className="progress-wrap"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <button className="btn ghost sm" onClick={() => settleDebt(d.id)}>{d.settled ? "Reopen" : "Settle ✓"}</button>
                        <button className="btn red sm" onClick={() => removeDebt(d.id)}>Remove</button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* ── BUDGET ── */}
          {tab === "budget" && (
            <div className="panel">
              <div className="card">
                <div className="section-title">Monthly Income</div>
                <div className="form-grid" style={{ marginTop: "0.75rem" }}>
                  <div className="field">
                    <label>Take-home income (£/mo)</label>
                    <input type="number" placeholder="0.00" value={data.income} onChange={(e) => update({ income: e.target.value })} />
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="section-title">Living Expenses</div>
                <div className="section-sub">Everything that goes out regularly — rent, food, subscriptions, transport. Don't add debt payments here, they're calculated separately.</div>
                <div className="form-grid">
                  <div className="field">
                    <label>Expense name</label>
                    <input placeholder="e.g. Rent" value={eForm.name} onChange={(e) => setEF({ ...eForm, name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Monthly amount (£)</label>
                    <input type="number" placeholder="0.00" value={eForm.amount} onChange={(e) => setEF({ ...eForm, amount: e.target.value })} />
                  </div>
                </div>
                <button className="btn" onClick={addExpense}>+ Add Expense</button>
              </div>

              {data.expenses.length > 0 && (
                <div className="card">
                  <div className="section-title" style={{ marginBottom: "1rem" }}>Budget Breakdown</div>
                  {data.expenses.map((e) => (
                    <div key={e.id} className="exp-row">
                      <span>{e.name}</span>
                      <div className="inline">
                        <span style={{ color: "var(--red)" }}>{fmt(e.amount)}</span>
                        <button className="btn ghost sm" onClick={() => update({ expenses: data.expenses.filter((ex) => ex.id !== e.id) })}>×</button>
                      </div>
                    </div>
                  ))}
                  <div className="exp-total"><span>Total Expenses</span><span style={{ color: "var(--red)" }}>{fmt(totalExpenses)}</span></div>
                  <div className="exp-row"><span>Agreed Debt Payments</span><span style={{ color: "var(--blue)" }}>{fmt(monthlyDebtCost)}</span></div>
                  <div className="exp-row" style={{ fontFamily: "var(--serif)", fontSize: "1.1rem", borderBottom: "none", paddingTop: "0.75rem" }}>
                    <span>Free Money</span>
                    <span style={{ color: freeMoney > 0 ? "var(--accent)" : "var(--red)" }}>{fmt(freeMoney)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── LOG PAYMENT ── */}
          {tab === "pay" && (
            <div className="panel">
              <div className="card">
                <div className="section-title">Log a Payment</div>
                <div className="section-sub">Record every payment you make. Debts auto-settle when the balance hits zero.</div>
                <div className="form-grid">
                  <div className="field">
                    <label>Which debt?</label>
                    <select value={pForm.debtId} onChange={(e) => setPF({ ...pForm, debtId: e.target.value })}>
                      <option value="">Select…</option>
                      {data.debts.filter((d) => !d.settled).map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Amount paid (£)</label>
                    <input type="number" placeholder="0.00" value={pForm.amount} onChange={(e) => setPF({ ...pForm, amount: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Note (optional)</label>
                    <input placeholder="e.g. Direct debit" value={pForm.note} onChange={(e) => setPF({ ...pForm, note: e.target.value })} />
                  </div>
                </div>
                <button className="btn" onClick={logPayment}>✓ Log Payment</button>
              </div>

              <div className="section-title" style={{ marginBottom: "0.75rem" }}>Payment History</div>
              {data.payments.length === 0 ? (
                <div className="empty">No payments logged yet.</div>
              ) : (
                <div className="card" style={{ padding: "0.5rem 1.25rem" }}>
                  {[...data.payments].reverse().map((p) => {
                    const debt = data.debts.find((d) => d.id === p.debtId);
                    return (
                      <div key={p.id} className="pay-row">
                        <div>
                          <div>{debt?.name || "Unknown"}</div>
                          <div className="pay-sub">{p.date}{p.note ? ` · ${p.note}` : ""}</div>
                        </div>
                        <span style={{ color: "var(--accent)", fontFamily: "var(--serif)" }}>+{fmt(p.amount)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── SPARE CASH ── */}
          {tab === "spare" && (
            <div className="panel">
              <div className="card">
                <div className="section-title">Spare Cash Allocator</div>
                <div className="section-sub">Got unexpected money? Enter the amount and Settle tells you exactly where every penny goes — highest priority first. Zero thinking required.</div>
                <div className="form-grid">
                  <div className="field">
                    <label>Amount available (£)</label>
                    <input type="number" placeholder="0.00" value={spare} onChange={(e) => { setSpare(e.target.value); setSpareResult(null); }} />
                  </div>
                </div>
                <button className="btn gold" onClick={runSpare}>Calculate Allocation →</button>

                {spareResult && (
                  <div style={{ marginTop: "1.5rem", borderTop: "1px solid var(--border)", paddingTop: "1.25rem" }}>
                    <div style={{ fontSize: "0.65rem", letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "0.75rem" }}>Here's exactly where it goes:</div>
                    {spareResult.allocations.map((a) => (
                      <div key={a.debtId} className="alloc-row">
                        <span>{a.name}</span>
                        <span style={{ color: "var(--accent)", fontFamily: "var(--serif)" }}>{fmt(a.amount)}</span>
                      </div>
                    ))}
                    {spareResult.leftover > 0.01 && (
                      <div className="alloc-row">
                        <span style={{ color: "var(--muted)" }}>Leftover (all debts covered!)</span>
                        <span style={{ color: "var(--accent)" }}>{fmt(spareResult.leftover)}</span>
                      </div>
                    )}
                    <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
                      <button className="btn" onClick={confirmSpare}>✓ Confirm &amp; Log</button>
                      <button className="btn ghost" onClick={() => setSpareResult(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>

              {data.spareHistory.length > 0 && (
                <>
                  <div className="section-title" style={{ marginBottom: "0.75rem" }}>Allocation History</div>
                  <div className="card" style={{ padding: "0.5rem 1.25rem" }}>
                    {[...data.spareHistory].reverse().map((h) => (
                      <div key={h.id} className="pay-row">
                        <div>
                          <div>{fmt(h.amount)} allocated across {h.allocations.length} debt{h.allocations.length !== 1 ? "s" : ""}</div>
                          <div className="pay-sub">{h.date}</div>
                        </div>
                        {h.leftover > 0.01 && <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{fmt(h.leftover)} left over</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </>
  );
}
