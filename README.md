# ChargeNote backend (ตัวอย่าง)

คำอธิบายสั้น ๆ: ตัวอย่าง backend (Express) ที่เชื่อมกับ Supabase โดยใช้ Service Role Key

การตั้งค่า

1. สร้างไฟล์ `.env` ตาม `.env.example` และใส่ค่าจริง (อย่า commit ไฟล์นี้)

2. ติดตั้ง dependencies:

```bash
npm install
```

3. สร้างไฟล์ `.env` หรือคัดลอกจาก `.env.example` แล้วใส่ค่าดังนี้:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
API_KEY=replace_with_a_random_secret_for_api
PORT=3000
```

4. รันเซิร์ฟเวอร์ในเครื่อง:

```bash
# ตั้งค่า .env แล้ว
npm run dev
```

การใช้งานกับ Git host / Deploy

- ให้ push โค้ดขึ้น Git (GitHub/GitLab/Bitbucket). ตั้ง Environment Variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY, PORT) บนแพลตฟอร์มโฮสต์ก่อน deploy.
- แพลตฟอร์มยอดนิยม: Vercel, Render, Fly, Heroku — เลือกแล้วเชื่อม repo แล้วตั้ง Secrets/Environment vars ใน Dashboard ของแต่ละบริการ

ตัวอย่าง git commands:

```bash
git add .
git commit -m "add backend skeleton"
git push origin main
```

ข้อแนะนำความปลอดภัย

- ห้ามเก็บ `SUPABASE_SERVICE_ROLE_KEY` ใน repo หรือฝังไว้ใน frontend — เก็บเฉพาะบน server/CI secrets
- จำกัดสิทธิ์ของ service role และพิจารณาใช้ Row Level Security/Policies บน Supabase ถ้าจำเป็น
