// Email alerts: login, signup, hacking / key-theft attempts
const nodemailer = require('nodemailer');

const ALERT_TO = process.env.ALERT_EMAIL;
let transporter = null;

function getTransport() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendMail(subject, text) {
  try {
    if (!ALERT_TO) return console.log('[mail off: ALERT_EMAIL missing]', subject);
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Uzair GPT <onboarding@resend.dev>', to: [ALERT_TO], subject, text }),
      });
      if (!r.ok) console.error('resend error', r.status);
      return;
    }
    const t = getTransport();
    if (!t) return console.log('[mail off: SMTP not set]', subject);
    await t.sendMail({ from: `"Uzair GPT" <${process.env.SMTP_USER}>`, to: ALERT_TO, subject, text });
  } catch (e) {
    console.error('mail error:', e.message);
  }
}

// Same alert ko 10 minute mein sirf ek baar bhejta hai (inbox spam se bachne ke liye)
const lastSent = new Map();
function alertOnce(type, ip, details) {
  const k = type + '|' + ip;
  const now = Date.now();
  if (now - (lastSent.get(k) || 0) < 10 * 60 * 1000) return;
  lastSent.set(k, now);
  sendMail(`[Uzair GPT] ⚠ ${type}`, `Time: ${new Date().toISOString()}\nIP: ${ip}\n\n${details}`);
}

module.exports = { sendMail, alertOnce };
