const { useState, useMemo, useEffect, useCallback, useRef } = React;

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


// ── Supabase API ────────────────────────────────────────────────
function makeApi(url, key) {
  const base = url.replace(/\/$/,'')+"/rest/v1";
  const H = {"Content-Type":"application/json","apikey":key,"Authorization":"Bearer "+key};
  const ok = async r => { if(!r.ok) throw new Error((await r.json()).message||r.statusText); };
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
    let r=await fetch(`${base}/${TABLE}${path}`,{method,headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(withComputed(row))});
    if(!r.ok){
      const msg=await r.text();
      if(/generated column|cannot insert|cannot update|final_price|baht_per_kwh/i.test(msg)){
        r=await fetch(`${base}/${TABLE}${path}`,{method,headers:{...H,"Prefer":"return=representation"},body:JSON.stringify(stripComputed(row))});
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
      const post = body => fetch(`${base}/${RTABLE}?on_conflict=station`,{method:"POST",headers:{...H,"Prefer":"return=representation,resolution=merge-duplicates"},body:JSON.stringify(body)});
      let r=await post({station,...data});
      if(!r.ok && ("color" in data || "abbr" in data)){
        const fallback={station,...data};
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

// ── Backend proxy API ───────────────────────────────────────────
function makeProxyApi(){
  const ok = async r => {
    if(!r.ok){
      const txt = await r.text();
      if(txt.trim().startsWith('<')){
        throw new Error(`เซิร์ฟเวอร์ตอบสนองผิดปกติ (${r.status} ${r.statusText})`);
      }
      let msg;
      try{ const j=JSON.parse(txt); msg=j.error||j.message||r.statusText; }
      catch{ msg=txt||r.statusText; }
      throw new Error(msg);
    }
  };
  return {
    async fetchAll(){ const r = await fetch('/api/charges'); await ok(r); return r.json(); },
    async insert(row){ const r=await fetch('/api/charges',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(row)}); await ok(r); return r.json(); },
    async update(id,row){ const r=await fetch(`/api/charges/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(row)}); await ok(r); return r.json(); },
    async remove(id){ const r=await fetch(`/api/charges/${id}`,{method:'DELETE'}); await ok(r); },
    async ping(){ const r=await fetch('/healthz'); await ok(r); return true; },
    async fetchRates(){ const r=await fetch('/api/rates'); if(!r.ok) return null; return r.json(); },
    async upsertRate(station,data){ const body={station,...data}; const r=await fetch('/api/rates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); await ok(r); },
    async deleteRate(station){ const r=await fetch(`/api/rates/${encodeURIComponent(station)}`,{method:'DELETE'}); await ok(r); },
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
  zap:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>,
  pin:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
  logout:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// ── SQL ─────────────────────────────────────────────────────────
const SQL=`-- 1) ตารางบันทึกการชาร์จ
create table charging_sessions (
  id                bigint generated always as identity primary key,
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
  created_at        timestamptz default now()
);
alter table charging_sessions enable row level security;
-- ⚠️ policy นี้เปิดให้ทุกคนที่รู้ anon key เข้าถึงได้
-- สำหรับใช้ส่วนตัว ควรเพิ่ม Supabase Auth และเปลี่ยนเป็น:
--   using (auth.uid() = user_id) with check (auth.uid() = user_id)
create policy "allow all" on charging_sessions
  for all using (true) with check (true);

-- 2) ตารางราคาสถานี (admin แก้ได้)
create table station_rates (
  station     text primary key,
  rate_type   text not null,       -- 'peak' | 'flat'
  on_peak     numeric(10,2),
  off_peak    numeric(10,2),
  on_time     text,
  off_time    text,
  flat        numeric(10,2),
  color       text,
  abbr        text,
  updated_at  timestamptz default now()
);
alter table station_rates add column if not exists color text;
alter table station_rates add column if not exists abbr text;
alter table station_rates enable row level security;
create policy "allow all" on station_rates
  for all using (true) with check (true);`;

// ── Auth ─────────────────────────────────────────────────────────
const AUTH_KEY    = "ev_auth_hash";
const SESSION_KEY = "ev_authed";

async function hashPin(pin) {
  const data = new TextEncoder().encode("chargenote:" + pin);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

const isSessionActive = () => sessionStorage.getItem(SESSION_KEY) === "1";
const setSession      = () => sessionStorage.setItem(SESSION_KEY, "1");
const clearSession    = () => sessionStorage.removeItem(SESSION_KEY);
const getStoredHash   = () => localStorage.getItem(AUTH_KEY);
const setStoredHash   = h  => localStorage.setItem(AUTH_KEY, h);

function LoginScreen({ onAuth }) {
  const hasPin = !!getStoredHash();
  const [pin, setPin]         = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr]         = useState("");
  const [busy, setBusy]       = useState(false);
  const pinRef = useRef(null);

  useEffect(() => { pinRef.current?.focus(); }, []);

  const submit = async () => {
    if (!pin) { setErr("กรุณากรอก PIN"); return; }
    setBusy(true); setErr("");
    try {
      if (!hasPin) {
        if (pin.length < 4)           { setErr("PIN ต้องมีอย่างน้อย 4 ตัว"); return; }
        if (pin !== confirm)           { setErr("PIN ไม่ตรงกัน กรุณากรอกใหม่"); return; }
        setStoredHash(await hashPin(pin));
        setSession(); onAuth();
      } else {
        const h = await hashPin(pin);
        if (h === getStoredHash()) { setSession(); onAuth(); }
        else { setErr("PIN ไม่ถูกต้อง"); setPin(""); }
      }
    } finally { setBusy(false); }
  };

  const onKey = e => { if (e.key === "Enter") submit(); };

  return (
    <div className="auth-scrim">
      <div className="auth-card">
        <div className="logo auth-logo">{I.bolt}</div>
        <h2>{hasPin ? "เข้าสู่ระบบ" : "ตั้ง PIN ครั้งแรก"}</h2>
        <p>{hasPin ? "กรอก PIN เพื่อเปิดแอป" : "ตั้ง PIN สำหรับป้องกันข้อมูล (ตัวเลขหรือตัวอักษร)"}</p>
        <div className="auth-fields">
          <input
            ref={pinRef}
            type="password"
            className="auth-input"
            placeholder={hasPin ? "PIN" : "PIN ใหม่ (อย่างน้อย 4 ตัว)"}
            value={pin}
            onChange={e => setPin(e.target.value)}
            onKeyDown={onKey}
            autoComplete="current-password"
          />
          {!hasPin && (
            <input
              type="password"
              className="auth-input"
              placeholder="ยืนยัน PIN"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={onKey}
              autoComplete="new-password"
            />
          )}
        </div>
        {err && <div className="auth-err">⚠ {err}</div>}
        <button className="btn btn-primary auth-btn" onClick={submit} disabled={busy}>
          {busy ? "กำลังตรวจสอบ…" : hasPin ? "เข้าสู่ระบบ" : "ตั้ง PIN และเข้าสู่ระบบ"}
        </button>
      </div>
    </div>
  );
}

// ── Setup ───────────────────────────────────────────────────────
function SetupPanel({ onSave }) {
  const [url,setUrl]=useState(""); const [key,setKey]=useState("");
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(""); const [sql,setSql]=useState(false);
  const test=async()=>{
    if(!url||!key){ setErr("กรุณากรอก URL และ Key"); return; }
    setBusy(true);setErr("");
    try{
      await makeApi(url.trim(),key.trim()).ping();
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
          <label>Project URL</label>
          <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://xxxxxxxxxxxx.supabase.co"/>
          <span className="hint">Settings → API → Project URL</span>
        </div>
        <div className="field" style={{gridColumn:"1/-1"}}>
          <label>anon / public Key</label>
          <input value={key} onChange={e=>setKey(e.target.value)} placeholder="eyJhbGci…" type="password"/>
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

// ── Stat Cards ──────────────────────────────────────────────────
function StatCards({entries}){
  const s=useMemo(()=>{
    const sorted=[...entries].sort((a,b)=>b.date.localeCompare(a.date));
    const now=sorted.length?sorted[0].date.slice(0,7):mKey(new Date().toISOString());
    const prev=(()=>{const d=new Date(now+"-01");d.setMonth(d.getMonth()-1);return d.toISOString().slice(0,7)})();
    const tm=entries.filter(e=>e.date.startsWith(now)), pm=entries.filter(e=>e.date.startsWith(prev));
    const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);
    const tmK=sum(tm,"kwh"),pmK=sum(pm,"kwh"),tmC=sum(tm,"final_price"),pmC=sum(pm,"final_price");
    const pct=(a,b)=>b?((a-b)/b)*100:0;
    return{tmKwh:tmK,tmCost:tmC,tmAvg:tmK?tmC/tmK:0,tmDisc:sum(tm,"discount"),sessions:tm.length,kD:pct(tmK,pmK),cD:pct(tmC,pmC)};
  },[entries]);
  const cards=[
    {lbl:"พลังงานเดือนนี้",val:NUM(s.tmKwh,2),suffix:"kWh",delta:s.kD},
    {lbl:"ค่าใช้จ่ายเดือนนี้",val:THB(s.tmCost),delta:s.cD,invert:true},
    {lbl:"ราคาเฉลี่ย",val:NUM(s.tmAvg,2),suffix:"฿/kWh"},
    {lbl:"ส่วนลดรวมเดือนนี้",val:THB(s.tmDisc),isPos:true},
  ];
  return(
    <div className="stats">
      {cards.map((c,i)=>(
        <div className="stat" key={i}>
          <div className="accent"/>
          <div className="lbl">{c.lbl}</div>
          <div className="val">{c.val}{c.suffix&&<small>{" "+c.suffix}</small>}</div>
          {c.delta!==undefined&&Math.abs(c.delta)>0.1&&(
            <div className={"delta "+((c.invert?c.delta<0:c.delta>0)?"":"down")}>
              {c.delta>=0?I.trend:I.trendDn}{(c.delta>=0?"+":"")+c.delta.toFixed(1)}% vs. เดือนก่อน
            </div>
          )}
          {c.isPos&&<div className="delta">{s.sessions} ครั้ง · เดือนนี้</div>}
        </div>
      ))}
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────────────
function ChartPanel({entries,monthFilter,setMonthFilter}){
  const [range,setRange]=useState("6");
  const data=useMemo(()=>{
    const by={};
    entries.forEach(e=>{
      const k=mKey(e.date);
      if(!by[k]) by[k]={cost:0,kwh:0,n:0};
      by[k].cost+=+e.final_price||0; by[k].kwh+=+e.kwh||0; by[k].n++;
    });
    const all=Object.entries(by).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>({key:k,...v}));
    return range==="all"?all:all.slice(-(+range));
  },[entries,range]);
  const max=Math.max(...data.map(d=>d.cost),1);
  const totC=data.reduce((a,d)=>a+d.cost,0), totK=data.reduce((a,d)=>a+d.kwh,0);
  return(
    <div className="panel">
      <div className="panel-hd">
        <div><h3>ค่าใช้จ่ายรายเดือน</h3><div className="panel-sub">{data.length} เดือน · {THB(totC)} · {NUM(totK,1)} kWh</div></div>
        <div className="chip-group small">
          {[["3","3ด."],["6","6ด."],["12","12ด."],["all","ทั้งหมด"]].map(([v,l])=>(
            <button key={v} className={range===v?"on":""} onClick={()=>setRange(v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="chart">
        {data.map(d=>{
          const act=monthFilter===d.key, dim=monthFilter&&monthFilter!==d.key;
          return(
            <div key={d.key} className={"bar-wrap clickable "+(act?"active ":"")+(dim?"dim ":"")} onClick={()=>setMonthFilter(monthFilter===d.key?null:d.key)} title={`${mLbl(d.key)} · ${THB(d.cost)} · ${d.n}ครั้ง`}>
              <div className="bar-amount">{THB(d.cost)}</div>
              <div className="bar-stack" style={{height:(d.cost/max*100)+"%"}}><span className="bar-seg solid"/></div>
              <div className="bar-label">{mLbl(d.key)}</div>
            </div>
          );
        })}
      </div>
      <div className="chart-footer">
        {monthFilter
          ?<button className="link-btn" onClick={()=>setMonthFilter(null)}>กำลังกรองเฉพาะ <b>{mLbl(monthFilter)}</b> · ยกเลิก</button>
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
    return Object.entries(by).map(([k,v])=>({key:k,...v,pct:tot?v.cost/tot*100:0})).sort((a,b)=>b.cost-a.cost).slice(0,6);
  },[entries]);
  return(
    <div className="panel">
      <h3>สัดส่วนตามสถานี</h3>
      <div className="panel-sub" style={{marginBottom:14}}>ยอดรวมตลอดประวัติ</div>
      <div className="breakdown-list">
        {bd.map(b=>{
          const s=smeta(b.key,rates);
          return(
            <div className="bd-row" key={b.key}>
              <div className="dot" style={{background:s.color+"28",color:s.color}}>{s.abbr}</div>
              <div className="info">
                <div className="name">{b.key}</div>
                <div className="meta">{b.n}ครั้ง · {NUM(b.kwh,1)} kWh</div>
                <div className="bd-bar"><i style={{width:b.pct+"%",background:s.color}}/></div>
              </div>
              <div><div className="amt">{THB(b.cost)}</div><div className="pct">{b.pct.toFixed(1)}%</div></div>
            </div>
          );
        })}
      </div>
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
  const Hdr=({label,k,align="left"})=>(
    <th className={(sort.key===k?"sorted ":"")+(align==="right"?"num":"")} onClick={()=>setK(k)}>
      {label}<span className="sort-ind">{sort.key===k?(sort.dir==="asc"?"▲":"▼"):"▲▼"}</span>
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
          <div className="search">{I.search}<input placeholder="ค้นหาสถานี / ทริป…" value={q} onChange={e=>setQ(e.target.value)}/></div>
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
              <Hdr label="ราคา/KWH" k="baht_per_kwh" align="right"/>
              <Hdr label="ส่วนลด" k="discount" align="right"/>
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
                    <td className="num">{NUM(e.baht_per_kwh,2)}</td>
                    <td className="num" style={{color:+e.discount>0?"var(--leaf-2)":"var(--muted)"}}>{+e.discount>0?"−"+THB(e.discount):"—"}</td>
                    <td className="num" style={{fontWeight:600,color:"var(--ink)"}}>{THB(e.final_price)}</td>
                    <td><div className="row-actions">
                      <button className="icon-btn" onClick={()=>onEdit(e)}>{I.edit}</button>
                      <button className="icon-btn danger" onClick={()=>onDelete(e)}>{I.trash}</button>
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
  const today=new Date().toISOString().slice(0,10);
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
  const valid=form.date&&form.station&&+form.price_before_disc>=0&&+form.kwh>=0&&(!isPeak||form.peak_type)&&!discountErr;

  const handleSave=()=>{
    if(!valid)return;
    // build snapshot
    const snap=stationRate?{...stationRate,captured_at:new Date().toISOString()}:null;
    onSave({
      date:form.date, station:form.station, station_id:stationRate?.id||null, trip:form.trip||null,
      peak_type:form.peak_type||null,
      price_before_disc:+form.price_before_disc,
      kwh:+form.kwh, discount:+form.discount||0,
      rate_snapshot:snap,
    });
  };

  return(
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd">
          <h2>{entry?"แก้ไขรายการ":"เพิ่มรายการชาร์จ"}</h2>
          <p>ราคาจะถูก snapshot ไว้อัตโนมัติ ณ วันที่บันทึก</p>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>วันที่</label>
            <input type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
          </div>
          <div className="field">
            <label>สถานี</label>
            <select value={form.station} onChange={e=>set("station",e.target.value)}>
              {Object.keys(rates).map(s=><option key={s}>{s}</option>)}
            </select>
          </div>

          {/* Peak selector */}
          {isPeak&&(
            <div className="field full">
              <label>ช่วงเวลา</label>
              <div className="peak-selector">
                <button type="button" className={"peak-btn "+(form.peak_type==="on_peak"?"on-sel":"")} onClick={()=>selectPeak("on_peak")}>
                  <span className="pb-icon">🌞</span>
                  <span className="pb-label">On Peak</span>
                  <span className="pb-price">฿{NUM(stationRate.on_peak,2)}/kWh</span>
                  <span className="pb-time">{stationRate.on_time||""}</span>
                </button>
                <button type="button" className={"peak-btn "+(form.peak_type==="off_peak"?"off-sel":"")} onClick={()=>selectPeak("off_peak")}>
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
            <label>ทริป (ไม่บังคับ)</label>
            <input value={form.trip} onChange={e=>set("trip",e.target.value)} placeholder="เช่น เชียงใหม่, หัวหิน…"/>
          </div>
          <div className="field">
            <label>พลังงาน (kWh)</label>
            <input type="number" step="0.01" min="0" value={form.kwh} onChange={e=>set("kwh",e.target.value)} placeholder="0.00"/>
          </div>
          <div className="field">
            <label>ส่วนลด (฿)</label>
            <input type="number" step="0.01" min="0" value={form.discount} onChange={e=>set("discount",e.target.value)} placeholder="0.00" style={discountErr?{borderColor:"var(--danger)"}:{}}/>
            {discountErr?<span className="hint" style={{color:"#A85B5B"}}>⚠ ส่วนลดมากกว่าราคาก่อนลด</span>:<span className="hint">โปรโมชั่น / สมาชิก</span>}
          </div>
          <div className="field">
            <label>ราคาก่อนลด (฿)</label>
            <input type="number" step="0.01" min="0" value={form.price_before_disc} onChange={e=>set("price_before_disc",e.target.value)} placeholder="คำนวณอัตโนมัติ"/>
            <span className="hint">kWh × ราคา — แก้ได้ถ้าไม่ตรง</span>
          </div>
          <div className="field computed">
            <label>ชำระจริง</label>
            <input value={THB(finalPrice)} readOnly/>
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
  const [draft,setDraft]=useState({station:"",type:"flat",flat:"7.50",on_peak:"8.00",off_peak:"5.50",on_time:"09:00–22:00",off_time:"22:00–09:00",color:"#6CAE76",abbr:""});
  const [editKey,setEditKey]=useState(null);
  const [editDraft,setEditDraft]=useState({name:"",abbr:"",color:""});
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
    setLocal(r=>{
      const next={...r};
      const data={...next[editKey],abbr:editDraft.abbr.toUpperCase().slice(0,3),color:editDraft.color};
      if(newName!==editKey){ delete next[editKey]; next[newName]=data; }
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

  const deleteStation=async(station)=>{
    if(!confirm(`ลบสถานี ${station}? รายการชาร์จเก่าจะยังอยู่ แต่สถานีนี้จะหายจากตัวเลือกใหม่`)) return;
    if(!api){
      setSaveErr("กรุณาเชื่อมต่อ Supabase ก่อนลบสถานี เพื่อให้ข้อมูลออนไลน์");
      return;
    }
    setSaving(true);
    try{
      await api.deleteRate(station);
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
      saveRates(local); setRates(local);
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
      <div className="add-station-card">
        <div className="field station-name">
          <label>เพิ่มสถานี</label>
          <input value={draft.station} onChange={e=>setDraft(d=>({...d,station:e.target.value,abbr:d.abbr||makeAbbr(e.target.value)}))} placeholder="เช่น Altervim, Tesla Supercharger"/>
        </div>
        <div className="field compact">
          <label>ประเภท</label>
          <select value={draft.type} onChange={e=>setDraft(d=>({...d,type:e.target.value}))}>
            <option value="flat">Flat</option>
            <option value="peak">On/Off Peak</option>
          </select>
        </div>
        <div className="field compact">
          <label>ตัวย่อ</label>
          <input value={draft.abbr} onChange={e=>setDraft(d=>({...d,abbr:e.target.value.toUpperCase()}))} placeholder="EV" maxLength="3"/>
        </div>
        <div className="field compact">
          <label>สี</label>
          <input type="color" value={draft.color} onChange={e=>setDraft(d=>({...d,color:e.target.value}))}/>
        </div>
        {draft.type==="flat"?(
          <div className="field compact">
            <label>ราคา</label>
            <input type="number" step="0.01" min="0" value={draft.flat} onChange={e=>setDraft(d=>({...d,flat:e.target.value}))}/>
          </div>
        ):(
          <>
            <div className="field compact">
              <label>On</label>
              <input type="number" step="0.01" min="0" value={draft.on_peak} onChange={e=>setDraft(d=>({...d,on_peak:e.target.value}))}/>
            </div>
            <div className="field compact">
              <label>Off</label>
              <input type="number" step="0.01" min="0" value={draft.off_peak} onChange={e=>setDraft(d=>({...d,off_peak:e.target.value}))}/>
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
                <button className="icon-btn" onClick={()=>startEdit(station)} title="แก้ไขชื่อ/สี">{I.edit}</button>
                <button className="icon-btn danger" onClick={()=>deleteStation(station)} title="ลบสถานี">{I.trash}</button>
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
  return(
    <div className="scrim" onClick={onCancel}>
      <div className="confirm-box" onClick={e=>e.stopPropagation()}>
        <h3>ลบรายการนี้?</h3>
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
  const [authed,setAuthed]   = useState(isSessionActive);
  const [cfg, setCfg]        = useState(loadCfg);
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

  const api = useMemo(()=>cfg.url&&cfg.key?makeApi(cfg.url,cfg.key):null,[cfg.url,cfg.key]);
  const hasCfg = !!(cfg.url&&cfg.key);
  const visibleEntries = entries;

  const statYears = useMemo(()=>[...new Set(entries.map(e=>+e.date.slice(0,4)))].sort((a,b)=>b-a),[entries]);
  const statMonthsInYear = useMemo(()=>new Set(entries.filter(e=>+e.date.slice(0,4)===statYear).map(e=>+e.date.slice(5,7))),[entries,statYear]);
  const statsEntries = useMemo(()=>statMonth===0?yearEntries:entries.filter(e=>+e.date.slice(0,4)===statYear&&+e.date.slice(5,7)===statMonth),[entries,statYear,statMonth,yearEntries]);
  const yearEntries  = useMemo(()=>entries.filter(e=>+e.date.slice(0,4)===statYear),[entries,statYear]);
  const MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),1800);};

  const load=useCallback(async()=>{
    if(!api) return;
    setStatus("loading"); setErrMsg("");
    try{
      const [data,rData]=await Promise.all([api.fetchAll(), api.fetchRates()]);
      setEntries(data);
      if(rData&&rData.length){
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
    }catch(e){setErrMsg(e.message);setStatus("err");}
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
    a.href=blobUrl; a.download=`ev-log-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(blobUrl);
    showToast("ส่งออก CSV แล้ว");
  };

  if (!authed) return <LoginScreen onAuth={()=>setAuthed(true)}/>;

  const handleLogout = () => { clearSession(); setAuthed(false); };

  const PAGE_TITLE = {สถิติ:"ภาพรวม", รายการ:"การชาร์จ", สถานี:"สถานี"};

  return(
    <div className="layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">{I.bolt}</div>
          <div><h1>Charge Note</h1><div className="sub">บันทึกการชาร์จรถไฟฟ้า</div></div>
        </div>

        <nav className="sidebar-nav">
          <button className={tab==="สถิติ"?"on":""} onClick={()=>setTab("สถิติ")}>{I.home} ภาพรวม</button>
          <button className={tab==="รายการ"?"on":""} onClick={()=>setTab("รายการ")}>{I.zap} การชาร์จ</button>
          <button className={tab==="สถานี"?"on":""} onClick={()=>setTab("สถานี")}>{I.pin} สถานี</button>
        </nav>

        <div className="sidebar-car">
          <img src="car.jpg" alt="Deepal S07" className="car-img" onError={e=>{e.target.style.display="none"}}/>
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
          {errMsg&&<div className="err-bar"><span>⚠️ {errMsg}</span><button onClick={()=>setErrMsg("")}>×</button></div>}

          {/* Setup */}
          {!hasCfg&&<SetupPanel onSave={onSaveCfg}/>}

          {/* สถานี */}
          {tab==="สถานี"&&<AdminPanel rates={rates} setRates={setRates} api={api}/>}

          {/* ภาพรวม */}
          {tab==="สถิติ"&&(
            <>
              <div className="stat-filter">
                <div className="chip-group">
                  {statYears.map(y=>(
                    <button key={y} className={statYear===y?"on":""} onClick={()=>{setStatYear(y);setStatMonth(m=>statMonthsInYear.has(m)?m:1);}}>{y}</button>
                  ))}
                </div>
                <div className="chip-group">
                  <button className={statMonth===0?"on":""} onClick={()=>setStatMonth(0)}>ทั้งหมด</button>
                  {MONTHS.map((lbl,i)=>{
                    const m=i+1;
                    return <button key={m} className={statMonth===m?"on":""} disabled={!statMonthsInYear.has(m)} onClick={()=>setStatMonth(m)}>{lbl}</button>;
                  })}
                </div>
              </div>
              <StatCards entries={statsEntries}/>
              <div className="panels">
                <ChartPanel
                  entries={yearEntries}
                  monthFilter={`${statYear}-${String(statMonth).padStart(2,"0")}`}
                  setMonthFilter={(val)=>{
                    if(!val) return;
                    const [y,m]=val.split("-");
                    setStatYear(+y); setStatMonth(+m);
                  }}/>
                <BreakdownPanel entries={statsEntries} rates={rates}/>
              </div>
            </>
          )}

          {/* การชาร์จ */}
          {tab==="รายการ"&&(
            <LogTable entries={visibleEntries} rates={rates} onEdit={e=>setModal(e)} onDelete={e=>setDel(e)} monthFilter={mf} setMonthFilter={setMf} loading={status==="loading"}/>
          )}

          {/* Modals */}
          {modal&&<EntryModal entry={modal==="new"?null:modal} rates={rates} onClose={()=>setModal(null)} onSave={onSave} saving={saving}/>}
          {confirmDel&&<ConfirmDel entry={confirmDel} rates={rates} onCancel={()=>setDel(null)} onConfirm={onDelConfirm} saving={saving}/>}
          {toast&&<div className="toast">✓ {toast}</div>}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<ErrorBoundary><App/></ErrorBoundary>);
