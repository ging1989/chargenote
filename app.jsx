import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import {
  filterEntriesByPeriod,
  getLocalDateInput,
  previousMonthKey,
  validateEntryForm,
} from "./utils.mjs";

// ── Config ──────────────────────────────────────────────────────
const CFG_KEY   = "ev_supabase_cfg";
const RATES_KEY = "ev_station_rates";   // local cache ของ rates
const TABLE     = "charging_sessions";
const RTABLE    = "station_rates";
const SUPABASE_DEFAULT = {
  url: "https://znwhsbjjykkbbgqyoewl.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpud2hzYmpqeWtrYmJncXlvZXdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MDQ0MTQsImV4cCI6MjA5NTE4MDQxNH0.juLswcub25iERIJllOdO_Uf-iicbSnVuuf0FM6xoJ2M",
};

// ── Storage helpers ─────────────────────────────────────────────
const loadCfg   = () => { try{ return JSON.parse(localStorage.getItem(CFG_KEY))||SUPABASE_DEFAULT; }catch(e){ return SUPABASE_DEFAULT; } };
const loadRates = () => { try{ return JSON.parse(localStorage.getItem(RATES_KEY))||{}; }catch(e){ return {}; } };
const saveRates = r  => localStorage.setItem(RATES_KEY, JSON.stringify(r));

// ── Helpers ─────────────────────────────────────────────────────
const THB  = n => "฿"+Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
const NUM  = (n,d=2) => Number(n||0).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const mKey = d => d.slice(0,7);
const MONTHS_FULL=["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
const mLbl = k => { const [y,m]=k.split("-"); return ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."][+m-1]+" "+String(+y+543).slice(-2); };
const dLbl = d => { const dt=new Date(d+"T00:00:00"),mo=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."]; return dt.getDate()+" "+mo[dt.getMonth()]+" "+String(dt.getFullYear()+543).slice(-2); };
const smeta = (name,rates) => rates[name] || { type:"flat", flat:0, color:"#8AA08C", abbr:(name||"??").slice(0,2).toUpperCase() };
const makeAbbr = name => (name||"EV").split(/\s+/).filter(Boolean).map(w=>w[0]).join("").slice(0,2).toUpperCase() || "EV";
const rateFromDb = r => ({
  id:r.id,
  type:r.rate_type||"flat",
  on_peak:r.on_peak,
  off_peak:r.off_peak,
  on_time:r.on_time||"09:00–22:00",
  off_time:r.off_time||"22:00–09:00",
  flat:r.flat,
  color:r.color||"#6CAE76",
  abbr:r.abbr||makeAbbr(r.station),
});

function useDialog(onClose) {
  const dialogRef=useRef(null);
  const closeRef=useRef(onClose);
  useEffect(()=>{closeRef.current=onClose;},[onClose]);
  useEffect(()=>{
    const previous=document.activeElement;
    const dialog=dialogRef.current;
    const focusable=()=>[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    focusable()[0]?.focus();
    const onKeyDown=e=>{
      if(e.key==="Escape"){closeRef.current();return;}
      if(e.key!=="Tab") return;
      const items=focusable();
      if(!items.length) return;
      const first=items[0],last=items[items.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    };
    document.addEventListener("keydown",onKeyDown);
    return()=>{document.removeEventListener("keydown",onKeyDown);previous?.focus?.();};
  },[]);
  return dialogRef;
}


// ── Supabase API ────────────────────────────────────────────────
function makeApi(url, key, accessToken, userId) {
  const base = url.replace(/\/$/,'')+"/rest/v1";
  const H = {"Content-Type":"application/json","apikey":key,"Authorization":"Bearer "+accessToken};
  const ok = async r => { if(!r.ok){ let msg; try{msg=(await r.json()).message;}catch{msg=r.statusText;} throw new Error(msg||`HTTP ${r.status}`); } };
  const withComputed = row => ({
    ...row,
    final_price:Math.max(0,(+row.price_before_disc||0)-(+row.discount||0)),
    baht_per_kwh:+row.kwh>0?Math.max(0,(+row.price_before_disc||0)-(+row.discount||0))/(+row.kwh):0,
  });
  const stripComputed = row => {
    const clean={...row};
    delete clean.final_price;
    delete clean.baht_per_kwh;
    return clean;
  };
  const writeSession = async (method, path, row) => {
    const body={...row,user_id:userId};
    let r=await fetch(`${base}/${TABLE}${path}`,{method,headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(withComputed(body))});
    if(!r.ok){
      const msg=await r.text();
      if(/generated column|cannot insert|cannot update|final_price|baht_per_kwh/i.test(msg)){
        r=await fetch(`${base}/${TABLE}${path}`,{method,headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(stripComputed(body))});
      } else {
        throw new Error(msg);
      }
    }
    await ok(r); const d=await r.json(); return Array.isArray(d)?d[0]:d;
  };
  return {
    async fetchAll(){
      const r=await fetch(`${base}/${TABLE}?select=*&order=date.desc`,{headers:{...H,"Prefer":"return=representation"}});
      await ok(r); return r.json();
    },
    async insert(row){
      return writeSession("POST","",row);
    },
    async update(id,row){
      return writeSession("PATCH",`?id=eq.${id}`,row);
    },
    async remove(id){
      const r=await fetch(`${base}/${TABLE}?id=eq.${id}`,{method:"DELETE",headers:H});
      await ok(r);
    },
    async ping(){ const r=await fetch(`${base}/${TABLE}?select=id&limit=1`,{headers:H}); await ok(r); return true; },
    async fetchRates(){
      const r=await fetch(`${base}/${RTABLE}?select=*`,{headers:H});
      if(!r.ok) return null; // table might not exist yet
      return r.json();
    },
    async upsertRate(station, data){
      const post = body => fetch(`${base}/${RTABLE}?on_conflict=user_id,station`,{method:"POST",headers:{...H,"Prefer":"return=representation,resolution=merge-duplicates"},body:JSON.stringify(body)});
      let r=await post({user_id:userId,station,...data});
      if(!r.ok && ("color" in data || "abbr" in data)){
        const fallback={user_id:userId,station,...data};
        delete fallback.color; delete fallback.abbr;
        r=await post(fallback);
      }
      await ok(r);
    },
    async deleteRate(station){
      const r=await fetch(`${base}/${RTABLE}?station=eq.${encodeURIComponent(station)}`,{method:"DELETE",headers:H});
      await ok(r);
    },
  };
}

// ── Icons ───────────────────────────────────────────────────────
const I={
  bolt:    <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>,
  plus:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  search:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  edit:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>,
  trash:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>,
  dl:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>,
  trend:   <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 4 4 6-7"/><path d="M22 6h-6"/></svg>,
  trendDn: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 4-4 6 7"/><path d="M22 18h-6"/></svg>,
  rf:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>,
  gear:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  home:    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  wallet:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>,
  zap:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>,
  pin:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
  logout:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// ── SQL ─────────────────────────────────────────────────────────
const SQL=`-- 1) ตารางบันทึกการชาร์จ
create table charging_sessions (
  id                bigint generated always as identity primary key,
  user_id           uuid          not null default auth.uid() references auth.users(id) on delete cascade,
  date              date          not null,
  station           text          not null,
  trip              text,
  peak_type         text,          -- 'on_peak' | 'off_peak' | null (flat)
  price_before_disc numeric(10,2) not null,
  kwh               numeric(10,2) not null,
  discount          numeric(10,2) not null default 0,
  final_price       numeric(10,2) generated always as
                    (price_before_disc - discount) stored,
  baht_per_kwh      numeric(10,4) generated always as
                    (case when kwh > 0
                     then (price_before_disc - discount) / kwh
                     else 0 end) stored,
  rate_snapshot     jsonb,         -- snapshot ราคา ณ วันที่ชาร์จ
  created_at        timestamptz default now(),
  constraint charging_sessions_peak_type_check check (peak_type is null or peak_type in ('on_peak','off_peak')),
  constraint charging_sessions_kwh_check check (kwh > 0),
  constraint charging_sessions_price_check check (price_before_disc >= 0),
  constraint charging_sessions_discount_check check (discount >= 0 and discount <= price_before_disc)
);
create index charging_sessions_user_date_idx on charging_sessions(user_id, date desc);
alter table charging_sessions enable row level security;
create policy "users manage own charging sessions" on charging_sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2) ตารางราคาสถานี (admin แก้ได้)
create table station_rates (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  station     text not null,
  rate_type   text not null,       -- 'peak' | 'flat'
  on_peak     numeric(10,2),
  off_peak    numeric(10,2),
  on_time     text,
  off_time    text,
  flat        numeric(10,2),
  color       text,
  abbr        text,
  updated_at  timestamptz default now(),
  constraint station_rates_type_check check (rate_type in ('flat','peak')),
  constraint station_rates_values_check check (
    (rate_type = 'flat' and flat >= 0)
    or (rate_type = 'peak' and on_peak >= 0 and off_peak >= 0)
  ),
  primary key (user_id, station)
);
alter table station_rates add column if not exists color text;
alter table station_rates add column if not exists abbr text;
alter table station_rates enable row level security;
create policy "users manage own station rates" on station_rates
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

// ── Auth ─────────────────────────────────────────────────────────
function LoginScreen({ supabase }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [err,  setErr]  = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const submit = async () => {
    if (!email || !password) { setErr("กรุณากรอก Email และ Password"); return; }
    setBusy(true); setErr("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email:email.trim(), password });
      if(error) throw error;
    } catch (e) {
      setErr("Email หรือ Password ไม่ถูกต้อง");
      setPassword("");
    } finally { setBusy(false); }
  };

  const onKey = e => { if (e.key === "Enter") submit(); };

  return (
    <div className="auth-scrim">
        <form className="auth-card" onSubmit={e=>{e.preventDefault();submit();}}>
        <div className="logo auth-logo">{I.bolt}</div>
        <h2>เข้าสู่ระบบ</h2>
        <p>กรอก Email และ Password เพื่อเปิดแอป</p>
        <div className="auth-fields">
          <input
            ref={emailRef}
            type="email"
            className="auth-input"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={onKey}
            autoComplete="email"
            aria-label="Email"
            style={{letterSpacing:"normal",textAlign:"left"}}
          />
          <input
            type="password"
            className="auth-input"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={onKey}
            autoComplete="current-password"
            aria-label="Password"
            style={{textAlign:"left"}}
          />
        </div>
        {err && <div className="auth-err" role="alert">⚠ {err}</div>}
        <button type="submit" className="btn btn-primary auth-btn" disabled={busy}>
          {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
        </button>
      </form>
    </div>
  );
}

// ── Setup ───────────────────────────────────────────────────────
function SetupPanel({ onSave, accessToken, userId }) {
  const [url,setUrl]=useState(""); const [key,setKey]=useState("");
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(""); const [sql,setSql]=useState(false);
  const test=async()=>{
    if(!url||!key){ setErr("กรุณากรอก URL และ Key"); return; }
    setBusy(true);setErr("");
    try{
      await makeApi(url.trim(),key.trim(),accessToken,userId).ping();
      onSave(url.trim(),key.trim());
    }catch(e){ setErr("เชื่อมต่อไม่ได้: "+e.message); }
    setBusy(false);
  };
  return (
    <div className="setup-card">
      <h2>🔌 เชื่อมต่อ Supabase</h2>
      <p>กรอก Project URL และ anon key — ระบบจะจำไว้ใน browser นี้<br/>ถ้ายังไม่มี table ให้รัน SQL ด้านล่างใน <strong>Supabase → SQL Editor</strong> ก่อน</p>
      <div className="online-note">
        ฐานข้อมูลอยู่บน Supabase ออนไลน์ เปิดจากเครื่องไหนก็เห็นข้อมูลเดียวกันเมื่อใช้ Project URL และ anon key ชุดเดียวกัน
      </div>
      <div className="setup-grid">
        <div className="field" style={{gridColumn:"1/-1"}}>
          <label htmlFor="setup-url">Project URL</label>
          <input id="setup-url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxxxxxxxxxx.supabase.co"/>
          <span className="hint">Settings → API → Project URL</span>
        </div>
        <div className="field" style={{gridColumn:"1/-1"}}>
          <label htmlFor="setup-key">anon / public Key</label>
          <input id="setup-key" value={key} onChange={e=>setKey(e.target.value)} placeholder="eyJhbGci…" type="password"/>
          <span className="hint">Settings → API → anon public</span>
        </div>
      </div>
      {err&&<div style={{fontSize:12,color:"#A85B5B",marginTop:10}}>⚠️ {err}</div>}
      <div style={{display:"flex",gap:8,marginTop:16}}>
        <button className="btn btn-primary" onClick={test} disabled={busy}>{busy?"กำลังทดสอบ…":"ทดสอบและบันทึก"}</button>
      </div>
      <button className="collapse-btn" onClick={()=>setSql(v=>!v)}>{sql?"▼":"▶"} SQL สำหรับสร้าง tables</button>
      {sql&&(
        <div style={{position:"relative"}}>
          <pre className="sql-block">{SQL}</pre>
          <button className="btn btn-ghost" style={{position:"absolute",top:8,right:8,fontSize:11,padding:"4px 10px"}} onClick={()=>navigator.clipboard?.writeText(SQL)}>คัดลอก</button>
        </div>
      )}
    </div>
  );
}

// ── Sparkline ───────────────────────────────────────────────────
function Sparkline({data,color="#6CAE76",w=88,h=28}){
  if(!data||data.length<2) return null;
  const min=Math.min(...data),max=Math.max(...data),rng=max-min||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-(v-min)/rng*h}`).join(" ");
  return(
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{overflow:"visible",display:"block"}}>
      <defs><linearGradient id={"sg"+color.replace("#","")} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".18"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient></defs>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Donut Chart ─────────────────────────────────────────────────
function DonutChart({segments,total,centerText,size=140}){
  const cx=size/2,cy=size/2,r=size*0.34,sw=size*0.16;
  const circ=2*Math.PI*r;
  let acc=0;
  const arcs=segments.map(s=>{
    const frac=(total?s.value/total:0);
    const dash=frac*circ;
    const arc={...s,dash,offset:acc};
    acc+=dash;
    return arc;
  });
  return(
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--line)" strokeWidth={sw}/>
      {arcs.map((a,i)=>(
        <circle key={i} cx={cx} cy={cy} r={r} fill="none"
          stroke={a.color} strokeWidth={sw}
          strokeDasharray={`${a.dash} ${circ-a.dash}`}
          strokeDashoffset={circ/4-a.offset}
          style={{transform:`rotate(-90deg)`,transformOrigin:`${cx}px ${cy}px`}}/>
      ))}
      {centerText&&(<>
        <text x={cx} y={cy-6} textAnchor="middle" fontSize={size*0.072} fill="var(--ink-3)" fontFamily="inherit">รวม</text>
        <text x={cx} y={cy+10} textAnchor="middle" fontSize={size*0.095} fontWeight="700" fill="var(--ink)" fontFamily="inherit">{centerText}</text>
      </>)}
    </svg>
  );
}

// ── Stat Cards ──────────────────────────────────────────────────
function StatCards({entries,allEntries}){
  const monthlyHistory=useMemo(()=>{
    const by={};
    (allEntries||entries).forEach(e=>{
      const k=mKey(e.date);
      if(!by[k]) by[k]={kwh:0,cost:0,n:0};
      by[k].kwh+=+e.kwh||0; by[k].cost+=+e.final_price||0; by[k].n++;
    });
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).slice(-6).map(([,v])=>v);
  },[allEntries,entries]);

  const s=useMemo(()=>{
    const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);
    const totK=sum(entries,"kwh"),totC=sum(entries,"final_price");
    const sorted=[...entries].sort((a,b)=>b.date.localeCompare(a.date));
    const now=sorted.length?sorted[0].date.slice(0,7):mKey(new Date().toISOString());
    const prev=previousMonthKey(now);
    const pm=entries.filter(e=>e.date.startsWith(prev));
    const pmK=sum(pm,"kwh"),pmC=sum(pm,"final_price");
    const pct=(a,b)=>b?((a-b)/b)*100:null;
    return{totKwh:totK,totCost:totC,avgRate:totK?totC/totK:0,sessions:entries.length,kD:pct(totK,pmK),cD:pct(totC,pmC)};
  },[entries]);

  const CARD_COLORS=["#6CAE76","#E87B6A","#6AAAE8","#B98CE8"];
  const CARD_ICONS=[
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>,
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>,
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>,
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  ];
  const cards=[
    {lbl:"พลังงานรวม",val:NUM(s.totKwh,1),suffix:"kWh",delta:s.kD,spark:monthlyHistory.map(m=>m.kwh)},
    {lbl:"ค่าใช้จ่ายรวม",val:THB(s.totCost),delta:s.cD,invert:true,spark:monthlyHistory.map(m=>m.cost)},
    {lbl:"ราคาเฉลี่ย kWh",val:NUM(s.avgRate,2),suffix:"฿/kWh",spark:monthlyHistory.map(m=>m.kwh?m.cost/m.kwh:0)},
    {lbl:"จำนวนครั้งในการชาร์จ",val:s.sessions,suffix:"ครั้ง",spark:monthlyHistory.map(m=>m.n)},
  ];
  return(
    <div className="stats">
      {cards.map((c,i)=>{
        const clr=CARD_COLORS[i];
        const up=c.invert?c.delta<0:c.delta>0;
        return(
          <div className="stat" key={i}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div className="lbl">{c.lbl}</div>
              <div style={{width:36,height:36,borderRadius:10,background:clr+"20",display:"grid",placeItems:"center",color:clr,flexShrink:0}}>{CARD_ICONS[i]}</div>
            </div>
            <div className="val" style={{marginTop:10}}>{c.val}{c.suffix&&<small>{" "+c.suffix}</small>}</div>
            {c.delta!=null&&Math.abs(c.delta)>0.05&&(
              <div className={"delta "+(up?"":"down")} style={{marginTop:6}}>
                {up?I.trend:I.trendDn}{(c.delta>=0?"+":"")+c.delta.toFixed(1)}% จากเดือนก่อน
              </div>
            )}
            <div style={{marginTop:"auto",paddingTop:12}}>
              <Sparkline data={c.spark} color={clr}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────────────
function ChartPanel({entries,monthFilter,setMonthFilter}){
  const [metric,setMetric]=useState("cost");
  const data=useMemo(()=>{
    const by={};
    entries.forEach(e=>{
      const k=mKey(e.date);
      if(!by[k]) by[k]={cost:0,kwh:0,n:0};
      by[k].cost+=+e.final_price||0; by[k].kwh+=+e.kwh||0; by[k].n++;
    });
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>({key:k,...v,avg:v.kwh?v.cost/v.kwh:0}));
  },[entries]);
  const val=d=>metric==="cost"?d.cost:metric==="kwh"?d.kwh:d.avg;
  const max=Math.max(...data.map(val),1);
  const METRICS=[["cost","ค่าใช้จ่าย (฿)"],["kwh","พลังงาน (kWh)"],["avg","ราคาเฉลี่ย (฿/kWh)"]];
  const fmt=v=>metric==="cost"?THB(v):metric==="kwh"?NUM(v,1)+" kWh":NUM(v,2)+" ฿/kWh";
  return(
    <div className="panel">
      <div className="panel-hd">
        <div><h3>แนวโน้มการชาร์จ</h3><div className="panel-sub">{data.length} เดือน</div></div>
      </div>
      <div className="chip-group small" style={{marginBottom:16,width:"fit-content"}}>
        {METRICS.map(([v,l])=>(
          <button key={v} className={metric===v?"on":""} onClick={()=>setMetric(v)}>{l}</button>
        ))}
      </div>
      <div className="chart">
        {data.map(d=>{
          const act=monthFilter===d.key,dim=monthFilter&&monthFilter!==d.key;
          return(
            <div key={d.key} className={"bar-wrap clickable "+(act?"active ":"")+(dim?"dim ":"")}
              role="button" tabIndex="0" aria-pressed={act}
              aria-label={`${mLbl(d.key)} ${fmt(val(d))}`}
              onClick={()=>setMonthFilter(monthFilter===d.key?null:d.key)}
              onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setMonthFilter(monthFilter===d.key?null:d.key);}}}
              title={`${mLbl(d.key)} · ${fmt(val(d))}`}>
              <div className="bar-amount">{fmt(val(d))}</div>
              <div className="bar-stack" style={{height:(val(d)/max*100)+"%"}}><span className="bar-seg solid"/></div>
              <div className="bar-label">{mLbl(d.key)}</div>
            </div>
          );
        })}
      </div>
      <div className="chart-footer">
        {monthFilter
          ?<button className="link-btn" onClick={()=>setMonthFilter(null)}>กรองเฉพาะ <b>{mLbl(monthFilter)}</b> · ยกเลิก</button>
          :<span className="hint-line">คลิกแท่งกราฟเพื่อกรองเดือนนั้น</span>}
      </div>
    </div>
  );
}

// ── Breakdown ───────────────────────────────────────────────────
function BreakdownPanel({entries,rates}){
  const bd=useMemo(()=>{
    const by={};
    entries.forEach(e=>{
      if(!by[e.station]) by[e.station]={kwh:0,cost:0,n:0};
      by[e.station].kwh+=+e.kwh||0; by[e.station].cost+=+e.final_price||0; by[e.station].n++;
    });
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return{items:Object.entries(by).map(([k,v])=>({key:k,...v,pct:tot?v.cost/tot*100:0})).sort((a,b)=>b.cost-a.cost).slice(0,6),tot};
  },[entries]);
  const segs=bd.items.map(b=>({value:b.cost,color:smeta(b.key,rates).color}));
  return(
    <div className="panel">
      <h3>การกระจายตามสถานี</h3>
      <div className="panel-sub" style={{marginBottom:16}}>ยอดรวมตลอดประวัติ</div>
      <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:16}}>
        <DonutChart segments={segs} total={bd.tot} centerText={THB(bd.tot)} size={140}/>
        <div style={{flex:1,display:"flex",flexDirection:"column",gap:8}}>
          {bd.items.map(b=>{
            const s=smeta(b.key,rates);
            return(
              <div key={b.key} style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:10,height:10,borderRadius:3,background:s.color,flexShrink:0}}/>
                <div style={{flex:1,fontSize:12,color:"var(--ink-2)",fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{b.key}</div>
                <div style={{fontSize:12,color:"var(--ink-3)",minWidth:32,textAlign:"right"}}>{b.pct.toFixed(0)}%</div>
                <div style={{fontSize:12,fontWeight:700,color:"var(--ink)",minWidth:60,textAlign:"right"}}>{THB(b.cost)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Charging Stats + Recent Activity ────────────────────────────
function DashboardBottom({entries,rates}){
  const stats=useMemo(()=>{
    const sum=(f)=>entries.reduce((a,e)=>a+(+e[f]||0),0);
    const kwh=sum("kwh"), co2=(kwh*0.495).toFixed(1);
    return{sessions:entries.length,kwh,co2};
  },[entries]);
  const recent=useMemo(()=>[...entries].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5),[entries]);
  return(
    <div className="panels" style={{marginTop:14}}>
      <div className="panel">
        <h3>สถิติการชาร์จ</h3>
        <div className="panel-sub" style={{marginBottom:18}}>ยอดรวมตลอดประวัติ</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          {[
            {icon:"⚡",lbl:"การชาร์จทั้งหมด",val:stats.sessions+" ครั้ง"},
            {icon:"🔋",lbl:"พลังงานรวม",val:NUM(stats.kwh,1)+" kWh"},
            {icon:"🌿",lbl:"คาร์บอนที่ลดได้",val:stats.co2+" kg CO₂"},
            {icon:"📅",lbl:"รายการทั้งหมด",val:stats.sessions+" รายการ"},
          ].map((s,i)=>(
            <div key={i} style={{background:"var(--surface-soft)",borderRadius:10,padding:"12px 14px"}}>
              <div style={{fontSize:20,marginBottom:6}}>{s.icon}</div>
              <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:4}}>{s.lbl}</div>
              <div style={{fontSize:16,fontWeight:700,color:"var(--ink)"}}>{s.val}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <h3>กิจกรรมล่าสุด</h3>
        <div className="panel-sub" style={{marginBottom:16}}>การชาร์จล่าสุด</div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {recent.length===0&&<div style={{color:"var(--ink-3)",fontSize:13}}>ยังไม่มีรายการ</div>}
          {recent.map(e=>{
            const s=smeta(e.station,rates);
            return(
              <div key={e.id} style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:34,height:34,borderRadius:9,background:s.color,display:"grid",placeItems:"center",color:"#fff",fontSize:12,fontWeight:700,flexShrink:0}}>{s.abbr}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.station}</div>
                  <div style={{fontSize:11,color:"var(--ink-3)"}}>{dLbl(e.date)}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--ink)"}}>{THB(e.final_price)}</div>
                  <div style={{fontSize:11,color:"var(--ink-3)"}}>{NUM(e.kwh,1)} kWh</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Line Chart ──────────────────────────────────────────────────
function LineChart({data,color="#6CAE76",h=200}){
  if(!data||data.length<2) return <div style={{height:h,display:"grid",placeItems:"center",color:"var(--ink-3)",fontSize:13}}>ยังไม่มีข้อมูล</div>;
  const pL=44,pR=16,pT=16,pB=32,W=480;
  const cw=W-pL-pR,ch=h-pT-pB;
  const maxV=Math.max(...data.map(d=>d.value),1);
  const pts=data.map((d,i)=>({x:pL+(i/(data.length-1))*cw,y:pT+ch-(d.value/maxV)*ch,...d}));
  const linePath=pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area=`${linePath} L${pts[pts.length-1].x.toFixed(1)},${pT+ch} L${pts[0].x.toFixed(1)},${pT+ch} Z`;
  const yTicks=[0,0.25,0.5,0.75,1];
  return(
    <svg width="100%" viewBox={`0 0 ${W} ${h}`} style={{overflow:"visible",display:"block"}}>
      <defs>
        <linearGradient id="lc-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".18"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      {yTicks.slice(1).map(f=>(
        <line key={f} x1={pL} x2={W-pR} y1={pT+ch*(1-f)} y2={pT+ch*(1-f)} stroke="var(--line)" strokeDasharray="4 3" strokeWidth="1"/>
      ))}
      {yTicks.map(f=>(
        <text key={f} x={pL-6} y={pT+ch*(1-f)+4} textAnchor="end" fontSize="10" fill="var(--ink-3)" fontFamily="inherit">
          {maxV*f>=1000?(maxV*f/1000).toFixed(0)+"k":(maxV*f).toFixed(0)}
        </text>
      ))}
      <path d={area} fill="url(#lc-fill)"/>
      <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
      {pts.map((p,i)=>(
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={i===pts.length-1?5:3.5} fill={i===pts.length-1?color:"#fff"} stroke={color} strokeWidth="2"/>
          {i===pts.length-1&&<text x={p.x} y={p.y-10} textAnchor="middle" fontSize="11" fontWeight="700" fill={color} fontFamily="inherit">{p.label2||""}</text>}
          <text x={p.x} y={pT+ch+16} textAnchor="middle" fontSize="11" fill="var(--ink-3)" fontFamily="inherit">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ── Expense Page ─────────────────────────────────────────────────
function ExpensePage({entries,rates,initialBudget,onBudgetSave}){
  const now=new Date();
  const [subTab,setSubTab]=useState("ภาพรวม");
  const years=useMemo(()=>[...new Set(entries.map(e=>+e.date.slice(0,4)))].sort((a,b)=>b-a),[entries]);
  const [yr,setYr]=useState(()=>now.getFullYear());
  const [mo,setMo]=useState(()=>now.getMonth()+1);
  const [budget,setBudget]=useState(()=>initialBudget||0);
  const [editBudget,setEditBudget]=useState(false);
  const [budgetInput,setBudgetInput]=useState("");

  const monthKey=`${yr}-${String(mo).padStart(2,"0")}`;
  const prevKey=previousMonthKey(monthKey);
  const mE=useMemo(()=>entries.filter(e=>e.date.startsWith(monthKey)),[entries,monthKey]);
  const pE=useMemo(()=>entries.filter(e=>e.date.startsWith(prevKey)),[entries,prevKey]);
  const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);

  const totC=sum(mE,"final_price"),totK=sum(mE,"kwh"),totD=sum(mE,"discount");
  const avgSess=mE.length?totC/mE.length:0,avgRate=totK?totC/totK:0;
  const pC=sum(pE,"final_price"),pK=sum(pE,"kwh");
  const pAvg=pK?pC/pK:0;
  const pct=(a,b)=>b?((a-b)/b)*100:null;
  const discSessions=mE.filter(e=>+e.discount>0).length;

  const trendData=useMemo(()=>{
    const by={};
    entries.forEach(e=>{const k=mKey(e.date);if(!by[k])by[k]={cost:0,kwh:0};by[k].cost+=+e.final_price||0;by[k].kwh+=+e.kwh||0;});
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).slice(-8).map(([k,v])=>({label:mLbl(k),value:v.cost,label2:THB(v.cost)}));
  },[entries]);

  const stBd=useMemo(()=>{
    const by={};
    mE.forEach(e=>{if(!by[e.station])by[e.station]={kwh:0,cost:0,n:0};by[e.station].kwh+=+e.kwh||0;by[e.station].cost+=+e.final_price||0;by[e.station].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return{items:Object.entries(by).map(([k,v])=>({key:k,...v,pct:tot?v.cost/tot*100:0,color:smeta(k,rates).color,abbr:smeta(k,rates).abbr})).sort((a,b)=>b.cost-a.cost),tot};
  },[mE,rates]);

  const pkBd=useMemo(()=>{
    const MAP={on_peak:{lbl:"On Peak",color:"#E87B6A"},off_peak:{lbl:"Off Peak",color:"#6AAAE8"},null:{lbl:"Flat Rate",color:"#6CAE76"}};
    const by={};
    mE.forEach(e=>{const k=String(e.peak_type||"null");if(!by[k])by[k]={...MAP[k]||{lbl:k,color:"#999"},cost:0,kwh:0,n:0};by[k].cost+=+e.final_price||0;by[k].kwh+=+e.kwh||0;by[k].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return{items:Object.values(by).filter(v=>v.n>0).map(v=>({...v,pct:tot?v.cost/tot*100:0,value:v.cost})),tot};
  },[mE]);

  const budgetPct=budget>0?Math.min(totC/budget*100,100):0;
  const MONTHS_TH=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const monthOpts=useMemo(()=>{
    const opts=[];
    years.forEach(y=>MONTHS_TH.forEach((_,i)=>{const k=`${y}-${String(i+1).padStart(2,"0")}`;if(entries.some(e=>e.date.startsWith(k)))opts.push({y,m:i+1,k,lbl:`${MONTHS_TH[i]} ${y+543}`});}));
    return opts.reverse();
  },[entries,years]);

  const DeltaBadge=({d,invert=false})=>{
    if(d==null||Math.abs(d)<0.05) return null;
    const up=invert?d<0:d>0;
    return <span className={"delta "+(up?"":"down")} style={{fontSize:11,marginLeft:6}}>{d>=0?"+":""}{d.toFixed(1)}%</span>;
  };

  // ─── Stat cards ───
  const statCards=[
    {lbl:"ค่าใช้จ่ายรวม",val:THB(totC),d:pct(totC,pC),inv:true,icon:"💳",bg:"#E87B6A20"},
    {lbl:"เฉลี่ยต่อครั้ง",val:THB(avgSess),d:pct(avgSess,pC&&pE.length?pC/pE.length:0),inv:true,icon:"⚡",bg:"#6AAAE820"},
    {lbl:"ราคาเฉลี่ย kWh",val:NUM(avgRate,2)+" ฿/kWh",d:pct(avgRate,pAvg),inv:true,icon:"📊",bg:"#6CAE7620"},
    {lbl:"ส่วนลดรวม",val:THB(totD),sub:discSessions+" รายการ",icon:"🏷️",bg:"#F5A62320"},
  ];

  // ─── Station breakdown for sub-tab ───
  const StationBreakdown=()=>(
    <div>
      <div style={{display:"flex",gap:20,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <DonutChart segments={stBd.items.map(b=>({value:b.cost,color:b.color}))} total={stBd.tot} centerText={THB(stBd.tot)} size={150}/>
        <div style={{flex:1,display:"flex",flexDirection:"column",gap:10}}>
          {stBd.items.map(b=>(
            <div key={b.key} style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:10,height:10,borderRadius:3,background:b.color,flexShrink:0}}/>
              <div style={{flex:1,fontSize:13,fontWeight:600,color:"var(--ink-2)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{b.key}</div>
              <span style={{fontSize:12,color:"var(--ink-3)",minWidth:36,textAlign:"right"}}>{b.pct.toFixed(0)}%</span>
              <span style={{fontSize:13,fontWeight:700,color:"var(--ink)",minWidth:70,textAlign:"right"}}>{THB(b.cost)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return(
    <div>
      {/* Month selector + sub-nav */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <p style={{margin:0,fontSize:13,color:"var(--ink-3)"}}>วิเคราะห์และจัดการค่าใช้จ่ายในการชาร์จ</p>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <select className="field input" style={{fontSize:13,padding:"6px 10px",borderRadius:8,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer"}}
            aria-label="เลือกเดือนค่าใช้จ่าย"
            value={monthKey} onChange={e=>{const[y,m]=e.target.value.split("-");setYr(+y);setMo(+m);}}>
            {monthOpts.map(o=><option key={o.k} value={o.k}>{o.lbl}</option>)}
          </select>
        </div>
      </div>

      <div className="chip-group" style={{marginBottom:20,width:"fit-content"}}>
        {["ภาพรวม","แนวโน้ม","แยกตามสถานี","แยกตามหมวด"].map(t=>(
          <button key={t} className={subTab===t?"on":""} onClick={()=>setSubTab(t)}>{t}</button>
        ))}
      </div>

      {/* ── ภาพรวม ── */}
      {subTab==="ภาพรวม"&&(<>
        {/* Stat cards */}
        <div className="stats" style={{marginBottom:16}}>
          {statCards.map((c,i)=>(
            <div className="stat" key={i} style={{minHeight:"unset"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div className="lbl">{c.lbl}</div>
                <div style={{fontSize:20}}>{c.icon}</div>
              </div>
              <div className="val" style={{marginTop:8,fontSize:22}}>{c.val}</div>
              {c.d!=null?<DeltaBadge d={c.d} invert={c.inv}/>:c.sub&&<span style={{fontSize:12,color:"var(--ink-3)"}}>{c.sub}</span>}
            </div>
          ))}
        </div>

        {/* Chart + Breakdown */}
        <div className="panels" style={{marginBottom:16}}>
          <div className="panel" style={{minHeight:"unset"}}>
            <div className="panel-hd"><h3>แนวโน้มค่าใช้จ่าย</h3></div>
            <LineChart data={trendData} color="var(--leaf-2)" h={200}/>
          </div>
          <div className="panel" style={{minHeight:"unset"}}>
            <h3>แยกตามสถานี</h3>
            <div className="panel-sub" style={{marginBottom:14}}>{MONTHS_TH[mo-1]} {yr+543}</div>
            <StationBreakdown/>
          </div>
        </div>

        {/* Comparison + Budget + Savings */}
        <div className="expense-3col">
          {/* เปรียบเทียบกับเดือนก่อน */}
          <div className="panel" style={{minHeight:"unset",padding:18}}>
            <h3 style={{marginBottom:14}}>เปรียบเทียบกับเดือนก่อน</h3>
            {[
              {lbl:"ค่าใช้จ่ายรวม",cur:totC,prv:pC,fmt:THB,inv:true},
              {lbl:"พลังงาน",cur:totK,prv:pK,fmt:v=>NUM(v,1)+" kWh"},
              {lbl:"ราคาเฉลี่ย",cur:avgRate,prv:pAvg,fmt:v=>NUM(v,2)+" ฿/kWh",inv:true},
            ].map((r,i)=>{
              const d=pct(r.cur,r.prv);
              const up=r.inv?d<0:d>0;
              return(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:10,marginBottom:10,borderBottom:i<2?"1px solid var(--line)":"none"}}>
                  <div>
                    <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:2}}>{r.lbl}</div>
                    <div style={{fontSize:14,fontWeight:700}}>{r.fmt(r.cur)}</div>
                    <div style={{fontSize:11,color:"var(--ink-3)"}}>จาก {r.fmt(r.prv)}</div>
                  </div>
                  {d!=null&&<span className={"delta "+(up?"":"down")} style={{fontSize:12}}>{d>=0?"+":""}{d.toFixed(1)}%</span>}
                </div>
              );
            })}
          </div>

          {/* งบประมาณ */}
          <div className="panel" style={{minHeight:"unset",padding:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <h3>งบประมาณเดือนนี้</h3>
              <button className="btn btn-ghost" style={{fontSize:11,padding:"3px 8px"}} onClick={()=>{setBudgetInput(String(budget));setEditBudget(true);}}>ตั้งค่า</button>
            </div>
            {editBudget&&(
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                <input type="number" value={budgetInput} onChange={e=>setBudgetInput(e.target.value)} style={{flex:1,padding:"6px 8px",borderRadius:8,border:"1px solid var(--line)",fontFamily:"inherit",fontSize:13}} placeholder="งบประมาณ (฿)"/>
                <button className="btn btn-primary" style={{padding:"6px 10px",fontSize:12}} onClick={()=>{const v=+budgetInput;if(v>=0){setBudget(v);onBudgetSave?.(v);}setEditBudget(false);}}>บันทึก</button>
              </div>
            )}
            {budget>0?(
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
                <div style={{position:"relative",width:110,height:110}}>
                  <DonutChart segments={[{value:budgetPct,color:budgetPct>=90?"#E87B6A":"var(--leaf-2)"},{value:100-budgetPct,color:"var(--line)"}]} total={100} size={110}/>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column"}}>
                    <span style={{fontSize:18,fontWeight:700,color:"var(--ink)"}}>{budgetPct.toFixed(0)}%</span>
                  </div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:14,fontWeight:700}}>{THB(totC)} / {THB(budget)}</div>
                  <div style={{fontSize:12,color:budget-totC<0?"#E87B6A":"var(--leaf-2)",marginTop:4}}>
                    {budget-totC>=0?`เหลืออีก ${THB(budget-totC)}`:`เกินงบ ${THB(totC-budget)}`}
                  </div>
                </div>
              </div>
            ):<div style={{fontSize:13,color:"var(--ink-3)",textAlign:"center",paddingTop:20}}>กดตั้งค่าเพื่อกำหนดงบประมาณ</div>}
          </div>

          {/* ส่วนลด */}
          <div className="panel" style={{minHeight:"unset",padding:18}}>
            <h3 style={{marginBottom:14}}>ประหยัดได้จากส่วนลด</h3>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8,paddingTop:12}}>
              <div style={{fontSize:36}}>🏷️</div>
              <div style={{fontSize:26,fontWeight:700,color:"var(--leaf-2)"}}>{THB(totD)}</div>
              <div style={{fontSize:13,color:"var(--ink-3)"}}>จาก {discSessions} รายการ</div>
              {totC>0&&<div style={{fontSize:12,color:"var(--ink-3)",marginTop:4}}>คิดเป็น {(totD/(totC+totD)*100).toFixed(1)}% ของค่าใช้จ่ายก่อนลด</div>}
            </div>
          </div>
        </div>

        {/* Recent expenses */}
        <div className="panel" style={{minHeight:"unset",padding:18}}>
          <h3 style={{marginBottom:14}}>รายการค่าใช้จ่ายล่าสุด</h3>
          {mE.length===0?<div style={{textAlign:"center",color:"var(--ink-3)",padding:"20px 0",fontSize:13}}>ยังไม่มีรายการในเดือนนี้</div>:(
            <div className="twrap">
              <table>
                <thead><tr>
                  <th>วันที่</th><th>สถานี</th>
                  <th className="num">พลังงาน (kWh)</th>
                  <th className="num">ราคา/kWh</th>
                  <th className="num">ส่วนลด</th>
                  <th className="num">ยอดรวม</th>
                  <th>หมายเหตุ</th>
                </tr></thead>
                <tbody>
                  {[...mE].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>{
                    const s=smeta(e.station,rates);
                    return(
                      <tr key={e.id}>
                        <td className="date">{dLbl(e.date)}</td>
                        <td className="station"><div className="station-cell"><div className="badge" style={{background:s.color}}>{s.abbr}</div><div>{e.station}</div></div></td>
                        <td className="num">{NUM(e.kwh,1)}</td>
                        <td className="num">{NUM(e.baht_per_kwh,2)}</td>
                        <td className="num" style={{color:+e.discount>0?"var(--leaf-2)":"var(--muted)"}}>{+e.discount>0?"−"+THB(e.discount):"—"}</td>
                        <td className="num" style={{fontWeight:600}}>{THB(e.final_price)}</td>
                        <td style={{fontSize:12,color:"var(--ink-3)"}}>{e.trip||"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>)}

      {/* ── แนวโน้ม ── */}
      {subTab==="แนวโน้ม"&&(
        <div className="panel">
          <div className="panel-hd"><h3>แนวโน้มค่าใช้จ่ายรายเดือน</h3></div>
          <LineChart data={trendData} color="var(--leaf-2)" h={280}/>
        </div>
      )}

      {/* ── แยกตามสถานี ── */}
      {subTab==="แยกตามสถานี"&&(
        <div className="panel">
          <h3 style={{marginBottom:4}}>แยกตามสถานี</h3>
          <div className="panel-sub" style={{marginBottom:20}}>{MONTHS_TH[mo-1]} {yr+543} · {mE.length} รายการ</div>
          <StationBreakdown/>
          {stBd.items.map(b=>(
            <div key={b.key} className="bd-row">
              <div className="dot" style={{background:b.color+"28",color:b.color}}>{b.abbr}</div>
              <div className="info">
                <div className="name">{b.key}</div>
                <div className="meta">{b.n}ครั้ง · {NUM(b.kwh,1)} kWh</div>
                <div className="bd-bar"><i style={{width:b.pct+"%",background:b.color}}/></div>
              </div>
              <div><div className="amt">{THB(b.cost)}</div><div className="pct">{b.pct.toFixed(1)}%</div></div>
            </div>
          ))}
        </div>
      )}

      {/* ── แยกตามหมวด (peak type) ── */}
      {subTab==="แยกตามหมวด"&&(
        <div className="panel">
          <h3 style={{marginBottom:4}}>แยกตามประเภทชาร์จ</h3>
          <div className="panel-sub" style={{marginBottom:20}}>{MONTHS_TH[mo-1]} {yr+543}</div>
          <div style={{display:"flex",gap:20,alignItems:"center",marginBottom:20}}>
            <DonutChart segments={pkBd.items} total={pkBd.tot} centerText={THB(pkBd.tot)} size={150}/>
            <div style={{flex:1,display:"flex",flexDirection:"column",gap:12}}>
              {pkBd.items.map((b,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:12,height:12,borderRadius:3,background:b.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600}}>{b.lbl}</div>
                    <div style={{fontSize:11,color:"var(--ink-3)"}}>{b.n}ครั้ง · {NUM(b.kwh,1)} kWh</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:14,fontWeight:700}}>{THB(b.cost)}</div>
                    <div style={{fontSize:11,color:"var(--ink-3)"}}>{b.pct.toFixed(1)}%</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Log Table ────────────────────────────────────────────────────
function LogTable({entries,rates,onEdit,onDelete,monthFilter,setMonthFilter,loading}){
  const [q,setQ]=useState(""); const [filter,setFilter]=useState("ทั้งหมด"); const [sort,setSort]=useState({key:"date",dir:"desc"});
  const filtered=useMemo(()=>{
    let r=entries;
    if(monthFilter) r=r.filter(e=>e.date.startsWith(monthFilter));
    if(filter==="มีส่วนลด") r=r.filter(e=>+e.discount>0);
    if(filter==="ราคาสูง") r=r.filter(e=>+e.baht_per_kwh>=7.5);
    if(q){const Q=q.toLowerCase();r=r.filter(e=>(e.station+" "+(e.trip||"")).toLowerCase().includes(Q));}
    const{key,dir}=sort,sgn=dir==="asc"?1:-1;
    return[...r].sort((a,b)=>{const va=a[key]??0,vb=b[key]??0;if(va<vb)return-sgn;if(va>vb)return sgn;return 0;});
  },[entries,q,filter,sort,monthFilter]);
  const setK=k=>setSort(s=>s.key===k?{key:k,dir:s.dir==="asc"?"desc":"asc"}:{key:k,dir:"desc"});
  const Hdr=({label,k,align="left",className=""})=>(
    <th className={(sort.key===k?"sorted ":"")+(align==="right"?"num ":"")+className}
      aria-sort={sort.key===k?(sort.dir==="asc"?"ascending":"descending"):"none"}>
      <button className="sortable-button" onClick={()=>setK(k)}>
        {label}<span className="sort-ind" aria-hidden="true">{sort.key===k?(sort.dir==="asc"?"▲":"▼"):"▲▼"}</span>
      </button>
    </th>
  );
  return(
    <div className="table-card">
      <div className="table-head">
        <div>
          <h3>รายการชาร์จ</h3>
          <div className="sub">
            {filtered.length} รายการ
            {monthFilter&&<span className="month-pill">{mLbl(monthFilter)} <button onClick={()=>setMonthFilter(null)}>×</button></span>}
          </div>
        </div>
        <div className="filters">
          <div className="chip-group">
            {["ทั้งหมด","มีส่วนลด","ราคาสูง"].map(f=>(
              <button key={f} className={filter===f?"on":""} onClick={()=>setFilter(f)}>{f}</button>
            ))}
          </div>
          <div className="search">{I.search}<input aria-label="ค้นหาสถานีหรือทริป" placeholder="ค้นหาสถานี / ทริป…" value={q} onChange={e=>setQ(e.target.value)}/></div>
        </div>
      </div>
      {loading?<div className="empty"><div className="spinner"/><div style={{marginTop:12}}>กำลังโหลด…</div></div>
      :filtered.length===0?<div className="empty">ไม่พบรายการ</div>
      :(
        <div className="twrap">
          <table>
            <thead><tr>
              <Hdr label="วันที่" k="date"/>
              <Hdr label="สถานี" k="station"/>
              <Hdr label="KWH" k="kwh" align="right"/>
              <Hdr label="ราคา/KWH" k="baht_per_kwh" align="right" className="optional-column"/>
              <Hdr label="ส่วนลด" k="discount" align="right" className="optional-column"/>
              <Hdr label="ค่าชาร์จ" k="final_price" align="right"/>
              <th style={{width:80}}></th>
            </tr></thead>
            <tbody>
              {filtered.map(e=>{
                const s=smeta(e.station,rates);
                return(
                  <tr key={e.id}>
                    <td className="date">{dLbl(e.date)}</td>
                    <td className="station">
                      <div className="station-cell">
                        <div className="badge" style={{background:s.color}}>{s.abbr}</div>
                        <div><div>{e.station}</div>{e.trip&&<div className="station-trip">{e.trip}</div>}</div>
                      </div>
                    </td>
                    <td className="num">{NUM(e.kwh,2)}</td>
                    <td className="num optional-column">{NUM(e.baht_per_kwh,2)}</td>
                    <td className="num optional-column" style={{color:+e.discount>0?"var(--leaf-2)":"var(--muted)"}}>{+e.discount>0?"−"+THB(e.discount):"—"}</td>
                    <td className="num" style={{fontWeight:600,color:"var(--ink)"}}>{THB(e.final_price)}</td>
                    <td><div className="row-actions">
                      <button className="icon-btn" aria-label={`แก้ไขรายการ ${e.station} ${dLbl(e.date)}`} onClick={()=>onEdit(e)}>{I.edit}</button>
                      <button className="icon-btn danger" aria-label={`ลบรายการ ${e.station} ${dLbl(e.date)}`} onClick={()=>onDelete(e)}>{I.trash}</button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Entry Modal ─────────────────────────────────────────────────
function EntryModal({entry,rates,onClose,onSave,saving}){
  const dialogRef=useDialog(onClose);
  const today=getLocalDateInput();
  const initStation=entry?.station||Object.keys(rates)[0]||"PTT";
  const [form,setForm]=useState({
    date:entry?.date||today,
    station:initStation,
    trip:entry?.trip||"",
    kwh:entry?String(entry.kwh):"",
    discount:entry?String(entry.discount):"0",
    peak_type:entry?.peak_type||null,
    price_before_disc:entry?String(entry.price_before_disc):"",
  });
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));

  const stationRate=rates[form.station];
  const isPeak=stationRate?.type==="peak";

  // when station changes, reset peak selection and price
  useEffect(()=>{
    if(!entry){
      set("peak_type",null);
      set("price_before_disc","");
    }
  },[form.station]);

  // auto-fill price when peak_type chosen
  const selectPeak=(pt)=>{
    set("peak_type",pt);
    if(stationRate){
      const rate=pt==="on_peak"?stationRate.on_peak:stationRate.off_peak;
      if(rate&&form.kwh) set("price_before_disc",String((+form.kwh*rate).toFixed(2)));
    }
  };

  // recalc price when kwh or station changes
  useEffect(()=>{
    if(form.peak_type&&stationRate&&form.kwh){
      const rate=form.peak_type==="on_peak"?stationRate.on_peak:stationRate.off_peak;
      if(rate) set("price_before_disc",String((+form.kwh*rate).toFixed(2)));
    } else if(!isPeak&&stationRate?.flat&&form.kwh){
      set("price_before_disc",String((+form.kwh*stationRate.flat).toFixed(2)));
    }
  },[form.kwh, form.station]);

  const finalPrice=Math.max(0,(+form.price_before_disc||0)-(+form.discount||0));
  const bahtPerKwh=+form.kwh>0?finalPrice/(+form.kwh):0;
  const discountErr=+form.discount>0&&+form.discount>(+form.price_before_disc||0);
  const valid=validateEntryForm(form,isPeak);

  const handleSave=()=>{
    if(!valid)return;
    // build snapshot
    const snap=stationRate?{...stationRate,captured_at:new Date().toISOString()}:null;
    onSave({
      date:form.date, station:form.station, trip:form.trip.trim()||null,
      peak_type:form.peak_type||null,
      price_before_disc:+form.price_before_disc,
      kwh:+form.kwh, discount:+form.discount||0,
      rate_snapshot:snap,
    });
  };

  return(
    <div className="scrim" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="entry-modal-title" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd">
          <h2 id="entry-modal-title">{entry?"แก้ไขรายการ":"เพิ่มรายการชาร์จ"}</h2>
          <p>ราคาจะถูก snapshot ไว้อัตโนมัติ ณ วันที่บันทึก</p>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="entry-date">วันที่</label>
            <input id="entry-date" type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
          </div>
          <div className="field">
            <label htmlFor="entry-station">สถานี</label>
            <select id="entry-station" value={form.station} onChange={e=>set("station",e.target.value)}>
              {Object.keys(rates).map(s=><option key={s}>{s}</option>)}
            </select>
          </div>

          {/* Peak selector */}
          {isPeak&&(
            <div className="field full">
              <label>ช่วงเวลา</label>
              <div className="peak-selector" role="group" aria-label="เลือกช่วงเวลาชาร์จ">
                <button type="button" aria-pressed={form.peak_type==="on_peak"} className={"peak-btn "+(form.peak_type==="on_peak"?"on-sel":"")} onClick={()=>selectPeak("on_peak")}>
                  <span className="pb-icon">🌞</span>
                  <span className="pb-label">On Peak</span>
                  <span className="pb-price">฿{NUM(stationRate.on_peak,2)}/kWh</span>
                  <span className="pb-time">{stationRate.on_time||""}</span>
                </button>
                <button type="button" aria-pressed={form.peak_type==="off_peak"} className={"peak-btn "+(form.peak_type==="off_peak"?"off-sel":"")} onClick={()=>selectPeak("off_peak")}>
                  <span className="pb-icon">🌙</span>
                  <span className="pb-label">Off Peak</span>
                  <span className="pb-price">฿{NUM(stationRate.off_peak,2)}/kWh</span>
                  <span className="pb-time">{stationRate.off_time||""}</span>
                </button>
              </div>
              {!form.peak_type&&<span className="hint" style={{color:"#A85B5B"}}>⚠ กรุณาเลือกช่วงเวลา</span>}
            </div>
          )}

          {/* Flat rate display */}
          {!isPeak&&stationRate&&(
            <div className="field full">
              <label>ราคา</label>
              <div className="rate-card">
                <div><div className="rc-label">Flat Rate</div><div className="rc-unit">ราคาเดียวตลอด</div></div>
                <div><div className="rc-price">฿{NUM(stationRate.flat,2)}</div><div className="rc-unit">ต่อ kWh</div></div>
              </div>
            </div>
          )}

          <div className="field full">
            <label htmlFor="entry-trip">ทริป (ไม่บังคับ)</label>
            <input id="entry-trip" value={form.trip} onChange={e=>set("trip",e.target.value)} placeholder="เช่น เชียงใหม่, หัวหิน…"/>
          </div>
          <div className="field">
            <label htmlFor="entry-kwh">พลังงาน (kWh)</label>
            <input id="entry-kwh" type="number" step="0.01" min="0.01" value={form.kwh} onChange={e=>set("kwh",e.target.value)} placeholder="0.00"/>
          </div>
          <div className="field">
            <label htmlFor="entry-discount">ส่วนลด (฿)</label>
            <input id="entry-discount" type="number" step="0.01" min="0" value={form.discount} onChange={e=>set("discount",e.target.value)} placeholder="0.00" aria-invalid={discountErr} style={discountErr?{borderColor:"var(--danger)"}:{}}/>
            {discountErr?<span className="hint" style={{color:"#A85B5B"}}>⚠ ส่วนลดมากกว่าราคาก่อนลด</span>:<span className="hint">โปรโมชั่น / สมาชิก</span>}
          </div>
          <div className="field">
            <label htmlFor="entry-price">ราคาก่อนลด (฿)</label>
            <input id="entry-price" type="number" step="0.01" min="0" value={form.price_before_disc} onChange={e=>set("price_before_disc",e.target.value)} placeholder="คำนวณอัตโนมัติ"/>
            <span className="hint">kWh × ราคา — แก้ได้ถ้าไม่ตรง</span>
          </div>
          <div className="field computed">
            <label htmlFor="entry-final-price">ชำระจริง</label>
            <input id="entry-final-price" value={THB(finalPrice)} readOnly/>
            <span className="hint">{NUM(bahtPerKwh,2)} ฿/kWh</span>
          </div>

          {/* snapshot preview */}
          {stationRate&&(
            <div className="full">
              <div className="snap-info">
                <span className="sdot"/>
                <span>Snapshot: {isPeak?`On ฿${NUM(stationRate.on_peak,2)} / Off ฿${NUM(stationRate.off_peak,2)}`:`฿${NUM(stationRate.flat,2)}/kWh`} — จะบันทึกไว้พร้อมรายการนี้</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-ft">
          <div className="left">{valid?`${NUM(+form.kwh,2)} kWh · ฿${NUM(+form.price_before_disc,2)} − ฿${NUM(+form.discount||0,2)}`:"กรอกข้อมูลเพื่อคำนวณ"}</div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>ยกเลิก</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!valid||saving} style={{opacity:valid&&!saving?1:.5}}>
              {saving?"กำลังบันทึก…":(entry?"บันทึก":"เพิ่ม")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Admin Panel ─────────────────────────────────────────────────
function AdminPanel({rates,setRates,api}){
  const [local,setLocal]=useState(()=>JSON.parse(JSON.stringify(rates)));
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [saveErr,setSaveErr]=useState("");
  const [pendingDelete,setPendingDelete]=useState(null);
  const [draft,setDraft]=useState({station:"",type:"flat",flat:"7.50",on_peak:"8.00",off_peak:"5.50",on_time:"09:00–22:00",off_time:"22:00–09:00",color:"#6CAE76",abbr:""});
  const [editKey,setEditKey]=useState(null);
  const [editDraft,setEditDraft]=useState({name:"",abbr:"",color:""});
  const [removedStations,setRemovedStations]=useState([]);
  const isDirty=JSON.stringify(local)!==JSON.stringify(rates);

  useEffect(()=>{ setLocal(JSON.parse(JSON.stringify(rates))); },[rates]);

  const startEdit=(station)=>{
    const d=local[station];
    setEditKey(station);
    setEditDraft({name:station,abbr:d.abbr||"",color:d.color||"#6CAE76"});
  };
  const applyEdit=()=>{
    const newName=editDraft.name.trim();
    if(!newName) return;
    if(newName!==editKey&&local[newName]){
      setSaveErr("มีสถานีชื่อนี้แล้ว");
      return;
    }
    if(newName!==editKey){
      setRemovedStations(items=>items.includes(editKey)?items:[...items,editKey]);
    }
    setLocal(r=>{
      const next={...r};
      const data={...next[editKey],abbr:editDraft.abbr.toUpperCase().slice(0,3),color:editDraft.color};
      if(newName!==editKey){
        delete next[editKey];
        next[newName]=data;
      }
      else { next[editKey]=data; }
      return next;
    });
    setEditKey(null);
  };

  const setField=(station,field,val)=>{
    setLocal(r=>({...r,[station]:{...r[station],[field]:field==="on_peak"||field==="off_peak"||field==="flat"?+val||0:val}}));
  };

  const addStation=()=>{
    const station=draft.station.trim();
    if(!station){ setSaveErr("กรุณากรอกชื่อสถานี"); return; }
    if(local[station]){ setSaveErr("มีสถานีนี้แล้ว"); return; }
    const next={
      type:draft.type,
      color:draft.color||"#6CAE76",
      abbr:(draft.abbr||makeAbbr(station)).slice(0,3).toUpperCase(),
      ...(draft.type==="peak"
        ? {on_peak:+draft.on_peak||0,off_peak:+draft.off_peak||0,on_time:draft.on_time,off_time:draft.off_time}
        : {flat:+draft.flat||0})
    };
    setLocal(r=>({...r,[station]:next}));
    setDraft(d=>({...d,station:"",abbr:""}));
    setSaveErr("");
  };

  const deleteStation=(station)=>setPendingDelete(station);

  const confirmDelete=async()=>{
    const station=pendingDelete;
    setPendingDelete(null);
    if(!api){ setSaveErr("กรุณาเชื่อมต่อ Supabase ก่อนลบสถานี เพื่อให้ข้อมูลออนไลน์"); return; }
    setSaving(true);
    try{
      await api.deleteRate(station);
      setRemovedStations(items=>items.filter(item=>item!==station));
      setLocal(r=>{ const n={...r}; delete n[station]; return n; });
      setRates(r=>{ const n={...r}; delete n[station]; saveRates(n); return n; });
      setSaved(true); setSaveErr(""); setTimeout(()=>setSaved(false),2000);
    }catch(e){ setSaveErr("ลบไม่ได้: "+e.message); }
    finally{ setSaving(false); }
  };

  const saveAll=async()=>{
    if(!api){
      setSaveErr("กรุณาเชื่อมต่อ Supabase ก่อนบันทึกราคา เพื่อให้ข้อมูลออนไลน์");
      return;
    }
    setSaving(true);
    try{
      for(const [station,data] of Object.entries(local)){
        await api.upsertRate(station,{
          rate_type:data.type,
          on_peak:data.on_peak||null, off_peak:data.off_peak||null,
          on_time:data.on_time||null, off_time:data.off_time||null,
          flat:data.flat||null,
          color:data.color||null,
          abbr:data.abbr||null,
        });
      }
      for(const station of removedStations){
        await api.deleteRate(station);
      }
      saveRates(local); setRates(local);
      setRemovedStations([]);
      setSaved(true); setSaveErr(""); setTimeout(()=>setSaved(false),2000);
    }catch(e){ setSaveErr("บันทึกไม่ได้: "+e.message); }
    finally{ setSaving(false); }
  };

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,gap:12,flexWrap:"wrap"}}>
        <div>
          <h2 style={{margin:"0 0 4px",fontSize:17,fontWeight:600}}>ราคาสถานีชาร์จ</h2>
          <p style={{margin:0,fontSize:13,color:"var(--ink-3)"}}>แก้ไขราคาที่นี่ — ระบบจะ snapshot ราคา ณ เวลาที่บันทึกรายการชาร์จแต่ละครั้ง</p>
        </div>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving}>
          {saving?"กำลังบันทึก…":saved?"✓ บันทึกแล้ว":"บันทึกราคา"}
        </button>
      </div>
      {isDirty&&<div style={{background:"#FFF3CD",border:"1px solid #E8A33A",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:13,color:"#9A6400"}}>⚠ มีการเปลี่ยนแปลงที่ยังไม่บันทึก</div>}
      {saveErr&&<div className="err-bar" style={{marginBottom:14}}><span>⚠️ {saveErr}</span><button onClick={()=>setSaveErr("")}>×</button></div>}
      {pendingDelete&&(
        <div style={{background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:13,color:"#991B1B"}}>ลบสถานี <strong>{pendingDelete}</strong>? รายการชาร์จเก่าจะยังอยู่ แต่สถานีนี้จะหายจากตัวเลือกใหม่</div>
          <div style={{display:"flex",gap:8,flexShrink:0}}>
            <button className="btn btn-ghost" style={{fontSize:12,padding:"4px 12px"}} onClick={()=>setPendingDelete(null)}>ยกเลิก</button>
            <button className="btn btn-danger" style={{fontSize:12,padding:"4px 12px"}} onClick={confirmDelete}>ลบ</button>
          </div>
        </div>
      )}
      <div className="add-station-card">
        <div className="field station-name">
          <label>เพิ่มสถานี</label>
          <input aria-label="ชื่อสถานีใหม่" value={draft.station} onChange={e=>setDraft(d=>({...d,station:e.target.value,abbr:d.abbr||makeAbbr(e.target.value)}))} placeholder="เช่น Altervim, Tesla Supercharger"/>
        </div>
        <div className="field compact">
          <label>ประเภท</label>
          <select aria-label="ประเภทสถานี" value={draft.type} onChange={e=>setDraft(d=>({...d,type:e.target.value}))}>
            <option value="flat">Flat</option>
            <option value="peak">On/Off Peak</option>
          </select>
        </div>
        <div className="field compact">
          <label>ตัวย่อ</label>
          <input aria-label="ตัวย่อสถานี" value={draft.abbr} onChange={e=>setDraft(d=>({...d,abbr:e.target.value.toUpperCase()}))} placeholder="EV" maxLength="3"/>
        </div>
        <div className="field compact">
          <label>สี</label>
          <input aria-label="สีสถานี" type="color" value={draft.color} onChange={e=>setDraft(d=>({...d,color:e.target.value}))}/>
        </div>
        {draft.type==="flat"?(
          <div className="field compact">
            <label>ราคา</label>
            <input aria-label="ราคา flat rate" type="number" step="0.01" min="0" value={draft.flat} onChange={e=>setDraft(d=>({...d,flat:e.target.value}))}/>
          </div>
        ):(
          <>
            <div className="field compact">
              <label>On</label>
              <input aria-label="ราคา on peak" type="number" step="0.01" min="0" value={draft.on_peak} onChange={e=>setDraft(d=>({...d,on_peak:e.target.value}))}/>
            </div>
            <div className="field compact">
              <label>Off</label>
              <input aria-label="ราคา off peak" type="number" step="0.01" min="0" value={draft.off_peak} onChange={e=>setDraft(d=>({...d,off_peak:e.target.value}))}/>
            </div>
          </>
        )}
        <button className="btn btn-soft" onClick={addStation}>{I.plus} เพิ่มสถานี</button>
      </div>
      <div className="admin-grid">
        {Object.entries(local).map(([station,data])=>{
          const s=smeta(station,rates);
          return(
            <div className="rate-row" key={station}>
              <div className="rr-name">
                {editKey===station?(
                  <div className="rr-edit">
                    <input className="rr-edit-input" value={editDraft.name} onChange={e=>setEditDraft(d=>({...d,name:e.target.value}))} placeholder="ชื่อสถานี"/>
                    <input className="rr-edit-input" value={editDraft.abbr} onChange={e=>setEditDraft(d=>({...d,abbr:e.target.value.toUpperCase()}))} placeholder="ตัวย่อ" maxLength="3" style={{width:60}}/>
                    <input type="color" value={editDraft.color} onChange={e=>setEditDraft(d=>({...d,color:e.target.value}))} style={{width:36,height:34,padding:2,borderRadius:8,border:"1px solid var(--line)",cursor:"pointer"}}/>
                    <button className="btn btn-primary" style={{padding:"6px 12px",fontSize:12}} onClick={applyEdit}>บันทึก</button>
                    <button className="btn btn-ghost" style={{padding:"6px 12px",fontSize:12}} onClick={()=>setEditKey(null)}>ยกเลิก</button>
                  </div>
                ):(
                  <div className="rr-sname">
                    <span style={{width:26,height:26,borderRadius:7,background:data.color||s.color,display:"inline-grid",placeItems:"center",fontSize:10,fontWeight:700,color:"#fff",flexShrink:0}}>{data.abbr||s.abbr}</span>
                    {station}
                    <span style={{fontSize:11,background:data.type==="peak"?"#FFF3CD":"var(--mint)",color:data.type==="peak"?"#9A6400":"var(--leaf-deep)",padding:"2px 8px",borderRadius:999,fontWeight:500}}>
                      {data.type==="peak"?"On/Off Peak":"Flat Rate"}
                    </span>
                  </div>
                )}
              </div>
              {data.type==="peak"?(
                <div className="rate-inputs">
                  <div className="rate-input-group">
                    <label>On Peak (฿/kWh)</label>
                    <input type="number" step="0.01" min="0" value={data.on_peak||""} onChange={e=>setField(station,"on_peak",e.target.value)}/>
                  </div>
                  <div className="rate-input-group">
                    <label>On Peak เวลา</label>
                    <input type="text" value={data.on_time||""} onChange={e=>setField(station,"on_time",e.target.value)} placeholder="09:00–22:00" style={{fontFamily:"inherit"}}/>
                  </div>
                  <div className="rate-input-group">
                    <label>Off Peak (฿/kWh)</label>
                    <input type="number" step="0.01" min="0" value={data.off_peak||""} onChange={e=>setField(station,"off_peak",e.target.value)}/>
                  </div>
                  <div className="rate-input-group">
                    <label>Off Peak เวลา</label>
                    <input type="text" value={data.off_time||""} onChange={e=>setField(station,"off_time",e.target.value)} placeholder="22:00–09:00" style={{fontFamily:"inherit"}}/>
                  </div>
                </div>
              ):(
                <div className="rate-inputs">
                  <div className="rate-input-group">
                    <label>ราคา (฿/kWh)</label>
                    <input type="number" step="0.01" min="0" value={data.flat||""} onChange={e=>setField(station,"flat",e.target.value)}/>
                  </div>
                </div>
              )}
              <div style={{display:"flex",gap:4}}>
                <button className="icon-btn" aria-label={`แก้ไขสถานี ${station}`} onClick={()=>startEdit(station)} title="แก้ไขชื่อ/สี">{I.edit}</button>
                <button className="icon-btn danger" aria-label={`ลบสถานี ${station}`} onClick={()=>deleteStation(station)} title="ลบสถานี">{I.trash}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Confirm ─────────────────────────────────────────────────────
function ConfirmDel({entry,rates,onCancel,onConfirm,saving}){
  const s=smeta(entry.station,rates);
  const dialogRef=useDialog(onCancel);
  return(
    <div className="scrim" onClick={onCancel}>
      <div ref={dialogRef} className="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" onClick={e=>e.stopPropagation()}>
        <h3 id="delete-title">ลบรายการนี้?</h3>
        <p>{dLbl(entry.date)} · {s.abbr} {entry.station}{entry.trip?` · ✈ ${entry.trip}`:""}<br/>
          {NUM(entry.kwh,2)} kWh · {THB(entry.final_price)}<br/><br/>การลบไม่สามารถยกเลิกได้
        </p>
        <div className="ca">
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>ยกเลิก</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={saving}>{saving?"กำลังลบ…":"ลบ"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Error Boundary ──────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state={err:null}; }
  static getDerivedStateFromError(err){ return {err}; }
  render(){
    if(this.state.err) return(
      <div style={{padding:60,textAlign:"center",color:"var(--ink-3)"}}>
        <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:8,color:"var(--ink)"}}>เกิดข้อผิดพลาดที่ไม่คาดคิด</div>
        <div style={{fontSize:13,marginBottom:20}}>{this.state.err.message}</div>
        <button className="btn btn-ghost" onClick={()=>this.setState({err:null})}>ลองใหม่</button>
      </div>
    );
    return this.props.children;
  }
}

// ── App ─────────────────────────────────────────────────────────
function App(){
  const [cfg, setCfg]        = useState(loadCfg);
  const supabase = useMemo(()=>createClient(cfg.url,cfg.key),[cfg.url,cfg.key]);
  const [session,setSession] = useState(null);
  const [authReady,setAuthReady] = useState(false);
  const [rates,setRates]     = useState(loadRates);
  const [entries,setEntries] = useState([]);
  const [status,setStatus]   = useState("idle");
  const [errMsg,setErrMsg]   = useState("");
  const [tab,setTab]         = useState("รายการ");
  const [modal,setModal]     = useState(null);
  const [confirmDel,setDel]  = useState(null);
  const [saving,setSaving]   = useState(false);
  const [toast,setToast]     = useState("");
  const [mf,setMf]           = useState(null);
  const _now = new Date();
  const [statYear,setStatYear]   = useState(_now.getFullYear());
  const [statMonth,setStatMonth] = useState(_now.getMonth()+1);

  const api = useMemo(
    ()=>cfg.url&&cfg.key&&session?.access_token
      ?makeApi(cfg.url,cfg.key,session.access_token,session.user.id)
      :null,
    [cfg.url,cfg.key,session]
  );
  const hasCfg = !!(cfg.url&&cfg.key);
  const visibleEntries = entries;

  const yearEntries  = useMemo(()=>statYear===0?entries:entries.filter(e=>+e.date.slice(0,4)===statYear),[entries,statYear]);
  const statsEntries = useMemo(()=>filterEntriesByPeriod(entries,statYear,statMonth),[entries,statYear,statMonth]);
  const statYearOpts = useMemo(()=>{
    const by={};
    entries.forEach(e=>{const y=+e.date.slice(0,4),m=+e.date.slice(5,7);if(!by[y])by[y]=new Set();by[y].add(m);});
    return Object.entries(by).sort(([a],[b])=>+a-+b).map(([y,ms])=>({year:+y,months:[...ms].sort((a,b)=>a-b)}));
  },[entries]);
  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),1800);};

  useEffect(()=>{
    let active=true;
    supabase.auth.getSession().then(({data})=>{
      if(active){
        setSession(data.session);
        setAuthReady(true);
      }
    });
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,nextSession)=>{
      setSession(current=>{
        if(current?.user?.id!==nextSession?.user?.id) setEntries([]);
        return nextSession;
      });
      setAuthReady(true);
    });
    return()=>{active=false;subscription.unsubscribe();};
  },[supabase]);

  const load=useCallback(async()=>{
    if(!api) return;
    setStatus("loading"); setErrMsg("");
    try{
      const [data,rData]=await Promise.all([api.fetchAll(), api.fetchRates()]);
      setEntries(data);
      if(rData){
        const fromDb={};
        rData.forEach(r=>{ fromDb[r.station]=rateFromDb(r); });
        setRates(fromDb); saveRates(fromDb);
      }
      setStatus("ok");
    }catch(e){setErrMsg(e.message);setStatus("err");}
  },[api]);

  useEffect(()=>{if(api) load();},[load]);

  const onSave=async(form)=>{
    if(!api){
      setErrMsg("กรุณาเชื่อมต่อ Supabase ก่อนบันทึก เพื่อให้ข้อมูลออนไลน์และเปิดได้จากทุกที่");
      setTab("ตั้งค่า");
      return;
    }
    setSaving(true);
    try{
      if(modal?.id){
        const u=await api.update(modal.id,form);
        setEntries(es=>es.map(e=>e.id===modal.id?u:e)); showToast("บันทึกการแก้ไขแล้ว");
      } else {
        const c=await api.insert(form);
        setEntries(es=>[c,...es].sort((a,b)=>b.date.localeCompare(a.date))); showToast("เพิ่มรายการแล้ว");
      }
      setModal(null);
    }catch(e){setErrMsg(e.message);}
    finally{setSaving(false);}
  };

  const onDelConfirm=async()=>{
    if(!api){
      setErrMsg("กรุณาเชื่อมต่อ Supabase ก่อนลบข้อมูล เพื่อให้ข้อมูลออนไลน์ตรงกันทุกอุปกรณ์");
      setTab("ตั้งค่า");
      return;
    }
    setSaving(true);
    try{
      await api.remove(confirmDel.id);
      setEntries(es=>es.filter(e=>e.id!==confirmDel.id)); setDel(null); showToast("ลบรายการแล้ว");
    }catch(e){setErrMsg(e.message);}
    finally{setSaving(false);}
  };

  const onSaveCfg=(url,key)=>{
    const c={url,key};
    localStorage.setItem(CFG_KEY,JSON.stringify(c));
    setCfg(c);
    setSession(null);
  };

  const onExport=()=>{
    const rows=[
      ["date","station","peak_type","trip","kwh","price_before_disc","discount","final_price","baht_per_kwh","rate_snapshot"],
      ...entries.map(e=>[e.date,e.station,e.peak_type||"",e.trip||"",e.kwh,e.price_before_disc,e.discount,e.final_price,Number(e.baht_per_kwh).toFixed(4),JSON.stringify(e.rate_snapshot||{})])
    ];
    const escCsv=c=>{ const s=String(c).replace(/"/g,'""'); return /^[=+\-@\t\r]/.test(s)?`"'${s}"`:`"${s}"`; };
    const csv="\uFEFF"+rows.map(r=>r.map(escCsv).join(",")).join("\n");
    const blobUrl=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const a=document.createElement("a");
    a.href=blobUrl; a.download=`ev-log-${getLocalDateInput()}.csv`; a.click();
    setTimeout(()=>URL.revokeObjectURL(blobUrl), 1000);
    showToast("ส่งออก CSV แล้ว");
  };

  if (!authReady) return <div className="auth-scrim"><div className="spinner" aria-label="กำลังตรวจสอบ session"/></div>;
  if (!session) return <LoginScreen supabase={supabase}/>;

  const handleLogout = async () => {
    const {error}=await supabase.auth.signOut();
    if(error) setErrMsg(error.message);
  };

  const PAGE_TITLE = {สถิติ:"ภาพรวม", รายการ:"การชาร์จ", สถานี:"สถานี", ค่าใช้จ่าย:"ค่าใช้จ่าย"};

  return(
    <div className="layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">{I.bolt}</div>
          <div><h1>Charge Note</h1><div className="sub">บันทึกการชาร์จรถไฟฟ้า</div></div>
        </div>

        <nav className="sidebar-nav">
          <button aria-current={tab==="สถิติ"?"page":undefined} className={tab==="สถิติ"?"on":""} onClick={()=>setTab("สถิติ")}>{I.home} ภาพรวม</button>
          <button aria-current={tab==="ค่าใช้จ่าย"?"page":undefined} className={tab==="ค่าใช้จ่าย"?"on":""} onClick={()=>setTab("ค่าใช้จ่าย")}>{I.wallet} ค่าใช้จ่าย</button>
          <button aria-current={tab==="รายการ"?"page":undefined} className={tab==="รายการ"?"on":""} onClick={()=>setTab("รายการ")}>{I.zap} การชาร์จ</button>
          <button aria-current={tab==="สถานี"?"page":undefined} className={tab==="สถานี"?"on":""} onClick={()=>setTab("สถานี")}>{I.pin} สถานี</button>
        </nav>

        <div className="sidebar-car">
          <img src="deepal.png" alt="Deepal S07" className="car-img" onError={e=>{e.target.style.display="none"}}/>
          <div className="car-name">Deepal S07</div>
        </div>

        <div className="sidebar-footer">
          <button onClick={handleLogout}>{I.logout} ออกจากระบบ</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="main">
        <div className="app">
          {/* Page header */}
          <div className="page-hd">
            <div>
              <h2>{PAGE_TITLE[tab]}</h2>
              {hasCfg&&status==="err"&&<span className="status-badge st-err"><span className="dot"/>เชื่อมต่อไม่ได้</span>}
            </div>
            <div className="actions">
              {tab==="รายการ"&&<button className="btn btn-primary" onClick={()=>setModal("new")}>{I.plus} เพิ่มรายการ</button>}
              {tab==="รายการ"&&<button className="btn btn-ghost" onClick={onExport}>{I.dl} ส่งออก</button>}
            </div>
          </div>

          {/* Error bar */}
          {errMsg&&<div className="err-bar" role="alert"><span>⚠️ {errMsg}</span><button aria-label="ปิดข้อความผิดพลาด" onClick={()=>setErrMsg("")}>×</button></div>}

          {/* Setup */}
          {!hasCfg&&<SetupPanel onSave={onSaveCfg} accessToken={session.access_token} userId={session.user.id}/>}

          {/* สถานี */}
          {tab==="สถานี"&&<AdminPanel rates={rates} setRates={setRates} api={api}/>}

          {/* ภาพรวม */}
          {tab==="สถิติ"&&(
            <>
              <div className="stat-filter" style={{flexDirection:"row",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                <select
                  value={statYear===0?"all":statYear}
                  aria-label="กรองตามปี"
                  onChange={e=>{const v=e.target.value;setStatYear(v==="all"?0:+v);setStatMonth(0);}}
                  style={{fontSize:13,padding:"7px 12px",borderRadius:9,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer",outline:"none",boxShadow:"var(--shadow-sm)"}}
                >
                  <option value="all">ทุกปี</option>
                  {statYearOpts.map(({year})=>(
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
                <select
                  value={statMonth===0?"all":statMonth}
                  aria-label="กรองตามเดือน"
                  onChange={e=>{const v=e.target.value;setStatMonth(v==="all"?0:+v);}}
                  style={{fontSize:13,padding:"7px 12px",borderRadius:9,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer",outline:"none",boxShadow:"var(--shadow-sm)"}}
                >
                  <option value="all">ทุกเดือน</option>
                  {(statYear===0
                    ?[...new Set(statYearOpts.flatMap(o=>o.months))].sort((a,b)=>a-b)
                    :(statYearOpts.find(o=>o.year===statYear)?.months||[])
                  ).map(m=>(
                    <option key={m} value={m}>{MONTHS_FULL[m-1]}</option>
                  ))}
                </select>
              </div>
              <StatCards entries={statsEntries} allEntries={yearEntries}/>
              <div className="panels">
                <ChartPanel
                  entries={yearEntries}
                  monthFilter={statYear!==0&&statMonth!==0?`${statYear}-${String(statMonth).padStart(2,"0")}`:null}
                  setMonthFilter={(val)=>{
                    if(!val) return;
                    const [y,m]=val.split("-");
                    setStatYear(+y); setStatMonth(+m);
                  }}/>
                <BreakdownPanel entries={statsEntries} rates={rates}/>
              </div>
              <DashboardBottom entries={statsEntries} rates={rates}/>
            </>
          )}

          {/* ค่าใช้จ่าย */}
          {tab==="ค่าใช้จ่าย"&&<ExpensePage entries={entries} rates={rates} initialBudget={+session?.user?.user_metadata?.ev_budget||0} onBudgetSave={async v=>{await supabase.auth.updateUser({data:{ev_budget:v}});}}/>}

          {/* การชาร์จ */}
          {tab==="รายการ"&&(
            <LogTable entries={visibleEntries} rates={rates} onEdit={e=>setModal(e)} onDelete={e=>setDel(e)} monthFilter={mf} setMonthFilter={setMf} loading={status==="loading"}/>
          )}

          {/* Modals */}
          {modal&&<EntryModal entry={modal==="new"?null:modal} rates={rates} onClose={()=>setModal(null)} onSave={onSave} saving={saving}/>}
          {confirmDel&&<ConfirmDel entry={confirmDel} rates={rates} onCancel={()=>setDel(null)} onConfirm={onDelConfirm} saving={saving}/>}
          {toast&&<div className="toast" role="status">✓ {toast}</div>}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<ErrorBoundary><App/></ErrorBoundary>);
