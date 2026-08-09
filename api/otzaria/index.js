/**
 * מערכת IVR - פורום "אוצריא"
 * ================================
 * מערכת טלפונית מלאה לגלישה בפורום אוצריא (otzaria.org/forum - מבוסס NodeBB,
 * מותקן תחת תת-נתיב /forum ולא בשורש הדומיין - ר' FORUM_BASE/FORUM_PATH_PREFIX
 * למטה) דרך מערכת "ימות המשיח", מבוססת על ספריית yemot-router2 (מודול API הרשמי).
 *
 * קובץ זה הוא עותק מותאם (מבחינת דומיין/נתיב בלבד) של api/yemot/index.js
 * (גרסת פורום מתמחים טופ) - ר' תיעוד מפורט יותר שם; כל הלוגיקה, זרימות
 * הניווט וההערות הטכניות זהות במהותן, למעט ההבדלים המצוינים כאן.
 *
 * ארכיטקטורה: קובץ יחיד (index.js) + package.json משותף לכל הפרויקט.
 * מיועד לפריסה כ-Serverless Function ב-Vercel, כפונקציה נפרדת תחת
 * api/otzaria/index.js (בדיוק כמו api/yemot ו-api/freeivr).
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
 * ו-api/userStore.js + api/register.js), 6=עזרה, 9=הגדרות אישיות (כרגע:
 * הרשמה/הסרה מצינתוקים על התראות חדשות - ר' settingsFlow/tzintukSettingsFlow
 * ו-api/tzintukSender.js + api/cron/check-notifications.js).
 * שלוחות 0/8 (חזרה למיקום אחרון, מנהל) הוסרו במלואן מהקוד, כולל שמירת מיקום
 * ב-Vercel Blob וה-cache בזיכרון.
 *
 * הערה חשובה על אימות (session): פורום אוצריא משתמש באותו שם משתמש/סיסמא
 * כמו פורום מתמחים טופ (לפי בקשת המשתמש) - ולכן מודול זה משתמש *באותם*
 * משתני סביבה בדיוק (SERVICE_USERNAME/SERVICE_PASSWORD) כמו api/yemot/index.js,
 * ואינו מגדיר משתני סביבה נפרדים משלו (בניגוד לדפוס שננקט ב-api/freeivr,
 * ששם יש FREEIVR_SERVICE_USERNAME/FREEIVR_SERVICE_PASSWORD נפרדים - כאן זה
 * מיותר כי מדובר באותו חשבון בפועל).
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
} = require('../../lib/userStore');
// שלוחה 9->3: הזנת מפתח/מפתחות AI (Gemini) מהטלפון, לשימוש עתידי בסיכום
// נושאים בבינה מלאכותית - ר' aiKeyEntryFlow למטה. תיקון קריטי: aiKeyStore
// היה קיים בפרויקט (משותף לכל הפורומים) אך לא נקרא כלל מקובץ זה - לא הייתה
// כל דרך למשתמשי פורום אוצריא להזין מפתח AI.
const { saveAiKeys } = require('../../lib/aiKeyStore');

/* ============================================================
 * 1. תשתית כללית
 * ============================================================ */

// זהות המערכת (system) לשימוש מול userStore.js - מבדילה בין רשומות פורום
// אוצריא לבין רשומות שאר הפורומים הנתמכים באותו מספר טלפון (ר' תיעוד
// מפורט ב-userStore.js / getUserCredentials).
const FORUM_SYSTEM_ID = 'otzaria';
// הערה קריטית: בניגוד ל-mitmachim.top ול-f2.freeivr.co.il (כל אחד בשורש
// הדומיין שלו), פורום אוצריא מותקן תחת תת-נתיב /forum בדומיין otzaria.org
// (למשל https://otzaria.org/forum/api/recent) - לכן FORUM_BASE כולל את
// תת-הנתיב הזה כחלק מה-baseURL של ה-http client, וכל קריאות ה-API
// (fetchRecentTopics/fetchCategories/fetchTopic/וכו') ממשיכות להשתמש
// בנתיבים היחסיים הרגילים ("/api/recent" וכו') בדיוק כמו בגרסאות האחרות -
// axios מצרף אותם אוטומטית אחרי ה-baseURL (otzaria.org/forum + /api/recent).
const FORUM_BASE = 'https://otzaria.org/forum';
// כתובת השרת עצמו: ב-Vercel, VERCEL_URL מכיל את הדומיין האמיתי של הפריסה
// הנוכחית (כולל פריסות preview, שיש להן דומיין ייחודי לכל פריסה) - אם לא
// נשתמש בו ונשתמש בכתובת ה-production הקבועה בלבד, קריאה עצמית לשירות
// התמלול (transcribeRecording) תיכשל בפריסות preview עם 404, כי הן רצות
// תחת דומיין אחר לגמרי. SERVER_BASE הקבוע משמש רק כברירת מחדל למקומי.
const SERVER_BASE = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://mitmachim-ivr.vercel.app';
// שרת הניהול של ימות המשיח - דרכו מורידים קבצי הקלטה שנשמרו ע"י type='record'
// (ר' תיעוד ליד downloadRecording/voiceSearchFlow). לא קשור לפורום otzaria.org.
const YEMOT_MANAGEMENT_BASE = 'https://www.call2all.co.il/ym/api';

// הגדרות HTTP client לפורום - keep-alive + timeout סביר + compression
const http = axios.create({
  baseURL: FORUM_BASE,
  timeout: 8000,
  headers: {
    'User-Agent': 'MitmachimIVR/1.0 (+https://mitmachim-ivr.vercel.app)',
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
  console.log('[AUTH] התחברות משתמש שירות הצליחה');
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
      console.log('[AUTH] session פג תוקף, מתחבר מחדש');
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
 * באותו זמן על אותו תהליך Vercel (Node הוא single-threaded אך יכול לשרת
 * מספר בקשות/שיחות "בו-זמנית" ברמת event loop). לכן ה-cookie של המשתמש
 * הקצה מוחזק ומועבר כערך מקומי (משתנה רגיל בתוך הפונקציה הקוראת), לא
 * ב-module-level state כמו משתמש השירות.
 * זורק שגיאה ברורה (ולא רק סטטוס http) אם ההתחברות נכשלה - למשל סיסמא
 * שגויה שהוזנה בטופס ההרשמה, או שהחשבון נחסם/נמחק בפורום.
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

/** שולף את רשימת ההתראות (notifications) האישיות של המשתמש המחובר, לפי
 *  עוגיית ה-session שהתקבלה מ-loginAsUser. נתיב זהה למה שהדפדפן קורא לו
 *  כשמשתמש מחובר פותח את פעמון ההתראות ב-NodeBB (/api/notifications).
 *  נשלף מחדש בכל כניסה לשלוחה 5, ללא cache - כדי להקריא תמיד את המצב
 *  העדכני ביותר, בדיוק כמו שאר שלוחות העיון בפרויקט. */
async function fetchUserNotifications(userCookie) {
  return withRetry(async () => {
    const { data } = await http.get('/api/notifications', { headers: { Cookie: userCookie } });
    return data;
  }, 1);
}

/* ============================================================
 * 2. שכבת נתונים - NodeBB REST API (otzaria.org/forum)
 * NodeBB חושף כל דף כ-JSON על ידי הוספת api/ בתחילת הנתיב (יחסית לתת-הנתיב
 * /forum שבו הפורום מותקן - ר' הערה ליד FORUM_BASE למעלה).
 * לדוגמה: otzaria.org/forum/recent -> otzaria.org/forum/api/recent
 * ============================================================ */

/** פוסטים/נושאים אחרונים בפורום (ממוין לפי זמן פעילות אחרונה/תגובה אחרונה) -
 *  נשלף מחדש בכל קריאה, ללא cache. נתיב ציבורי - אינו דורש session. */
async function fetchRecentTopics(page = 1) {
  return withRetry(async () => {
    const { data } = await http.get('/api/recent', { params: { page } });
    return data;
  }, 1);
}

/** נושאים (אשכולות) חדשים, ממוינים לפי זמן *יצירת האשכול* (topic.timestamp) ולא
 *  לפי זמן הפעילות/תגובה אחרונה - זהו הבדל מהותי מ-fetchRecentTopics/api/recent.
 *  משתמש באות�� פרמטרים בדיוק כמו הכתובת הפעילה בדפדפן:
 *  https://otzaria.org/forum/search?in=titles&term=&matchWords=all&by=&categories=&
 *    searchChildren=false&hasTags=&replies=&repliesFilter=atleast&timeFilter=newer&
 *    timeRange=&sortBy=topic.timestamp&sortDirection=desc&showAs=topics
 *  התגובה מגיעה במבנה posts[] כאשר לכל פריט יש שדה topic מקונן (ולא רשימת topics
 *  שטוחה) - ר' parseNewestTopicsResponse.
 *  הערה קריטית: /api/search ב-NodeBB חסום לאורחים כברירת מחדל ומחזיר 401 בלי
 *  session מחובר - לכן נעשה שימוש ב-authenticatedGet (משתמש שירות, ר' תיעוד
 *  למעלה) ולא בקריאה ישירה. נשלף מחדש בכל קריאה, ללא cache. */
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

/** ממיר תגובת /api/search (מבנה posts[].topic מקונן, ראה תיעוד ליד fetchNewestTopics)
 *  לרשימת אובייקטי topic שטוחה, כדי שנוכל להשתמש באותם buildTopicHeaderMessages
 *  ו-browseTopicList כמו בשאר שלוחות עיון האשכולות. הערה קריטית: לאובייקט ה-topic
 *  המקונן בתגובת החיפוש אין שדה user משלו (זה שדה של ה-post המכיל), לכן יש להעתיק
 *  את user מה-post האב אל האובייקט השטוח - אחרת ההקראה תציג תמיד "אנונימי". */
function parseNewestTopicsResponse(data) {
  const posts = data.posts || data.topics || [];
  return posts
    .map((p) => {
      // הערה קריטית: גם post וגם topic נושאים שדה tid - אי אפשר להבדיל ביניהם
      // לפי tid בלבד! ההבדל האמיתי: ל-topic שטוח יש title (או titleRaw), בעוד
      // של-post יש content. זה מה שגרם לבאג "ללא כותרת" - post גולמי (בלי title)
      // עבר כאילו הוא כבר topic שטוח, ואז buildTopicHeaderMessages לא מצא title.
      if (p.title || p.titleRaw) return p; // כבר במבנה topic שטוח
      if (!p.topic) return null;
      return { ...p.topic, user: p.topic.user || p.user };
    })
    .filter(Boolean);
}

/** חיפוש חופשי בפורום לפי טקסט (term) - משמש בשלוחה 4 (חיפוש קולי) עם הטקסט
 *  שתומלל מההקלטה. משתמש באותו נתיב /api/search כמו fetchNewestTopics, אך עם
 *  term אמיתי במקום ריק, וממוין לפי רלוונטיות (ברירת מחדל של NodeBB) ולא לפי
 *  timestamp. אותה הערה קריטית לגבי session חלה גם כאן - ר' fetchNewestTopics.
 *  נשלף מחדש בכל קריאה, ללא cache. */
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

/** רשימת כל הקטגוריות בפורום, כולל תתי-קטגוריות (NodeBB מחזיר עץ עם children) -
 *  נשלף מחדש בכל קריאה, ללא cache. */
async function fetchCategories() {
  return withRetry(async () => {
    const { data } = await http.get('/api/categories');
    return data;
  }, 1);
}

/** משטח עץ קטגוריות (עם children מקוננים) לרשימה שטוחה אחת, לשימוש בתפריט הקולי.
 *  כל קטגוריה מקבלת prefix חזותי לפי עומק ה-nesting שלה (למשל "  ↳ ") כדי
 *  שיהיה ברור בהקראה שמדובר בתת-קטגוריה. */
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

/** נושאים (אשכולות) בתוך קטגוריה מסוימת. הערה קריטית: ב-NodeBB שדה slug של קטגוריה
 *  מגיע כבר בפורמט המלא "cid/טקסט-סלאג" (למשל "25/sub1") - אסור להוסיף cid בנפרד
 *  לפני ה-slug, אחרת מתקבל נתיב כפול ו-404 (בדיוק מה שקרה קודם). */
async function fetchCategoryTopics(cid, slug, page = 1) {
  return withRetry(async () => {
    const path = slug ? `/api/category/${slug}` : `/api/category/${cid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  }, 1);
}

/** תוכן אשכול (topic) שלם, כולל כל ההודעות (posts). הערה: ב-NodeBB slug של נושא
 *  מגיע כבר בפורמט המלא "tid/טקסט-סלאג" - לא להוסיף tid בנפרד לפני ה-slug.
 *  נשלף מחדש בכל קריאה, ללא cache. */
async function fetchTopic(tid, slug, page = 1) {
  return withRetry(async () => {
    const path = slug ? `/api/topic/${slug}` : `/api/topic/${tid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  }, 1);
}

/* ============================================================
 * 2ב. תמלול קול - הורדת הקלטה ממערכת ימות ושליחתה לתמלול (Python)
 * ============================================================
 * נקודת אמת חשובה (מתועדת בקוד yemot-router2 עצמו): קריאה עם mode='record'
 * *לא* מחזירה את בייטי האודיו ל-webhook שלנו - value שמוחזר הוא רק מספר/
 * מזהה קובץ. קובץ ה-wav עצמו נשמר בשרתי ימות בנתיב שהוגדר (path/file_name),
 * ויש להוריד אותו בנפרד דרך Management API של ימות (טוקן נפרד, לא קשור
 * לפרטי ההתחברות של הפורום). ר' גם .env.example (YEMOT_MANAGEMENT_TOKEN).
 */

/** מוריד את קובץ ה-wav שנשמר בתת-שלוחת ההקלטה (path בפורמט ivr2:/... של
 *  Management API - ר' VOICE_SEARCH_MGMT_PATH ב-voiceSearchFlow). מחזיר
 *  Buffer של בייטי ה-wav הגולמיים. הערה: לפי תיעוד DownloadFile הרשמי של
 *  ימות, אם הקובץ לא קיים בנתיב המדויק - השרת מחזיר 404 (לא שגיאת JSON) -
 *  לכן שגיאת 404 כאן פירושה כמעט תמיד שהנתיב/שם הקובץ לא תואם למה שימות
 *  שמרה בפועל (ולא בעיית רשת/הרשאות). */
// מס' ניסיונות/השהיה בין ניסיונות בהורדת ההקלטה. שני בעיות אמיתיות שנצפו
// בפועל חוברו כאן לפתרון אחד:
//  1) race זמני בין סיום call.read('record') לבין שהקובץ אכן נכתב בפועל
//     בשרתי הקבצים של ימות (הבקשה הראשונה ל-DownloadFile חוזרת 404 אף
//     שההקלטה כן נשמרה שבריר שנייה אחר כך) - נפתר ע"י ניסיונות חוזרים.
//  2) קאשינג בצד שרתי ימות/CDN לפי הנתיב: DownloadFile מחזיר תוכן ישן
//     (מטמון) ולא את התוכן העדכני שנכתב זה עתה על גבי אותו path+file_name
//     קבוע - נצפה בפועל כ"מוצא כל פעם את ההקלטה הקודמת ולא את החדשה". זו
//     לא שגיאת HTTP (200 עם תוכן ישן), כך שניסיון חוזר על אותו נתיב בלבד
//     לא פותר אותה - הפתרון האמין היחיד הוא לעולם לא לחזור על אותו path+
//     file_name בין שיחות: כעת לא מציינים file_name כלל ב-voiceSearchFlow -
//     ימות עצמה ממספרת כל הקלטה חדשה אוטומטית (מספר גבוה ביותר בשלוחה + 1),
//     כך שאין יותר path+file_name קבוע שחוזר על עצמו בין שיחות ושיכול "לשבור" שמפתחו הוא הנתיב עצמו.
//     פרמטר ה-cache-busting (_cb) כאן הוא הגנה נוספת בלבד, למקרה שהמטמון
//     מפתח גם לפי query string.
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
    throw new Error(`קובץ ההקלטה לא נמצא בנתיב ${recordingPath} לאחר ${DOWNLOAD_RECORDING_RETRIES + 1} ניסיונות - יתכן שההקלטה לא נשמרה או ששם הקובץ שונה`);
  }
  throw lastErr;
}

/** שולח את בייטי ה-wav לפונקציית התמלול (Python, api/transcribe.py) ומחזיר
 *  את הטקסט המתומלל. ריפוד השקט לפני/אחרי (כדי שהתמלול לא "יבלע" חצאי מילים
 *  בתחילת/סוף ההקלטה) מתבצע בצד הפייתון על קובץ ה-wav שהתקבל, לא בצד ימות -
 *  אין אפשרות ב-type='record' של ימות להוסיף שקט לתוך ההקלטה עצמה.
 *
 *  הערה קריטית לגבי 401 שהתקבל בפועל: אומת ש-api/transcribe.py עצמו אינו
 *  בודק שום טוקן/הרשאה כלל, ובכל שגיאה מחזיר קוד 500 (לא 401) - כלומר קוד
 *  401 לא יכול לבוא מהקוד של הפייתון עצמו. הסיבה הסבירה ביותר: הגנת
 *  "Deployment Protection" ברמת הפלטפורמה של Vercel (Password/SSO/Standard
 *  Protection) שחוסמת את הבקשה עוד לפני שהיא מגיעה לקוד - כי זו קריאת שרת-אל-
 *  עצמו (מ-index.js אל api/transcribe) ולה אין session דפדפן/הרשאה כמו לגולש
 *  רגיל. אם מוגדרת הגנה כזו על הפרויקט ב-Vercel, יש להנפיק Protection Bypass
 *  Secret (בהגדרות הפרויקט ב-Vercel: Settings -> Deployment Protection ->
 *  Protection Bypass for Automation) ולהגדירו במשתנה הסביבה
 *  VERCEL_PROTECTION_BYPASS_SECRET - הקוד להלן ישלח אותו אוטומטית ככותרת אם
 *  הוגדר, ולא ישנה התנהגות כלל אם לא (100% תואם לאחור). */
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
    .replace(/<[^>]*>/g, ' ')                 // הסרת תגי HTML
    .replace(/https?:\/\/\S+/g, 'קישור')       // החלפת קישורים במילה "קישור"
    .replace(/@[\w.\-א-ת]+/g, '')             // הסרת תיוגי משתמשים (@שם)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, 'ו')
    .replace(/[#*_`~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // הגבלת אורך למניעת הודעות ארוכות מדי (מגבלת מנוע ההקראה של ימות)
  if (text.length > 1200) text = text.slice(0, 1200) + '... הטקסט המלא ארוך מכדי להיקרא במלואו';
  return text;
}

/** בונה מערך messages להקראת כותרת פוסט/נושא כולל מטא-דאטה (מחבר, תאריך, תגובות). */
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

/** מביא את ההודעה האחרונה האמיתית באשכול (topic), ישירות מ-API של הנושא -
 *  ולא מהשדה topic.teaser. הערה קריטית שהתגלתה בפועל: topic.teaser ב-NodeBB
 *  תלוי לגמרי בהגדרת ACP בפורום עצמו ("Teaser post: First" או "Last") - זו
 *  הגדרה בצד השרת של הפורום שאין לנו שליטה עליה, ובפועל התברר שבפורום הזה
 *  היא מוגדרת ל-First (מציגה את הפוסט הראשון, לא האחרון). לכן, כדי להבטיח
 *  שרלוחה 1 תמיד תשמיע את הפוסט *האחרון* בפועל (ללא תלות בהגדרות הפורום),
 *  יש להביא את עמוד ההודעות האחרון של הנושא ולקחת ממנו את ההודעה האחרונה -
 *  באותה שיטה בדיוק ש-topicFlow כבר משתמשת בה לניווט בין עמודים (pageCount).
 *  עלות: קריאת API נוספת אחת per topic ברשימה - מקובל לפי בקשת המשתמש. */
async function fetchLastPost(tid, slug, postcount) {
  // הערה קריטית (תוקן): לא ניתן לנחש את מספר העמוד האחרון לפי postcount בלבד -
  // topic.postcount שמגיע מרשימות (recent/search) לעיתים undefined או לא מדויק,
  // מה שגרם ל-estimatedLastPage לצאת תמיד 1 (Math.ceil((undefined||1)/20)=1) -
  // כלומר בפועל תמיד הובא עמוד 1, ולכן הוקרא הפוסט הראשון במקום האחרון (הבאג
  // שדווח בפועל). הפתרון: קודם מביאים עמוד 1 ושואבים משם את pagination.pageCount
  // *האמיתי* שמחזיר ה-API עצמו (בדיוק כמו ש-topicFlow כבר עושה), ורק אם יש
  // יותר מעמוד אחד מביאים בפועל את העמוד האחרון האמיתי.
  const firstPageData = await fetchTopic(tid, slug, 1);
  const realPageCount = firstPageData.pagination?.pageCount || 1;

  let posts = firstPageData.posts || [];
  if (realPageCount > 1) {
    const lastPageData = await fetchTopic(tid, slug, realPageCount);
    if (lastPageData.posts && lastPageData.posts.length > 0) {
      posts = lastPageData.posts;
    }
    // אם מסיבה כלשהי העמוד האחרון חזר ריק (edge case), נשארים עם posts
    // מעמוד 1 שכבר הבאנו - עדיף מהודעה חסרה לגמרי.
  }

  return posts.length > 0 ? posts[posts.length - 1] : null;
}

/** בונה מערך messages להקראת ההודעה האחרונה האמיתית של נושא (ר' fetchLastPost
 *  לעיל, ולמה זה לא topic.teaser). שונה מ-buildTopicHeaderMessages שמקריא רק
 *  את כותרת הנושא ומטא-דאטה, בלי תוכן הודעה בכלל. */
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

/** בונה מערך messages להקראת התראה אישית בודדת מ-/api/notifications.
 *  מבנה התגובה של NodeBB לכל התראה כולל בדרך כלל bodyShort (טקסט קצר
 *  מוכן להצגה, כבר מרונדר עם שם המשתמש הרלוונטי) ו/או bodyLong, וכן
 *  datetimeISO לזמן היצירה. יש התראות ללא bodyShort (תלוי בסוג
 *  ההתראה ב-NodeBB) - ולכן יש נפילה (fallback) לשרשור subject/from
 *  ידני, כדי שלעולם לא תישמע הודעה ריקה. */
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

/* ---------- שלוחה 1: פוסטים אחרונים (תוכן ה-teaser - ההודעה האחרונה שנכתבה) ---------- */

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

/* ---------- שלוחה 2: נושאים אחרונים - אשכולות חדשים לפי זמן *יצירת האשכול*
 * (topic.timestamp), תואם לרשימה המוצגת בכתובת:
 * https://otzaria.org/forum/search?in=titles&sortBy=topic.timestamp&sortDirection=desc&showAs=topics
 * שונה משלוחה 1 שמציגה פוסטים/נושאים לפי זמן פעילות/תגובה אחרונה (api/recent). ---------- */

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

  // תגובת /api/search (showAs=topics) מחזירה posts[] עם topic מקונן לכל פריט
  // (ראה תיעוד ליד fetchNewestTopics/parseNewestTopicsResponse) - ממירים לרשימת
  // topic שטוחה עם user מועתק מה-post האב, לשימוש ב-browseTopicList הרגיל.
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

/* ---------- שלוחה 5: התראות אישיות (מזוהה לפי מספר הטלפון המתקשר) ----------
 * זרימה:
 *   1. שליפת פרטי ההתחברות לפורום ששויכו למספר הטלפון של המתקשר (call.phone)
 *      מתוך Upstash Redis - הפרטים נשמרו מראש דרך אתר ההרשמה (api/register.js).
 *   2. אם לא נמצא שיוך - הודעה ברורה שמכוונת את המתקשר להירשם קודם באתר.
 *   3. התחברות לפורום *כמשתמש הזה עצמו* (loginAsUser, session נפרד לגמרי
 *      ממשתמש השירות הקבוע ששמור ב-sessionCookie המשותף - ר' תיעוד ליד
 *      loginAsUser) ושליפת רשימת ההתראות שלו (/api/notifications).
 *   4. הקראת ההתראות בדיוק באותה חוויית ניווט (9/7/0/*) כמו שאר שלוחות
 *      העיון בפרויקט (browseTopicList), באמצעות buildNotificationMessages.
 * הערה חשובה: בשונה משאר השלוחות, אין כאן "פתיחה" של פריט לתוכן נוסף -
 * ההתראה כולה מוקראת ישירות ברשימה עצמה, כי בניגוד לנושא/פוסט אין entity
 * נפרד (topic/post) לפתוח בפועל - ההתראה היא כבר התוכן המלא הרלוונטי
 * להשמעה. לכן "לפתיחה הקישו 1" מדלג פשוט להתראה הבאה (התנהגות זהה ל-9),
 * כדי לשמור על עקביות מלאה עם המבנה של browseTopicList ללא כפילות קוד. */
/* ---------- שלוחה 9: הגדרות אישיות ----------
 * תפריט קצר: 1 = הרשמה/הסרה מצינתוקים (התראות טלפוניות) על התראות חדשות
 * בשלוחה 5. דורש קודם שיוך מספר טלפון->פרטי התחברות (כמו שלוחה 5 עצמה) -
 * אם המספר לא רשום לפורום כלל, מכוונים אותו לאתר ההרשמה במקום להציג
 * תפריט הרשמה לצינתוקים חסר משמעות (אין למי לצנתק בלי number->credentials). */
async function settingsFlow(call) {
  const choice = await call.read([
    { type: 'text', data: 'הגדרות אישיות', removeInvalidChars: true },
    { type: 'text', data: 'להרשמה או הסרה מצינתוקים על התראות חדשות הקישו 1', removeInvalidChars: true },
    { type: 'text', data: 'להזנת מפתח בינה מלאכותית לסיכום נושאים דרך הטלפון הקישו 3', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (choice === '1') return tzintukSettingsFlow(call);
  if (choice === '3') return aiKeyEntryFlow(call);
  throw new GoToMainMenu();
}

/**
 * שלוחה 9->3: הזנת מפתח (או מספר מפתחות) Gemini API דרך הטלפון בלבד, ללא
 * מקלדת מחשב - במקלדת רב-הקשה מובנית של ימות (typing_playback_mode=
 * 'EnglishKeyboard'). נשמר דרך saveAiKeys ב-aiKeyStore.js, לפי מספר הטלפון
 * בלבד (ללא תלות בפורום/שם משתמש) - משותף לכל הפורומים הנתמכים בפרויקט.
 * תמיכה במספר מפתחות: ניתן להקיש כמה מפתחות ברצף, מופרדים בפסיק, כדי
 * לאפשר fallback אוטומטי אם מפתח אחד עובר את המכסה החינמית.
 */
async function aiKeyEntryFlow(call) {
  const rawKeys = await call.read([
    { type: 'text', data: 'הזנת מפתח בינה מלאכותית לסיכום נושאים', removeInvalidChars: true },
    { type: 'text', data: 'אנא הקישו את מפתח ה-API של גוגל ג׳מיני שלכם באמצעות מקלדת הטלפון, ולאחר מכן הקישו סולמית פעמיים לסיום. ניתן להזין כמה מפתחות ברצף, מופרדים בפסיק', removeInvalidChars: true }
  ], 'tap', { max_digits: 200, min_digits: 1, sec_wait: 20, typing_playback_mode: 'EnglishKeyboard' });

  if (!rawKeys) {
    return call.id_list_message([
      { type: 'text', data: 'לא הוזן מפתח, הפעולה בוטלה', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  try {
    await saveAiKeys(call.phone, rawKeys);
  } catch (err) {
    console.error('[aiKeyEntryFlow] שגיאה בשמירת מפתח/מפתחות AI', err.message);
    return call.id_list_message([
      { type: 'text', data: 'אירעה שגיאה בשמירת המפתח, אנא ודאו שהזנתם מפתח תקין ונסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  return call.id_list_message([
    { type: 'text', data: 'המפתח נשמר בהצלחה', removeInvalidChars: true }
  ], { prependToNextAction: true });
}

/** שלוחה 9->1: הרשמה/הסרה מצינתוקים. מציג את המצב הנוכחי ומאפשר להחליף אותו
 *  בהקשה אחת (1 = פעולה הפוכה למצב הנוכחי). ר' תיעוד מפורט ב-userStore.js
 *  (subscribeToTzintuk/unsubscribeFromTzintuk) לגבי משמעות since וההתנהגות
 *  האידמפוטנטית של הרשמה חוזרת. */
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
    // תיקון ניווט (5ה): הקשה לא מזוהה חוזרת על הפריט הנוכחי (re-prompt),
    // ולא מקדמת אוטומטית לפריט הבא - כדי לא ליצור תחושת "דילוג" לא צפוי.
    continue;
  }

  // תיקון ניווט (5ה): במסך סוף-רשימה, רק '*' (במפורש) גורם למעבר לתפריט
  // הראשי - כל הקשה אחרת (כולל 7/9 לא רלוונטיים כאן) חוזרת על אותה הודעת
  // סיום, ולא "בורחת" לתפריט הראשי כמו שקרה בעבר (זו הייתה הסיבה שהקשות
  // 7/9 מהרגל, לפי ה-NAV_HINT הרגיל, נראו "לפעמים לא עובדות").
  for (;;) {
    const endKey = await call.read([
      { type: 'text', data: 'הגעתם לסוף רשימת ההתראות', removeInvalidChars: true },
      { type: 'text', data: 'לחזרה להתחלת הרשימה הקישו 7, לתפריט הראשי הקישו כוכבית', removeInvalidChars: true }
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '*' });

    if (endKey === '7') return notificationsFlow(call);
    if (endKey === '*') throw new GoToMainMenu();
    // הקשה אחרת - חוזר על אותה הודעת סיום (re-prompt).
  }
}

/**
 * מכריז "יש לך X התראות חדשות" בתפריט הראשי, *לפני* שהמשתמש בוחר שלוחה -
 * תיקון באג: בעבר ההכרזה הזו קרתה בתוך שלוחה 5 עצמה (notificationsFlow),
 * כלומר אחרי שהמשתמש כבר היה שם - חסרת תכלית, כי המשתמש כבר בחר להיכנס.
 * המיקום הנכון הוא בתפריט הראשי, כדי להנחות אותו *להיכנס* לשלוחה 5.
 * רצה פעם אחת בלבד בתחילת השיחה (מחוץ ל-for(;;) בתפריט הראשי) ולא בכל
 * חזרה ללולאה, כדי לא לחזור על ההכרזה בכל GoToMainMenu. best-effort: כל
 * שגיאה (רשת/התחברות) נלכדת ומתעלמת - אף פעם לא חוסמת את המשך השיחה.
 */
async function announceNewNotifications(call) {
  try {
    const sub = await getTzintukSubscription(call.phone, FORUM_SYSTEM_ID);
    if (!sub?.enabled) return;

    const creds = await getUserCredentials(call.phone, FORUM_SYSTEM_ID);
    if (!creds) return;

    const userCookie = await loginAsUser(creds.username, creds.password);
    const data = await fetchUserNotifications(userCookie);
    const notifications = data?.notifications || [];

    const sinceTime = new Date(sub.since).getTime();
    const newCount = notifications.filter((n) => {
      const t = new Date(n.datetimeISO || n.datetime || 0).getTime();
      return !isNaN(t) && t > sinceTime;
    }).length;

    if (newCount > 0) {
      await call.id_list_message([
        { type: 'text', data: 'יש לך', removeInvalidChars: true },
        { type: 'number', data: String(newCount) },
        { type: 'text', data: 'התראות חדשות, לשמיעה הקישו 5', removeInvalidChars: true }
      ]);
    }
  } catch (err) {
    console.error('[announceNewNotifications] שגיאה בבדיקת מונה התראות חדשות', err.message);
  }
}

/* ---------- שלוחה 4: חיפוש קולי - הקלטה -> תמלול -> חיפוש בפורום ---------- */

// תיקיית יעד קבועה לשמירת הקלטות החיפוש, כתת-שלוחה של השלוחה הראשית.
// ensureRecordingFolder דואגת שהיא תיווצר אוטומטית כ-type=playfile (השלוחה
// שמיועדת להחזיק קבצים להשמעה/הקלטה) אם עוד אינה קיימת - ר' תיעוד
// UpdateExtension: "במידה והשלוחה לא קיימת, תיווצר".
//
// הערה קריטית (תוקן): בניסיון קודם הוחלף מספר השלוחה הממוספר (8) בשם תיקייה
// אנגלי חופשי ("VoiceSearchRecordings"), בהשראת פרויקט ייחוס אחר. זה היה שגוי
// ולכן ההקלטה לא נשמרה בכלל: תיעוד UpdateExtension הרשמי של ימות מראה
// שהפרמטר path הוא תמיד *מספר שלוחה* בעץ החיוג (למשל path=ivr2:1), ולא נתיב
// טקסטואלי חופשי - זו שלוחה מבוססת ספרות בלבד, כמו כל שלוחה אחרת בימות.
// ה-path בפרויקט הייחוס ("/ApiRecords") כנראה תלוי בהתנהגות ספציפית של
// אותה מערכת ולא ניתן להעתיק אותו כמו שהוא. חוזרים לשלוחה ממוספרת - זו
// הצורה התקינה היחידה שנתמכת בפועל בעץ השלוחות של ימות. את השם "באנגלית"
// ניתן לתת רק כתיאור (title) של השלוחה בממשק הניהול, לא כחלק מה-path עצמו.
const VOICE_SEARCH_EXTENSION_NUMBER = '8'; // מספר תת-שלוחה קבוע תחת השלוחה הראשית
const VOICE_SEARCH_EXTENSION_TITLE = 'VoiceSearchRecordings'; // שם תיאורי באנגלית - מוצג בממשק הניהול של ימות בלבד, לא חלק מהנתיב
// הערה קריטית שאומתה בפועל מלוג ימות אמיתי: ימות עצמה מצרפת '/' + file_name
// ל-path בעת השמירה. path עם '/' בסוף גורם לנתיב כפול (למשל "...//query.wav")
// - ולכן path חייב להיות בלי '/' בסוף.
const VOICE_SEARCH_RECORD_PATH = `/${VOICE_SEARCH_EXTENSION_NUMBER}`; // פורמט תקין לפי תיעוד ימות: '/' מוביל, בלי '/' בסוף
const VOICE_SEARCH_MGMT_PATH = `ivr2:/${VOICE_SEARCH_EXTENSION_NUMBER}`; // פורמט Management API

// שיחה מקליטה תמיד לאותו שם קובץ קבוע ("query"), שרתי ימות (ו/או שכבת CDN
// שלפניהם) מטמינים את הקובץ לפי הנתיב path+file_name. כתיבה מחדש על אותו
// נתיב לא בהכרח "שוברת" את המטמון הזה בצד ימות - כך שקריאת DownloadFile
// לפעמים מחזירה את בייטי ההקלטה *הקודמת* (200 תקין, לא שגיאה), למרות
// שהוקלטה הקלטה חדשה. זה נצפה בפועל: "החיפוש עובד פעם ראשונה בלבד, ומשם
// כל שיחה מוצאת/מתמללת את מה שנשמר בשיחה הקודמת".
//
// תוקן סופית לפי תיעוד רשמי של ימות (מודול API, "הגדרות עבור הקלטות",
// הערך החמישי): כאשר לא מציינים file_name כלל, ימות עצמה ממספרת את הקובץ
// אוטומטית כ"מספר הגבוה ביותר בשלוחה + 1" - כלומר כל הקלטה מקבלת מעצמה שם
// קובץ חדש וייחודי (101, 102, 103...) בלי שום צורך שלנו לנחש/לייצר שם.
// זה גם מבטל לחלוטין את מנגנון "שינוי שם לקובץ קיים" (הערך השמיני בתיעוד),
// שרלוונטי רק כאשר יש התנגשות בשם קובץ מפורש - ומכיוון שאנחנו לא קובעים
// שם קבוע יותר, אין יותר התנגשות שיכולה לגרום לרינדור מוזר/מושהה של הקובץ
// הישן, לקאש שמפתחו path+file_name קבוע, או להחזרת קובץ לא-מעודכן.
// המקור היחיד לאמת לגבי הנתיב שבו נשמר הקובץ הוא הערך שימות מחזירה בפועל
// מ-call.read (recordResult / val_2) - ר' הטיפול בו למטה.
let recordingFolderEnsured = false;

/** מוודאת שהתיקייה הייעודית לשמירת הקלטות החיפוש קיימת במערכת ימות, ואם לא -
 *  יוצרת אותה כ-type=playfile (התיקייה המיועדת להחזיק קבצים). רצה פעם אחת
 *  בלבד לכל cold start (תהליך Vercel), לא בכל שיחה - כדי לא להעמיס בקריאות API
 *  מיותרות. משתמשת בטוקן ניהול נפרד (YEMOT_MANAGEMENT_TOKEN), לא בפרטי הפורום. */
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
  // קריטי: Management API של ימות מחזיר HTTP 200 גם בכשלים לוגיים (למשל טוקן
  // ללא הרשאה לשלוחה הזו) - השגיאה מגיעה בגוף התגובה (responseStatus/message),
  // לא בקוד HTTP. בעבר תוצאת הקריאה לא נבדקה כלל, כך שאם היצירה נכשלה בשקט -
  // recordingFolderEnsured עדיין הוסמן כ-true, וההורדה נכשלה אחר כך ב-404 בלי
  // שום אינדיקציה לגורם האמיתי. עכשיו בודקים responseStatus ומוודאים בפועל
  // (CheckIfFolderExists נוסף) שהשלוחה אכן נוצרה, לפני שמסמנים ensured=true.
  if (updateData?.responseStatus && updateData.responseStatus !== 'OK') {
    throw new Error(`יצירת תת-שלוחת ההקלטות ${VOICE_SEARCH_MGMT_PATH} נכשלה: ${updateData.message || JSON.stringify(updateData)}`);
  }
  const { data: verifyData } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/CheckIfFolderExists`, {
    params: { token, path: VOICE_SEARCH_MGMT_PATH },
    timeout: 10000
  });
  if (!verifyData?.folderExists) {
    throw new Error(`תת-שלוחת ההקלטות ${VOICE_SEARCH_MGMT_PATH} עדיין לא קיימת לאחר ניסיון היצירה - ייתכן שהטוקן (YEMOT_MANAGEMENT_TOKEN) חסר הרשאה למערכת/DID של פורום זה`);
  }
  recordingFolderEnsured = true;
}

async function voiceSearchFlow(call) {
  // שלב 0: לוודא שתת-שלוחת ההקלטות קיימת (יוצרת אוטומטית אם לא, ר' תיעוד
  // ensureRecordingFolder). אם זה נכשל (למשל טוקן שגוי), עדיף להיכשל כאן
  // בבירור מאשר לקבל 404 מבלבל בהמשך בשלב ההורדה.
  try {
    await ensureRecordingFolder();
  } catch (err) {
    console.error('[voiceSearchFlow] שגיאה בוידוא תיקיית הקלטות', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שירות החיפוש הקולי אינו זמין כרגע, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  // שלב 1: הקלטת השאילתה. no_confirm_menu=true מדלג על "לאישור הקישו 2" -
  // המאזין פשוט מקליט ומקיש # ועוברים ישר לתמלול, לחוויה זורמת יותר בחיפוש.
  // בכוונה לא מציינים file_name: ימות תמספר את הקובץ אוטומטית כ"מספר גבוה
  // ביותר בשלוחה + 1" (ר' הערה למעלה) - כך שכל הקלטה מקבלת נתיב חדש וייחודי
  // משל עצמה, ולא נכנסים למנגנון "שינוי שם לקובץ קיים" או לבעיית קאש
  // אפשרית על נתיב קבוע וחוזר.
  const recordResult = await call.read([
    { type: 'text', data: 'חיפוש קולי בפורום', removeInvalidChars: true },
    { type: 'text', data: 'אנא אמרו את מה שתרצו לחפש לאחר הצליל, ובסיום הקישו סולמית', removeInvalidChars: true }
  ], 'record', {
    path: VOICE_SEARCH_RECORD_PATH,
    no_confirm_menu: true,
    min_length: 1,
    max_length: 20
  });

  // שלב 2: הורדת ההקלטה מימות ושליחתה לתמלול. הריפוד בשקט לפני/אחרי ההקלטה
  // (כדי שהתמלול לא יחתוך חצאי מילים בתחילת/סוף) מתבצע בצד הפייתון, ר' תיעוד
  // downloadRecording/transcribeRecording למעלה.
  //
  // הערה קריטית (תוקן): בעבר הנתיב נבנה כניחוש קבוע מתוך VOICE_SEARCH_MGMT_PATH
  // ו-VOICE_SEARCH_RECORD_FILENAME. בפועל התברר מלוג אמיתי של ימות ש-call.read
  // עם mode='record' מחזירה (val_2) את הנתיב *האמיתי* שבו ימות שמרה את הקובץ -
  // ובמקרה שנבדק זה היה "8//query.wav" (עם // כפול) ולא "8/query.wav" כפי
  // שהקוד ניחש, ולכן ההורדה נכשלה עם 404 (הקובץ נשמר, רק לא בנתיב שניחשנו).
  // הפתרון: להשתמש בערך שימות עצמה מחזירה כמקור האמת היחיד לנתיב ההורדה,
  // במקום לבנות אותו בניחוש - כך הקוד תמיד יתאים למקום שבו ימות שמרה בפועל,
  // גם אם ההתנהגות הפנימית של שרשור path+file_name משתנה או שונה מהמצופה.
  // recordResult תואם לפורמט היחסי (כמו val_2 הגולמי, למשל "8/query.wav" או
  // "8//query.wav") - יש לנרמל '//' ל-'/' ולהמיר לפורמט ivr2: של Management API.
  let queryText;
  try {
    if (!recordResult || typeof recordResult !== 'string') {
      throw new Error(`call.read('record') לא החזיר נתיב קובץ תקין (קיבלנו: ${JSON.stringify(recordResult)})`);
    }
    // נרמול '//' כפול ל-'/' יחיד (התופעה שנצפתה בפועל בלוג), והסרת '/' מוביל
    // אם קיים, לפני הרכבת הנתיב בפורמט ivr2: הנדרש ל-Management API.
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

  // שלב 3: חיפוש בפורום עם הטקסט שתומלל, והצגת התוצאות כמו בשא�� השלוחות.
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

/** עמוד תוצאות נוסף לחיפוש קולי (עמוד 1 מטופל בתוך voiceSearchFlow עצמה,
 *  יחד עם ההקלטה/תמלול - אין טעם להקליט מחדש כדי לדפדף בין עמודי אותה שאילתה). */
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
 * זרימת עיון גנרית ברשימת נושאים: מקריאה תוכן לכל נושא ברשימה (לפי buildMessages
 * שהועבר - כותרת+מטא, או תוכן ה-teaser), ומאפשרת ניווט 9/7/0/* ובחירת נושא
 * לפי מספרו הסידורי ברשימה. חוזרת (return) כשהמסך הזה סיים - לא קופצת עם go_to_folder.
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

/**
 * האזנה לתוכן קטגוריה נתונה. קטגוריה יכולה להיות באחד משלושה מצבים:
 *   מצב 1: יש בה אשכולות ישירות בלבד -> מציגים אותם ישירות (browseTopicList).
 *   מצב 2: יש בה רק תתי-קטגוריות (אין אשכולות ישירים) -> נכנסים ישר לרשימת תתי-הקטגוריות.
 *   מצב 3: יש גם וגם -> מציגים תפריט בחירה: אשכולות בקטגוריה / תתי-קטגוריות.
 * חיפוש אשכולות בתוך תתי-קטגוריות הוא רקורסיבי דרך subcategoriesFlow/categoryFlow -
 * לעולם לא מציגים "אין אשכולות" רק בגלל שאין אשכולות ישירים כשקיימות תתי-קטגוריות.
 * הערה: תת-הקטגוריות (children) מגיעות בתגובת /api/category/:slug של NodeBB עצמה,
 * לכן אין צורך בקריאת API נוספת כדי לדעת אם יש כאלה.
 */
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

  // מצב 2: רק תתי-קטגוריות, אין אשכולות ישירים - נכנסים ישר לרשימת תתי-הקטגוריות.
  if (!hasTopics && hasChildren) {
    return subcategoriesFlow(call, children, name);
  }

  // מצב 3: ��ם וגם - תפריט בחירה בין אשכולות בקטגוריה לתתי-קטגוריות.
  if (hasTopics && hasChildren && page === 1) {
    const key = await call.read([
      { type: 'text', data: `בקטגוריה ${sanitizeForSpeech(name)} יש גם אשכולות וגם תתי-קטגוריות`, removeInvalidChars: true },
      { type: 'text', data: 'לאשכולות בקטגוריה הקישו 1', removeInvalidChars: true },
      { type: 'text', data: 'לתתי-קטגוריות הקישו 2', removeInvalidChars: true },
      { type: 'text', data: 'לחזרה לרשימת הקטגוריות הקישו 0', removeInvalidChars: true }
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    if (key === '2') return subcategoriesFlow(call, children, name);
    if (key === '0' || key === '*') throw new GoToMainMenu();
    // כל הקשה אחרת (כולל 1) ממשיכה להצגת האשכולות הישירים למטה
  }

  // מצב 1 (או המשך מצב 3 אחרי בחירת "אשכולות"): הצגת האשכולות הישירים בקטגוריה.
  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => categoryFlow(call, cid, slugParam, page + 1, name),
    onPrevPage: page > 1 ? () => categoryFlow(call, cid, slugParam, page - 1, name) : null,
    context: `category:${cid}:${page}`
  });
}

/**
 * עיון ברשימת תתי-קטגוריות של קטגוריית-אב. בחירה בתת-קטגוריה נכנסת אליה עם
 * categoryFlow הרגיל - שם הטיפול במצבים 1/2/3 חוזר על עצמו רקורסיבית באופן טבעי
 * (תת-קטגוריה יכולה בעצמה להכיל גם אשכולות וגם תתי-תתי-קטגוריות).
 */
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

/* ---------- אשכול: האזנה לכל ההודעות, מעבר בין הודעה להודעה, דילוג ---------- */

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
      continue; // כבר בהודעה הראשונה
    }
    if (key === '0') return categoriesFlow(call);
    if (key === '*') throw new GoToMainMenu();

    // ניווט לפי ספרות: הקשה של מספר עובר ישירות להודעה המבוקשת באשכול הנוכחי
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

/* ---------- תפריט ראשי - נקודת הכניסה היחידה, לולאה פנימית שלא יוצאת לשלוחות אחרות ---------- */

router.get('/', async (call) => {
  console.log(`[MAIN] שיחה חדשה/פעילה מ-${call.phone}, callId=${call.callId}`);

  // הכרזת "יש לך X התראות חדשות" - פעם אחת בלבד בתחילת השיחה, *לפני*
  // כניסה ללולאת התפריט, ולכן לא חוזרת על עצמה בכל GoToMainMenu (ר' תיעוד
  // announceNewNotifications). best-effort בלבד - לעולם לא חוסמת את התפריט.
  await announceNewNotifications(call);

  // לולאה אינסופית: כל בחירה בתפריט מפעילה פונקציה פנימית; GoToMainMenu מחזיר לכאן.
  // אין ולו קריאה אחת ל-call.go_to_folder בקוד הזה - הניווט כולו פנימי.
  for (;;) {
    try {
      const choice = await call.read([
        { type: 'text', data: 'ברוכים הבאים לפורום אוצַריֵא הקולי', removeInvalidChars: true },
        { type: 'text', data: 'להאזנה לפוסטים אחרונים הקישו 1', removeInvalidChars: true },
        { type: 'text', data: 'לנושאים אחרונים הקישו 2', removeInvalidChars: true },
        { type: 'text', data: 'לקטגוריות הקישו 3', removeInvalidChars: true },
        { type: 'text', data: 'לחיפוש קולי בפורום הקישו 4', removeInvalidChars: true },
        { type: 'text', data: 'להתראות אישיות הקישו 5', removeInvalidChars: true },
        { type: 'text', data: 'לעזרה הקישו 6', removeInvalidChars: true },
        { type: 'text', data: 'להגדרות אישיות הקישו 9', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      console.log(`[MAIN] נבחר: ${choice}`);

      switch (choice) {
        case '1': await recentPostsFlow(call, 1); break;
        case '2': await recentTopicsFlow(call, 1); break;
        case '3': await categoriesFlow(call); break;
        case '4': await voiceSearchFlow(call); break;
        case '5': await notificationsFlow(call); break;
        case '6': await helpFlow(call); break;
        case '9': await settingsFlow(call); break;
        default: break; // הקשה לא מוכרת - חוזר לתפריט הראשי
      }
    } catch (err) {
      if (err instanceof GoToMainMenu) continue; // מסך פנימי ביקש לחזור לכאן
      throw err; // שגיאה אמיתית - תעלה ל-uncaughtErrorHandler
    }
  }
});

/* ============================================================
 * 7. הרכבת אפליקציית Express וייצוא ל-Vercel
 * ============================================================ */

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// לוג ברור לכל בקשה נכנסת מימות - חיוני לאבחון תקלות ב-Vercel Function Logs
app.use((req, res, next) => {
  console.log(`[OTZARIA IN] ${req.method} ${req.originalUrl}`);
  const send = res.send.bind(res);
  res.send = (body) => {
    console.log(`[OTZARIA OUT] ${req.originalUrl} ->`, typeof body === 'string' ? body.slice(0, 300) : body);
    return send(body);
  };
  next();
});

// בריאות המערכת - לבדיקה ידנית/ניטור
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', system: FORUM_SYSTEM_ID, server: SERVER_BASE, time: new Date().toISOString() });
});

// חיבור הראוטר של ימות - נתיב יחיד תואם ל-api_link שיוגדר בשלוחה (שלוחה נפרדת
// מ-mitmachim/freeivr, ר' api_link המומלץ בתיעוד הראשי של הפרויקט/README):
// https://<דומיין-הפרויקט>/api/otzaria/
app.use('/api/otzaria', router.asExpressRouter);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`אוצריא IVR פועל על פורט ${port}`));
}

// חשיפת loginAsUser/fetchUserNotifications כמאפיינים על אובייקט ה-app
// המיוצא - כדי ש-api/cron/check-notifications.js יוכל לבצע login+שליפת
// התראות עבור פורום זה בדיוק באותה לוגיקה שמשמשת את שלוחה 5 (notificationsFlow),
// ללא כפילות קוד. לא משנה את ההתנהגות של app כ-handler של Express -
// זו רק הוספת שדות על האובייקט (פונקציה/אובייקט ב-JS יכול לשאת מאפיינים נוספים).
app.loginAsUser = loginAsUser;
app.fetchUserNotifications = fetchUserNotifications;

module.exports = app;
