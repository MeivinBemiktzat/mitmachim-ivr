/**
 * דף הרשמה - קישור מספר טלפון לחשבון בפורום "מתמחים טופ"
 * ==========================================================
 * מטרה: לאפשר למשתמש קצה למלא טופס אינטרנטי קצר (מספר פלאפון + שם משתמש
 * וסיסמא בפורום mitmachim.top), ולשמור את השיוך הזה בזיכרון קבוע (Upstash
 * Redis, לפי REST API) - כדי ששלוחה 5 בשלוחת ה-IVR (api/yemot/index.js)
 * תוכל לזהות מתקשר לפי מספר הטלפון שלו (call.phone) ולהתחבר בשמו לפורום
 * כדי להקריא לו את ההתראות האישיות שלו.
 *
 * ארכיטקטורה: קובץ Vercel Serverless Function עצמאי (Express app), בדיוק
 * כמו api/yemot/index.js - Vercel מריץ כל קובץ תחת api/ כפונקציה נפרדת.
 * הכתובת הציבורית תהיה: https://<דומיין-הפרויקט>/api/register
 *   GET  /api/register  -> מחזיר טופס HTML פשוט (ללא תלות חיצונית/CSS/JS
 *                          כבד - טופס אחד, נגיש, עובד גם ללא JavaScript).
 *   POST /api/register  -> מקבל phone+username+password (JSON או form),
 *                          מנרמל את מספר הטלפון, ושומר אותו כ-key ב-Redis.
 *
 * אחסון: Upstash Redis REST API (לא דורש חבילת @upstash/redis - מספיק
 * HTTP client רגיל, בדיוק כמו axios שכבר משמש בפרויקט לקריאות לפורום).
 * משתני סביבה נדרשים (יש להגדיר ב-Vercel Project Settings -> Environment
 * Variables, ר' גם .env.example):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * מפתח האחסון: `mitmachim:phone:<מספר מנורמל>` -> JSON string עם
 * { username, password, updatedAt }. הנרמול (normalizePhone) הוא קריטי:
 * חייב להתאים בדיוק לפורמט שבו ימות המשיח מעביר את call.phone בהמשך
 * (ר' תיעוד מפורט ליד normalizePhone למטה ובקובץ api/yemot/index.js
 * ליד notificationsFlow) - אחרת הזיהוי האוטומטי לפי מספר מתקשר ייכשל.
 *
 * אבטחה: הסיסמא לפורום נשמרת כפי שהיא (טקסט גלוי) ב-Redis, מכיוון שהיא
 * נדרשת בפועל כדי לבצע login אמיתי מול NodeBB בזמן השיחה (ר' loginAsUser
 * ב-api/yemot/index.js) - NodeBB עצמו לא חושף API להתחברות עם hash בלבד.
 * יש להסביר זאת למשתמשים בטופס (ר' ההודעה בעמוד עצמו) ולוודא ש-Redis
 * עצמו מאובטח (Upstash כברירת מחדל דורש טוקן+TLS).
 */

'use strict';

const express = require('express');
// נרמול מספר הטלפון ושמירת פרטי ההתחברות מוגדרים במודול משותף (userStore.js)
// כדי להבטיח שהנרמול זהה בדיוק לזה שמשמש בשלוחה 5 (api/yemot/index.js)
// בעת שליפת הפרטים לפי מספר המתקשר - ר' תיעוד מפורט ב-userStore.js.
const { normalizePhone, saveUserCredentials } = require('./userStore');

/** בורח (escape) HTML כדי למנוע XSS בהודעות שגיאה/הצלחה המוזרקות לטופס. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** בונה את עמוד ה-HTML של הטופס, עם הודעת סטטוס אופציונלית (הצלחה/שגיאה). */
function renderPage({ status, message } = {}) {
  let banner = '';
  if (status === 'success') {
    banner = `<div class="banner success">${escapeHtml(message || 'הפרטים נשמרו בהצלחה!')}</div>`;
  } else if (status === 'error') {
    banner = `<div class="banner error">${escapeHtml(message || 'אירעה שגיאה, אנא נסו שוב.')}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>הרשמה להתראות קוליות - מתמחים טופ</title>
<style>
  :root {
    --bg: #f4f6f8;
    --card-bg: #ffffff;
    --primary: #2563eb;
    --primary-dark: #1d4ed8;
    --text: #1f2937;
    --muted: #6b7280;
    --success-bg: #ecfdf5;
    --success-border: #10b981;
    --error-bg: #fef2f2;
    --error-border: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    justify-content: center;
    padding: 32px 16px;
    min-height: 100vh;
  }
  .card {
    background: var(--card-bg);
    border-radius: 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    padding: 32px 28px;
    max-width: 440px;
    width: 100%;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 8px;
    text-align: center;
  }
  p.subtitle {
    color: var(--muted);
    text-align: center;
    margin: 0 0 24px;
    font-size: 15px;
    line-height: 1.5;
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 6px;
    font-size: 14px;
  }
  input[type="text"], input[type="tel"], input[type="password"] {
    width: 100%;
    padding: 11px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 15px;
    margin-bottom: 18px;
    direction: ltr;
    text-align: right;
  }
  input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(37,99,235,0.15);
  }
  button {
    width: 100%;
    padding: 12px;
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: var(--primary-dark); }
  .banner {
    padding: 12px 14px;
    border-radius: 8px;
    margin-bottom: 20px;
    font-size: 14px;
    border: 1px solid;
  }
  .banner.success { background: var(--success-bg); border-color: var(--success-border); color: #065f46; }
  .banner.error { background: var(--error-bg); border-color: var(--error-border); color: #991b1b; }
  .note {
    margin-top: 20px;
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.6;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>הרשמה להתראות קוליות</h1>
    <p class="subtitle">קשרו את מספר הפלאפון שלכם לחשבון שלכם בפורום "מתמחים טופ", כדי שתוכלו לשמוע את ההתראות האישיות שלכם בשלוחה 5 בטלפון.</p>
    ${banner}
    <form method="POST" action="/api/register">
      <label for="phone">מספר פלאפון</label>
      <input type="tel" id="phone" name="phone" placeholder="05XXXXXXXX" required>

      <label for="username">שם משתמש בפורום</label>
      <input type="text" id="username" name="username" placeholder="שם המשתמש שלכם בפורום" required>

      <label for="password">סיסמא בפורום</label>
      <input type="password" id="password" name="password" placeholder="הסיסמא שלכם בפורום" required>

      <button type="submit">שמירה</button>
    </form>
    <div class="note">
      הפרטים נשמרים אך ורק לצורך התחברות אוטומטית לפורום בעת שיחה משלוחה 5,
      כדי להקריא לכם את ההתראות האישיות שלכם. ניתן לעדכן את הפרטים בכל עת
      על ידי מילוי הטופס מחדש.
    </div>
  </div>
</body>
</html>`;
}

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/api/register', (_req, res) => {
  res.status(200).send(renderPage());
});

app.post('/api/register', async (req, res) => {
  const { phone, username, password } = req.body || {};

  if (!phone || !username || !password) {
    return res.status(400).send(renderPage({ status: 'error', message: 'יש למלא את כל השדות: מספר פלאפון, שם משתמש וסיסמא.' }));
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 9) {
    return res.status(400).send(renderPage({ status: 'error', message: 'מספר הפלאפון שהוזן אינו תקין, אנא בדקו ונסו שוב.' }));
  }

  try {
    await saveUserCredentials(phone, username, password);
    return res.status(200).send(renderPage({ status: 'success', message: 'הפרטים נשמרו בהצלחה! כעת ניתן להתקשר ולהיכנס לשלוחה 5 לשמיעת ההתראות שלכם.' }));
  } catch (err) {
    console.error('[register] שגיאה בשמירת פרטי משתמש', err.message);
    return res.status(500).send(renderPage({ status: 'error', message: 'אירעה שגיאה בשמירת הפרטים, אנא נסו שוב מאוחר יותר.' }));
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`דף הרשמה פועל על פורט ${port}`));
}

module.exports = app;
