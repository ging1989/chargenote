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
const sbClient = supabase.createClient(SUPABASE_DEFAULT.url, SUPABASE_DEFAULT.key);

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
  wallet:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>,
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
function LoginScreen() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr]           = useState("");
  const [busy, setBusy]         = useState(false);
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const submit = async () => {
    if (!email || !password) { setErr("กรุณากรอก Email และ Password"); return; }
    setBusy(true); setErr("");
    try {
      const { error } = await sbClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (e) {
      setErr(e.message === "Invalid login credentials" ? "Email หรือ Password ไม่ถูกต้อง" : e.message);
    } finally { setBusy(false); }
  };

  const onKey = e => { if (e.key === "Enter") submit(); };

  return (
    <div className="auth-scrim">
      <div className="auth-card">
        <div className="logo auth-logo">{I.bolt}</div>
        <h2>Charge Note</h2>
        <p>เข้าสู่ระบบเพื่อดูข้อมูลการชาร์จ</p>
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
            style={{letterSpacing:"normal",textAlign:"left"}}
          />
        </div>
        {err && <div className="auth-err">⚠ {err}</div>}
        <button className="btn btn-primary auth-btn" onClick={submit} disabled={busy}>
          {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
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
    const prev=(()=>{const d=new Date(now+"-01");d.setMonth(d.getMonth()-1);return d.toISOString().slice(0,7)})();
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
            <div key={d.key} className={"bar-wrap clickable "+(act?"active ":"")+(dim?"dim ":"")} onClick={()=>setMonthFilter(monthFilter===d.key?null:d.key)} title={`${mLbl(d.key)} · ${fmt(val(d))}`}>
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

// ── Dashboard Stat Cards (5 cols) ───────────────────────────────
function DashStatCards({entries,allEntries,rates}){
  const history=useMemo(()=>{
    const by={};
    (allEntries||entries).forEach(e=>{const k=mKey(e.date);if(!by[k])by[k]={kwh:0,cost:0,n:0};by[k].kwh+=+e.kwh||0;by[k].cost+=+e.final_price||0;by[k].n++;});
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).slice(-6).map(([,v])=>v);
  },[allEntries,entries]);
  const s=useMemo(()=>{
    const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);
    const totK=sum(entries,"kwh"),totC=sum(entries,"final_price");
    const sorted=[...entries].sort((a,b)=>b.date.localeCompare(a.date));
    const now=sorted.length?sorted[0].date.slice(0,7):mKey(new Date().toISOString());
    const prev=(()=>{const d=new Date(now+"-01");d.setMonth(d.getMonth()-1);return d.toISOString().slice(0,7)})();
    const pm=(allEntries||entries).filter(e=>e.date.startsWith(prev));
    const pmK=sum(pm,"kwh"),pmC=sum(pm,"final_price");
    const pct=(a,b)=>b?((a-b)/b)*100:null;
    const savings=entries.reduce((a,e)=>a+(+e.discount||0),0);
    return{totKwh:totK,totCost:totC,avgRate:totK?totC/totK:0,sessions:entries.length,kD:pct(totK,pmK),cD:pct(totC,pmC),savings};
  },[entries,rates]);
  const cards=[
    {lbl:"พลังงานรวม",val:NUM(s.totKwh,1),suffix:"kWh",delta:s.kD,invert:true,spark:history.map(m=>m.kwh),color:"#6CAE76",
     icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>},
    {lbl:"ค่าใช้จ่ายรวม",val:THB(s.totCost),delta:s.cD,invert:true,spark:history.map(m=>m.cost),color:"#E87B6A",
     icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>},
    {lbl:"ราคาเฉลี่ย",val:NUM(s.avgRate,2),suffix:"฿/kWh",delta:s.cD,invert:true,spark:history.map(m=>m.kwh?m.cost/m.kwh:0),color:"#6AAAE8",
     icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>},
    {lbl:"จำนวนครั้ง",val:s.sessions,suffix:"ครั้ง",delta:s.kD,invert:true,spark:history.map(m=>m.n),color:"#B98CE8",
     icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>},
    {lbl:"ส่วนลดรวม",val:THB(s.savings),sub:"โปรโมชั่น / สมาชิก",color:"#4CAF6E",noSpark:true,
     icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>},
  ];
  return(
    <div className="stats-5">
      {cards.map((c,i)=>{
        const up=c.invert?c.delta<0:c.delta>0;
        return(
          <div className="stat" key={i}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div className="lbl">{c.lbl}</div>
              <div style={{width:34,height:34,borderRadius:9,background:c.color+"20",display:"grid",placeItems:"center",color:c.color,flexShrink:0}}>{c.icon}</div>
            </div>
            <div className="val" style={{marginTop:8,fontSize:c.suffix?20:22}}>{c.val}{c.suffix&&<small>{" "+c.suffix}</small>}</div>
            {c.sub&&<div style={{fontSize:11,color:"var(--ink-3)",marginTop:3,lineHeight:1.4}}>{c.sub}</div>}
            {c.delta!=null&&Math.abs(c.delta)>0.05&&(
              <div className={"delta "+(up?"":"down")} style={{marginTop:6}}>
                {up?I.trend:I.trendDn}{(c.delta>=0?"+":"")+c.delta.toFixed(1)}% จากเดือนก่อน
              </div>
            )}
            {!c.noSpark&&<div style={{marginTop:"auto",paddingTop:10}}><Sparkline data={c.spark} color={c.color}/></div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Trend Chart (dual-axis bar+line) ─────────────────────────────
function TrendChart({entries}){
  const [metric,setMetric]=useState("cost");
  const [hov,setHov]=useState(null);
  const data=useMemo(()=>{
    const by={};
    entries.forEach(e=>{const k=mKey(e.date);if(!by[k])by[k]={kwh:0,cost:0,n:0};by[k].kwh+=+e.kwh||0;by[k].cost+=+e.final_price||0;by[k].n++;});
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).slice(-6)
      .map(([k,v])=>({key:k,label:mLbl(k),kwh:v.kwh,cost:v.cost,n:v.n,avg:v.kwh?v.cost/v.kwh:0}));
  },[entries]);
  const METRICS=[{v:"cost",l:"ค่าใช้จ่าย (฿)"},{v:"kwh",l:"พลังงาน (kWh)"},{v:"avg",l:"ราคาเฉลี่ย (฿/kWh)"}];
  const getBar=d=>metric==="avg"?d.avg:d.kwh;
  const showLine=metric==="cost";
  const maxBar=Math.max(...data.map(getBar),1);
  const maxLine=Math.max(...data.map(d=>d.cost),1);
  const W=480,H=200,pL=46,pR=showLine?44:10,pT=22,pB=36;
  const cw=W-pL-pR,ch=H-pT-pB;
  const n=data.length||1;
  const bw=Math.min((cw/n)*0.55,48);
  const bx=i=>pL+(i+0.5)*(cw/n)-bw/2;
  const bh=d=>Math.max(3,getBar(d)/maxBar*ch);
  const by2=d=>pT+ch-bh(d);
  const lx=i=>pL+(i+0.5)*(cw/n);
  const ly=d=>pT+ch-(d.cost/maxLine)*ch;
  const linePath=data.map((d,i)=>`${i===0?"M":"L"}${lx(i).toFixed(1)},${ly(d).toFixed(1)}`).join(" ");
  const fmtY=v=>v>=1000?(v/1000).toFixed(1)+"k":v.toFixed(metric==="avg"?1:0);
  return(
    <div className="panel" style={{minHeight:300}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:14}}>
        <div><h3>แนวโน้มการชาร์จ 6 เดือนล่าสุด</h3><div className="panel-sub">แสดงข้อมูลย้อนหลัง</div></div>
        <div className="chip-group small">
          {METRICS.map(({v,l})=><button key={v} className={metric===v?"on":""} onClick={()=>setMetric(v)}>{l}</button>)}
        </div>
      </div>
      {data.length===0?(
        <div style={{height:160,display:"grid",placeItems:"center",color:"var(--ink-3)",fontSize:13}}>ยังไม่มีข้อมูล</div>
      ):(
        <>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible",display:"block"}}>
            {[0.25,0.5,0.75,1].map(f=>(
              <line key={f} x1={pL} x2={W-pR} y1={pT+ch*(1-f)} y2={pT+ch*(1-f)} stroke="var(--line)" strokeDasharray="4 3" strokeWidth="1"/>
            ))}
            {[0,0.5,1].map(f=>(
              <text key={f} x={pL-6} y={pT+ch*(1-f)+4} textAnchor="end" fontSize="10" fill="var(--ink-3)" fontFamily="inherit">{fmtY(maxBar*f)}</text>
            ))}
            {showLine&&[0,0.5,1].map(f=>(
              <text key={f} x={W-pR+6} y={pT+ch*(1-f)+4} textAnchor="start" fontSize="10" fill="#4F9F52" fontFamily="inherit">
                {(()=>{const v=maxLine*f;return v>=1000?"฿"+(v/1000).toFixed(0)+"k":"฿"+v.toFixed(0);})()}
              </text>
            ))}
            {data.map((d,i)=>(
              <g key={d.key} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)} style={{cursor:"default"}}>
                <rect x={pL+i*(cw/n)} y={pT} width={cw/n} height={ch} fill="transparent"/>
                <rect x={bx(i)} y={by2(d)} width={bw} height={bh(d)} rx="5"
                  fill={hov===i?"#6CAE76":"#A8D5A0"} style={{transition:"fill .1s"}}/>
                <text x={lx(i)} y={H-6} textAnchor="middle" fontSize="10"
                  fill={hov===i?"var(--ink)":"var(--ink-3)"} fontWeight={hov===i?"700":"400"} fontFamily="inherit">{d.label}</text>
              </g>
            ))}
            {showLine&&(
              <>
                <path d={linePath} fill="none" stroke="#4F9F52" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                {data.map((d,i)=>(
                  <circle key={i} cx={lx(i)} cy={ly(d)} r={hov===i?5:3.5} fill={hov===i?"#4F9F52":"#fff"} stroke="#4F9F52" strokeWidth="2"/>
                ))}
              </>
            )}
            {hov!=null&&(()=>{
              const d=data[hov],i=hov;
              const tipH=showLine?62:42,tipW=132;
              const tx=Math.min(Math.max(lx(i)-tipW/2,pL),W-pR-tipW);
              const ty=Math.max(pT-tipH-6,2);
              return(
                <g style={{pointerEvents:"none"}}>
                  <rect x={tx} y={ty} width={tipW} height={tipH} rx="8" fill="#1B3A1F" opacity=".92"/>
                  <text x={tx+10} y={ty+16} fontSize="11" fontWeight="700" fill="#fff" fontFamily="inherit">{d.label}</text>
                  {showLine?(
                    <>
                      <text x={tx+10} y={ty+32} fontSize="10" fill="#A8D5A0" fontFamily="inherit">⚡ {NUM(d.kwh,1)} kWh</text>
                      <text x={tx+10} y={ty+48} fontSize="10" fill="#A8D5A0" fontFamily="inherit">฿ {THB(d.cost)}</text>
                    </>
                  ):(
                    <text x={tx+10} y={ty+30} fontSize="10" fill="#A8D5A0" fontFamily="inherit">
                      {metric==="avg"?NUM(d.avg,2)+" ฿/kWh":NUM(d.kwh,1)+" kWh"}
                    </text>
                  )}
                </g>
              );
            })()}
          </svg>
          {showLine&&(
            <div style={{display:"flex",gap:16,marginTop:6,fontSize:12,color:"var(--ink-3)"}}>
              <span style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:12,height:10,borderRadius:2,background:"#A8D5A0",display:"inline-block"}}/> พลังงาน (kWh)</span>
              <span style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:20,height:2,background:"#4F9F52",display:"inline-block",borderRadius:1}}/> ค่าใช้จ่าย (฿)</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Insights Panel ───────────────────────────────────────────────
function InsightsPanel({entries,allEntries,rates}){
  const list=useMemo(()=>{
    const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);
    const totK=sum(entries,"kwh"),totC=sum(entries,"final_price");
    const sorted=[...entries].sort((a,b)=>b.date.localeCompare(a.date));
    const now=sorted.length?sorted[0].date.slice(0,7):mKey(new Date().toISOString());
    const prev=(()=>{const d=new Date(now+"-01");d.setMonth(d.getMonth()-1);return d.toISOString().slice(0,7)})();
    const MSHORT=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
    const prevName=MSHORT[+prev.split("-")[1]-1];
    const src=allEntries||entries;
    const curE=src.filter(e=>e.date.startsWith(now)),prevE=src.filter(e=>e.date.startsWith(prev));
    const curK=sum(curE,"kwh"),curC=sum(curE,"final_price"),prevK=sum(prevE,"kwh"),prevC=sum(prevE,"final_price");
    const curAvg=curK?curC/curK:0,prevAvg=prevK?prevC/prevK:0;
    const ins=[];
    if(curAvg&&prevAvg){
      const diff=((curAvg-prevAvg)/prevAvg)*100;
      ins.push({icon:diff<0?"📉":"📈",color:diff<0?"#6CAE76":"#E87B6A",
        text:`ค่าไฟเฉลี่ย${diff<0?"ลดลง":"เพิ่มขึ้น"} ${Math.abs(diff).toFixed(0)}%`,
        sub:`เมื่อเทียบกับเดือน${prevName}`});
    }
    if(totK>0){
      const offK=sum(entries.filter(e=>e.peak_type==="off_peak"),"kwh");
      const pct=(offK/totK)*100;
      ins.push({icon:"🌙",color:"#6AAAE8",text:`ชาร์จช่วง Off Peak ${pct.toFixed(0)}%`,
        sub:pct>=50?"ช่วยประหยัดค่าใช้จ่ายได้มากขึ้น":"ลองชาร์จตอนกลางคืนเพื่อประหยัดกว่านี้"});
    }
    const byS={};
    entries.forEach(e=>{if(!byS[e.station])byS[e.station]={kwh:0};byS[e.station].kwh+=+e.kwh||0;});
    const top=Object.entries(byS).sort(([,a],[,b])=>b.kwh-a.kwh)[0];
    if(top&&totK>0) ins.push({icon:"⚡",color:smeta(top[0],rates).color,
      text:`ชาร์จที่ ${top[0]} มากที่สุด`,sub:`คิดเป็น ${(top[1].kwh/totK*100).toFixed(0)}% ของพลังงานทั้งหมด`});
    const rVals=Object.values(rates);
    if(rVals.length&&totK>0){
      const maxRate=rVals.reduce((mx,r)=>Math.max(mx,r.type==="peak"?Math.max(r.on_peak||0,r.off_peak||0):(r.flat||0)),0);
      if(maxRate>0){
        const sav=Math.max(0,entries.reduce((a,e)=>a+maxRate*(+e.kwh||0),0)-totC);
        if(sav>0) ins.push({icon:"💰",color:"#4CAF6E",text:`ประหยัดได้ ${THB(sav)}`,sub:"เมื่อเทียบกับสถานีที่แพงที่สุด"});
      }
    }
    return ins;
  },[entries,rates]);
  return(
    <div className="panel" style={{minHeight:300}}>
      <h3>ภาพรวมเชิงลึก</h3>
      <div className="panel-sub" style={{marginBottom:14}}>Insights</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {list.length===0&&<div style={{color:"var(--ink-3)",fontSize:13,textAlign:"center",padding:"32px 0"}}>เพิ่มข้อมูลเพื่อดู insights</div>}
        {list.map((ins,i)=>(
          <div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",background:"var(--surface-soft)",borderRadius:10,border:"1px solid var(--line)"}}>
            <div style={{width:34,height:34,borderRadius:9,background:ins.color+"20",display:"grid",placeItems:"center",fontSize:16,flexShrink:0}}>{ins.icon}</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"var(--ink)"}}>{ins.text}</div>
              <div style={{fontSize:12,color:"var(--ink-3)",marginTop:2}}>{ins.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Station Distribution Table ───────────────────────────────────
function StationDistTable({entries,rates,onViewAll}){
  const data=useMemo(()=>{
    const by={};
    entries.forEach(e=>{if(!by[e.station])by[e.station]={kwh:0,cost:0,n:0};by[e.station].kwh+=+e.kwh||0;by[e.station].cost+=+e.final_price||0;by[e.station].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return Object.entries(by).map(([k,v])=>({name:k,...v,pct:tot?v.cost/tot*100:0,...smeta(k,rates)}))
      .sort((a,b)=>b.cost-a.cost).slice(0,5);
  },[entries,rates]);
  return(
    <div className="panel">
      <h3>การกระจายตามสถานี</h3>
      <div className="panel-sub" style={{marginBottom:12}}>ตามข้อมูลที่เลือก</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:"unset"}}>
        <thead>
          <tr style={{borderBottom:"2px solid var(--line)"}}>
            {["สถานีชาร์จ","ครั้ง","kWh","ค่าใช้จ่าย","สัดส่วน"].map(h=>(
              <th key={h} style={{textAlign:h==="สถานีชาร์จ"?"left":"right",padding:"6px 6px 10px",color:"var(--ink-3)",fontWeight:600,fontSize:12}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length===0&&<tr><td colSpan="5" style={{textAlign:"center",padding:"20px 0",color:"var(--ink-3)"}}>ยังไม่มีข้อมูล</td></tr>}
          {data.map(d=>(
            <tr key={d.name} style={{borderBottom:"1px solid var(--line)"}}>
              <td style={{padding:"9px 6px"}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <div style={{width:26,height:26,borderRadius:6,background:d.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{d.abbr}</div>
                  <span style={{fontSize:12,fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:80}}>{d.name}</span>
                </div>
              </td>
              <td style={{textAlign:"right",padding:"9px 6px",color:"var(--ink-3)",fontSize:12}}>{d.n}</td>
              <td style={{textAlign:"right",padding:"9px 6px",color:"var(--ink-2)",fontWeight:500,fontSize:12}}>{NUM(d.kwh,1)}</td>
              <td style={{textAlign:"right",padding:"9px 6px",fontWeight:700,color:"var(--ink)",fontSize:12}}>{THB(d.cost)}</td>
              <td style={{padding:"9px 0 9px 6px"}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
                  <span style={{fontSize:11,fontWeight:700,color:d.color}}>{d.pct.toFixed(0)}%</span>
                  <div style={{width:44,height:4,background:"var(--line)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{width:d.pct+"%",height:"100%",background:d.color,borderRadius:2}}/>
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.length>0&&<button className="link-btn" style={{marginTop:10,fontSize:12}} onClick={onViewAll}>ดูรายละเอียดทั้งหมด →</button>}
    </div>
  );
}

// ── Peak Time Panel ──────────────────────────────────────────────
function PeakTimePanel({entries}){
  const data=useMemo(()=>{
    const MAP={on_peak:{lbl:"On Peak (09:00–22:00)",color:"#E87B6A"},off_peak:{lbl:"Off Peak (22:00–09:00)",color:"#6AAAE8"},null:{lbl:"Flat Rate",color:"#6CAE76"}};
    const by={};
    entries.forEach(e=>{const k=String(e.peak_type||"null");if(!by[k])by[k]={...(MAP[k]||{lbl:k,color:"#999"}),kwh:0,n:0};by[k].kwh+=+e.kwh||0;by[k].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.kwh,0);
    return{items:Object.values(by).filter(v=>v.n>0).map(v=>({...v,pct:tot?v.kwh/tot*100:0})),tot};
  },[entries]);
  return(
    <div className="panel">
      <h3>ช่วงเวลาการชาร์จ</h3>
      <div className="panel-sub" style={{marginBottom:12}}>แบ่งตาม Peak / Off Peak</div>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
        <DonutChart segments={data.items.map(d=>({value:d.kwh,color:d.color}))} total={data.tot} centerText={data.items.length?"100%":"-"} size={120}/>
        <div style={{width:"100%",display:"flex",flexDirection:"column",gap:8}}>
          {data.items.length===0&&<div style={{color:"var(--ink-3)",fontSize:13,textAlign:"center"}}>ยังไม่มีข้อมูล</div>}
          {data.items.map((d,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:12}}>
              <div style={{width:10,height:10,borderRadius:2,background:d.color,flexShrink:0}}/>
              <div style={{flex:1,color:"var(--ink-2)",fontWeight:500}}>{d.lbl}</div>
              <span style={{fontWeight:700,color:"var(--ink)"}}>{d.pct.toFixed(0)}%</span>
              <span style={{color:"var(--ink-3)",minWidth:54,textAlign:"right"}}>{NUM(d.kwh,1)} kWh</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Cost Compare Panel ───────────────────────────────────────────
function CostComparePanel({entries,rates}){
  const totKwh=useMemo(()=>entries.reduce((a,e)=>a+(+e.kwh||0),0),[entries]);
  const cmp=useMemo(()=>{
    const rows=[];
    Object.entries(rates).forEach(([name,r])=>{
      const color=r.color||"#8AA08C",abbr=r.abbr||makeAbbr(name);
      if(r.type==="peak"){
        if(r.on_peak) rows.push({name,label:"On Peak",cost:(r.on_peak||0)*totKwh,color,abbr,peakTag:"on"});
        if(r.off_peak) rows.push({name,label:"Off Peak",cost:(r.off_peak||0)*totKwh,color,abbr,peakTag:"off"});
      } else {
        rows.push({name,label:null,cost:(r.flat||0)*totKwh,color,abbr});
      }
    });
    return rows.filter(d=>d.cost>0).sort((a,b)=>a.cost-b.cost);
  },[rates,totKwh]);
  const maxCost=cmp.length?cmp[cmp.length-1].cost:1;
  const cheap=cmp[0],exp=cmp[cmp.length-1];
  const savings=cheap&&exp&&cheap!==exp?exp.cost-cheap.cost:0;
  return(
    <div className="panel">
      <h3>เปรียบเทียบค่าใช้จ่าย</h3>
      <div className="panel-sub" style={{marginBottom:12}}>คำนวณจากพลังงาน {NUM(totKwh,1)} kWh ที่แต่ละสถานี</div>
      {cmp.length===0?(
        <div style={{color:"var(--ink-3)",fontSize:13,textAlign:"center",padding:"20px 0"}}>ต้องการข้อมูลราคาสถานี</div>
      ):(
        <>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {cmp.map((d,i)=>(
              <div key={i}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <div style={{width:24,height:24,borderRadius:6,background:d.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{d.abbr}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <span style={{fontSize:13,fontWeight:600,color:"var(--ink)"}}>{d.name}</span>
                    {d.label&&<span style={{marginLeft:6,fontSize:11,padding:"1px 6px",borderRadius:999,fontWeight:600,
                      background:d.peakTag==="on"?"#FFF3CD":d.peakTag==="off"?"#E8F5E9":"var(--mint)",
                      color:d.peakTag==="on"?"#9A6400":d.peakTag==="off"?"#2E7D32":"var(--ink-2)"}}>{d.label}</span>}
                  </div>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--ink)",flexShrink:0}}>{THB(d.cost)}</div>
                </div>
                <div style={{width:"100%",height:5,background:"var(--line)",borderRadius:3,overflow:"hidden"}}>
                  <div style={{width:(d.cost/maxCost*100)+"%",height:"100%",background:d.peakTag==="off"?d.color+"99":d.color,borderRadius:3,transition:"width .3s"}}/>
                </div>
              </div>
            ))}
          </div>
          {savings>0&&cheap&&(
            <div style={{marginTop:14,padding:"12px 14px",background:"var(--mint)",borderRadius:10,border:"1px solid var(--mint-2)"}}>
              <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:1}}>คุณประหยัดได้</div>
              <div style={{fontSize:22,fontWeight:700,color:"var(--leaf-deep)"}}>{THB(savings)}</div>
              <div style={{fontSize:12,color:"var(--ink-3)",marginTop:1}}>จากการเลือกสถานี {cheap.name}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Recent Charges Panel ─────────────────────────────────────────
function RecentChargesPanel({entries,rates,onViewAll}){
  const recent=useMemo(()=>[...entries].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5),[entries]);
  return(
    <div className="panel">
      <h3>ประวัติการชาร์จล่าสุด</h3>
      <div className="panel-sub" style={{marginBottom:12}}>5 รายการล่าสุด</div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:"unset"}}>
          <thead>
            <tr style={{borderBottom:"2px solid var(--line)"}}>
              {["วันที่","สถานี","เวลา","พลังงาน","ค่าใช้จ่าย","ประเภท"].map(h=>(
                <th key={h} style={{textAlign:"left",padding:"6px 8px 10px",color:"var(--ink-3)",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recent.length===0&&<tr><td colSpan="6" style={{textAlign:"center",padding:"24px 0",color:"var(--ink-3)"}}>ยังไม่มีรายการ</td></tr>}
            {recent.map(e=>{
              const s=smeta(e.station,rates);
              const snap=e.rate_snapshot||{};
              const isPeak=e.peak_type==="on_peak",isOff=e.peak_type==="off_peak";
              const timeStr=isPeak?(snap.on_time||"--"):(isOff?(snap.off_time||"--"):"--");
              return(
                <tr key={e.id} style={{borderBottom:"1px solid var(--line)"}}>
                  <td style={{padding:"9px 8px",color:"var(--ink)",fontWeight:500,whiteSpace:"nowrap"}}>{dLbl(e.date)}</td>
                  <td style={{padding:"9px 8px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:7}}>
                      <div style={{width:26,height:26,borderRadius:6,background:s.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{s.abbr}</div>
                      <span style={{fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap"}}>{e.station}</span>
                    </div>
                  </td>
                  <td style={{padding:"9px 8px",color:"var(--ink-3)",whiteSpace:"nowrap",fontSize:12}}>{timeStr}</td>
                  <td style={{padding:"9px 8px",color:"var(--ink-2)",fontWeight:500}}>{NUM(e.kwh,1)} kWh</td>
                  <td style={{padding:"9px 8px",fontWeight:700,color:"var(--ink)"}}>{THB(e.final_price)}</td>
                  <td style={{padding:"9px 8px"}}>
                    {isPeak&&<span className="peak-pill peak-on">On Peak</span>}
                    {isOff&&<span className="peak-pill peak-off">Off Peak</span>}
                    {!isPeak&&!isOff&&<span style={{fontSize:12,color:"var(--ink-3)"}}>Flat</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {recent.length>0&&<button className="link-btn" style={{marginTop:10,fontSize:12}} onClick={onViewAll}>ดูประวัติทั้งหมด →</button>}
    </div>
  );
}

// ── Vehicle Efficiency Panel ─────────────────────────────────────
const EV_EFF_DEFAULT=5.2;
function VehicleEffPanel({entries,allEntries}){
  const data=useMemo(()=>{
    // คำนวณประสิทธิภาพจาก odometer จริง
    const src=[...(allEntries||entries)].filter(e=>e.odometer!=null).sort((a,b)=>a.date.localeCompare(b.date)||(a.id-b.id));
    let totalKm=0,totalKwhOdo=0;
    for(let i=1;i<src.length;i++){
      const km=+src[i].odometer-(+src[i-1].odometer);
      const kwh=+src[i].kwh||0;
      if(km>0&&km<3000&&kwh>0){totalKm+=km;totalKwhOdo+=kwh;}
    }
    const hasReal=totalKm>0&&totalKwhOdo>0;
    const eff=hasReal?totalKm/totalKwhOdo:EV_EFF_DEFAULT;
    const totK=entries.reduce((a,e)=>a+(+e.kwh||0),0);
    const totC=entries.reduce((a,e)=>a+(+e.final_price||0),0);
    const avgRate=totK?totC/totK:0;
    return{eff,hasReal,totalKm,perKm:avgRate?avgRate/eff:0,per100km:avgRate?avgRate/eff*100:0,avgRate};
  },[entries,allEntries]);
  const stats=[
    {lbl:"ประสิทธิภาพเฉลี่ย",val:NUM(data.eff,1),suf:"km/kWh",icon:"🏎️"},
    {lbl:"ต่อกิโลเมตร",val:data.avgRate?THB(data.perKm):"--",icon:"📍"},
    {lbl:"ต่อ 100 กิโลเมตร",val:data.avgRate?THB(data.per100km):"--",icon:"🛣️"},
  ];
  return(
    <div className="panel">
      <h3>ประสิทธิภาพการใช้รถ</h3>
      <div className="panel-sub" style={{marginBottom:14}}>
        {data.hasReal?`จากเลขไมล์จริง · ขับแล้ว ${NUM(data.totalKm,0)} km`:`โดยประมาณ (Deepal S07 ${EV_EFF_DEFAULT} km/kWh)`}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {stats.map((s,i)=>(
          <div key={i} style={{background:"var(--surface-soft)",borderRadius:10,padding:"13px 10px",textAlign:"center",border:"1px solid var(--line)"}}>
            <div style={{fontSize:20,marginBottom:5}}>{s.icon}</div>
            <div style={{fontSize:17,fontWeight:700,color:"var(--ink)",lineHeight:1.2}}>{s.val}</div>
            {s.suf&&<div style={{fontSize:11,color:"var(--ink-3)",marginTop:2}}>{s.suf}</div>}
            <div style={{fontSize:11,color:"var(--ink-3)",marginTop:4}}>{s.lbl}</div>
          </div>
        ))}
      </div>
      <div style={{marginTop:10,fontSize:11,color:"var(--muted)",textAlign:"center"}}>
        {data.hasReal
          ?`ประสิทธิภาพ ${NUM(data.eff,2)} km/kWh · ราคาเฉลี่ย ${NUM(data.avgRate,2)} ฿/kWh`
          :`ยังไม่มีข้อมูลเลขไมล์ — บันทึก odometer เพื่อดูค่าจริง`}
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

// ── Expense Trend Bar Chart ──────────────────────────────────────
function ExpBarChart({data,selectedKey}){
  const [hov,setHov]=useState(null);
  const W=460,H=200,pL=46,pR=10,pT=20,pB=30;
  const ch=H-pT-pB,cw=W-pL-pR;
  const maxC=Math.max(...data.map(d=>d.cost),1);
  const n=data.length;
  const bw=Math.min(30,(cw/n)*0.6);
  const bx=i=>pL+i*(cw/n)+(cw/n-bw)/2;
  const bh=d=>Math.max(3,d.cost/maxC*ch);
  const by2=d=>pT+ch-bh(d);
  const cx=i=>bx(i)+bw/2;
  const fmtC=v=>v>=1000?"฿"+(v/1000).toFixed(1)+"k":"฿"+v.toFixed(0);
  return(
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible",display:"block"}}>
      {[0.5,1].map(f=>(
        <line key={f} x1={pL} x2={W-pR} y1={pT+ch*(1-f)} y2={pT+ch*(1-f)} stroke="var(--line)" strokeDasharray="4 3" strokeWidth="1"/>
      ))}
      {[0,0.5,1].map(f=>(
        <text key={f} x={pL-4} y={pT+ch*(1-f)+4} textAnchor="end" fontSize="10" fill="var(--ink-3)" fontFamily="inherit">{fmtC(maxC*f)}</text>
      ))}
      {data.map((d,i)=>{
        const isSel=d.key===selectedKey;
        const isHov=hov===i;
        const fill=isSel?"#1B6B3A":(isHov?"#6CAE76":"#A8D5A0");
        return(
          <g key={d.key} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)} style={{cursor:"default"}}>
            <rect x={bx(i)} y={pT} width={cw/n} height={ch} fill="transparent"/>
            <rect x={bx(i)} y={by2(d)} width={bw} height={bh(d)} rx="4" fill={fill} style={{transition:"fill .1s"}}/>
            <text x={cx(i)} y={H-6} textAnchor="middle" fontSize="10"
              fill={isSel?"var(--ink)":(isHov?"var(--ink)":"var(--ink-3)")} fontWeight={isSel?"700":"400"} fontFamily="inherit">{d.label}</text>
            {(isHov||isSel)&&(
              <text x={cx(i)} y={by2(d)-5} textAnchor="middle" fontSize="10" fill="var(--ink)" fontWeight="600" fontFamily="inherit">{fmtC(d.cost)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Expense Page ─────────────────────────────────────────────────
function ExpensePage({entries,rates}){
  const now=new Date();
  const [subTab,setSubTab]=useState("ภาพรวม");
  const [expYear,setExpYear]=useState(()=>now.getFullYear());
  const [expMonth,setExpMonth]=useState(()=>now.getMonth()+1);

  const MONTHS_TH=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const expYearOpts=useMemo(()=>{
    const by={};
    entries.forEach(e=>{const y=+e.date.slice(0,4),m=+e.date.slice(5,7);if(!by[y])by[y]=new Set();by[y].add(m);});
    return Object.entries(by).sort(([a],[b])=>+a-+b).map(([y,ms])=>({year:+y,months:[...ms].sort((a,b)=>a-b)}));
  },[entries]);

  const mE=useMemo(()=>{
    let r=entries;
    if(expYear!==0) r=r.filter(e=>+e.date.slice(0,4)===expYear);
    if(expYear!==0&&expMonth!==0) r=r.filter(e=>+e.date.slice(5,7)===expMonth);
    return r;
  },[entries,expYear,expMonth]);

  const pE=useMemo(()=>{
    if(expYear===0) return [];
    if(expMonth===0) return entries.filter(e=>+e.date.slice(0,4)===expYear-1);
    const d=new Date(`${expYear}-${String(expMonth).padStart(2,"0")}-01`);
    d.setMonth(d.getMonth()-1);
    return entries.filter(e=>+e.date.slice(0,4)===d.getFullYear()&&+e.date.slice(5,7)===d.getMonth()+1);
  },[entries,expYear,expMonth]);

  const sum=(arr,f)=>arr.reduce((a,e)=>a+(+e[f]||0),0);

  const totC=sum(mE,"final_price");
  const avgSess=mE.length?totC/mE.length:0;
  const pC=sum(pE,"final_price");
  const pct=(a,b)=>b?((a-b)/b)*100:null;

  const prevPeriodName=useMemo(()=>{
    if(expYear===0||pE.length===0) return "";
    if(expMonth===0) return `ปี ${(expYear-1)+543}`;
    const d=new Date(`${expYear}-${String(expMonth).padStart(2,"0")}-01`);
    d.setMonth(d.getMonth()-1);
    return `${MONTHS_TH[d.getMonth()]} ${d.getFullYear()+543}`;
  },[expYear,expMonth,pE]);

  const monthKey=expYear===0?null:expMonth===0?null:`${expYear}-${String(expMonth).padStart(2,"0")}`;
  const mo=expMonth; // alias for tab labels

  // On/Off Peak costs
  const pkCosts=useMemo(()=>{
    const on=sum(mE.filter(e=>e.peak_type==="on_peak"),"final_price");
    const off=sum(mE.filter(e=>e.peak_type!=="on_peak"),"final_price");
    return{on,off};
  },[mE]);
  const onPct=totC?pkCosts.on/totC*100:0;
  const offPct=totC?pkCosts.off/totC*100:0;

  // Trend data (last 8 months)
  const trendData=useMemo(()=>{
    const by={};
    entries.forEach(e=>{const k=mKey(e.date);if(!by[k])by[k]={cost:0,kwh:0,n:0};by[k].cost+=+e.final_price||0;by[k].kwh+=+e.kwh||0;by[k].n++;});
    return Object.entries(by).sort(([a],[b])=>a<b?-1:1).slice(-8).map(([k,v])=>({key:k,label:mLbl(k),...v}));
  },[entries]);

  // Station breakdown
  const stBd=useMemo(()=>{
    const by={};
    mE.forEach(e=>{if(!by[e.station])by[e.station]={kwh:0,cost:0,n:0};by[e.station].kwh+=+e.kwh||0;by[e.station].cost+=+e.final_price||0;by[e.station].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return Object.entries(by).map(([k,v])=>({name:k,...v,pct:tot?v.cost/tot*100:0,...smeta(k,rates)})).sort((a,b)=>b.cost-a.cost);
  },[mE,rates]);

  // Peak breakdown for ช่วงเวลา tab
  const pkBd=useMemo(()=>{
    const MAP={on_peak:{lbl:"On Peak",color:"#E87B6A"},off_peak:{lbl:"Off Peak",color:"#6AAAE8"},null:{lbl:"Flat Rate",color:"#6CAE76"}};
    const by={};
    mE.forEach(e=>{const k=String(e.peak_type||"null");if(!by[k])by[k]={...MAP[k]||{lbl:k,color:"#999"},cost:0,kwh:0,n:0};by[k].cost+=+e.final_price||0;by[k].kwh+=+e.kwh||0;by[k].n++;});
    const tot=Object.values(by).reduce((a,v)=>a+v.cost,0);
    return{items:Object.values(by).filter(v=>v.n>0).map(v=>({...v,pct:tot?v.cost/tot*100:0,value:v.cost})),tot};
  },[mE]);

  // Insight cards data
  const insightData=useMemo(()=>{
    const onC=pkCosts.on,offC=pkCosts.off;
    const peakTimeLbl=onC>=offC?"09:00 – 22:00":"22:00 – 09:00";
    const peakTimeAmt=Math.max(onC,offC);
    const peakTimePct=totC?peakTimeAmt/totC*100:0;
    const byDay={};
    mE.forEach(e=>{if(!byDay[e.date])byDay[e.date]=0;byDay[e.date]+=+e.final_price||0;});
    const expDay=Object.entries(byDay).sort(([,a],[,b])=>b-a)[0]||null;
    const expSess=mE.length?[...mE].sort((a,b)=>(+b.final_price||0)-(+a.final_price||0))[0]:null;
    const byS={};
    mE.forEach(e=>{if(!byS[e.station])byS[e.station]={kwh:0,cost:0};byS[e.station].kwh+=+e.kwh||0;byS[e.station].cost+=+e.final_price||0;});
    const bestSt=Object.entries(byS).filter(([,v])=>v.kwh>=1).map(([k,v])=>({name:k,avg:v.kwh?v.cost/v.kwh:0,...smeta(k,rates)})).sort((a,b)=>a.avg-b.avg)[0]||null;
    return{peakTimeLbl,peakTimeAmt,peakTimePct,expDay,expSess,bestSt};
  },[mE,pkCosts,totC,rates]);

  const DeltaBadge=({d,invert=false})=>{
    if(d==null||Math.abs(d)<0.05) return null;
    const up=invert?d<0:d>0;
    return <span className={"delta "+(up?"":"down")} style={{fontSize:11}}>{d>=0?"+":""}{d.toFixed(1)}%</span>;
  };

  const handleDownload=()=>{
    const dlKey=expYear===0?"all":expMonth===0?String(expYear):monthKey;
    const rows=[["วันที่","สถานี","kWh","฿/kWh","ส่วนลด","ยอดรวม","ประเภท"],...[...mE].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>[e.date,e.station,e.kwh,e.baht_per_kwh,e.discount,e.final_price,e.peak_type||"flat"])];
    const csv=rows.map(r=>r.join(",")).join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download=`charges_${dlKey}.csv`;a.click();
  };

  const EntryRow=({e})=>{
    const s=smeta(e.station,rates);
    const snap=e.rate_snapshot||{};
    const isPeak=e.peak_type==="on_peak",isOff=e.peak_type==="off_peak";
    const timeStr=isPeak?(snap.on_time||"--"):(isOff?(snap.off_time||"--"):"--");
    return(
      <tr style={{borderBottom:"1px solid var(--line)"}}>
        <td style={{padding:"9px 8px",color:"var(--ink)",fontWeight:500,whiteSpace:"nowrap"}}>{dLbl(e.date)}</td>
        <td style={{padding:"9px 8px"}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <div style={{width:24,height:24,borderRadius:6,background:s.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{s.abbr}</div>
            <span style={{fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap"}}>{e.station}</span>
          </div>
        </td>
        <td style={{padding:"9px 8px",color:"var(--ink-3)",whiteSpace:"nowrap",fontSize:12}}>{timeStr}</td>
        <td style={{padding:"9px 8px",color:"var(--ink-2)",fontWeight:500,whiteSpace:"nowrap"}}>{NUM(e.kwh,1)} kWh</td>
        <td style={{padding:"9px 8px",fontWeight:700,color:"var(--ink)",whiteSpace:"nowrap"}}>{THB(e.final_price)}</td>
        <td style={{padding:"9px 8px",color:"var(--ink-2)",whiteSpace:"nowrap"}}>{NUM((+e.final_price)/(+e.kwh||1),2)} ฿/kWh</td>
        <td style={{padding:"9px 8px"}}>
          {isPeak&&<span className="peak-pill peak-on">On Peak</span>}
          {isOff&&<span className="peak-pill peak-off">Off Peak</span>}
          {!isPeak&&!isOff&&<span style={{fontSize:12,color:"var(--ink-3)"}}>Flat</span>}
        </td>
      </tr>
    );
  };

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:13,color:"var(--ink-3)"}}>วิเคราะห์ค่าใช้จ่ายค่าชาร์จทั้งหมดของคุณ</div>
          {prevPeriodName&&<div style={{fontSize:12,color:"var(--ink-3)",marginTop:3}}>เทียบกับ {prevPeriodName} ⓘ</div>}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <select value={expYear===0?"all":expYear}
            onChange={e=>{const v=e.target.value;setExpYear(v==="all"?0:+v);setExpMonth(0);}}
            style={{fontSize:13,padding:"7px 12px",borderRadius:9,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer",outline:"none",boxShadow:"var(--shadow-sm)"}}>
            <option value="all">ทุกปี</option>
            {expYearOpts.map(o=><option key={o.year} value={o.year}>{o.year}</option>)}
          </select>
          <select value={expMonth===0?"all":expMonth}
            onChange={e=>{const v=e.target.value;setExpMonth(v==="all"?0:+v);}}
            style={{fontSize:13,padding:"7px 12px",borderRadius:9,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer",outline:"none",boxShadow:"var(--shadow-sm)"}}>
            <option value="all">ทุกเดือน</option>
            {(expYear===0
              ?expYearOpts.flatMap(o=>o.months.map(m=>({year:o.year,m})))
              :(expYearOpts.find(o=>o.year===expYear)?.months||[]).map(m=>({year:expYear,m}))
            ).map(({year,m})=><option key={`${year}-${m}`} value={m}>{MONTHS_FULL[m-1]}</option>)}
          </select>
          <button className="btn btn-ghost" style={{fontSize:12,padding:"6px 12px",display:"flex",alignItems:"center",gap:5}} onClick={handleDownload}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ดาวน์โหลด
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="chip-group" style={{marginBottom:20,width:"fit-content"}}>
        {["ภาพรวม","แนวโน้ม","แยกตามสถานี","ช่วงเวลา","รายการชาร์จ"].map(t=>(
          <button key={t} className={subTab===t?"on":""} onClick={()=>setSubTab(t)}>{t}</button>
        ))}
      </div>

      {/* ── ภาพรวม ── */}
      {subTab==="ภาพรวม"&&(<>

        {/* 4 Stat cards */}
        <div className="exp-4cards" style={{marginBottom:14}}>
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:6}}>ค่าใช้จ่ายรวม</div>
            <div style={{fontSize:26,fontWeight:700,color:"var(--ink)",lineHeight:1.2}}>{THB(totC)}</div>
            <div style={{marginTop:8,display:"flex",alignItems:"center",gap:6}}>
              <DeltaBadge d={pct(totC,pC)} invert={true}/>
              {pC>0&&prevPeriodName&&<span style={{fontSize:11,color:"var(--ink-3)"}}>จาก{prevPeriodName}</span>}
            </div>
          </div>
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:6}}>เฉลี่ยต่อครั้ง</div>
            <div style={{fontSize:26,fontWeight:700,color:"var(--ink)",lineHeight:1.2}}>{THB(avgSess)}</div>
            <div style={{marginTop:8,display:"flex",alignItems:"center",gap:6}}>
              <DeltaBadge d={pct(avgSess,pE.length?sum(pE,"final_price")/pE.length:0)} invert={true}/>
              {pE.length>0&&prevPeriodName&&<span style={{fontSize:11,color:"var(--ink-3)"}}>จาก{prevPeriodName}</span>}
            </div>
          </div>
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:6}}>ค่าใช้จ่าย On Peak</div>
            <div style={{fontSize:26,fontWeight:700,color:"var(--ink)",lineHeight:1.2}}>{THB(pkCosts.on)}</div>
            <div style={{marginTop:8}}>
              <div style={{fontSize:11,color:"#E87B6A",fontWeight:600,marginBottom:4}}>{onPct.toFixed(0)}% ของค่าใช้จ่ายทั้งหมด</div>
              <div style={{height:4,background:"var(--line)",borderRadius:2}}>
                <div style={{width:onPct+"%",height:"100%",background:"#E87B6A",borderRadius:2,transition:"width .3s"}}/>
              </div>
            </div>
          </div>
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:6}}>ค่าใช้จ่าย Off Peak</div>
            <div style={{fontSize:26,fontWeight:700,color:"var(--ink)",lineHeight:1.2}}>{THB(pkCosts.off)}</div>
            <div style={{marginTop:8}}>
              <div style={{fontSize:11,color:"#6AAAE8",fontWeight:600,marginBottom:4}}>{offPct.toFixed(0)}% ของค่าใช้จ่ายทั้งหมด</div>
              <div style={{height:4,background:"var(--line)",borderRadius:2}}>
                <div style={{width:offPct+"%",height:"100%",background:"#6AAAE8",borderRadius:2,transition:"width .3s"}}/>
              </div>
            </div>
          </div>
        </div>

        {/* Trend chart + Station ranking */}
        <div className="dash-2col" style={{marginBottom:14}}>
          <div className="panel" style={{minHeight:"unset"}}>
            <h3 style={{marginBottom:14}}>แนวโน้มค่าใช้จ่ายรายเดือน</h3>
            {trendData.length===0
              ?<div style={{height:160,display:"grid",placeItems:"center",color:"var(--ink-3)",fontSize:13}}>ยังไม่มีข้อมูล</div>
              :<ExpBarChart data={trendData} selectedKey={monthKey}/>
            }
            {pC>0&&totC>0&&(()=>{
              const diff=totC-pC;
              const pctD=Math.abs((diff/pC)*100);
              const lower=diff<0;
              return(
                <div style={{marginTop:12,padding:"10px 12px",background:lower?"var(--surface-soft)":"#FEF3F2",borderRadius:8,borderLeft:`3px solid ${lower?"var(--leaf-2)":"#E87B6A"}`}}>
                  <div style={{fontSize:12,color:lower?"var(--leaf-2)":"#E87B6A",fontWeight:600}}>
                    ค่าใช้จ่ายรวมเดือนนี้{lower?"ต่ำกว่า":"สูงกว่า"}เดือนก่อน {THB(Math.abs(diff))} {lower?"ลดลง":"เพิ่มขึ้น"} {pctD.toFixed(1)}%
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="panel" style={{minHeight:"unset"}}>
            <h3 style={{marginBottom:4}}>ค่าใช้จ่ายแยกตามสถานี</h3>
            <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:14}}>จัดอันดับตามค่าใช้จ่ายสูงสุด</div>
            {stBd.length===0
              ?<div style={{color:"var(--ink-3)",fontSize:13,textAlign:"center",padding:"20px 0"}}>ยังไม่มีข้อมูล</div>
              :(
                <>
                  <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:14}}>
                    {stBd.map((s,i)=>(
                      <div key={s.name}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <span style={{width:20,height:20,borderRadius:"50%",background:"var(--surface-soft)",border:"1px solid var(--line)",display:"grid",placeItems:"center",fontSize:11,fontWeight:700,color:"var(--ink-2)",flexShrink:0}}>{i+1}</span>
                          <div style={{width:26,height:26,borderRadius:6,background:s.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{s.abbr}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,fontWeight:600,color:"var(--ink)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:13,fontWeight:700,color:"var(--ink)"}}>{THB(s.cost)}</div>
                            <div style={{fontSize:11,color:"var(--ink-3)"}}>{s.pct.toFixed(0)}%</div>
                          </div>
                        </div>
                        <div style={{height:4,background:"var(--line)",borderRadius:2,marginLeft:58}}>
                          <div style={{width:s.pct+"%",height:"100%",background:s.color,borderRadius:2}}/>
                        </div>
                      </div>
                    ))}
                  </div>
                  {stBd[0]&&(
                    <div style={{padding:"10px 12px",background:"var(--surface-soft)",borderRadius:8,border:"1px solid var(--line)",fontSize:12,color:"var(--ink-2)"}}>
                      คุณใช้จ่ายกับ <strong>{stBd[0].name}</strong> มากที่สุด คิดเป็น {stBd[0].pct.toFixed(0)}% ของค่าใช้จ่ายทั้งหมด
                    </div>
                  )}
                </>
              )
            }
          </div>
        </div>

        {/* 4 insight cards */}
        <div className="exp-4cards" style={{marginBottom:14}}>
          {/* ช่วงเวลาที่ใช้จ่ายสูงสุด */}
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:8,fontWeight:600,letterSpacing:".3px"}}>ช่วงเวลาที่ใช้จ่ายสูงสุด</div>
            {totC>0?(
              <>
                <div style={{fontSize:16,fontWeight:700,color:"var(--ink)",marginBottom:4}}>{insightData.peakTimeLbl}</div>
                <div style={{fontSize:22,fontWeight:700,color:"var(--leaf-2)",marginBottom:4}}>{THB(insightData.peakTimeAmt)}</div>
                <div style={{fontSize:12,color:"var(--ink-3)"}}>{insightData.peakTimePct.toFixed(0)}% ของค่าใช้จ่ายทั้งหมด</div>
              </>
            ):<div style={{color:"var(--ink-3)",fontSize:13,paddingTop:8}}>ยังไม่มีข้อมูล</div>}
          </div>
          {/* วันที่จ่ายแพงสุด */}
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:8,fontWeight:600,letterSpacing:".3px"}}>วันที่จ่ายแพงสุด</div>
            {insightData.expDay?(
              <>
                <div style={{fontSize:15,fontWeight:700,color:"var(--ink)",marginBottom:4}}>{dLbl(insightData.expDay[0])}</div>
                <div style={{fontSize:22,fontWeight:700,color:"#E87B6A",marginBottom:4}}>{THB(insightData.expDay[1])}</div>
                <div style={{fontSize:12,color:"var(--ink-3)"}}>{totC?(insightData.expDay[1]/totC*100).toFixed(0):0}% ของค่าใช้จ่ายทั้งหมด</div>
              </>
            ):<div style={{color:"var(--ink-3)",fontSize:13,paddingTop:8}}>ยังไม่มีข้อมูล</div>}
          </div>
          {/* เซสชั่นที่แพงสุด */}
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:8,fontWeight:600,letterSpacing:".3px"}}>เซสชั่นที่แพงสุด</div>
            {insightData.expSess?(()=>{
              const e=insightData.expSess;
              const s=smeta(e.station,rates);
              const snap=e.rate_snapshot||{};
              const isPeak=e.peak_type==="on_peak",isOff=e.peak_type==="off_peak";
              const timeStr=isPeak?(snap.on_time||"--"):(isOff?(snap.off_time||"--"):"--");
              return(
                <>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6}}>
                    <div style={{width:24,height:24,borderRadius:6,background:s.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{s.abbr}</div>
                    <span style={{fontSize:13,fontWeight:600,color:"var(--ink)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.station}</span>
                  </div>
                  <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:2}}>{dLbl(e.date)} · {timeStr}</div>
                  <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:6}}>{NUM(e.kwh,1)} kWh</div>
                  <div style={{fontSize:22,fontWeight:700,color:"var(--ink)"}}>{THB(e.final_price)}</div>
                  <div style={{fontSize:11,color:"var(--ink-3)",marginTop:2}}>{NUM((+e.final_price)/(+e.kwh||1),2)} ฿/kWh</div>
                </>
              );
            })():<div style={{color:"var(--ink-3)",fontSize:13,paddingTop:8}}>ยังไม่มีข้อมูล</div>}
          </div>
          {/* สถานีที่คุ้มค่าสุด */}
          <div className="panel" style={{padding:"16px 18px",minHeight:"unset"}}>
            <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:8,fontWeight:600,letterSpacing:".3px"}}>สถานีที่คุ้มค่าสุด</div>
            {insightData.bestSt?(()=>{
              const b=insightData.bestSt;
              return(
                <>
                  <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6,flexWrap:"wrap"}}>
                    <div style={{width:24,height:24,borderRadius:6,background:b.color,display:"grid",placeItems:"center",color:"#fff",fontSize:10,fontWeight:700,flexShrink:0}}>{b.abbr}</div>
                    <span style={{fontSize:13,fontWeight:600,color:"var(--ink)"}}>{b.name}</span>
                    <span style={{fontSize:10,padding:"2px 7px",borderRadius:999,background:"#4CAF6E20",color:"#4CAF6E",fontWeight:700}}>ถูกสุด</span>
                  </div>
                  <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:4}}>ราคาเฉลี่ย</div>
                  <div style={{fontSize:22,fontWeight:700,color:"var(--leaf-2)"}}>{NUM(b.avg,2)} ฿/kWh</div>
                </>
              );
            })():<div style={{color:"var(--ink-3)",fontSize:13,paddingTop:8}}>ยังไม่มีข้อมูล</div>}
          </div>
        </div>

        {/* Recent charges */}
        <div className="panel" style={{minHeight:"unset",padding:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h3>รายการชาร์จล่าสุด</h3>
            <span style={{fontSize:12,color:"var(--ink-3)"}}>{mE.length} รายการในเดือนนี้</span>
          </div>
          {mE.length===0?<div style={{textAlign:"center",color:"var(--ink-3)",padding:"20px 0",fontSize:13}}>ยังไม่มีรายการในเดือนนี้</div>:(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:"unset"}}>
                <thead>
                  <tr style={{borderBottom:"2px solid var(--line)"}}>
                    {["วันที่","สถานี","เวลา","พลังงาน","ค่าใช้จ่าย","ราคาเฉลี่ย","ประเภท"].map(h=>(
                      <th key={h} style={{textAlign:"left",padding:"6px 8px 10px",color:"var(--ink-3)",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...mE].sort((a,b)=>b.date.localeCompare(a.date)).map(e=><EntryRow key={e.id} e={e}/>)}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer note */}
        <div style={{marginTop:12,fontSize:12,color:"var(--ink-3)",display:"flex",alignItems:"flex-start",gap:6}}>
          <span>ⓘ</span>
          <span>ค่าใช้จ่ายทั้งหมดเป็นค่าชาร์จเท่านั้น (ยังไม่รวมค่าบริการอื่นๆ หรือภาษีบริการ)</span>
        </div>
      </>)}

      {/* ── แนวโน้ม ── */}
      {subTab==="แนวโน้ม"&&(
        <div className="panel">
          <h3 style={{marginBottom:14}}>แนวโน้มค่าใช้จ่ายรายเดือน</h3>
          {trendData.length===0?<div style={{height:200,display:"grid",placeItems:"center",color:"var(--ink-3)"}}>ยังไม่มีข้อมูล</div>:
            <ExpBarChart data={trendData} selectedKey={monthKey}/>
          }
        </div>
      )}

      {/* ── แยกตามสถานี ── */}
      {subTab==="แยกตามสถานี"&&(
        <div className="panel">
          <h3 style={{marginBottom:4}}>แยกตามสถานี</h3>
          <div className="panel-sub" style={{marginBottom:20}}>{expYear===0?"ทุกช่วงเวลา":expMonth===0?`ปี ${expYear+543}`:`${MONTHS_TH[mo-1]} ${expYear+543}`} · {mE.length} รายการ</div>
          {stBd.length===0?<div style={{textAlign:"center",color:"var(--ink-3)",padding:"20px 0"}}>ยังไม่มีข้อมูล</div>:(
            <>
              <div style={{display:"flex",gap:20,alignItems:"center",marginBottom:20,flexWrap:"wrap"}}>
                <DonutChart segments={stBd.map(b=>({value:b.cost,color:b.color}))} total={totC} centerText={THB(totC)} size={140}/>
                <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",gap:10}}>
                  {stBd.map(b=>(
                    <div key={b.name} style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:10,height:10,borderRadius:3,background:b.color,flexShrink:0}}/>
                      <div style={{flex:1,fontSize:13,fontWeight:600,color:"var(--ink-2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}</div>
                      <span style={{fontSize:12,color:"var(--ink-3)",minWidth:36,textAlign:"right"}}>{b.pct.toFixed(0)}%</span>
                      <span style={{fontSize:13,fontWeight:700,color:"var(--ink)",minWidth:70,textAlign:"right"}}>{THB(b.cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
              {stBd.map(b=>(
                <div key={b.name} className="bd-row">
                  <div className="dot" style={{background:b.color+"28",color:b.color}}>{b.abbr}</div>
                  <div className="info">
                    <div className="name">{b.name}</div>
                    <div className="meta">{b.n}ครั้ง · {NUM(b.kwh,1)} kWh</div>
                    <div className="bd-bar"><i style={{width:b.pct+"%",background:b.color}}/></div>
                  </div>
                  <div><div className="amt">{THB(b.cost)}</div><div className="pct">{b.pct.toFixed(1)}%</div></div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── ช่วงเวลา ── */}
      {subTab==="ช่วงเวลา"&&(
        <div className="panel">
          <h3 style={{marginBottom:4}}>แยกตามประเภทชาร์จ</h3>
          <div className="panel-sub" style={{marginBottom:20}}>{expYear===0?"ทุกช่วงเวลา":expMonth===0?`ปี ${expYear+543}`:`${MONTHS_TH[mo-1]} ${expYear+543}`}</div>
          {pkBd.items.length===0?<div style={{textAlign:"center",color:"var(--ink-3)",padding:"20px 0"}}>ยังไม่มีข้อมูล</div>:(
            <div style={{display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
              <DonutChart segments={pkBd.items} total={pkBd.tot} centerText={THB(pkBd.tot)} size={150}/>
              <div style={{flex:1,minWidth:160,display:"flex",flexDirection:"column",gap:12}}>
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
          )}
        </div>
      )}

      {/* ── รายการชาร์จ ── */}
      {subTab==="รายการชาร์จ"&&(
        <div className="panel" style={{minHeight:"unset",padding:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h3>รายการชาร์จ — {expYear===0?"ทุกช่วงเวลา":expMonth===0?`ปี ${expYear+543}`:`${MONTHS_TH[mo-1]} ${expYear+543}`}</h3>
            <span style={{fontSize:12,color:"var(--ink-3)"}}>{mE.length} รายการ</span>
          </div>
          {mE.length===0?<div style={{textAlign:"center",color:"var(--ink-3)",padding:"20px 0",fontSize:13}}>ยังไม่มีรายการในเดือนนี้</div>:(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:"unset"}}>
                <thead>
                  <tr style={{borderBottom:"2px solid var(--line)"}}>
                    {["วันที่","สถานี","เวลา","พลังงาน","ค่าใช้จ่าย","ราคาเฉลี่ย","ประเภท"].map(h=>(
                      <th key={h} style={{textAlign:"left",padding:"6px 8px 10px",color:"var(--ink-3)",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...mE].sort((a,b)=>b.date.localeCompare(a.date)).map(e=><EntryRow key={e.id} e={e}/>)}
                </tbody>
              </table>
            </div>
          )}
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
    odometer:entry?.odometer!=null?String(entry.odometer):"",
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
      odometer:form.odometer?+form.odometer:null,
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

          <div className="field">
            <label>เลขไมล์ (km) <span style={{fontWeight:400,color:"var(--muted)"}}>— ไม่บังคับ</span></label>
            <input type="number" step="0.1" min="0" value={form.odometer} onChange={e=>set("odometer",e.target.value)} placeholder="เช่น 12500"/>
            <span className="hint">มาตรวัดระยะทาง ณ ตอนเข้าชาร์จ</span>
          </div>
          <div className="field">
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
  const [savingStation,setSavingStation]=useState(null);
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
  const saveStationData=async(station,data)=>{
    if(!api){ setSaveErr("ไม่ได้เชื่อมต่อ Supabase"); return; }
    setSavingStation(station);
    try{
      await api.upsertRate(station,{
        rate_type:data.type,
        on_peak:data.on_peak||null, off_peak:data.off_peak||null,
        on_time:data.on_time||null, off_time:data.off_time||null,
        flat:data.flat||null, color:data.color||null, abbr:data.abbr||null,
      });
      setRates(r=>{ const n={...r,[station]:data}; saveRates(n); return n; });
      setSaved(true); setSaveErr(""); setTimeout(()=>setSaved(false),1800);
    }catch(e){ setSaveErr("บันทึกไม่ได้: "+e.message); }
    finally{ setSavingStation(null); }
  };

  const applyEdit=()=>{
    const newName=editDraft.name.trim();
    if(!newName) return;
    let sd,ss;
    setLocal(r=>{
      const next={...r};
      const data={...next[editKey],abbr:editDraft.abbr.toUpperCase().slice(0,3),color:editDraft.color};
      if(newName!==editKey){ delete next[editKey]; next[newName]=data; }
      else{ next[editKey]=data; }
      sd=data; ss=newName; return next;
    });
    setEditKey(null);
    setTimeout(()=>{ if(sd&&ss) saveStationData(ss,sd); },0);
  };

  const setField=(station,field,val)=>{
    setLocal(r=>({...r,[station]:{...r[station],[field]:field==="on_peak"||field==="off_peak"||field==="flat"?+val||0:val}}));
  };

  const addStation=async()=>{
    const station=draft.station.trim();
    if(!station){ setSaveErr("กรุณากรอกชื่อสถานี"); return; }
    if(local[station]){ setSaveErr("มีสถานีนี้แล้ว"); return; }
    const next={
      type:draft.type, color:draft.color||"#6CAE76",
      abbr:(draft.abbr||makeAbbr(station)).slice(0,3).toUpperCase(),
      ...(draft.type==="peak"
        ? {on_peak:+draft.on_peak||0,off_peak:+draft.off_peak||0,on_time:draft.on_time,off_time:draft.off_time}
        : {flat:+draft.flat||0})
    };
    setLocal(r=>({...r,[station]:next}));
    setDraft(d=>({...d,station:"",abbr:""}));
    setSaveErr("");
    await saveStationData(station,next);
  };

  const deleteStation=async(station)=>{
    if(!confirm(`ลบสถานี ${station}? รายการชาร์จเก่าจะยังอยู่ แต่สถานีนี้จะหายจากตัวเลือกใหม่`)) return;
    if(!api){ setSaveErr("ไม่ได้เชื่อมต่อ Supabase"); return; }
    setSavingStation(station);
    try{
      await api.deleteRate(station);
      setLocal(r=>{ const n={...r}; delete n[station]; return n; });
      setRates(r=>{ const n={...r}; delete n[station]; saveRates(n); return n; });
      setSaved(true); setSaveErr(""); setTimeout(()=>setSaved(false),1800);
    }catch(e){ setSaveErr("ลบไม่ได้: "+e.message); }
    finally{ setSavingStation(null); }
  };

  const stationList = Object.entries(local);
  const peakCount  = stationList.filter(([,d])=>d.type==="peak").length;
  const flatCount  = stationList.filter(([,d])=>d.type==="flat").length;
  const avgPrice   = stationList.length
    ? stationList.reduce((s,[,d])=>s+(d.type==="peak"?((+d.on_peak||0)+(+d.off_peak||0))/2:(+d.flat||0)),0)/stationList.length
    : 0;

  const inpStyle = {appearance:"none",fontFamily:"inherit",fontSize:13,color:"var(--ink)",background:"var(--surface-soft)",border:"1px solid var(--line)",borderRadius:8,padding:"8px 12px",outline:"none",width:"100%"};

  return(
    <div>
      {/* ── Header ── */}
      <div className="page-hd">
        <div>
          <h2>EV Charging Pricing</h2>
          <p style={{margin:"4px 0 0",fontSize:13,color:"var(--ink-3)"}}>จัดการราคาค่าชาร์จของแต่ละผู้ให้บริการ</p>
        </div>
        {savingStation&&<span style={{fontSize:13,color:"var(--ink-3)",display:"flex",alignItems:"center",gap:6}}><div className="spinner" style={{width:14,height:14,borderWidth:2}}/>กำลังบันทึก…</span>}
        {saved&&!savingStation&&<span style={{fontSize:13,color:"var(--leaf-2)",fontWeight:600}}>✓ บันทึกแล้ว</span>}
      </div>

      {saveErr&&<div className="err-bar" style={{marginBottom:16}}><span>⚠️ {saveErr}</span><button onClick={()=>setSaveErr("")}>×</button></div>}

      {/* ── Summary stats ── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
        {[
          {icon:"🏢",bg:"#E8F5E9",lbl:"ทั้งหมด",val:stationList.length,unit:"สถานี"},
          {icon:"📈",bg:"#FFF3E0",lbl:"On/Off Peak",val:peakCount,unit:"สถานี"},
          {icon:"⚡",bg:"#F1F8E9",lbl:"Flat Rate",val:flatCount,unit:"สถานี"},
          {icon:"฿",bg:"#E3F2FD",lbl:"ราคาเฉลี่ย",val:NUM(avgPrice,2),unit:"บาท/หน่วย"},
        ].map(c=>(
          <div key={c.lbl} className="stat" style={{minHeight:"unset",padding:"14px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:36,height:36,borderRadius:10,background:c.bg,display:"grid",placeItems:"center",fontSize:17,flexShrink:0}}>{c.icon}</div>
              <div className="lbl">{c.lbl}</div>
            </div>
            <div className="val" style={{fontSize:26,lineHeight:1}}>{c.val}<small style={{fontSize:12,marginLeft:4}}>{c.unit}</small></div>
          </div>
        ))}
      </div>

      {/* ── Add station form ── */}
      <div style={{background:"var(--surface)",border:"1px solid var(--line)",borderRadius:12,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",boxShadow:"var(--shadow-sm)"}}>
        <span style={{fontSize:13,fontWeight:700,color:"var(--leaf-2)",whiteSpace:"nowrap"}}>+ เพิ่มสถานีใหม่</span>
        <input style={{...inpStyle,flex:"2 1 150px"}} value={draft.station}
          onChange={e=>setDraft(d=>({...d,station:e.target.value,abbr:d.abbr||makeAbbr(e.target.value)}))}
          placeholder="ชื่อสถานี" onKeyDown={e=>e.key==="Enter"&&addStation()}/>
        <select style={{...inpStyle,flex:"1 1 120px"}} value={draft.type}
          onChange={e=>setDraft(d=>({...d,type:e.target.value}))}>
          <option value="flat">Flat Rate</option>
          <option value="peak">On/Off Peak</option>
        </select>
        {draft.type==="flat"?(
          <input type="number" step="0.01" min="0"
            style={{...inpStyle,flex:"1 1 110px",fontFamily:"var(--font-mono)"}}
            value={draft.flat} onChange={e=>setDraft(d=>({...d,flat:e.target.value}))}
            placeholder="ราคา (บาท/หน่วย)"/>
        ):(
          <>
            <input type="number" step="0.01" min="0"
              style={{...inpStyle,flex:"1 1 100px",fontFamily:"var(--font-mono)"}}
              value={draft.on_peak} onChange={e=>setDraft(d=>({...d,on_peak:e.target.value}))}
              placeholder="On Peak ฿"/>
            <input type="number" step="0.01" min="0"
              style={{...inpStyle,flex:"1 1 100px",fontFamily:"var(--font-mono)"}}
              value={draft.off_peak} onChange={e=>setDraft(d=>({...d,off_peak:e.target.value}))}
              placeholder="Off Peak ฿"/>
          </>
        )}
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <input type="color" value={draft.color} onChange={e=>setDraft(d=>({...d,color:e.target.value}))}
            style={{width:36,height:36,padding:3,borderRadius:8,border:"1px solid var(--line)",cursor:"pointer"}}/>
          <span style={{fontSize:12,color:"var(--ink-3)"}}>สี</span>
        </div>
        <button className="btn btn-primary" style={{height:36,padding:"0 16px",flexShrink:0}} onClick={addStation}>{I.plus} เพิ่ม</button>
      </div>

      {/* ── Station cards ── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
        {stationList.map(([station,data])=>{
          const s=smeta(station,rates);
          const isPeak=data.type==="peak";
          return(
            <div key={station} style={{background:"var(--surface)",border:"1px solid var(--line)",borderRadius:12,overflow:"hidden",boxShadow:"var(--shadow-sm)"}}>
              {/* Card header */}
              <div style={{padding:"12px 14px",borderBottom:"1px solid var(--line-2)",display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:40,height:40,borderRadius:10,background:data.color||s.color,display:"grid",placeItems:"center",fontWeight:700,fontSize:13,color:"#fff",flexShrink:0,letterSpacing:"0.5px"}}>
                  {data.abbr||s.abbr}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  {editKey===station?(
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                      <input className="rr-edit-input" value={editDraft.name} onChange={e=>setEditDraft(d=>({...d,name:e.target.value}))} placeholder="ชื่อสถานี" style={{flex:1,minWidth:80}}/>
                      <input className="rr-edit-input" value={editDraft.abbr} onChange={e=>setEditDraft(d=>({...d,abbr:e.target.value.toUpperCase()}))} placeholder="ตัวย่อ" maxLength="3" style={{width:52}}/>
                      <input type="color" value={editDraft.color} onChange={e=>setEditDraft(d=>({...d,color:e.target.value}))} style={{width:32,height:32,padding:2,borderRadius:7,border:"1px solid var(--line)",cursor:"pointer"}}/>
                      <button className="btn btn-primary" style={{padding:"4px 10px",fontSize:12,height:32}} onClick={applyEdit}>บันทึก</button>
                      <button className="btn btn-ghost" style={{padding:"4px 10px",fontSize:12,height:32}} onClick={()=>setEditKey(null)}>ยกเลิก</button>
                    </div>
                  ):(
                    <>
                      <div style={{fontWeight:700,fontSize:15,color:"var(--ink)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{station}</div>
                      <span style={{fontSize:11,background:isPeak?"#FFF3CD":"var(--mint)",color:isPeak?"#9A6400":"var(--leaf-deep)",padding:"2px 8px",borderRadius:999,fontWeight:600,display:"inline-block",marginTop:3}}>
                        {isPeak?"On/Off Peak":"Flat Rate"}
                      </span>
                    </>
                  )}
                </div>
                {editKey!==station&&(
                  <div style={{display:"flex",gap:4,flexShrink:0}}>
                    <button className="icon-btn" onClick={()=>startEdit(station)}>{I.edit}</button>
                    <button className="icon-btn danger" onClick={()=>deleteStation(station)}>{I.trash}</button>
                  </div>
                )}
              </div>
              {/* Card body */}
              {isPeak?(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr"}}>
                  {[
                    {label:"☀ On Peak",field:"on_peak",timeField:"on_time",timePlaceholder:"09:00–22:00",timeColor:"var(--leaf-2)"},
                    {label:"🌙 Off Peak",field:"off_peak",timeField:"off_time",timePlaceholder:"22:00–09:00",timeColor:"#6AAAE8"},
                  ].map((p,i)=>(
                    <div key={p.field} style={{padding:"14px 16px",borderRight:i===0?"1px solid var(--line-2)":"none"}}>
                      <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:6}}>{p.label}</div>
                      <div style={{display:"flex",alignItems:"baseline",gap:2}}>
                        <span style={{fontSize:12,color:"var(--ink-3)",fontWeight:600}}>฿</span>
                        <input type="number" step="0.01" min="0" value={data[p.field]||""} onChange={e=>setField(station,p.field,e.target.value)} onBlur={()=>saveStationData(station,data)}
                          style={{border:"none",background:"transparent",fontFamily:"var(--font-mono)",fontSize:26,fontWeight:700,color:"var(--ink)",outline:"none",padding:0,width:"100%"}}/>
                      </div>
                      <div style={{fontSize:11,color:"var(--ink-3)",marginBottom:6}}>บาท/หน่วย</div>
                      <input type="text" value={data[p.timeField]||""} onChange={e=>setField(station,p.timeField,e.target.value)} onBlur={()=>saveStationData(station,data)} placeholder={p.timePlaceholder}
                        style={{border:"none",background:"transparent",fontFamily:"inherit",fontSize:12,color:p.timeColor,outline:"none",padding:0,fontWeight:600,width:"100%"}}/>
                    </div>
                  ))}
                </div>
              ):(
                <div style={{padding:"18px 16px",textAlign:"center"}}>
                  <div style={{display:"flex",alignItems:"baseline",gap:2,justifyContent:"center"}}>
                    <span style={{fontSize:14,color:"var(--ink-3)",fontWeight:600}}>฿</span>
                    <input type="number" step="0.01" min="0" value={data.flat||""} onChange={e=>setField(station,"flat",e.target.value)} onBlur={()=>saveStationData(station,data)}
                      style={{border:"none",background:"transparent",fontFamily:"var(--font-mono)",fontSize:32,fontWeight:700,color:"var(--ink)",outline:"none",padding:0,textAlign:"center",width:"100%"}}/>
                  </div>
                  <div style={{fontSize:12,color:"var(--ink-3)",marginBottom:8}}>บาท/หน่วย</div>
                  <div style={{fontSize:12,color:"var(--leaf-2)",display:"flex",alignItems:"center",gap:4,justifyContent:"center",fontWeight:600}}>
                    ⚡ คิดราคาเดียวตลอด 24 ชั่วโมง
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{fontSize:12,color:"var(--ink-3)",textAlign:"center",padding:"4px 0 8px"}}>
        ⓘ ราคาทั้งหมดเป็นบาทต่อหน่วย (kWh)
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
  const [authed,setAuthed]   = useState(false);
  const [authReady,setAuthReady] = useState(false);
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

  useEffect(()=>{
    sbClient.auth.getSession().then(({data:{session}})=>{
      setAuthed(!!session); setAuthReady(true);
    });
    const {data:{subscription}}=sbClient.auth.onAuthStateChange((_,session)=>{
      setAuthed(!!session);
    });
    return ()=>subscription.unsubscribe();
  },[]);

  const api = useMemo(()=>cfg.url&&cfg.key?makeApi(cfg.url,cfg.key):null,[cfg.url,cfg.key]);
  const hasCfg = !!(cfg.url&&cfg.key);
  const visibleEntries = entries;

  const statYears = useMemo(()=>[...new Set(entries.map(e=>+e.date.slice(0,4)))].sort((a,b)=>b-a),[entries]);
  const statMonthsInYear = useMemo(()=>new Set(entries.filter(e=>+e.date.slice(0,4)===statYear).map(e=>+e.date.slice(5,7))),[entries,statYear]);
  const yearEntries  = useMemo(()=>statYear===0?entries:entries.filter(e=>+e.date.slice(0,4)===statYear),[entries,statYear]);
  const statsEntries = useMemo(()=>statYear===0||statMonth===0?yearEntries:entries.filter(e=>+e.date.slice(0,4)===statYear&&+e.date.slice(5,7)===statMonth),[entries,statYear,statMonth,yearEntries]);
  const statYearOpts = useMemo(()=>{
    const by={};
    entries.forEach(e=>{const y=+e.date.slice(0,4),m=+e.date.slice(5,7);if(!by[y])by[y]=new Set();by[y].add(m);});
    return Object.entries(by).sort(([a],[b])=>+a-+b).map(([y,ms])=>({year:+y,months:[...ms].sort((a,b)=>a-b)}));
  },[entries]);
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

  if (!authReady) return <div className="auth-scrim"><div className="spinner"/></div>;
  if (!authed) return <LoginScreen/>;

  const handleLogout = () => { sbClient.auth.signOut(); };

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
          <button className={tab==="สถิติ"?"on":""} onClick={()=>setTab("สถิติ")}>{I.home} ภาพรวม</button>
          <button className={tab==="ค่าใช้จ่าย"?"on":""} onClick={()=>setTab("ค่าใช้จ่าย")}>{I.wallet} ค่าใช้จ่าย</button>
          <button className={tab==="รายการ"?"on":""} onClick={()=>setTab("รายการ")}>{I.zap} การชาร์จ</button>
          <button className={tab==="สถานี"?"on":""} onClick={()=>setTab("สถานี")}>{I.pin} สถานี</button>
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
              {tab==="สถิติ"&&<div style={{fontSize:13,color:"var(--ink-3)",marginTop:2}}>สรุปการใช้งานสถานีชาร์จของคุณ</div>}
              {hasCfg&&status==="err"&&<span className="status-badge st-err"><span className="dot"/>เชื่อมต่อไม่ได้</span>}
            </div>
            <div className="actions">
              {tab==="สถิติ"&&(
                <>
                  <select
                    value={statYear===0?"all":statYear}
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
                    onChange={e=>{const v=e.target.value;setStatMonth(v==="all"?0:+v);}}
                    style={{fontSize:13,padding:"7px 12px",borderRadius:9,border:"1px solid var(--line)",background:"var(--surface)",fontFamily:"inherit",color:"var(--ink)",cursor:"pointer",outline:"none",boxShadow:"var(--shadow-sm)"}}
                  >
                    <option value="all">ทุกเดือน</option>
                    {(statYear===0?statYearOpts.flatMap(o=>o.months.map(m=>({year:o.year,m}))):
                      (statYearOpts.find(o=>o.year===statYear)?.months||[]).map(m=>({year:statYear,m}))
                    ).map(({year,m})=>(
                      <option key={`${year}-${m}`} value={m}>{MONTHS_FULL[m-1]}</option>
                    ))}
                  </select>
                </>
              )}
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
              <DashStatCards entries={statsEntries} allEntries={yearEntries} rates={rates}/>
              <div className="dash-2col">
                <TrendChart entries={entries}/>
                <InsightsPanel entries={statsEntries} allEntries={entries} rates={rates}/>
              </div>
              <div className="dash-3col">
                <StationDistTable entries={statsEntries} rates={rates} onViewAll={()=>setTab("รายการ")}/>
                <PeakTimePanel entries={statsEntries}/>
                <CostComparePanel entries={statsEntries} rates={rates}/>
              </div>
              <div className="dash-2col">
                <RecentChargesPanel entries={entries} rates={rates} onViewAll={()=>setTab("รายการ")}/>
                <VehicleEffPanel entries={statsEntries} allEntries={entries}/>
              </div>
            </>
          )}

          {/* ค่าใช้จ่าย */}
          {tab==="ค่าใช้จ่าย"&&<ExpensePage entries={entries} rates={rates}/>}

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
