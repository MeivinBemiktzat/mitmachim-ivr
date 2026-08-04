/**
 * דף הרשמה - קישור מספר טלפון לחשבון בפורום ("מתמחים טופ" או "freeivr")
 * ==========================================================
 * מטרה: לאפשר למשתמש קצה למלא טופס אינטרנטי קצר (מספר פלאפון + בחירת
 * הפורום + שם משתמש וסיסמא באותו פורום), ולשמור את השיוך הזה בזיכרון קבוע
 * (Upstash Redis, לפי REST API) - כדי ששלוחה 5 בכל אחת מגרסאות ה-IVR
 * (api/yemot/index.js עבור מתמחים טופ, api/freeivr/index.js עבור freeivr,
 * api/otzaria/index.js עבור פורום אוצריא) תוכל לזהות מתקשר לפי מספר הטלפון
 * שלו (call.phone) ולהתחבר בשמו לפורום הרלוונטי כדי להקריא לו את ההתראות
 * האישיות שלו.
 *
 * תמיכה במספר פורומים: אותו מספר טלפון יכול להירשם בנפרד לכל אחד
 * מהפורומים הנתמכים (בפעולות שליחה נפרדות של הטופס, אחת לכל פורום) -
 * הרשומות בעלות מפתחות נפרדים ב-Redis (ר' userStore.js, פרמטר system),
 * כך שרישום לפורום אחד אינו דורס או משפיע על הרישום לפורום אחר.
 *
 * ארכיטקטורה: קובץ Vercel Serverless Function עצמאי (Express app), בדיוק
 * כמו api/yemot/index.js ו-api/freeivr/index.js - Vercel מריץ כל קובץ תחת
 * api/ כפונקציה נפרדת. הכתובת הציבורית תהיה: https://<דומיין-הפרויקט>/api/register
 *   GET  /api/register  -> מחזיר טופס HTML פשוט (ללא תלות חיצונית/CSS/JS
 *                          כבד - טופס אחד, נגיש, עובד גם ללא JavaScript),
 *                          כולל בחירת הפורום (radio buttons).
 *   POST /api/register  -> מקבל phone+system+username+password (JSON או
 *                          form), מנרמל את מספר הטלפון, ושומר אותו כ-key
 *                          ב-Redis תחת המפתח הספציפי לפורום שנבחר.
 *
 * אחסון: Upstash Redis REST API (לא דורש חבילת @upstash/redis - מספיק
 * HTTP client רגיל, בדיוק כמו axios שכבר משמש בפרויקט לקריאות לפורום).
 * משתני סביבה נדרשים (יש להגדיר ב-Vercel Project Settings -> Environment
 * Variables, ר' גם .env.example) - משותפים לכל הפורומים הנתמכים:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * מפתח האחסון: `mitmachim:phone:<system>:<מספר מנורמל>` -> JSON string עם
 * { username, password, updatedAt }. הנרמול (normalizePhone) הוא קריטי:
 * חייב להתאים בדיוק לפורמט שבו ימות המשיח מעביר את call.phone בהמשך
 * (ר' תיעוד מפורט ב-userStore.js וב-notificationsFlow בכל אחת מגרסאות
 * ה-IVR) - אחרת הזיהוי האוטומטי לפי מספר מתקשר ייכשל.
 *
 * אבטחה: הסיסמא לפורום נשמרת כפי שהיא (טקסט גלוי) ב-Redis, מכיוון שהיא
 * נדרשת בפועל כדי לבצע login אמיתי מול NodeBB בזמן השיחה (ר' loginAsUser
 * בכל אחת מגרסאות ה-IVR) - NodeBB עצמו לא חושף API להתחברות עם hash בלבד.
 * יש להסביר זאת למשתמשים בטופס (ר' ההודעה בעמוד עצמו) ולוודא ש-Redis
 * עצמו מאובטח (Upstash כברירת מחדל דורש טוקן+TLS).
 */

'use strict';

const express = require('express');
// נרמול מספר הטלפון ושמירת פרטי ההתחברות מוגדרים במודול משותף (userStore.js)
// כדי להבטיח שהנרמול זהה בדיוק לזה שמשמש בשלוחה 5 (api/yemot/index.js)
// בעת שליפת הפרטים לפי מספר המתקשר - ר' תיעוד מפורט ב-userStore.js.
const {
  normalizePhone,
  saveUserCredentials,
  subscribeToTzintuk,
  unsubscribeFromTzintuk
} = require('./userStore');

/** רשימת הפורומים הנתמכים: value = מזהה system (תואם ל-userStore.js
 *  ולפרמטר FORUM_SYSTEM_ID/'mitmachim' בכל אחת מגרסאות ה-IVR), label = שם
 *  תצוגה בעברית לטופס. הוספת פורום נתמך נוסף בעתיד דורשת רק הוספת ערך כאן
 *  ("system") ויצירת קובץ api/<תיקייה חדשה>/index.js מקביל. */
const SUPPORTED_SYSTEMS = [
  { value: 'mitmachim', label: 'מתמחים טופ (mitmachim.top)' },
  { value: 'freeivr', label: 'הגדרות מתקדמות - ימות המשיח (f2.freeivr.co.il)' },
  { value: 'otzaria', label: 'פורום אוצריא (otzaria.org/forum)' }
];

function isValidSystem(system) {
  return SUPPORTED_SYSTEMS.some((s) => s.value === system);
}

/** בורח (escape) HTML כדי למנוע XSS בהודעות שגיאה/הצלחה המוזרקות לטופס. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** בונה את עמוד ה-HTML של הטופס, עם הודעת סטטוס אופציונלית (הצלחה/שגיאה)
 *  ועם שימור הבחירה הקודמת של פורום/מספר טלפון/שם משתמש (כדי שהמשתמש לא
 *  יצטרך למלא הכל מחדש רק כי שכח שדה אחד וקיבל שגיאת ולידציה). */
function renderPage({ status, message, selectedSystem, phoneValue, usernameValue, tzintukChecked } = {}) {
  let banner = '';
  if (status === 'success') {
    banner = `<div class="banner success">${escapeHtml(message || 'הפרטים נשמרו בהצלחה!')}</div>`;
  } else if (status === 'error') {
    banner = `<div class="banner error">${escapeHtml(message || 'אירעה שגיאה, אנא נסו שוב.')}</div>`;
  }

  const currentSystem = isValidSystem(selectedSystem) ? selectedSystem : SUPPORTED_SYSTEMS[0].value;
  const systemOptionsHtml = SUPPORTED_SYSTEMS.map((s) => `
      <label class="radio-option">
        <input type="radio" name="system" value="${escapeHtml(s.value)}" ${s.value === currentSystem ? 'checked' : ''}>
        <span>${escapeHtml(s.label)}</span>
      </label>`).join('');

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>הרשמה להתראות קוליות - מתמחים טופ / freeivr / אוצריא</title>
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
  fieldset {
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 12px 14px 14px;
    margin: 0 0 18px;
  }
  legend {
    font-weight: 600;
    font-size: 14px;
    padding: 0 6px;
  }
  .radio-option {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 400;
    font-size: 14.5px;
    margin-bottom: 8px;
    cursor: pointer;
  }
  .radio-option:last-child { margin-bottom: 0; }
  .radio-option input[type="radio"] {
    width: 17px;
    height: 17px;
    margin: 0;
    flex-shrink: 0;
    cursor: pointer;
  }
  .checkbox-option {
    align-items: flex-start;
    margin: 0 0 18px;
    font-size: 14px;
    line-height: 1.4;
  }
  .checkbox-option input[type="checkbox"] {
    width: 17px;
    height: 17px;
    margin: 2px 0 0;
    flex-shrink: 0;
    cursor: pointer;
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
    <p class="subtitle">קשרו את מספר הפלאפון שלכם לחשבון שלכם באחד הפורומים, כדי שתוכלו לשמוע את ההתראות האישיות שלכם בשלוחה 5 בטלפון. ניתן להירשם למספר פורומים בנפרד (הגשה נפרדת לכל פורום).</p>
    ${banner}
    <form method="POST" action="/api/register">
      <fieldset>
        <legend>בחרו פורום</legend>
        ${systemOptionsHtml}
      </fieldset>

      <label for="phone">מספר פלאפון</label>
      <input type="tel" id="phone" name="phone" placeholder="05XXXXXXXX" value="${escapeHtml(phoneValue || '')}" required>

      <label for="username">שם משתמש בפורום</label>
      <input type="text" id="username" name="username" placeholder="שם המשתמש שלכם בפורום" value="${escapeHtml(usernameValue || '')}" required>

      <label for="password">סיסמא בפורום</label>
      <input type="password" id="password" name="password" placeholder="הסיסמא שלכם בפורום" required>

      <label class="radio-option checkbox-option">
        <input type="checkbox" id="tzintuk" name="tzintuk" ${tzintukChecked ? 'checked' : ''}>
        <span>קבל צינתוק טלפוני על התראה חדשה (שיחה קצרה שמצלצלת אליכם כשיש התראה חדשה בשלוחה 5)</span>
      </label>

      <button type="submit">שמירה</button>
    </form>
    <div class="note">
      הפרטים נשמרים אך ורק לצורך התחברות אוטומטית לפורום שנבחר בעת שיחה
      משלוחה 5, כדי להקריא לכם את ההתראות האישיות שלכם. ניתן לעדכן את
      הפרטים בכל עת על ידי מילוי הטופס מחדש (לכל פורום בנפרד).
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
  const { phone, system, username, password, tzintuk } = req.body || {};
  // תיבת סימון HTML: קיימת בגוף הבקשה (כל ערך, בד"כ 'on') רק אם המשתמש סימן
  // אותה - ולא קיימת כלל אם לא סומנה. לכן די בבדיקת אמיתות (truthy).
  const tzintukChecked = !!tzintuk;

  if (!phone || !system || !username || !password) {
    return res.status(400).send(renderPage({
      status: 'error',
      message: 'יש למלא את כל השדות: בחירת פורום, מספר פלאפון, שם משתמש וסיסמא.',
      selectedSystem: system,
      phoneValue: phone,
      usernameValue: username,
      tzintukChecked
    }));
  }

  if (!isValidSystem(system)) {
    return res.status(400).send(renderPage({
      status: 'error',
      message: 'הפורום שנבחר אינו תקין, אנא בחרו שוב.',
      phoneValue: phone,
      usernameValue: username,
      tzintukChecked
    }));
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 9) {
    return res.status(400).send(renderPage({
      status: 'error',
      message: 'מספר הפלאפון שהוזן אינו תקין, אנא בדקו ונסו שוב.',
      selectedSystem: system,
      usernameValue: username,
      tzintukChecked
    }));
  }

  const systemLabel = SUPPORTED_SYSTEMS.find((s) => s.value === system)?.label || system;

  try {
    await saveUserCredentials(phone, username, password, system);
  } catch (err) {
    console.error('[register] שגיאה בשמירת פרטי משתמש', err.message);
    return res.status(500).send(renderPage({
      status: 'error',
      message: 'אירעה שגיאה בשמירת הפרטים, אנא נסו שוב מאוחר יותר.',
      selectedSystem: system,
      phoneValue: phone,
      usernameValue: username,
      tzintukChecked
    }));
  }

  // עדכון ההרשמה לצינתוקים - כשל כאן לא אמור לבטל את שמירת פרטי ההתחברות
  // שכבר הצליחה למעלה, לכן מטופל בנפרד עם הודעת אזהרה בלבד (לא מוצג כשגיאה
  // חוסמת, כי הפעולה העיקרית של הטופס - שיוך הטלפון לפורום - כן הצליחה).
  let tzintukWarning = '';
  try {
    if (tzintukChecked) {
      await subscribeToTzintuk(phone, system);
    } else {
      await unsubscribeFromTzintuk(phone, system);
    }
  } catch (err) {
    console.error('[register] שגיאה בעדכון הרשמה לצינתוקים', err.message);
    tzintukWarning = ' (עדכון ההרשמה לצינתוקים נכשל, ניתן לשנות זאת בשלוחה 9 בטלפון)';
  }

  return res.status(200).send(renderPage({
    status: 'success',
    message: `הפרטים נשמרו בהצלחה עבור ${systemLabel}! כעת ניתן להתקשר ולהיכנס לשלוחה 5 לשמיעת ההתראות שלכם.${tzintukWarning}`,
    selectedSystem: system,
    phoneValue: phone,
    usernameValue: username,
    tzintukChecked
  }));
});

if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`דף הרשמה פועל על פורט ${port}`));
}

module.exports = app;
