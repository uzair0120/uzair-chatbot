# Uzair GPT — Claude jaisa AI chat app

Features: Login/Register • Chat history • Streaming jawab • Live voice baat-cheet (Urdu/Hindi/English) •
File + PDF upload aur sawal-jawab • Photo upload • Dark/Light mode • Email alerts • Security.

## 1) Apne computer par chalana (localhost)
1. Node.js 18+ install karein (nodejs.org).
2. Folder mein terminal kholein:
   ```
   npm install
   copy .env.example .env      (Mac/Linux: cp .env.example .env)
   ```
3. `.env` file kholein: `AI_API_KEY`, `JWT_SECRET`, `SMTP_PASS` bharein.
4. `npm start` chalayen → browser mein http://localhost:3000

## 2) GitHub par upload
```
git init
git add .
git commit -m "Uzair GPT"
git branch -M main
git remote add origin https://github.com/APNA-USERNAME/uzair-gpt.git
git push -u origin main
```
`.env` upload nahi hoti (.gitignore mein hai) — ye sahi hai, key GitHub par nahi jani chahiye.

## 3) Live karna (Render.com — free)
1. render.com → New → Web Service → apni GitHub repo chunein (render.yaml khud settings le lega).
2. Environment mein ye daalein: `AI_API_KEY`, `RESEND_API_KEY` (neeche dekhein), `ALERT_EMAIL`.
3. Deploy → aap ko `https://uzair-gpt.onrender.com` jaisa link milega.

⚠ Free plan par database restart/redeploy par reset ho sakta hai. Users/chats hamesha rakhne ke liye
Render ka paid Disk lagayen (mount path `/var/data`, aur env `DB_PATH=/var/data/uzair.db`) ya Railway Volume.

## Email alerts kaise chalain
- **Local (Gmail)**: Google Account → Security → 2-Step Verification on → "App passwords" → 16 letters ka password `SMTP_PASS` mein.
- **Live (Render free)**: Render free par SMTP block hai, isliye resend.com par free account banayen
  (isi email `uuzairarani3@gmail.com` se), API key `RESEND_API_KEY` mein daalein.

Email in cases mein aati hai: naya register, har login, bohat ghalat passwords (brute-force),
`.env`/key/secret wale raaste kholne ki koshish, chat mein key/password maangna, IP auto-block.

## Security jo lagi hui hai
API key sirf server par • passwords bcrypt hash • login cookie httpOnly+Secure • CSRF header check •
rate limiting • helmet + strict CSP • file type/signature check • scanner IP 1 ghante ke liye block •
har user sirf apni chats/files dekh sakta hai.

## Zaroori
Aap ne API key chat mein paste ki thi. Behtar hai Google AI Studio se **nayi key banayen aur purani delete** karein,
phir nayi key sirf `.env` / Render Environment mein rakhein.
