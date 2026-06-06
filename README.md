# Charge Note

เว็บบันทึกและวิเคราะห์ค่าใช้จ่ายการชาร์จ EV ใช้ React, Vite และ Supabase Auth/Postgres

## เริ่มใช้งาน

```bash
npm install
npm run dev
```

คำสั่งตรวจสอบ:

```bash
npm run check
```

## Supabase

สำหรับฐานข้อมูลใหม่ ให้คัดลอก SQL จากหน้าตั้งค่าในแอปไปรันใน Supabase SQL Editor จากนั้นสร้างผู้ใช้ใน Authentication

ฐานข้อมูลเดิมต้องรัน [supabase-migration.sql](./supabase-migration.sql) โดยเปลี่ยน `YOUR_LOGIN_EMAIL` เป็นอีเมล Supabase Auth ที่จะเป็นเจ้าของข้อมูลเดิมก่อน ระบบใช้ `user_id` และ Row Level Security เพื่อแยกข้อมูลของผู้ใช้แต่ละคน

## Backend

สร้าง `.env` จาก `.env.example`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
PORT=3000
```

ห้ามนำ service-role key ใส่ frontend หรือ commit ลง repository ทุก `/api/*` endpoint ตรวจ Supabase Bearer token และจำกัด query ด้วย `user_id`

```bash
npm start
```

`npm start` จะ build frontend แล้วเสิร์ฟไฟล์จาก `dist/`
