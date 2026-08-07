/**
 * מערכת IVR - פורום "בינה טופ" (bina.top)
 * ================================
 * מערכת טלפונית מלאה לגלישה בפורום bina.top (מבוסס NodeBB, אותה תשתית
 * פורום בדיוק כמו mitmachim.top/f2.freeivr.co.il/otzaria.org/good-link.org)
 * דרך מערכת "ימות המשיח", מבוססת על ספריית yemot-router2 (מודול API הרשמי).
 *
 * קובץ זה הוא עותק מותאם (מבחינת דומיין ומזהה מערכת בלבד) של
 * api/goodlink/index.js (גרסת פורום גוד לינק) - ר' תיעוד מפורט יותר שם;
 * כל הלוגיקה, זרימות הניווט וההערות הטכניות זהות במהותן, למעט ההבדלים
 * המצוינים כאן.
 *
 * ארכיטקטורה: קובץ יחיד (index.js) + package.json משותף לכל הפרויקט.
 * מיועד לפריסה כ-Serverless Function ב-Vercel, כפונקציה נפרדת תחת
 * api/binatop/index.js (בדיוק כמו api/yemot, api/freeivr, api/otzaria,
 * api/goodlink) - כדי שיהיה אפשר להצביע אליו מהגדרות שלוחה שונה בממשק
 * הניהול של ימות המשיח, ללא שום התנגשות בין המערכות (לא ב-session, לא
 * בקבצי הקלטה, ולא בשלוחות).
 * דומיין הפרויקט (משותף): https://mitmachim-ivr.vercel.app
 * הכתובת הספציפית לשלוחה זו: https://mitmachim-ivr.vercel.app/api/binatop
 *
 * מבנה הקובץ (מודולרי פנימית, למרות שהוא קובץ אחד):
 *   1. תשתית: קבועים, HTTP client לפורום (ללא cache - כל קריאה מביאה מידע עדכני)
 *   2. שכבת נתונים: פונקציות שמביאות מידע מ-NodeBB API (עם retry, בלי cache)
 *   3. שכבת הקראה: המרת תוכן פורום למבני message של ימות (טיפול בתאריכים, מחברים וכו')
 *   4. עזרי ניווט משותפים
 *   5. שכבת ניווט: תפריטים (ראשי, פוסטים אחרונים, נושאים אחרונים, קטגוריות
 *      ותתי-קטגוריות רקורסיבית, אשכול/הודעות, עזרה)
 *   6. הרכבת הראוטר וייצוא ל-Vercel
 *
 * תפריט ראשי נוכחי: 1=פוסטים אחרונים, 2=נושאים אחרונים, 3=קטגוריות,
 * 4=חיפוש קולי (הקלטה -> תמלול -> חיפוש בפורום, ר' voiceSearchFlow),
 * 5=התראות אישיות (זיהוי לפי מספר הטלפון המתקשר, ר' notificationsFlow
 * ו-api/userStore.js + api/register.js - הערך שנבחר שם הוא "binatop"),
 * 6=עזרה, 9=הגדרות אישיות (כרגע: הרשמה/הסרה מצינתוקים על התראות חדשות -
 * ר' settingsFlow/tzintukSettingsFlow ו-api/tzintukSender.js +
 * api/cron/check-notifications.js).
 * שלוחות 0/8 (חזרה למיקום אחרון, מנהל) הוסרו במלואן מהקוד, כולל שמירת מיקום
 * ב-Vercel Blob וה-cache בזיכרון.
 *
 * הערה חשובה על אימות (session): פורום בינה טופ הוא פורום עצמאי עם חשבונות
 * משלו - ולכן מודול זה משתמש *באותם* משתני סביבה כמו api/yemot/index.js
 * (SERVICE_USERNAME/SERVICE_PASSWORD) - כי לפי הדפוס הקיים בפרויקט, פורומים
 * שמשתמשים באותו חשבון שירות (כמו גוד לינק ומתמחים טופ) חולקים את אותם
 * משתני סביבה. אם בפועל נדרשים פרטי התחברות נפרדים לפורום בינה טופ, יש
 * להוסיף BINATOP_SERVICE_USERNAME / BINATOP_SERVICE_PASSWORD בדיוק כפי שנעשה
 * ב-api/freeivr (ר' הערת FREEIVR_SERVICE_USERNAME שם), ולשנות את
 * loginServiceAccount בהתאם.
 * משתני הסביבה הקשורים להתראות/לאתר ההרשמה (UPSTASH/CRON/QSTASH) משותפים
 * לכל הפורומים ואינם דורשים הוספה כלשהי.
 *
 * הערה: מוזיקת רקע (music_on_hold) אינה מנוהלת בקוד זה בכלל -
 * היא מוגדרת ומופעלת ברמת השלוחה בממשק ניהול ימות המשיח בלבד.
 */

'use strict';

const express = require('express');
const { YemotRouter, ExitError } = require('yemot-router2');
const axios = require('axios');
// שלוחה 5 (התראות אישיות): שליפת שיוך מספר-טלפון -> פרטי התחברות בפורום,
// שנשמר מראש דרך אתר ההרשמה (api/register.js). ר' תיעוד מפורט ב-userStore.js
// ובפונקציה notificationsFlow למטה.
const {
  getUserCredentials,
  subscribeToTzintuk,
  unsubscribeFromTzintuk,
  getTzintukSubscription
} = require('../userStore');

/* ============================================================
 * 1. תשתית כללית
 * ============================================================ */

// זהות המערכת (system) לשימוש מול userStore.js - מבדילה בין רשומות פורום
// בינה טופ לבין רשומות שאר הפורומים הנתמכים באותו מספר טלפון (ר' תיעוד
// מפורט ב-userStore.js / getUserCredentials).
const FORUM_SYSTEM_ID = 'binatop';
// פורום בינה טופ בשורש הדומיין שלו (כמו mitmachim.top ו-good-link.org) -
// לכן FORUM_BASE הוא כתובת הדומיין בלבד, ללא תת-נתיב נוסף.
const FORUM_BASE = 'https://bina.top';
// כתובת השרת עצמו: ב-Vercel, VERCEL_URL מכיל את הדומיין האמיתי של הפריסה
// הנוכחית (כולל פריסות preview, שיש להן דומיין ייחודי לכל פריסה) - אם לא
// נשתמש בו ונשתמש בכתובת ה-production הקבועה בלבד, קריאה עצמית לשירות
// התמלול (transcribeRecording) תיכשל בפריסות preview עם 404, כי הן רצות
// תחת דומיין אחר לגמרי. SERVER_BASE הקבוע משמש רק כברירת מחדל למקומי.
const SERVER_BASE = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://mitmachim-ivr.vercel.app';
// שרת הניהול של ימות המשיח - דרכו מורידים קבצי הקלטה שנשמרו ע"י type='record'
// (ר' תיעוד ליד downloadRecording/voiceSearchFlow). לא קשור לפורום bina.top.
const YEMOT_MANAGEMENT_BASE = 'https://www.call2all.co.il/ym/api';

// הגדרות HTTP client לפורום - keep-alive + timeout סביר + compression
const http = axios.create({
  baseURL: FORUM_BASE,
  timeout: 8000,
  headers: {
    'User-Agent': 'MitmachimIVR-BinaTop/1.0 (+https://mitmachim-ivr.vercel.app)',
    'Accept-Encoding': 'gzip, deflate, br'
  }
});

/**
 * עוטף כל קריאת רשת בניסיון חוזר יחיד לפני כישלון סופי (יציבות מול תקלות זמניות).
 * הערה: אין כאן שכבת cache - בכוונה. כל כניסה לשלוחה חייבת להביא את הנתונים
 * העדכניים ביותר מהפורום ברגע הכניסה, ללא צורך ברענון ידני וללא סיכון להצגת
 * מידע ישן (נושאים אחרונים, תוכן קטגוריה וכו').
 * @param {Function} fn - פונקציה אסינכרונית לביצוע
 * @param {number} retries - כמות ניסיונות נוספים
 */
async function withRetry(fn, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * ניהול session של "משתמש שירות" קבוע בפורום, לצורך קריאה ל-API-ים שדורשים
 * חיבור (כגון /api/search - חיפוש חסום לאורחים ב-NodeBB כברירת מחדל, ראו הערה
 * ליד fetchNewestTopics). ה-session מוחזק בזיכרון התהליך (module-level state):
 *   1. GET /api/config -> csrf_token + עוגיית express.sid ראשונית.
 *   2. POST /login עם username/password/_csrf -> עוגיית session מחוברת.
 * העוגייה נשמרת ומצורפת ידנית לכל בקשה מוגנת (Cookie header), ומתבצע login
 * מחדש אוטומטי אם מתקבל 401 (session פג/לא תקין) - כדי שלא יידרש רענון ידני.
 * הרשאות: SERVICE_USERNAME + SERVICE_PASSWORD במשתני הסביבה (ראו .env.example).
 * אם לא הוגדרו, שלוחות שדורשות session (שלוחה 2) יחזירו הודעת שגיאה ברורה.
 */
let sessionCookie = null;
let sessionLoginPromise = null;

async function loginServiceAccount() {
  const username = process.env.SERVICE_USERNAME;
  const password = process.env.SERVICE_PASSWORD;
  if (!username || !password) {
    throw new Error('SERVICE_USERNAME/SERVICE_PASSWORD לא מוגדרים בסביבה - לא ניתן להתחבר לפורום');
  }

  const configRes = await http.get('/api/config', {
    headers: sessionCookie ? { Cookie: sessionCookie } : {}
  });
  const csrfToken = configRes.data?.csrf_token;
  const initialCookie = extractCookie(configRes.headers['set-cookie']);
  if (!csrfToken) throw new Error('לא התקבל csrf_token מ-/api/config');

  const loginRes = await http.post('/login', { username, password }, {
    headers: {
      'x-csrf-token': csrfToken,
      Cookie: initialCookie || (sessionCookie || ''),
      'Content-Type': 'application/json'
    },
    validateStatus: (s) => s < 500
  });

  if (loginRes.status >= 400) {
    throw new Error(`התחברות משתמש שירות נכשלה (סטטוס ${loginRes.status})`);
  }

  const loginCookie = extractCookie(loginRes.headers['set-cookie']);
  sessionCookie = loginCookie || initialCookie;
  if (!sessionCookie) throw new Error('לא התקבלה עוגיית session אחרי התחברות');
  console.log('[AUTH] התחברות משתמש שירות הצליחה (binatop)');
  return sessionCookie;
}

/** מבטיח שיש session תקף (מתחבר אם עוד אין), תוך מניעת התחברויות מקבילות כפולות. */
async function ensureSession() {
  if (sessionCookie) return sessionCookie;
  if (!sessionLoginPromise) {
    sessionLoginPromise = loginServiceAccount().finally(() => { sessionLoginPromise = null; });
  }
  return sessionLoginPromise;
}

/** שולף רק את זוג ה-key=value של express.sid (מתעלם מ-Path/HttpOnly/וכו') מתוך
 *  מערך כותרות set-cookie, כדי לשלוח Cookie header תקין בבקשות הבאות. */
function extractCookie(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const parts = arr.map((c) => c.split(';')[0].trim()).filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

/**
 * מבצע קריאת GET מאומתת (עם session של משתמש השירות) אל נתיב מוגן בפורום.
 * מתחבר אוטומטית אם אין session עדיין, ומתחבר מחדש פעם אחת אם מתקבל 401
 * (למשל session שפג) - כדי שלא יידרש רענון ידני אף פעם.
 */
async function authenticatedGet(path, params) {
  await ensureSession();
  try {
    const res = await http.get(path, { params, headers: { Cookie: sessionCookie } });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('[AUTH] session פג תוקף, מתחבר מחדש (binatop)');
      sessionCookie = null;
      await ensureSession();
      const res = await http.get(path, { params, headers: { Cookie: sessionCookie } });
      return res.data;
    }
    throw err;
  }
}

/**
 * מתחבר לפורום כ-*משתמש קצה ספציפי* (לא משתמש השירות הקבוע) לצורך שלוחה 5
 * (התראות אישיות). זהו session נפרד לגמרי מ-sessionCookie/loginServiceAccount
 * למעלה: אסור בשום אופן לערבב בין השניים או לשמור את עוגיית המשתמש הקצה
 * ב-sessionCookie המשותף - זה ישבש את משתמש השירות עבור כל שיחה אחרת שרצה
 * באותו זמן על אותו תהליך Vercel.
 * מחזיר את ה-Cookie header (string) לשימוש בקריאות הבאות מול הפורום.
 */
async function loginAsUser(username, password) {
  const configRes = await http.get('/api/config');
  const csrfToken = configRes.data?.csrf_token;
  const initialCookie = extractCookie(configRes.headers['set-cookie']);
  if (!csrfToken) throw new Error('לא התקבל csrf_token מ-/api/config');

  const loginRes = await http.post('/login', { username, password }, {
    headers: {
      'x-csrf-token': csrfToken,
      Cookie: initialCookie || '',
      'Content-Type': 'application/json'
    },
    validateStatus: (s) => s < 500
  });

  if (loginRes.status >= 400) {
    throw new Error(`התחברות המשתמש לפורום נכשלה (סטטוס ${loginRes.status}) - יתכן ששם המשתמש או הסיסמא שהוזנו בהרשמה שגויים`);
  }

  const loginCookie = extractCookie(loginRes.headers['set-cookie']);
  const userCookie = loginCookie || initialCookie;
  if (!userCookie) throw new Error('לא התקבלה עוגיית session אחרי התחברות המשתמש');
  return userCookie;
}

/** שולף את רשימת ההתראות (notifications) האישיות של המשתמש המחובר. */
async function fetchUserNotifications(userCookie) {
  return withRetry(async () => {
    const { data } = await http.get('/api/notifications', { headers: { Cookie: userCookie } });
    return data;
  }, 1);
}

/* ============================================================
 * 2. שכבת נתונים - NodeBB REST API (bina.top)
 * NodeBB חושף כל דף כ-JSON על ידי הוספת api/ בתחילת הנתיב.
 * לדוגמה: bina.top/recent -> bina.top/api/recent
 * ============================================================ */

/** פוסטים/נושאים אחרונים בפורום (ממוין לפי זמן פעילות אחרונה/תגובה אחרונה) -
 *  נשלף מחדש בכל קריאה, ללא cache. נתיב ציבורי - אינו דורש session. */
async function fetchRecentTopics(page = 1) {
  return withRetry(async () => {
    const { data } = await http.get('/api/recent', { params: { page } });
    return data;
  }, 1);
}

/** נושאים (אשכולות) חדשים, ממוינים לפי זמן *יצירת האשכול* (topic.timestamp).
 *  הערה קריטית: /api/search ב-NodeBB חסום לאורחים - לכן נעשה שימוש
 *  ב-authenticatedGet (משתמש שירות). */
async function fetchNewestTopics(page = 1) {
  return withRetry(() => authenticatedGet('/api/search', {
    in: 'titles',
    term: '',
    matchWords: 'all',
    by: '',
    categories: '',
    searchChildren: 'false',
    hasTags: '',
    replies: '',
    repliesFilter: 'atleast',
    timeFilter: 'newer',
    timeRange: '',
    sortBy: 'topic.timestamp',
    sortDirection: 'desc',
    showAs: 'topics',
    page
  }), 1);
}

/** ממיר תגובת /api/search לרשימת אובייקטי topic שטוחה. */
function parseNewestTopicsResponse(data) {
  const posts = data.posts || data.topics || [];
  return posts
    .map((p) => {
      if (p.title || p.titleRaw) return p;
      if (!p.topic) return null;
      return { ...p.topic, user: p.topic.user || p.user };
    })
    .filter(Boolean);
}

/** חיפוש חופשי בפורום לפי טקסט (term) - משמש בשלוחה 4 (חיפוש קולי). */
async function fetchSearchResults(term, page = 1) {
  return withRetry(() => authenticatedGet('/api/search', {
    in: 'titlesposts',
    term,
    matchWords: 'all',
    by: '',
    categories: '',
    searchChildren: 'false',
    hasTags: '',
    replies: '',
    repliesFilter: 'atleast',
    timeFilter: '',
    timeRange: '',
    sortBy: '',
    sortDirection: 'desc',
    showAs: 'topics',
    page
  }), 1);
}

/** רשימת כל הקטגוריות בפורום, כולל תתי-קטגוריות. */
async function fetchCategories() {
  return withRetry(async () => {
    const { data } = await http.get('/api/categories');
    return data;
  }, 1);
}

/** משטח עץ קטגוריות לרשימה שטוחה, לשימוש בתפריט הקולי. */
function flattenCategoryTree(categories, depth = 0) {
  const out = [];
  for (const cat of categories || []) {
    if (cat.disabled) continue;
    out.push({ ...cat, _depth: depth });
    if (Array.isArray(cat.children) && cat.children.length > 0) {
      out.push(...flattenCategoryTree(cat.children, depth + 1));
    }
  }
  return out;
}

/** נושאים (אשכולות) בתוך קטגוריה מסוימת. */
async function fetchCategoryTopics(cid, slug, page = 1) {
  return withRetry(async () => {
    const path = slug ? `/api/category/${slug}` : `/api/category/${cid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  }, 1);
}

/** תוכן אשכול (topic) שלם, כולל כל ההודעות (posts). */
async function fetchTopic(tid, slug, page = 1) {
  return withRetry(async () => {
    const path = slug ? `/api/topic/${slug}` : `/api/topic/${tid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  }, 1);
}

/* ============================================================
 * 2ב. תמלול קול - הורדת הקלטה ממערכת ימות ושליחתה לתמלול (Python)
 * ============================================================ */

const DOWNLOAD_RECORDING_RETRIES = 3;
const DOWNLOAD_RECORDING_RETRY_DELAY_MS = 400;

async function downloadRecording(recordingPath) {
  const token = process.env.YEMOT_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error('YEMOT_MANAGEMENT_TOKEN לא מוגדר בסביבה - לא ניתן להוריד הקלטות');
  }
  let lastErr;
  for (let attempt = 0; attempt <= DOWNLOAD_RECORDING_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/DownloadFile`, {
        params: { token, path: recordingPath, _cb: Date.now() },
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
      });
      return Buffer.from(data);
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 404 && attempt < DOWNLOAD_RECORDING_RETRIES) {
        await new Promise((r) => setTimeout(r, DOWNLOAD_RECORDING_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  if (lastErr?.response?.status === 404) {
    throw new Error(`קובץ ההקלטה לא נמצא בנתיב ${recordingPath} לאחר ${DOWNLOAD_RECORDING_RETRIES + 1} ניסיונות`);
  }
  throw lastErr;
}

async function transcribeRecording(wavBuffer) {
  const bypassSecret = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
  const { data } = await axios.post(`${SERVER_BASE}/api/transcribe`, wavBuffer, {
    headers: {
      'Content-Type': 'audio/wav',
      ...(bypassSecret ? { 'x-vercel-protection-bypass': bypassSecret } : {})
    },
    timeout: 20000,
    maxBodyLength: 20 * 1024 * 1024
  });
  if (!data || typeof data.text !== 'string') {
    throw new Error('תגובת שירות התמלול לא תקינה');
  }
  return data.text.trim();
}

/* ============================================================
 * 3. שכבת הקראה - הפיכת תוכן טקסטואלי מהפורום למבני message של ימות
 * ============================================================ */

/** מסיר תגי HTML, קישורים גולמיים ותווים בעייתיים מטקסט המיועד להקראה. */
function sanitizeForSpeech(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, 'קישור')
    .replace(/@[\w.\-א-ת]+/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, 'ו')
    .replace(/[#*_`~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 1200) text = text.slice(0, 1200) + '... הטקסט המלא ארוך מכדי להיקרא במלואו';
  return text;
}

/** בונה מערך messages להקראת כותרת פוסט/נושא כולל מטא-דאטה. */
function buildTopicHeaderMessages(topic) {
  const authorName = topic.user?.displayname || topic.user?.username || 'אנונימי';
  const date = new Date(topic.timestamp || topic.lastposttime || Date.now());
  const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  const replies = topic.postcount != null ? topic.postcount - 1 : 0;

  const messages = [
    { type: 'text', data: sanitizeForSpeech(topic.title || topic.titleRaw || 'ללא כותרת'), removeInvalidChars: true }
  ];
  messages.push({ type: 'text', data: `מאת ${sanitizeForSpeech(authorName)}`, removeInvalidChars: true });
  messages.push({ type: 'date', data: dateStr });
  if (replies > 0) {
    messages.push({ type: 'text', data: `${replies} תגובות`, removeInvalidChars: true });
  }
  return messages;
}

/** מביא את ההודעה האחרונה האמיתית באשכול (topic), ישירות מ-API. */
async function fetchLastPost(tid, slug, postcount) {
  const firstPageData = await fetchTopic(tid, slug, 1);
  const realPageCount = firstPageData.pagination?.pageCount || 1;

  let posts = firstPageData.posts || [];
  if (realPageCount > 1) {
    const lastPageData = await fetchTopic(tid, slug, realPageCount);
    if (lastPageData.posts && lastPageData.posts.length > 0) {
      posts = lastPageData.posts;
    }
  }

  return posts.length > 0 ? posts[posts.length - 1] : null;
}

/** בונה מערך messages להקראת ה-teaser (ההודעה האחרונה האמיתית) של נושא. */
async function buildTeaserMessages(topic, index, total) {
  let lastPost = null;
  try {
    lastPost = await fetchLastPost(topic.tid, topic.slug || '', topic.postcount);
  } catch (err) {
    console.error('[buildTeaserMessages] שגיאה בשליפת ההודעה האחרונה', topic.tid, err.message);
  }

  const authorName = lastPost?.user?.displayname || lastPost?.user?.username || 'אנונימי';
  const date = new Date(lastPost?.timestamp || topic.lastposttime || Date.now());
  const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  const content = sanitizeForSpeech(lastPost?.content);

  return [
    { type: 'text', data: `פריט ${index + 1} מתוך ${total}`, removeInvalidChars: true },
    { type: 'text', data: `בנושא: ${sanitizeForSpeech(topic.title || 'ללא כותרת')}`, removeInvalidChars: true },
    { type: 'text', data: `מאת ${sanitizeForSpeech(authorName)}`, removeInvalidChars: true },
    { type: 'date', data: dateStr },
    { type: 'text', data: content || 'הודעה ללא תוכן טקסטואלי', removeInvalidChars: true }
  ];
}

function buildPostMessages(post, index, total) {
  const authorName = post.user?.displayname || post.user?.username || 'אנונימי';
  const date = new Date(post.timestamp || Date.now());
  const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  const content = sanitizeForSpeech(post.content);

  return [
    { type: 'text', data: `הודעה ${index + 1} מתוך ${total}`, removeInvalidChars: true },
    { type: 'text', data: `מאת ${sanitizeForSpeech(authorName)}`, removeInvalidChars: true },
    { type: 'date', data: dateStr },
    { type: 'text', data: content || 'הודעה ללא תוכן טקסטואלי', removeInvalidChars: true }
  ];
}

/** בונה מערך messages להקראת התראה אישית בודדת מ-/api/notifications. */
function buildNotificationMessages(notif, index, total) {
  const rawText = notif.bodyShort || notif.bodyLong || notif.subject
    || `התראה מאת ${notif.user?.displayname || notif.user?.username || 'הפורום'}`;
  const text = sanitizeForSpeech(rawText);
  const date = new Date(notif.datetimeISO || notif.datetime || Date.now());
  const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  const readLabel = notif.read ? 'נקראה' : 'חדשה';

  return [
    { type: 'text', data: `התראה ${index + 1} מתוך ${total} - ${readLabel}`, removeInvalidChars: true },
    { type: 'date', data: dateStr },
    { type: 'text', data: text || 'התראה ללא תוכן טקסטואלי', removeInvalidChars: true }
  ];
}

/* ============================================================
 * 4. עזרי ניווט משותפים
 *
 * הערה קריטית: יש לנו שלוחת API אחת בלבד בימות המשיח.
 * לכן אסור להשתמש ב-call.go_to_folder('/xxx') לניווט פנימי - זו
 * פקודה שאומרת לימות "עבור לשלוחה פיזית /xxx" והיא תיכשל עם השגיאה
 * "השלוחה אינה קיימת" כי שלוחה כזו לא קיימת בממשק הניהול.
 * כל הניווט חייב לקרות בתוך הקוד עצמו, כקריאות פונקציה רגילות.
 * ============================================================ */

const NAV_HINT = 'הקישו 9 להבא, 7 לקודם, 0 לחזרה, כוכבית לתפריט הראשי';

function navHintMessage() {
  return { type: 'text', data: NAV_HINT, removeInvalidChars: true };
}

/** אפשרויות read סטנדרטיות לתפריטי הקשה (תפריט עם ספרה בודדת). */
const MENU_READ_OPTS = {
  max_digits: 2,
  min_digits: 1,
  sec_wait: 7,
  allow_empty: false,
  block_asterisk_key: false,
  block_zero_key: false
};

/** נזרק ע"י מסך פנימי כדי לאותת "חזור לתפריט הראשי" למרכז השיחה (main loop). */
class GoToMainMenu extends Error {}

/* ============================================================
 * 5. הראוטר הראשי - שלוחת API יחידה, כל הניווט קורה בתוך הקוד
 * ============================================================ */

const router = YemotRouter({
  printLog: process.env.NODE_ENV !== 'production',
  timeout: 25000,
  uncaughtErrorHandler: async (call, error) => {
    console.error('שגיאה לא מטופלת בשיחה', call.callId, error);
    try {
      await call.id_list_message([
        { type: 'text', data: 'אירעה תקלה זמנית במערכת. אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
      ]);
    } catch (_) { /* השיחה כבר בתהליך סגירה */ }
  }
});

/* ---------- שלוחה 1: פוסטים אחרונים ---------- */

async function recentPostsFlow(call, page) {
  let data;
  try {
    data = await fetchRecentTopics(page);
  } catch (err) {
    console.error('[recentPostsFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע פוסטים אחרונים, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = data.topics || [];
  if (topics.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצאו פוסטים בעת הזו', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  await browseTopicList(call, topics, {
    buildMessages: (t, i, total) => buildTeaserMessages(t, i, total),
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => recentPostsFlow(call, page + 1),
    onPrevPage: page > 1 ? () => recentPostsFlow(call, page - 1) : null,
    context: `recentposts:${page}`
  });
}

/* ---------- שלוחה 2: נושאים אחרונים ---------- */

async function recentTopicsFlow(call, page) {
  let data;
  try {
    data = await fetchNewestTopics(page);
  } catch (err) {
    console.error('[recentTopicsFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע נושאים אחרונים, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = parseNewestTopicsResponse(data);

  if (topics.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצאו נושאים בעת הזו', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => recentTopicsFlow(call, page + 1),
    onPrevPage: page > 1 ? () => recentTopicsFlow(call, page - 1) : null,
    context: `recenttopics:${page}`
  });
}

/* ---------- שלוחה 5: התראות אישיות ---------- */

async function notificationsFlow(call) {
  let creds;
  try {
    creds = await getUserCredentials(call.phone, FORUM_SYSTEM_ID);
  } catch (err) {
    console.error('[notificationsFlow] שגיאה בשליפת פרטי משתמש', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שירות ההתראות אינו זמין כרגע, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  if (!creds) {
    return call.id_list_message([
      { type: 'text', data: 'מספר הטלפון שלכם אינו רשום לשירות ההתראות', removeInvalidChars: true },
      { type: 'text', data: 'כדי להירשם, אנא היכנסו לאתר ההרשמה ומלאו את הפרטים שלכם בפורום', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let userCookie;
  try {
    userCookie = await loginAsUser(creds.username, creds.password);
  } catch (err) {
    console.error('[notificationsFlow] שגיאת התחברות למשתמש', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן היה להתחבר לחשבון שלכם בפורום, אנא ודאו שהפרטים שהזנתם באתר ההרשמה נכונים', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let data;
  try {
    data = await fetchUserNotifications(userCookie);
  } catch (err) {
    console.error('[notificationsFlow] שגיאה בשליפת התראות', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע את ההתראות שלכם, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const notifications = data?.notifications || [];

  try {
    const sub = await getTzintukSubscription(call.phone, FORUM_SYSTEM_ID);
    if (sub?.enabled) {
      const sinceTime = new Date(sub.since).getTime();
      const newCount = notifications.filter((n) => {
        const t = new Date(n.datetimeISO || n.datetime || 0).getTime();
        return !isNaN(t) && t > sinceTime;
      }).length;
      if (newCount > 0) {
        await call.id_list_message([
          { type: 'text', data: `יש לך`, removeInvalidChars: true },
          { type: 'number', data: String(newCount) },
          { type: 'text', data: 'התראות חדשות בשלוחה 5', removeInvalidChars: true }
        ], { prependToNextAction: true });
      }
    }
  } catch (err) {
    console.error('[notificationsFlow] שגיאה בבדיקת מונה התראות חדשות', err.message);
  }

  if (notifications.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'אין לכם כרגע התראות חדשות בפורום', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let i = 0;
  while (i < notifications.length) {
    const notif = notifications[i];
    const messages = [
      ...buildNotificationMessages(notif, i, notifications.length),
      navHintMessage()
    ];

    const key = await call.read(messages, 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '9' });

    if (key === '9' || key === '1' || key === '') { i++; continue; }
    if (key === '7') { i = Math.max(0, i - 1); continue; }
    if (key === '0' || key === '*') throw new GoToMainMenu();
    i++;
  }

  const endKey = await call.read([
    { type: 'text', data: 'הגעתם לסוף רשימת ההתראות', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה להתחלת הרשימה הקישו 7, לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '*' });

  if (endKey === '7') return notificationsFlow(call);
  throw new GoToMainMenu();
}

/* ---------- שלוחה 9: הגדרות אישיות ---------- */

async function settingsFlow(call) {
  const choice = await call.read([
    { type: 'text', data: 'הגדרות אישיות', removeInvalidChars: true },
    { type: 'text', data: 'להרשמה או הסרה מצינתוקים על התראות חדשות הקישו 1', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (choice === '1') return tzintukSettingsFlow(call);
  throw new GoToMainMenu();
}

async function tzintukSettingsFlow(call) {
  let creds;
  try {
    creds = await getUserCredentials(call.phone, FORUM_SYSTEM_ID);
  } catch (err) {
    console.error('[tzintukSettingsFlow] שגיאה בשליפת פרטי משתמש', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שירות ההגדרות אינו זמין כרגע, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  if (!creds) {
    return call.id_list_message([
      { type: 'text', data: 'מספר הטלפון שלכם אינו רשום עדיין לפורום', removeInvalidChars: true },
      { type: 'text', data: 'כדי להירשם, אנא היכנסו לאתר ההרשמה ומלאו את הפרטים שלכם בפורום', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let sub;
  try {
    sub = await getTzintukSubscription(call.phone, FORUM_SYSTEM_ID);
  } catch (err) {
    console.error('[tzintukSettingsFlow] שגיאה בשליפת מצב הרשמה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שירות ההגדרות אינו זמין כרגע, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const isSubscribed = !!sub?.enabled;

  const choice = await call.read([
    { type: 'text', data: isSubscribed ? 'אתם רשומים כרגע לצינתוקים על התראות חדשות' : 'אינכם רשומים כרגע לצינתוקים על התראות חדשות', removeInvalidChars: true },
    { type: 'text', data: isSubscribed ? 'להסרה מצינתוקים הקישו 1' : 'להרשמה לצינתוקים הקישו 1', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (choice !== '1') throw new GoToMainMenu();

  try {
    if (isSubscribed) {
      await unsubscribeFromTzintuk(call.phone, FORUM_SYSTEM_ID);
      await call.id_list_message([
        { type: 'text', data: 'הוסרתם בהצלחה מצינתוקים על התראות חדשות', removeInvalidChars: true }
      ], { prependToNextAction: true });
    } else {
      await subscribeToTzintuk(call.phone, FORUM_SYSTEM_ID);
      await call.id_list_message([
        { type: 'text', data: 'נרשמתם בהצלחה לצינתוקים על התראות חדשות', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }
  } catch (err) {
    console.error('[tzintukSettingsFlow] שגיאה בעדכון הרשמה לצינתוקים', err.message);
    return call.id_list_message([
      { type: 'text', data: 'אירעה שגיאה בעדכון ההרשמה, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  throw new GoToMainMenu();
}

/* ---------- שלוחה 4: חיפוש קולי ---------- */

const VOICE_SEARCH_EXTENSION_NUMBER = '8';
const VOICE_SEARCH_EXTENSION_TITLE = 'VoiceSearchRecordings';
const VOICE_SEARCH_RECORD_PATH = `/${VOICE_SEARCH_EXTENSION_NUMBER}`;
const VOICE_SEARCH_MGMT_PATH = `ivr2:/${VOICE_SEARCH_EXTENSION_NUMBER}`;

let recordingFolderEnsured = false;

async function ensureRecordingFolder() {
  if (recordingFolderEnsured) return;
  const token = process.env.YEMOT_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error('YEMOT_MANAGEMENT_TOKEN לא מוגדר בסביבה - לא ניתן לוודא תיקיית הקלטות');
  }

  const { data: checkData } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/CheckIfFolderExists`, {
    params: { token, path: VOICE_SEARCH_MGMT_PATH },
    timeout: 10000
  });

  if (checkData?.folderExists) {
    recordingFolderEnsured = true;
    return;
  }

  console.log(`[voiceSearch] תת-שלוחת ההקלטות ${VOICE_SEARCH_MGMT_PATH} אינה קיימת, יוצר אוטומטית`);
  const { data: updateData } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/UpdateExtension`, {
    params: {
      token,
      path: VOICE_SEARCH_MGMT_PATH,
      type: 'playfile',
      title: VOICE_SEARCH_EXTENSION_TITLE
    },
    timeout: 10000
  });

  if (updateData?.responseStatus && updateData.responseStatus !== 'OK') {
    throw new Error(`יצירת תת-שלוחת ההקלטות ${VOICE_SEARCH_MGMT_PATH} נכשלה: ${updateData.message || JSON.stringify(updateData)}`);
  }

  const { data: verifyData } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/CheckIfFolderExists`, {
    params: { token, path: VOICE_SEARCH_MGMT_PATH },
    timeout: 10000
  });
  if (!verifyData?.folderExists) {
    throw new Error(`תת-שלוחת ההקלטות ${VOICE_SEARCH_MGMT_PATH} עדיין לא קיימת לאחר ניסיון היצירה`);
  }
  recordingFolderEnsured = true;
}

async function voiceSearchFlow(call) {
  try {
    await ensureRecordingFolder();
  } catch (err) {
    console.error('[voiceSearchFlow] שגיאה בוידוא תיקיית הקלטות', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שירות החיפוש הקולי אינו זמין כרגע, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const recordResult = await call.read([
    { type: 'text', data: 'חיפוש קולי בפורום', removeInvalidChars: true },
    { type: 'text', data: 'אנא אמרו את מה שתרצו לחפש לאחר הצליל, ובסיום הקישו סולמית', removeInvalidChars: true }
  ], 'record', {
    path: VOICE_SEARCH_RECORD_PATH,
    no_confirm_menu: true,
    min_length: 1,
    max_length: 20
  });

  let queryText;
  try {
    if (!recordResult || typeof recordResult !== 'string') {
      throw new Error(`call.read('record') לא החזיר נתיב קובץ תקין (קיבלנו: ${JSON.stringify(recordResult)})`);
    }
    const normalizedRelativePath = recordResult.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    const recordingPath = `ivr2:/${normalizedRelativePath}`;
    const wavBuffer = await downloadRecording(recordingPath);
    queryText = await transcribeRecording(wavBuffer);
  } catch (err) {
    console.error('[voiceSearchFlow] שגיאת תמלול', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן היה לתמלל את ההקלטה כרגע, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  if (!queryText) {
    return call.id_list_message([
      { type: 'text', data: 'לא זוהה דיבור בהקלטה, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let data;
  try {
    data = await fetchSearchResults(queryText, 1);
  } catch (err) {
    console.error('[voiceSearchFlow] שגיאת חיפוש', err.message);
    return call.id_list_message([
      { type: 'text', data: 'החיפוש נכשל כרגע, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = parseNewestTopicsResponse(data);

  if (topics.length === 0) {
    return call.id_list_message([
      { type: 'text', data: `לא נמצאו תוצאות עבור: ${sanitizeForSpeech(queryText)}`, removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  await call.id_list_message([
    { type: 'text', data: `נמצאו ${topics.length} תוצאות עבור: ${sanitizeForSpeech(queryText)}`, removeInvalidChars: true }
  ], { prependToNextAction: true });

  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => voiceSearchResultsPage(call, queryText, 2),
    onPrevPage: null,
    context: `voicesearch:${queryText}:1`
  });
}

async function voiceSearchResultsPage(call, queryText, page) {
  let data;
  try {
    data = await fetchSearchResults(queryText, page);
  } catch (err) {
    console.error('[voiceSearchResultsPage] שגיאת חיפוש', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון את העמוד הבא כרגע, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = parseNewestTopicsResponse(data);
  if (topics.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'אין תוצאות נוספות', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => voiceSearchResultsPage(call, queryText, page + 1),
    onPrevPage: page > 1 ? () => voiceSearchResultsPage(call, queryText, page - 1) : null,
    context: `voicesearch:${queryText}:${page}`
  });
}

/**
 * זרימת עיון גנרית ברשימת נושאים.
 */
async function browseTopicList(call, topics, { onOpen, onNextPage, onPrevPage, context, buildMessages }) {
  const buildFn = buildMessages || ((topic, i, total) => [
    { type: 'text', data: `פריט ${i + 1} מתוך ${total}`, removeInvalidChars: true },
    ...buildTopicHeaderMessages(topic)
  ]);

  let i = 0;
  while (i < topics.length) {
    const topic = topics[i];
    const messages = [
      ...(await buildFn(topic, i, topics.length)),
      { type: 'text', data: 'לפתיחה הקישו 1', removeInvalidChars: true },
      navHintMessage()
    ];

    const key = await call.read(messages, 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    if (key === '1') {
      return onOpen(topic);
    }
    if (key === '9') { i++; continue; }
    if (key === '7') { i = Math.max(0, i - 1); continue; }
    if (key === '0' || key === '*') throw new GoToMainMenu();
    i++;
  }

  const nextKey = await call.read([
    { type: 'text', data: 'הגעתם לסוף הרשימה בעמוד הנוכחי', removeInvalidChars: true },
    { type: 'text', data: onNextPage ? 'לעמוד הבא הקישו 9' : '', removeInvalidChars: true },
    { type: 'text', data: onPrevPage ? 'לעמוד הקודם הקישו 7' : '', removeInvalidChars: true },
    { type: 'text', data: 'לתפריט הראשי הקישו 0', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '0' });

  if (nextKey === '9' && onNextPage) return onNextPage();
  if (nextKey === '7' && onPrevPage) return onPrevPage();
  throw new GoToMainMenu();
}

/* ---------- קטגוריות ---------- */

async function categoriesFlow(call) {
  let data;
  try {
    data = await fetchCategories();
  } catch (err) {
    console.error('[categoriesFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע את רשימת הקטגוריות, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const categories = flattenCategoryTree(data.categories || []);
  if (categories.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצאו קטגוריות', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let i = 0;
  while (i < categories.length) {
    const cat = categories[i];
    const depthLabel = cat._depth > 0 ? `תת-קטגוריה ברמה ${cat._depth}: ` : '';
    const key = await call.read([
      { type: 'text', data: `קטגוריה ${i + 1} מתוך ${categories.length}`, removeInvalidChars: true },
      { type: 'text', data: `${depthLabel}${sanitizeForSpeech(cat.name)}`, removeInvalidChars: true },
      { type: 'text', data: 'לכניסה הקישו 1', removeInvalidChars: true },
      navHintMessage()
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    if (key === '1') {
      return categoryFlow(call, cat.cid, cat.slug || '', 1, cat.name);
    }
    if (key === '9') { i++; continue; }
    if (key === '7') { i = Math.max(0, i - 1); continue; }
    if (key === '0' || key === '*') throw new GoToMainMenu();
    i++;
  }

  throw new GoToMainMenu();
}

async function categoryFlow(call, cid, slugParam, page, catName) {
  let data;
  try {
    data = await fetchCategoryTopics(cid, slugParam, page);
  } catch (err) {
    console.error('[categoryFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע את תוכן הקטגוריה, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = data.topics || [];
  const children = (data.children || []).filter((c) => !c.disabled);
  const name = catName || data.name || '';

  const hasTopics = topics.length > 0;
  const hasChildren = children.length > 0;

  if (!hasTopics && !hasChildren) {
    return call.id_list_message([
      { type: 'text', data: 'אין אשכולות או תתי-קטגוריות בקטגוריה זו כרגע', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  if (!hasTopics && hasChildren) {
    return subcategoriesFlow(call, children, name);
  }

  if (hasTopics && hasChildren && page === 1) {
    const key = await call.read([
      { type: 'text', data: `בקטגוריה ${sanitizeForSpeech(name)} יש גם אשכולות וגם תתי-קטגוריות`, removeInvalidChars: true },
      { type: 'text', data: 'לאשכולות בקטגוריה הקישו 1', removeInvalidChars: true },
      { type: 'text', data: 'לתתי-קטגוריות הקישו 2', removeInvalidChars: true },
      { type: 'text', data: 'לחזרה לרשימת הקטגוריות הקישו 0', removeInvalidChars: true }
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    if (key === '2') return subcategoriesFlow(call, children, name);
    if (key === '0' || key === '*') throw new GoToMainMenu();
  }

  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => categoryFlow(call, cid, slugParam, page + 1, name),
    onPrevPage: page > 1 ? () => categoryFlow(call, cid, slugParam, page - 1, name) : null,
    context: `category:${cid}:${page}`
  });
}

async function subcategoriesFlow(call, children, parentName) {
  let i = 0;
  while (i < children.length) {
    const sub = children[i];
    const key = await call.read([
      { type: 'text', data: `תת-קטגוריה ${i + 1} מתוך ${children.length} ב${sanitizeForSpeech(parentName)}`, removeInvalidChars: true },
      { type: 'text', data: sanitizeForSpeech(sub.name), removeInvalidChars: true },
      { type: 'text', data: 'לכניסה הקישו 1', removeInvalidChars: true },
      navHintMessage()
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    if (key === '1') {
      return categoryFlow(call, sub.cid, sub.slug || '', 1, sub.name);
    }
    if (key === '9') { i++; continue; }
    if (key === '7') { i = Math.max(0, i - 1); continue; }
    if (key === '0' || key === '*') throw new GoToMainMenu();
    i++;
  }

  throw new GoToMainMenu();
}

/* ---------- אשכול ---------- */

async function topicFlow(call, tid, slugParam, page, startIdx) {
  let idx = startIdx || 0;

  let data;
  try {
    data = await fetchTopic(tid, slugParam, page);
  } catch (err) {
    console.error('[topicFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע את האשכול, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const posts = data.posts || [];
  if (posts.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצאו הודעות באשכול זה', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const pageCount = data.pagination?.pageCount || 1;

  while (idx >= 0 && idx < posts.length) {
    const messages = [
      ...buildPostMessages(posts[idx], idx, posts.length),
      navHintMessage()
    ];

    const key = await call.read(messages, 'tap', { ...MENU_READ_OPTS, max_digits: 2, allow_empty: true, empty_val: '9' });

    if (key === '9' || key === '') {
      if (idx + 1 < posts.length) { idx++; continue; }
      if (page < pageCount) return topicFlow(call, tid, slugParam, page + 1, 0);
      const endKey = await call.read([
        { type: 'text', data: 'הגעתם לסוף האשכול', removeInvalidChars: true },
        { type: 'text', data: 'לחזרה לקטגוריות הקישו 0, לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '0' });
      if (endKey === '0') return categoriesFlow(call);
      throw new GoToMainMenu();
    }
    if (key === '7') {
      if (idx > 0) { idx--; continue; }
      if (page > 1) return topicFlow(call, tid, slugParam, page - 1, 0);
      continue;
    }
    if (key === '0') return categoriesFlow(call);
    if (key === '*') throw new GoToMainMenu();

    const target = parseInt(key, 10);
    if (!isNaN(target) && target >= 1 && target <= posts.length) {
      idx = target - 1;
      continue;
    }
  }
}

/* ---------- עזרה ---------- */

async function helpFlow(call) {
  await call.id_list_message([
    { type: 'text', data: 'מדריך ניווט מהיר', removeInvalidChars: true },
    { type: 'text', data: 'בכל שלב, הקישו 9 למעבר להודעה או פריט הבא', removeInvalidChars: true },
    { type: 'text', data: 'הקישו 7 לחזרה להודעה או לפריט הקודם', removeInvalidChars: true },
    { type: 'text', data: 'הקישו 0 לחזרה לתפריט הקטגוריות', removeInvalidChars: true },
    { type: 'text', data: 'הקישו כוכבית בכל עת לחזרה לתפריט הראשי', removeInvalidChars: true },
    { type: 'text', data: 'בתוך אשכול, ניתן להקיש את מספר ההודעה כדי לדלג ישירות אליה', removeInvalidChars: true }
  ], { prependToNextAction: true });
}

/* ---------- תפריט ראשי ---------- */

router.get('/', async (call) => {
  console.log(`[MAIN/binatop] שיחה חדשה/פעילה מ-${call.phone}, callId=${call.callId}`);

  for (;;) {
    try {
      const choice = await call.read([
        { type: 'text', data: 'ברוכים הבאים לפורום בינה טופ הקולי', removeInvalidChars: true },
        { type: 'text', data: 'להאזנה לפוסטים אחרונים הקישו 1', removeInvalidChars: true },
        { type: 'text', data: 'לנושאים אחרונים הקישו 2', removeInvalidChars: true },
        { type: 'text', data: 'לקטגוריות הקישו 3', removeInvalidChars: true },
        { type: 'text', data: 'לחיפוש קולי בפורום הקישו 4', removeInvalidChars: true },
        { type: 'text', data: 'להתראות אישיות הקישו 5', removeInvalidChars: true },
        { type: 'text', data: 'לעזרה הקישו 6', removeInvalidChars: true },
        { type: 'text', data: 'להגדרות אישיות הקישו 9', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      console.log(`[MAIN/binatop] נבחר: ${choice}`);

      switch (choice) {
        case '1': await recentPostsFlow(call, 1); break;
        case '2': await recentTopicsFlow(call, 1); break;
        case '3': await categoriesFlow(call); break;
        case '4': await voiceSearchFlow(call); break;
        case '5': await notificationsFlow(call); break;
        case '6': await helpFlow(call); break;
        case '9': await settingsFlow(call); break;
        default: break;
      }
    } catch (err) {
      if (err instanceof GoToMainMenu) continue;
      throw err;
    }
  }
});

/* ============================================================
 * 6. הרכבת אפליקציית Express וייצוא ל-Vercel
 * ============================================================ */

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[BINATOP IN] ${req.method} ${req.originalUrl}`);
  const send = res.send.bind(res);
  res.send = (body) => {
    console.log(`[BINATOP OUT] ${req.originalUrl} ->`, typeof body === 'string' ? body.slice(0, 300) : body);
    return send(body);
  };
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', forum: 'binatop', server: SERVER_BASE, time: new Date().toISOString() });
});

app.use('/api/binatop', router.asExpressRouter);

if (require.main === module) {
  const port = process.env.PORT || 3004;
  app.listen(port, () => console.log(`בינה טופ IVR פועל על פורט ${port}`));
}

// חשיפת loginAsUser/fetchUserNotifications כמאפיינים על אובייקט ה-app
// המיוצא - כדי ש-api/cron/check-notifications.js יוכל לבצע login+שליפת
// התראות עבור פורום זה בדיוק באותה לוגיקה שמשמשת את שלוחה 5, ללא כפילות קוד.
app.loginAsUser = loginAsUser;
app.fetchUserNotifications = fetchUserNotifications;

module.exports = app;
