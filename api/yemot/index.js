/**
 * מערכת IVR - פורום "מתמחים טופ"
 * ================================
 * מערכת טלפונית מלאה לגלישה בפורום מתמחים טופ (mitmachim.top - מבוסס NodeBB)
 * דרך מערכת "ימות המשיח", מבוססת על ספריית yemot-router2 (מודול API הרשמי).
 *
 * ארכיטקטורה: קובץ יחיד (index.js) + package.json בלבד.
 * מיועד לפריסה כ-Serverless Function ב-Vercel.
 * דומיין: https://mitmachim-ivr.vercel.app
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
 * תפריט ראשי נוכחי: 1=פוסטים אחרונים, 2=נושאים אחרונים, 3=קטגוריות, 6=עזרה.
 * שלוחות 0/4/5/8/9 (חזרה למיקום אחרון, חיפוש, תפריט אישי, הגדרות, מנהל) הוסרו
 * במלואן מהקוד, כולל שמירת מיקום ב-Vercel Blob וה-cache בזיכרון.
 *
 * הערה: מוזיקת רקע (music_on_hold) אינה מנוהלת בקוד זה בכלל -
 * היא מוגדרת ומופעלת ברמת השלוחה בממשק ניהול ימות המשיח בלבד.
 */

'use strict';

const express = require('express');
const { YemotRouter, ExitError } = require('yemot-router2');
const axios = require('axios');

/* ============================================================
 * 1. תשתית כללית
 * ============================================================ */

const FORUM_BASE = 'https://mitmachim.top';
const SERVER_BASE = 'https://mitmachim-ivr.vercel.app';

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

/* ============================================================
 * 2. שכבת נתונים - NodeBB REST API (mitmachim.top)
 * NodeBB חושף כל דף כ-JSON על ידי הוספת api/ בתחילת הנתיב.
 * לדוגמה: mitmachim.top/recent -> mitmachim.top/api/recent
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
 *  משתמש באותם פרמטרים בדיוק כמו הכתובת הפעילה בדפדפן:
 *  https://mitmachim.top/search?in=titles&term=&matchWords=all&by=&categories=&
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
      if (p.tid) return p; // כבר במבנה topic שטוח
      if (!p.topic) return null;
      return { ...p.topic, user: p.topic.user || p.user };
    })
    .filter(Boolean);
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

/** בונה מערך messages להקראת ה"פוסט האחרון" (teaser) של נושא - זו התגובה/הודעה
 *  העדכנית ביותר שנכתבה באותו נושא, כולל תוכנה המלא. שונה מ-buildTopicHeaderMessages
 *  שמקריא רק את כותרת הנושא ומטא-דאטה. */
function buildTeaserMessages(topic, index, total) {
  const teaser = topic.teaser || {};
  const authorName = teaser.user?.displayname || teaser.user?.username || 'אנונימי';
  const date = new Date(teaser.timestamp || topic.lastposttime || Date.now());
  const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  const content = sanitizeForSpeech(teaser.content);

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
 * https://mitmachim.top/search?in=titles&sortBy=topic.timestamp&sortDirection=desc&showAs=topics
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
      ...buildFn(topic, i, topics.length),
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

  // מצב 3: גם וגם - תפריט בחירה בין אשכולות בקטגוריה לתתי-קטגוריות.
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

  // לולאה אינסופית: כל בחירה בתפריט מפעילה פונקציה פנימית; GoToMainMenu מחזיר לכאן.
  // אין ולו קריאה אחת ל-call.go_to_folder בקוד הזה - הניווט כולו פנימי.
  for (;;) {
    try {
      const choice = await call.read([
        { type: 'text', data: 'ברוכים הבאים לפורום מתמחים טופ הקולי', removeInvalidChars: true },
        { type: 'text', data: 'להאזנה לפוסטים אחרונים הקישו 1', removeInvalidChars: true },
        { type: 'text', data: 'לנושאים אחרונים הקישו 2', removeInvalidChars: true },
        { type: 'text', data: 'לקטגוריות הקישו 3', removeInvalidChars: true },
        { type: 'text', data: 'לעזרה הקישו 6', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      console.log(`[MAIN] נבחר: ${choice}`);

      switch (choice) {
        case '1': await recentPostsFlow(call, 1); break;
        case '2': await recentTopicsFlow(call, 1); break;
        case '3': await categoriesFlow(call); break;
        case '6': await helpFlow(call); break;
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
  console.log(`[YEMOT IN] ${req.method} ${req.originalUrl}`);
  const send = res.send.bind(res);
  res.send = (body) => {
    console.log(`[YEMOT OUT] ${req.originalUrl} ->`, typeof body === 'string' ? body.slice(0, 300) : body);
    return send(body);
  };
  next();
});

// בריאות המערכת - לבדיקה ידנית/ניטור
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: SERVER_BASE, time: new Date().toISOString() });
});

// חיבור הראוטר של ימות - נתיב יחיד תואם ל-api_link שהוגדר בשלוחה
app.use('/api/yemot', router.asExpressRouter);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`מתמחים IVR פועל על פורט ${port}`));
}

module.exports = app;
