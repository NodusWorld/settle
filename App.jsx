// SETTLE — Supabase backend version
import { useState, useEffect, useCallback } from "react";

const SUPABASE_URL = "https://typvhhdgecychmcmstls.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5cHZoaGRnZWN5Y2htY21zdGxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM5MjM4MDIsImV4cCI6MjA1OTQ5OTgwMn0.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5cHZoaGRnZWN5Y2htY21zdGxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM5MjM4MDIsImV4cCI6MjA1OTQ5OTgwMn0";

// ── Supabase client (no SDK needed — raw fetch) ───────────────────────────────
const sb = {
  headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  authHeaders: (token) => ({ "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json", "Authorization": `Bearer ${token}` }),

  async signUp(email, password) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, { method: "POST", headers: sb.headers, body: JSON.stringify({ email, password }) });
    return r.json();
  },
  async signIn(email, password) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: sb.headers, body: JSON.stringify({ email, password }) });
    return r.json();
  },
  async signOut(token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: sb.authHeaders(token) });
  },
  async getSession() {
    try {
      const stored = localStorage.getItem("settle_sb_session");
      if (!stored) return null;
      const session = JSON.parse(stored);
      // Refresh if needed
      if (session.expires_at && Date.now() / 1000 > session.expires_at - 60) {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST", headers: sb.headers, body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        const fresh = await r.json();
        if (fresh.access_token) {
          localStorage.setItem("settle_sb_session", JSON.stringify(fresh));
          return fresh;
        }
        return null;
      }
      return session;
    } catch { return null; }
  },
  async loadData(token, userId) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_data?id=eq.${userId}&select=data`, { headers: sb.authHeaders(token) });
    const rows = await r.json();
    return rows?.[0]?.data || null;
  },
  async saveData(token, userId, data) {
    await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method: "POST",
      headers: { ...sb.authHeaders(token), "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, data, updated_at: new Date().toISOString() })
    });
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────
const DEBT_TYPES = [
  { value: "ccj",             label: "CCJ" },
  { value: "deadline",        label: "Deadline Date" },
  { value: "dmp",             label: "DMP" },
  { value: "parking_council", label: "Parking (Council)" },
  { value: "plan",            label: "Payment Plan — Agreed" },
  { value: "parking_private", label: "Parking (Private)" },
  { value: "in_dispute",      label: "In Dispute" },
  { value: "free",            label: "Free — Pay When I Can" },
];
const TYPE_PRIORITY = { ccj:1,deadline:2,dmp:3,parking_council:4,plan:5,parking_private:6,in_dispute:7,free:8 };
const TYPE_STYLE = {
  dmp:             {bg:"#e8f0f8",color:"#1a4a6b",border:"#b0c8e0"},
  ccj:             {bg:"#faeaea",color:"#b83232",border:"#e8b0b0"},
  parking_private: {bg:"#fdf4e3",color:"#9a6b1a",border:"#e8d0a0"},
  parking_council: {bg:"#fff0e8",color:"#c05010",border:"#e8c0a0"},
  plan:            {bg:"#e8f2ec",color:"#2d5a3d",border:"#a0c8b0"},
  in_dispute:      {bg:"#f5f0ff",color:"#6040a0",border:"#c8b0e8"},
  free:            {bg:"#f0f0f0",color:"#505050",border:"#c0c0c0"},
  deadline:        {bg:"#faeaea",color:"#b83232",border:"#e8b0b0"},
  settled:         {bg:"#e8f2ec",color:"#2d5a3d",border:"#a0c8b0"},
};
const EMPTY_DEBT  = {name:"",balance:"",type:"plan",dueDate:"",monthlyAmount:"",nextAction:"",notes:"",reference:""};
const DEFAULT_DATA = () => ({income:"",expenses:[],debts:[],payments:[],spareHistory:[]});

// ── Utils ─────────────────────────────────────────────────────────────────────
const fmt = (n) => new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(n||0);
const todayStr = () => new Date().toISOString().split("T")[0];
let _uid = Date.now();
const uid = () => String(++_uid);
const nextMonthSameDay = (ds) => { const d=new Date(ds); d.setMonth(d.getMonth()+1); return d.toISOString().split("T")[0]; };
const isPastOrThisMonth = (ds) => { if(!ds) return false; const d=new Date(ds),n=new Date(); return d<=new Date(n.getFullYear(),n.getMonth()+1,0); };
const monthLabel = new Date().toLocaleDateString("en-GB",{month:"long",year:"numeric"});
const typeLabel = (v) => DEBT_TYPES.find(t=>t.value===v)?.label||v;
const isMonthly = (t) => ["plan","dmp","ccj"].includes(t);

// ── Plan engine ───────────────────────────────────────────────────────────────
const buildPlan = (debts, payments) => {
  const pm={};
  payments.forEach(p=>{ pm[p.debtId]=(pm[p.debtId]||0)+Number(p.amount); });
  return debts.filter(d=>!d.settled).map(d=>{
    const totalPaid=pm[d.id]||0;
    const remaining=Math.max(0,Number(d.balance)-totalPaid);
    let dueThisMonth=false, effectiveDate=d.dueDate;
    if(d.type==="deadline"){ if(d.dueDate&&isPastOrThisMonth(d.dueDate)) effectiveDate=nextMonthSameDay(d.dueDate); dueThisMonth=d.dueDate?isPastOrThisMonth(effectiveDate||d.dueDate):false; }
    else if(isMonthly(d.type)) dueThisMonth=true;
    return {...d,remaining,dueThisMonth,effectiveDate,priority:TYPE_PRIORITY[d.type]||9,totalPaid};
  }).sort((a,b)=>a.priority-b.priority||a.remaining-b.remaining);
};
const allocateSpare = (amount,plan) => {
  let pot=Number(amount); const allocs=[];
  for(const d of plan.filter(d=>d.remaining>0)){ if(pot<=0) break; const take=Math.min(pot,d.remaining); allocs.push({debtId:d.id,name:d.name,amount:take}); pot-=take; }
  return {allocations:allocs,leftover:pot};
};

// ── Excel import ──────────────────────────────────────────────────────────────
const loadSheetJS = () => new Promise((res,rej)=>{ if(window.XLSX){res(window.XLSX);return;} const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"; s.onload=()=>res(window.XLSX); s.onerror=rej; document.head.appendChild(s); });
const parseSpreadsheet = async (file) => { const XLSX=await loadSheetJS(); const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:"array"}); const ws=wb.Sheets[wb.SheetNames[0]]; return XLSX.utils.sheet_to_json(ws,{defval:""}); };
const OUR_COLS = [
  {key:"name",         label:"Debt Owner / Name",   required:true },
  {key:"type",         label:"Type",                required:true },
  {key:"balance",      label:"Amount Owed (Total)", required:true },
  {key:"paid",         label:"Total Amount Paid",   required:false},
  {key:"monthlyAmount",label:"Monthly Payment (£)", required:false},
  {key:"dueDate",      label:"Deadline / Due Date", required:false},
  {key:"reference",    label:"Reference Number",    required:false},
  {key:"nextAction",   label:"Next Action",         required:false},
  {key:"notes",        label:"Notes",               required:false},
];
const guessMapping = (headers) => {
  const lower=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
  const hints={name:["debtowner","owner","creditor","name","debt","company","lender"],type:["type","debttype","kind","category"],balance:["amountowed","totalamount","balance","owed","total","amount","outstanding"],paid:["paid","totalpaid","amountpaid","payments","paidtodate"],monthlyAmount:["monthly","monthlypayment","paymentamount","installment"],dueDate:["duedate","deadline","date","due"],reference:["reference","ref","refnum","accountnumber","accnum","account"],nextAction:["nextaction","action","todo","next"],notes:["notes","note","comments","comment","info"]};
  const map={};
  OUR_COLS.forEach(({key})=>{ const h=hints[key]||[]; const match=headers.find(hdr=>h.some(hint=>lower(hdr).includes(hint))); if(match) map[key]=match; });
  return map;
};
const guessType = (raw) => { if(!raw) return "free"; const r=String(raw).toLowerCase().replace(/[^a-z]/g,""); if(r.includes("ccj")) return "ccj"; if(r.includes("dmp")) return "dmp"; if(r.includes("council")) return "parking_council"; if(r.includes("private")||r.includes("parking")) return "parking_private"; if(r.includes("dispute")) return "in_dispute"; if(r.includes("deadline")) return "deadline"; if(r.includes("plan")||r.includes("agreed")) return "plan"; return "free"; };
const parseNum = (v) => { if(!v) return 0; const n=parseFloat(String(v).replace(/[^0-9.-]/g,"")); return isNaN(n)?0:n; };
const isBlankRow = (row, mapping) => { const name=String(row[mapping.name]||"").trim(); const balance=parseNum(row[mapping.balance]); return !name && balance===0; };

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;500;600&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --bg:#f5f0e8;--bg2:#ede8de;--surface:#fff;--border:#d8d0c0;--border2:#c8bfae;
    --ink:#1a1814;--ink2:#4a4540;--muted:#8c8478;
    --accent:#2d5a3d;--accent-light:#e8f2ec;
    --red:#b83232;--red-light:#faeaea;--gold:#9a6b1a;--gold-light:#fdf4e3;
    --blue:#1a4a6b;--serif:'Playfair Display',Georgia,serif;--sans:'Syne',sans-serif;
  }
  html,body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh;}

  .auth-wrap{min-height:100vh;display:grid;grid-template-columns:1fr 1fr;}
  @media(max-width:680px){.auth-wrap{grid-template-columns:1fr;}.auth-left{display:none;}}
  .auth-left{background:var(--accent);display:flex;flex-direction:column;justify-content:center;padding:4rem 3rem;position:relative;overflow:hidden;}
  .auth-left::before{content:'';position:absolute;top:-80px;right:-80px;width:320px;height:320px;border-radius:50%;background:rgba(255,255,255,0.06);}
  .auth-left::after{content:'';position:absolute;bottom:-60px;left:-60px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,0.04);}
  .auth-brand{font-family:var(--serif);font-size:3.5rem;color:#fff;line-height:1;margin-bottom:1rem;}
  .auth-brand em{font-style:italic;color:rgba(255,255,255,0.7);}
  .auth-tagline{font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:3rem;}
  .auth-pillars{display:flex;flex-direction:column;gap:1.2rem;}
  .auth-pillar{display:flex;align-items:flex-start;gap:0.75rem;}
  .auth-pillar-icon{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:0.7rem;flex-shrink:0;margin-top:2px;}
  .auth-pillar-text{font-size:0.8rem;color:rgba(255,255,255,0.75);line-height:1.5;}
  .auth-pillar-text strong{color:#fff;display:block;font-size:0.85rem;margin-bottom:0.1rem;}
  .auth-right{background:var(--surface);display:flex;align-items:center;justify-content:center;padding:3rem 2rem;}
  .auth-box{width:100%;max-width:380px;}
  .auth-title{font-family:var(--serif);font-size:1.8rem;margin-bottom:0.3rem;}
  .auth-subtitle{font-size:0.75rem;color:var(--muted);margin-bottom:2rem;letter-spacing:0.05em;}
  .auth-toggle{display:flex;background:var(--bg2);border-radius:4px;padding:3px;margin-bottom:1.5rem;gap:3px;}
  .auth-toggle-btn{flex:1;background:none;border:none;border-radius:3px;font-family:var(--sans);font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;padding:0.5rem;cursor:pointer;color:var(--muted);transition:all 0.2s;}
  .auth-toggle-btn.active{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,0.12);}
  .auth-error{background:var(--red-light);border:1px solid #e8b0b0;border-radius:4px;color:var(--red);font-size:0.75rem;padding:0.6rem 0.75rem;margin-bottom:1rem;}
  .auth-info{background:var(--accent-light);border:1px solid #b8d4c0;border-radius:4px;color:var(--accent);font-size:0.75rem;padding:0.6rem 0.75rem;margin-bottom:1rem;}

  .field{display:flex;flex-direction:column;gap:0.3rem;margin-bottom:0.9rem;}
  label{font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);}
  input,select,textarea{background:var(--bg2);border:1.5px solid var(--border);border-radius:4px;color:var(--ink);font-family:var(--sans);font-size:0.9rem;padding:0.65rem 0.75rem;outline:none;transition:border-color 0.15s,background 0.15s;width:100%;}
  input:focus,select:focus,textarea:focus{border-color:var(--accent);background:#fff;}
  select option{background:#fff;}

  .btn{background:var(--accent);border:none;border-radius:4px;color:#fff;cursor:pointer;font-family:var(--sans);font-size:0.75rem;font-weight:600;letter-spacing:0.1em;padding:0.7rem 1.4rem;text-transform:uppercase;transition:opacity 0.15s,transform 0.1s;white-space:nowrap;}
  .btn:hover{opacity:0.88;transform:translateY(-1px);}
  .btn:active{transform:none;opacity:1;}
  .btn.full{width:100%;}
  .btn.ghost{background:none;border:1.5px solid var(--border);color:var(--ink2);}
  .btn.ghost:hover{border-color:var(--accent);color:var(--accent);}
  .btn.red{background:var(--red);}
  .btn.gold{background:var(--gold);}
  .btn.sm{font-size:0.65rem;padding:0.35rem 0.7rem;}

  .app-wrap{min-height:100vh;display:flex;flex-direction:column;}
  .topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 1.5rem;display:flex;align-items:center;gap:1rem;height:56px;position:sticky;top:0;z-index:10;}
  .topbar-brand{font-family:var(--serif);font-size:1.5rem;color:var(--accent);line-height:1;margin-right:auto;}
  .topbar-user{font-size:0.7rem;color:var(--muted);letter-spacing:0.08em;}
  .topbar-user strong{color:var(--ink2);}

  .daily-focus{background:var(--accent);color:#fff;padding:1.1rem 1.5rem;display:flex;align-items:center;gap:1rem;border-bottom:1px solid #245030;}
  .daily-focus-icon{font-size:1.4rem;flex-shrink:0;}
  .daily-focus-label{font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.6);margin-bottom:0.2rem;}
  .daily-focus-text{font-family:var(--serif);font-size:1.05rem;color:#fff;line-height:1.3;}
  .daily-focus-debt{font-size:0.7rem;color:rgba(255,255,255,0.7);margin-top:0.15rem;}

  .stats{display:grid;grid-template-columns:repeat(4,1fr);background:var(--surface);border-bottom:1px solid var(--border);}
  @media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr);}}
  .stat{padding:1.2rem 1.5rem;border-right:1px solid var(--border);}
  .stat:last-child{border-right:none;}
  .stat-label{font-size:0.6rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:0.35rem;}
  .stat-value{font-family:var(--serif);font-size:1.55rem;line-height:1;}
  .stat-value.red{color:var(--red);}.stat-value.green{color:var(--accent);}.stat-value.gold{color:var(--gold);}.stat-value.blue{color:var(--blue);}

  .tabs{background:var(--surface);border-bottom:1px solid var(--border);display:flex;padding:0 1.5rem;overflow-x:auto;}
  .tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);cursor:pointer;font-family:var(--sans);font-size:0.7rem;font-weight:500;letter-spacing:0.1em;padding:0.9rem 1rem;text-transform:uppercase;transition:color 0.15s,border-color 0.15s;white-space:nowrap;margin-bottom:-1px;}
  .tab:hover:not(.active){color:var(--ink2);}
  .tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600;}

  .main{flex:1;padding:2rem 1.5rem 5rem;max-width:900px;margin:0 auto;width:100%;}
  .panel{animation:rise 0.2s ease;}
  @keyframes rise{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
  .section-title{font-family:var(--serif);font-size:1.4rem;color:var(--ink);margin-bottom:0.25rem;}
  .section-sub{font-size:0.72rem;color:var(--muted);margin-bottom:1.25rem;line-height:1.5;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1.5rem;margin-bottom:1.5rem;}
  .form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:0.75rem;margin-bottom:1rem;}

  .plan-section-label{font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin:1.25rem 0 0.5rem;}
  .plan-item{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:0 6px 6px 0;padding:1rem 1.25rem;margin-bottom:2px;display:grid;grid-template-columns:28px 1fr auto;gap:0.75rem;align-items:start;}
  .plan-num{font-family:var(--serif);font-size:1.3rem;color:var(--border2);text-align:center;padding-top:2px;}
  .plan-name{font-weight:500;font-size:0.9rem;margin-bottom:0.2rem;}
  .plan-meta{font-size:0.65rem;color:var(--muted);display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;margin-bottom:0.3rem;}
  .plan-action{font-size:0.72rem;color:var(--accent);background:var(--accent-light);border-radius:3px;padding:0.25rem 0.5rem;margin-top:0.3rem;display:inline-block;}
  .plan-amount{font-family:var(--serif);font-size:1.15rem;text-align:right;white-space:nowrap;}

  .debt-row{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem 1.25rem;margin-bottom:4px;transition:box-shadow 0.15s;}
  .debt-row:hover{box-shadow:0 2px 8px rgba(0,0,0,0.06);}
  .debt-row.settled{opacity:0.45;}
  .debt-name{font-family:var(--serif);font-size:1.1rem;margin-bottom:0.3rem;}
  .debt-meta{font-size:0.65rem;color:var(--muted);display:flex;gap:1rem;flex-wrap:wrap;margin-top:0.2rem;}
  .debt-next-action{margin-top:0.5rem;font-size:0.75rem;color:var(--accent);background:var(--accent-light);border-radius:3px;padding:0.3rem 0.6rem;display:inline-flex;align-items:center;gap:0.4rem;cursor:pointer;}

  /* Edit modal */
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:100;display:flex;align-items:center;justify-content:center;padding:1rem;}
  .modal{background:var(--surface);border-radius:8px;padding:2rem;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;}
  .modal-title{font-family:var(--serif);font-size:1.4rem;margin-bottom:1.25rem;}

  .type-badge{font-size:0.55rem;letter-spacing:0.1em;text-transform:uppercase;padding:0.15rem 0.45rem;border-radius:2px;font-weight:600;border:1px solid;}
  .progress-wrap{background:var(--bg2);border-radius:2px;height:3px;margin-top:0.5rem;overflow:hidden;max-width:200px;}
  .progress-fill{height:100%;border-radius:2px;background:var(--accent);transition:width 0.4s ease;}

  .exp-row{display:flex;justify-content:space-between;align-items:center;padding:0.55rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;}
  .exp-row:last-child{border-bottom:none;}
  .exp-total{display:flex;justify-content:space-between;align-items:center;padding:0.7rem 0;border-top:2px solid var(--border);font-size:0.85rem;font-weight:600;}
  .alloc-row{display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;}
  .alloc-row:last-child{border-bottom:none;}
  .pay-row{display:flex;justify-content:space-between;align-items:center;padding:0.55rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;}
  .pay-row:last-child{border-bottom:none;}
  .pay-sub{font-size:0.62rem;color:var(--muted);margin-top:0.1rem;}

  .alert{background:var(--accent-light);border:1px solid #b8d4c0;border-radius:4px;color:var(--accent);font-size:0.78rem;padding:0.75rem 1rem;margin-bottom:1.25rem;line-height:1.5;}
  .empty{color:var(--muted);font-size:0.8rem;text-align:center;padding:2.5rem 1rem;border:1.5px dashed var(--border);border-radius:6px;}
  .inline{display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;}

  .drop-zone{border:2px dashed var(--border);border-radius:6px;padding:2.5rem;text-align:center;cursor:pointer;transition:border-color 0.2s,background 0.2s;}
  .drop-zone:hover,.drop-zone.over{border-color:var(--accent);background:var(--accent-light);}
  .drop-zone-icon{font-size:2rem;margin-bottom:0.5rem;}
  .drop-zone-text{font-size:0.85rem;color:var(--muted);}
  .drop-zone-text strong{color:var(--ink);}
  .mapper-table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:1rem;}
  .mapper-table th{font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);padding:0.4rem 0.5rem;border-bottom:1px solid var(--border);text-align:left;}
  .mapper-table td{padding:0.4rem 0.5rem;border-bottom:1px solid var(--border);vertical-align:middle;}
  .mapper-table tr:last-child td{border-bottom:none;}
  .preview-table{width:100%;border-collapse:collapse;font-size:0.75rem;display:block;overflow-x:auto;}
  .preview-table th{background:var(--bg2);padding:0.4rem 0.6rem;border:1px solid var(--border);font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);text-align:left;}
  .preview-table td{padding:0.35rem 0.6rem;border:1px solid var(--border);color:var(--ink2);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .import-success{background:var(--accent-light);border:1px solid #a0c8b0;border-radius:4px;padding:2rem;text-align:center;color:var(--accent);}
  .saving-indicator{font-size:0.65rem;color:var(--muted);letter-spacing:0.08em;}
`;

// ── TypeBadge ─────────────────────────────────────────────────────────────────
function TypeBadge({type}){
  const s=TYPE_STYLE[type]||TYPE_STYLE.free;
  return <span className="type-badge" style={{background:s.bg,color:s.color,borderColor:s.border}}>{typeLabel(type)}</span>;
}

// ── EditDebtModal ─────────────────────────────────────────────────────────────
function EditDebtModal({debt, onSave, onClose}){
  const [form, setForm] = useState({...EMPTY_DEBT, ...debt});
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  return(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Edit Debt</div>
        <div className="form-grid">
          <div className="field"><label>Debt owner / name *</label><input value={form.name} onChange={e=>set("name",e.target.value)}/></div>
          <div className="field"><label>Total balance (£) *</label><input type="number" value={form.balance} onChange={e=>set("balance",e.target.value)}/></div>
          <div className="field"><label>Type *</label>
            <select value={form.type} onChange={e=>set("type",e.target.value)}>
              {DEBT_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {isMonthly(form.type)&&<div className="field"><label>Monthly payment (£)</label><input type="number" value={form.monthlyAmount} onChange={e=>set("monthlyAmount",e.target.value)}/></div>}
          {form.type==="deadline"&&<div className="field"><label>Deadline date</label><input type="date" value={form.dueDate} onChange={e=>set("dueDate",e.target.value)}/></div>}
          <div className="field"><label>Reference number</label><input placeholder="e.g. ACC-00123" value={form.reference||""} onChange={e=>set("reference",e.target.value)}/></div>
          <div className="field"><label>Next action</label><input placeholder="e.g. Call to request CCA" value={form.nextAction||""} onChange={e=>set("nextAction",e.target.value)}/></div>
          <div className="field" style={{gridColumn:"1/-1"}}><label>Notes</label><input placeholder="e.g. 0% interest, in dispute" value={form.notes||""} onChange={e=>set("notes",e.target.value)}/></div>
        </div>
        <div className="inline">
          <button className="btn" onClick={()=>onSave(form)}>Save Changes</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── AuthScreen ────────────────────────────────────────────────────────────────
function AuthScreen({onLogin}){
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [error,setError]=useState("");
  const [info,setInfo]=useState("");
  const [loading,setLoading]=useState(false);

  const submit=async()=>{
    setError(""); setInfo("");
    if(!email.trim()||!password){setError("Please fill in all fields.");return;}
    setLoading(true);
    if(mode==="register"){
      if(password.length<6){setError("Password must be at least 6 characters.");setLoading(false);return;}
      if(password!==confirm){setError("Passwords don't match.");setLoading(false);return;}
      const res=await sb.signUp(email.trim(),password);
      if(res.error){setError(res.error.message||"Sign up failed.");setLoading(false);return;}
      if(res.user&&!res.session){setInfo("Check your email to confirm your account, then sign in.");setLoading(false);return;}
      if(res.session){ localStorage.setItem("settle_sb_session",JSON.stringify(res.session)); onLogin(res.session,res.user); }
    } else {
      const res=await sb.signIn(email.trim(),password);
      if(res.error){setError(res.error.message||"Sign in failed.");setLoading(false);return;}
      localStorage.setItem("settle_sb_session",JSON.stringify(res));
      onLogin(res,{email:email.trim()});
    }
    setLoading(false);
  };

  return(
    <div className="auth-wrap">
      <div className="auth-left">
        <div className="auth-brand">Settle<em>.</em></div>
        <div className="auth-tagline">Your debt command centre</div>
        <div className="auth-pillars">
          {[{icon:"🎯",title:"One clear daily action",desc:"Log in and know exactly what to do today."},{icon:"📋",title:"Monthly action plan",desc:"Every debt prioritised, every month, automatically."},{icon:"💰",title:"Smart cash allocation",desc:"Spare money goes exactly where it should."}].map(p=>(
            <div key={p.title} className="auth-pillar"><div className="auth-pillar-icon">{p.icon}</div><div className="auth-pillar-text"><strong>{p.title}</strong>{p.desc}</div></div>
          ))}
        </div>
      </div>
      <div className="auth-right">
        <div className="auth-box">
          <div className="auth-title">{mode==="login"?"Welcome back.":"Get started."}</div>
          <div className="auth-subtitle">{mode==="login"?"Sign in to your Settle account.":"Create your account — your data syncs across all devices."}</div>
          <div className="auth-toggle">
            <button className={`auth-toggle-btn ${mode==="login"?"active":""}`} onClick={()=>{setMode("login");setError("");setInfo("");}}>Sign in</button>
            <button className={`auth-toggle-btn ${mode==="register"?"active":""}`} onClick={()=>{setMode("register");setError("");setInfo("");}}>Create account</button>
          </div>
          {error&&<div className="auth-error">{error}</div>}
          {info&&<div className="auth-info">{info}</div>}
          <div className="field"><label>Email address</label><input autoFocus type="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/></div>
          <div className="field"><label>Password</label><input type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/></div>
          {mode==="register"&&<div className="field"><label>Confirm password</label><input type="password" placeholder="••••••••" value={confirm} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/></div>}
          <button className="btn full" onClick={submit} disabled={loading} style={{marginTop:"0.5rem"}}>{loading?"…":mode==="login"?"Sign In →":"Create Account →"}</button>
        </div>
      </div>
    </div>
  );
}

// ── ImportTab ─────────────────────────────────────────────────────────────────
function ImportTab({onImport}){
  const [stage,setStage]=useState("drop");
  const [rows,setRows]=useState([]);
  const [headers,setHeaders]=useState([]);
  const [mapping,setMapping]=useState({});
  const [preview,setPreview]=useState([]);
  const [over,setOver]=useState(false);
  const [count,setCount]=useState(0);
  const [skipped,setSkipped]=useState(0);

  const handleFile=async(file)=>{
    try{
      const data=await parseSpreadsheet(file);
      if(!data.length) return;
      const hdrs=Object.keys(data[0]);
      setRows(data);setHeaders(hdrs);setMapping(guessMapping(hdrs));setStage("map");
    }catch(e){alert("Couldn't read that file. Try saving as .xlsx or .csv first.");}
  };

  const buildPreview=()=>{
    const mapped=mapping;
    const valid=rows.filter(r=>!isBlankRow(r,mapped));
    const skippedCount=rows.length-valid.length;
    setSkipped(skippedCount);
    setPreview(valid.slice(0,5).map(row=>({
      name:row[mapped.name]||"—",type:typeLabel(guessType(row[mapped.type])),
      balance:fmt(parseNum(row[mapped.balance])),paid:fmt(parseNum(row[mapped.paid])),
      nextAction:row[mapped.nextAction]||"—",notes:row[mapped.notes]||"—",
    })));
    setStage("preview");
  };

  const doImport=()=>{
    const mapped=mapping;
    const valid=rows.filter(r=>!isBlankRow(r,mapped));
    const items=valid.map(row=>{
      const balance=parseNum(row[mapped.balance]);
      const paid=parseNum(row[mapped.paid]);
      const debtId=uid();
      return{
        debt:{id:debtId,name:String(row[mapped.name]||"Unknown"),type:guessType(row[mapped.type]),balance,monthlyAmount:parseNum(row[mapped.monthlyAmount])||"",dueDate:row[mapped.dueDate]?String(row[mapped.dueDate]).trim():"",reference:row[mapped.reference]?String(row[mapped.reference]).trim():"",nextAction:row[mapped.nextAction]?String(row[mapped.nextAction]).trim():"",notes:row[mapped.notes]?String(row[mapped.notes]).trim():"",settled:Math.max(0,balance-paid)<=0,createdAt:todayStr()},
        payments:paid>0?[{id:uid(),debtId,amount:paid,note:"Imported",date:todayStr()}]:[],
      };
    });
    onImport(items);setCount(items.length);setStage("done");
  };

  if(stage==="done") return(<div className="panel"><div className="import-success"><div style={{fontSize:"2rem",marginBottom:"0.5rem"}}>✅</div><div style={{fontFamily:"var(--serif)",fontSize:"1.2rem",marginBottom:"0.3rem"}}>{count} debts imported</div>{skipped>0&&<div style={{fontSize:"0.75rem",color:"var(--muted)"}}>({skipped} blank rows skipped)</div>}<div style={{fontSize:"0.8rem",color:"var(--muted)",marginTop:"0.3rem"}}>Head to My Debts to review and edit them.</div></div></div>);

  if(stage==="preview") return(
    <div className="panel">
      <div className="section-title">Preview — first 5 valid rows</div>
      <div className="section-sub">{rows.filter(r=>!isBlankRow(r,mapping)).length} rows to import{skipped>0?`, ${skipped} blank rows will be skipped`:""}</div>
      <div style={{overflowX:"auto",marginBottom:"1.5rem"}}><table className="preview-table"><thead><tr><th>Name</th><th>Type</th><th>Balance</th><th>Paid</th><th>Next Action</th><th>Notes</th></tr></thead><tbody>{preview.map((r,i)=><tr key={i}><td>{r.name}</td><td>{r.type}</td><td>{r.balance}</td><td>{r.paid}</td><td>{r.nextAction}</td><td>{r.notes}</td></tr>)}</tbody></table></div>
      <div className="inline"><button className="btn" onClick={doImport}>Import {rows.filter(r=>!isBlankRow(r,mapping)).length} debts →</button><button className="btn ghost" onClick={()=>setStage("map")}>← Back</button></div>
    </div>
  );

  if(stage==="map") return(
    <div className="panel">
      <div className="section-title">Match your columns</div>
      <div className="section-sub">We've guessed the mapping — check and correct if needed. Required fields marked *</div>
      <div className="card">
        <table className="mapper-table"><thead><tr><th>Settle field</th><th>Your column</th></tr></thead>
          <tbody>{OUR_COLS.map(col=>(<tr key={col.key}><td><strong>{col.label}</strong>{col.required&&" *"}</td><td><select style={{padding:"0.3rem 0.5rem",fontSize:"0.78rem"}} value={mapping[col.key]||""} onChange={e=>setMapping({...mapping,[col.key]:e.target.value})}><option value="">— skip —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</select></td></tr>))}</tbody>
        </table>
        <div className="inline"><button className="btn" onClick={buildPreview}>Preview →</button><button className="btn ghost" onClick={()=>setStage("drop")}>← Start over</button></div>
      </div>
    </div>
  );

  return(
    <div className="panel">
      <div className="section-title">Import from Spreadsheet</div>
      <div className="section-sub">Upload your existing Excel or CSV. Blank rows are automatically skipped. Supports .xlsx, .xls, .csv</div>
      <div className={`drop-zone ${over?"over":""}`} onDragOver={e=>{e.preventDefault();setOver(true);}} onDragLeave={()=>setOver(false)} onDrop={e=>{e.preventDefault();setOver(false);const f=e.dataTransfer.files[0];if(f)handleFile(f);}} onClick={()=>document.getElementById("file-input").click()}>
        <div className="drop-zone-icon">📂</div>
        <div className="drop-zone-text"><strong>Drop your spreadsheet here</strong><br/>or click to browse</div>
        <input id="file-input" type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])}/>
      </div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function Settle(){
  const [session,setSession]=useState(null);
  const [user,setUser]=useState(null);
  const [data,setData]=useState(null);
  const [saving,setSaving]=useState(false);
  const [tab,setTab]=useState("dashboard");
  const [dForm,setDF]=useState({...EMPTY_DEBT});
  const [eForm,setEF]=useState({name:"",amount:""});
  const [pForm,setPF]=useState({debtId:"",amount:"",note:""});
  const [spare,setSpare]=useState("");
  const [spareResult,setSpareResult]=useState(null);
  const [editingDebt,setEditingDebt]=useState(null);

  // ── restore session ──────────────────────────────────────────────────────
  useEffect(()=>{
    sb.getSession().then(async sess=>{
      if(!sess) return;
      setSession(sess);
      setUser({email:sess.user?.email||""});
      const d=await sb.loadData(sess.access_token,sess.user.id);
      setData(d||DEFAULT_DATA());
    });
  },[]);

  const handleLogin=async(sess,u)=>{
    setSession(sess); setUser(u);
    const d=await sb.loadData(sess.access_token,sess.user.id);
    setData(d||DEFAULT_DATA());
  };

  const handleLogout=async()=>{
    if(session) await sb.signOut(session.access_token);
    localStorage.removeItem("settle_sb_session");
    setSession(null); setUser(null); setData(null); setTab("dashboard");
  };

  // ── persist to Supabase ──────────────────────────────────────────────────
  const update=useCallback((partial)=>{
    setData(prev=>{
      const next={...prev,...partial};
      if(session){
        setSaving(true);
        sb.saveData(session.access_token,session.user.id,next).finally(()=>setSaving(false));
      }
      return next;
    });
  },[session]);

  if(!session||!data) return <><style>{CSS}</style><AuthScreen onLogin={handleLogin}/></>;

  // ── derived ──────────────────────────────────────────────────────────────
  const plan=buildPlan(data.debts,data.payments);
  const totalDebt=data.debts.filter(d=>!d.settled).reduce((s,d)=>{const paid=data.payments.filter(p=>p.debtId===d.id).reduce((a,p)=>a+Number(p.amount),0);return s+Math.max(0,Number(d.balance)-paid);},0);
  const totalPaid=data.payments.reduce((s,p)=>s+Number(p.amount),0);
  const totalExpenses=data.expenses.reduce((s,e)=>s+Number(e.amount),0);
  const monthlyDebtCost=data.debts.filter(d=>isMonthly(d.type)&&!d.settled).reduce((s,d)=>s+Number(d.monthlyAmount||0),0);
  const freeMoney=Math.max(0,Number(data.income||0)-totalExpenses-monthlyDebtCost);
  const thisMonthDue=plan.filter(d=>d.dueThisMonth).reduce((s,d)=>s+(isMonthly(d.type)?Number(d.monthlyAmount||0):d.remaining),0);
  const dailyFocus=plan.find(d=>d.nextAction&&d.nextAction.trim())||plan[0];

  // ── handlers ─────────────────────────────────────────────────────────────
  const addDebt=()=>{
    if(!dForm.name||!dForm.balance) return;
    update({debts:[...data.debts,{id:uid(),...dForm,balance:Number(dForm.balance),settled:false,createdAt:todayStr()}]});
    setDF({...EMPTY_DEBT});
  };
  const saveEditedDebt=(form)=>{
    update({debts:data.debts.map(d=>d.id===editingDebt.id?{...d,...form,balance:Number(form.balance)}:d)});
    setEditingDebt(null);
  };
  const settleDebt=(id)=>update({debts:data.debts.map(d=>d.id===id?{...d,settled:!d.settled}:d)});
  const removeDebt=(id)=>update({debts:data.debts.filter(d=>d.id!==id),payments:data.payments.filter(p=>p.debtId!==id)});
  const addExpense=()=>{if(!eForm.name||!eForm.amount) return;update({expenses:[...data.expenses,{id:uid(),...eForm,amount:Number(eForm.amount)}]});setEF({name:"",amount:""});};
  const logPayment=()=>{
    if(!pForm.debtId||!pForm.amount) return;
    const debt=data.debts.find(d=>d.id===pForm.debtId);
    const prevPaid=data.payments.filter(p=>p.debtId===pForm.debtId).reduce((s,p)=>s+Number(p.amount),0);
    const payment={id:uid(),...pForm,amount:Number(pForm.amount),date:todayStr()};
    let debts=data.debts;
    if(debt&&prevPaid+Number(pForm.amount)>=Number(debt.balance)) debts=data.debts.map(d=>d.id===pForm.debtId?{...d,settled:true}:d);
    update({payments:[...data.payments,payment],debts});
    setPF({debtId:"",amount:"",note:""});
  };
  const runSpare=()=>{if(!spare) return;setSpareResult(allocateSpare(spare,plan));};
  const confirmSpare=()=>{
    if(!spareResult) return;
    const newPayments=spareResult.allocations.map(a=>({id:uid(),debtId:a.debtId,amount:a.amount,note:"Spare cash",date:todayStr()}));
    let debts=[...data.debts];
    newPayments.forEach(np=>{const d=debts.find(d=>d.id===np.debtId);if(!d)return;const prev=data.payments.filter(p=>p.debtId===np.debtId).reduce((s,p)=>s+Number(p.amount),0);if(prev+np.amount>=Number(d.balance))debts=debts.map(dd=>dd.id===np.debtId?{...dd,settled:true}:dd);});
    update({payments:[...data.payments,...newPayments],debts,spareHistory:[...data.spareHistory,{id:uid(),amount:Number(spare),date:todayStr(),allocations:spareResult.allocations,leftover:spareResult.leftover}]});
    setSpare("");setSpareResult(null);
  };
  const handleImport=(items)=>update({debts:[...data.debts,...items.map(i=>i.debt)],payments:[...data.payments,...items.flatMap(i=>i.payments)]});

  return(
    <>
      <style>{CSS}</style>
      {editingDebt&&<EditDebtModal debt={editingDebt} onSave={saveEditedDebt} onClose={()=>setEditingDebt(null)}/>}
      <div className="app-wrap">

        <div className="topbar">
          <div className="topbar-brand">Settle.</div>
          {saving&&<span className="saving-indicator">saving…</span>}
          <div className="topbar-user">Signed in as <strong>{user?.email}</strong></div>
          <button className="btn ghost sm" onClick={handleLogout}>Sign out</button>
        </div>

        <div className="daily-focus">
          <div className="daily-focus-icon">🎯</div>
          <div>
            <div className="daily-focus-label">Today's focus</div>
            {dailyFocus?(
              <><div className="daily-focus-text">{dailyFocus.nextAction&&dailyFocus.nextAction.trim()?dailyFocus.nextAction:`Make your ${isMonthly(dailyFocus.type)?"payment on":"progress with"} ${dailyFocus.name}`}</div>
              <div className="daily-focus-debt">{dailyFocus.name} · <TypeBadge type={dailyFocus.type}/> · {fmt(dailyFocus.remaining)} remaining</div></>
            ):<div style={{fontSize:"0.85rem",color:"rgba(255,255,255,0.75)",fontStyle:"italic"}}>No debts yet — add them to get your daily focus.</div>}
          </div>
        </div>

        <div className="stats">
          <div className="stat"><div className="stat-label">Remaining Debt</div><div className={`stat-value ${totalDebt>0?"red":"green"}`}>{fmt(totalDebt)}</div></div>
          <div className="stat"><div className="stat-label">Total Paid Off</div><div className="stat-value green">{fmt(totalPaid)}</div></div>
          <div className="stat"><div className="stat-label">Due This Month</div><div className="stat-value gold">{fmt(thisMonthDue)}</div></div>
          <div className="stat"><div className="stat-label">Free Money / mo</div><div className={`stat-value ${freeMoney>0?"blue":"red"}`}>{fmt(freeMoney)}</div></div>
        </div>

        <div className="tabs">
          {[{key:"dashboard",label:"📋 This Month"},{key:"debts",label:"💳 My Debts"},{key:"import",label:"📂 Import"},{key:"budget",label:"🏠 Budget"},{key:"pay",label:"✅ Log Payment"},{key:"spare",label:"💰 Spare Cash"}]
            .map(t=><button key={t.key} className={`tab ${tab===t.key?"active":""}`} onClick={()=>setTab(t.key)}>{t.label}</button>)}
        </div>

        <div className="main">

          {tab==="dashboard"&&(
            <div className="panel">
              <div className="section-title">{monthLabel}</div>
              <div className="section-sub">Your structured action plan. Do these in order.</div>
              {freeMoney>0&&<div className="alert">💡 You have <strong>{fmt(freeMoney)}</strong> free each month. Use the Spare Cash tab when extra money comes in.</div>}
              {plan.length===0?<div className="empty">No debts yet — add them in My Debts or use Import.</div>:(
                <>
                  {plan.filter(d=>d.dueThisMonth).length>0&&(<>
                    <div className="plan-section-label">Action now — due this month</div>
                    {plan.filter(d=>d.dueThisMonth).map((d,i)=>{
                      const monthly=isMonthly(d.type)?Number(d.monthlyAmount||0):d.remaining;
                      const pct=Math.min(100,(d.totalPaid/Number(d.balance))*100);
                      const ts=TYPE_STYLE[d.type]||TYPE_STYLE.free;
                      return(<div key={d.id} className="plan-item" style={{borderLeftColor:ts.color}}>
                        <div className="plan-num">{i+1}</div>
                        <div><div className="plan-name">{d.name}</div>
                          <div className="plan-meta"><TypeBadge type={d.type}/>{isMonthly(d.type)&&d.monthlyAmount&&<span>Monthly: {fmt(d.monthlyAmount)}</span>}{d.type==="deadline"&&d.effectiveDate&&<span>Due: {d.effectiveDate}</span>}<span>Remaining: {fmt(d.remaining)}</span></div>
                          {d.nextAction&&<div className="plan-action">→ {d.nextAction}</div>}
                          <div className="progress-wrap"><div className="progress-fill" style={{width:`${pct}%`}}/></div>
                        </div>
                        <div className="plan-amount">{fmt(monthly)}</div>
                      </div>);
                    })}
                  </>)}
                  {plan.filter(d=>!d.dueThisMonth).length>0&&(<>
                    <div className="plan-section-label">On the horizon</div>
                    {plan.filter(d=>!d.dueThisMonth).map((d,i)=>{
                      const pct=Math.min(100,(d.totalPaid/Number(d.balance))*100);
                      const ts=TYPE_STYLE[d.type]||TYPE_STYLE.free;
                      return(<div key={d.id} className="plan-item" style={{borderLeftColor:ts.color}}>
                        <div className="plan-num">{i+1}</div>
                        <div><div className="plan-name">{d.name}</div>
                          <div className="plan-meta"><TypeBadge type={d.type}/>{d.dueDate&&<span>Due: {d.dueDate}</span>}<span>Remaining: {fmt(d.remaining)}</span></div>
                          {d.nextAction&&<div className="plan-action">→ {d.nextAction}</div>}
                          <div className="progress-wrap"><div className="progress-fill" style={{width:`${pct}%`}}/></div>
                        </div>
                        <div className="plan-amount">{fmt(d.remaining)}</div>
                      </div>);
                    })}
                  </>)}
                </>
              )}
            </div>
          )}

          {tab==="debts"&&(
            <div className="panel">
              <div className="card">
                <div className="section-title">Add a Debt</div>
                <div className="section-sub">Or use the Import tab to upload a spreadsheet.</div>
                <div className="form-grid">
                  <div className="field"><label>Debt owner / name *</label><input placeholder="e.g. Lowell / Barclaycard" value={dForm.name} onChange={e=>setDF({...dForm,name:e.target.value})}/></div>
                  <div className="field"><label>Total balance (£) *</label><input type="number" placeholder="0.00" value={dForm.balance} onChange={e=>setDF({...dForm,balance:e.target.value})}/></div>
                  <div className="field"><label>Type *</label><select value={dForm.type} onChange={e=>setDF({...dForm,type:e.target.value})}>{DEBT_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                  {isMonthly(dForm.type)&&<div className="field"><label>Monthly payment (£)</label><input type="number" placeholder="0.00" value={dForm.monthlyAmount} onChange={e=>setDF({...dForm,monthlyAmount:e.target.value})}/></div>}
                  {dForm.type==="deadline"&&<div className="field"><label>Deadline date</label><input type="date" value={dForm.dueDate} onChange={e=>setDF({...dForm,dueDate:e.target.value})}/></div>}
                  <div className="field"><label>Reference number</label><input placeholder="e.g. ACC-00123" value={dForm.reference} onChange={e=>setDF({...dForm,reference:e.target.value})}/></div>
                  <div className="field"><label>Next action</label><input placeholder="e.g. Call to request CCA" value={dForm.nextAction} onChange={e=>setDF({...dForm,nextAction:e.target.value})}/></div>
                  <div className="field"><label>Notes</label><input placeholder="e.g. 0% interest, in dispute" value={dForm.notes} onChange={e=>setDF({...dForm,notes:e.target.value})}/></div>
                </div>
                <button className="btn" onClick={addDebt}>+ Add Debt</button>
              </div>

              <div className="section-title" style={{marginBottom:"0.75rem"}}>Your Debts ({data.debts.filter(d=>!d.settled).length} active, {data.debts.filter(d=>d.settled).length} settled)</div>
              {data.debts.length===0?<div className="empty">No debts yet.</div>:data.debts.map(d=>{
                const paid=data.payments.filter(p=>p.debtId===d.id).reduce((s,p)=>s+Number(p.amount),0);
                const remaining=Math.max(0,Number(d.balance)-paid);
                const pct=Math.min(100,(paid/Number(d.balance))*100);
                return(
                  <div key={d.id} className={`debt-row ${d.settled?"settled":""}`}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"1rem",alignItems:"start"}}>
                      <div>
                        <div className="inline" style={{marginBottom:"0.3rem"}}>
                          <span className="debt-name">{d.name}</span>
                          <TypeBadge type={d.settled?"settled":d.type}/>
                        </div>
                        <div className="debt-meta">
                          <span>Balance: {fmt(d.balance)}</span><span>Paid: {fmt(paid)}</span><span>Remaining: {fmt(remaining)}</span>
                          {d.dueDate&&<span>Due: {d.dueDate}</span>}
                          {d.monthlyAmount&&<span>Monthly: {fmt(d.monthlyAmount)}</span>}
                          {d.reference&&<span>🔖 {d.reference}</span>}
                        </div>
                        {d.notes&&<div style={{fontSize:"0.7rem",color:"var(--muted)",marginTop:"0.2rem"}}>📝 {d.notes}</div>}
                        {d.nextAction&&<div className="debt-next-action" onClick={()=>setEditingDebt(d)}>→ {d.nextAction} <span style={{opacity:0.6,fontSize:"0.65rem"}}>✏️</span></div>}
                        {!d.nextAction&&!d.settled&&<button className="btn ghost sm" style={{marginTop:"0.5rem"}} onClick={()=>setEditingDebt(d)}>+ Add next action</button>}
                        <div className="progress-wrap"><div className="progress-fill" style={{width:`${pct}%`}}/></div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:"0.4rem",flexShrink:0}}>
                        <button className="btn ghost sm" onClick={()=>setEditingDebt(d)}>✏️ Edit</button>
                        <button className="btn ghost sm" onClick={()=>settleDebt(d.id)}>{d.settled?"Reopen":"Settle ✓"}</button>
                        <button className="btn red sm" onClick={()=>removeDebt(d.id)}>Remove</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab==="import"&&<ImportTab onImport={handleImport}/>}

          {tab==="budget"&&(
            <div className="panel">
              <div className="card"><div className="section-title">Monthly Income</div><div className="form-grid" style={{marginTop:"0.75rem"}}><div className="field"><label>Take-home income (£/mo)</label><input type="number" placeholder="0.00" value={data.income} onChange={e=>update({income:e.target.value})}/></div></div></div>
              <div className="card">
                <div className="section-title">Living Expenses</div>
                <div className="section-sub">Regular monthly outgoings — rent, food, subscriptions, transport. Don't add debt payments here.</div>
                <div className="form-grid">
                  <div className="field"><label>Expense name</label><input placeholder="e.g. Rent" value={eForm.name} onChange={e=>setEF({...eForm,name:e.target.value})}/></div>
                  <div className="field"><label>Monthly amount (£)</label><input type="number" placeholder="0.00" value={eForm.amount} onChange={e=>setEF({...eForm,amount:e.target.value})}/></div>
                </div>
                <button className="btn" onClick={addExpense}>+ Add Expense</button>
              </div>
              {data.expenses.length>0&&(
                <div className="card">
                  <div className="section-title" style={{marginBottom:"1rem"}}>Budget Breakdown</div>
                  {data.expenses.map(e=>(<div key={e.id} className="exp-row"><span>{e.name}</span><div className="inline"><span style={{color:"var(--red)"}}>{fmt(e.amount)}</span><button className="btn ghost sm" onClick={()=>update({expenses:data.expenses.filter(ex=>ex.id!==e.id)})}>×</button></div></div>))}
                  <div className="exp-total"><span>Total Expenses</span><span style={{color:"var(--red)"}}>{fmt(totalExpenses)}</span></div>
                  <div className="exp-row"><span>Agreed Debt Payments (DMP / Plan / CCJ)</span><span style={{color:"var(--blue)"}}>{fmt(monthlyDebtCost)}</span></div>
                  <div className="exp-row" style={{fontFamily:"var(--serif)",fontSize:"1.1rem",borderBottom:"none",paddingTop:"0.75rem"}}><span>Free Money</span><span style={{color:freeMoney>0?"var(--accent)":"var(--red)"}}>{fmt(freeMoney)}</span></div>
                </div>
              )}
            </div>
          )}

          {tab==="pay"&&(
            <div className="panel">
              <div className="card">
                <div className="section-title">Log a Payment</div>
                <div className="section-sub">Record every payment. Debts auto-settle when the balance hits zero.</div>
                <div className="form-grid">
                  <div className="field"><label>Which debt?</label><select value={pForm.debtId} onChange={e=>setPF({...pForm,debtId:e.target.value})}><option value="">Select…</option>{data.debts.filter(d=>!d.settled).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
                  <div className="field"><label>Amount paid (£)</label><input type="number" placeholder="0.00" value={pForm.amount} onChange={e=>setPF({...pForm,amount:e.target.value})}/></div>
                  <div className="field"><label>Note (optional)</label><input placeholder="e.g. Direct debit" value={pForm.note} onChange={e=>setPF({...pForm,note:e.target.value})}/></div>
                </div>
                <button className="btn" onClick={logPayment}>✓ Log Payment</button>
              </div>
              <div className="section-title" style={{marginBottom:"0.75rem"}}>Payment History</div>
              {data.payments.length===0?<div className="empty">No payments logged yet.</div>:(
                <div className="card" style={{padding:"0.5rem 1.25rem"}}>
                  {[...data.payments].reverse().map(p=>{const debt=data.debts.find(d=>d.id===p.debtId);return(<div key={p.id} className="pay-row"><div><div>{debt?.name||"Unknown"}</div><div className="pay-sub">{p.date}{p.note?` · ${p.note}`:""}</div></div><span style={{color:"var(--accent)",fontFamily:"var(--serif)"}}>+{fmt(p.amount)}</span></div>);})}
                </div>
              )}
            </div>
          )}

          {tab==="spare"&&(
            <div className="panel">
              <div className="card">
                <div className="section-title">Spare Cash Allocator</div>
                <div className="section-sub">Drop in any extra money and Settle tells you exactly where every penny goes — highest priority first.</div>
                <div className="form-grid"><div className="field"><label>Amount available (£)</label><input type="number" placeholder="0.00" value={spare} onChange={e=>{setSpare(e.target.value);setSpareResult(null);}}/></div></div>
                <button className="btn gold" onClick={runSpare}>Calculate Allocation →</button>
                {spareResult&&(
                  <div style={{marginTop:"1.5rem",borderTop:"1px solid var(--border)",paddingTop:"1.25rem"}}>
                    <div style={{fontSize:"0.65rem",letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--muted)",marginBottom:"0.75rem"}}>Here's exactly where it goes:</div>
                    {spareResult.allocations.map(a=><div key={a.debtId} className="alloc-row"><span>{a.name}</span><span style={{color:"var(--accent)",fontFamily:"var(--serif)"}}>{fmt(a.amount)}</span></div>)}
                    {spareResult.leftover>0.01&&<div className="alloc-row"><span style={{color:"var(--muted)"}}>Leftover (all debts covered!)</span><span style={{color:"var(--accent)"}}>{fmt(spareResult.leftover)}</span></div>}
                    <div style={{marginTop:"1rem",display:"flex",gap:"0.5rem"}}><button className="btn" onClick={confirmSpare}>✓ Confirm &amp; Log</button><button className="btn ghost" onClick={()=>setSpareResult(null)}>Cancel</button></div>
                  </div>
                )}
              </div>
              {data.spareHistory.length>0&&(<>
                <div className="section-title" style={{marginBottom:"0.75rem"}}>Allocation History</div>
                <div className="card" style={{padding:"0.5rem 1.25rem"}}>
                  {[...data.spareHistory].reverse().map(h=>(<div key={h.id} className="pay-row"><div><div>{fmt(h.amount)} across {h.allocations.length} debt{h.allocations.length!==1?"s":""}</div><div className="pay-sub">{h.date}</div></div>{h.leftover>0.01&&<span style={{color:"var(--muted)",fontSize:"0.75rem"}}>{fmt(h.leftover)} left over</span>}</div>))}
                </div>
              </>)}
            </div>
          )}

        </div>
      </div>
    </>
  );
}
