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
 *   1. תשתית: קבועים, cache, HTTP client לפורום
 *   2. שכבת נתונים: פונקציות שמביאות מידע מ-NodeBB API (עם retry)
 *   3. שכבת הקראה: המרת תוכן פורום למבני message של ימות (טיפול בתאריכים, מחברים וכו')
 *   4. עזרי ניווט משותפים ושמירת מיקום האזנה
 *   5. שכבת ניווט: תפריטים (ראשי, קטגוריות, אשכולות, הודעות, חיפוש, אישי, עזרה, הגדרות, מנהל)
 *   6. הרכבת הראוטר וייצוא ל-Vercel
 *
 * הערה: מוזיקת רקע (music_on_hold) אינה מנוהלת בקוד זה בכלל -
 * היא מוגדרת ומופעלת ברמת השלוחה בממשק ניהול ימות המשיח בלבד.
 */

'use strict';

const express = require('express');
const { YemotRouter, ExitError } = require('yemot-router2');
const NodeCache = require('node-cache');
const axios = require('axios');
const { put, head, del } = require('@vercel/blob');

/* ============================================================
 * 1. תשתית כללית
 * ============================================================ */

const FORUM_BASE = 'https://mitmachim.top';
const SERVER_BASE = 'https://mitmachim-ivr.vercel.app';

// מטמון בזיכרון - TTL קצר לתוכן דינמי (פוסטים/נושאים), ארוך יותר לקטגוריות
const cache = new NodeCache({ stdTTL: 90, checkperiod: 30, useClones: false });
const CACHE_TTL = {
  recent: 60,       // פוסטים/נושאים אחרונים
  categories: 600,  // רשימת קטגוריות - משתנה לעיתים רחוקות
  category: 90,      // נושאים בקטגוריה מסוימת
  topic: 60          // הודעות באשכול
};

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

/** עטיפת cache-aside גנרית: מחזיר מהמטמון אם קיים, אחרת שולף ושומר. */
async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await withRetry(fetcher, 1);
  cache.set(key, value, ttl);
  return value;
}

/* ============================================================
 * 2. שכבת נתונים - NodeBB REST API (mitmachim.top)
 * NodeBB חושף כל דף כ-JSON על ידי הוספת api/ בתחילת הנתיב.
 * לדוגמה: mitmachim.top/recent -> mitmachim.top/api/recent
 * ============================================================ */

/** פוסטים/נושאים אחרונים בפורום. */
async function fetchRecentTopics(page = 1) {
  return cached(`recent:${page}`, CACHE_TTL.recent, async () => {
    const { data } = await http.get('/api/recent', { params: { page } });
    return data;
  });
}

/** רשימת כל הקטגוריות בפורום, כולל תתי-קטגוריות (NodeBB מחזיר עץ עם children). */
async function fetchCategories() {
  return cached('categories', CACHE_TTL.categories, async () => {
    const { data } = await http.get('/api/categories');
    return data;
  });
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
  return cached(`cat:${slug || cid}:${page}`, CACHE_TTL.category, async () => {
    const path = slug ? `/api/category/${slug}` : `/api/category/${cid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  });
}

/** תוכן אשכול (topic) שלם, כולל כל ההודעות (posts). הערה: ב-NodeBB slug של נושא
 *  מגיע כבר בפורמט המלא "tid/טקסט-סלאג" - לא להוסיף tid בנפרד לפני ה-slug. */
async function fetchTopic(tid, slug, page = 1) {
  return cached(`topic:${slug || tid}:${page}`, CACHE_TTL.topic, async () => {
    const path = slug ? `/api/topic/${slug}` : `/api/topic/${tid}`;
    const { data } = await http.get(path, { params: { page } });
    return data;
  });
}

/** חיפוש חופשי בפורום. */
async function searchForum(term, page = 1) {
  return cached(`search:${term}:${page}`, CACHE_TTL.recent, async () => {
    const { data } = await http.get('/api/search', {
      params: { term, in: 'titlesposts', page }
    });
    return data;
  });
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

/**
 * שמירת מצב משתמש (מיקום אחרון וכו') ב-Vercel Blob, לפי מספר טלפון.
 * דורש משתנה סביבה BLOB_READ_WRITE_TOKEN (מוגדר אוטומטית ע"י Vercel כשמחברים Blob Store).
 * נכשל בשקט (לא מפיל שיחה) אם האחסון לא זמין רגעית - רק רושם ללוג.
 */
function positionBlobKey(phone) {
  return `ivr-state/${phone}.json`;
}

async function saveLastPosition(phone, state) {
  if (!phone) return;
  try {
    const body = JSON.stringify({ ...state, savedAt: Date.now() });
    await put(positionBlobKey(phone), body, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true
    });
    console.log(`[BLOB] נשמר מיקום עבור ${phone}:`, state);
  } catch (err) {
    console.error(`[BLOB] כשל בשמירת מיקום עבור ${phone}:`, err.message);
  }
}

async function getLastPosition(phone) {
  if (!phone) return null;
  try {
    const meta = await head(positionBlobKey(phone));
    const { data } = await axios.get(meta.url, { timeout: 5000 });
    console.log(`[BLOB] נטען מיקום עבור ${phone}:`, data);
    return data;
  } catch (err) {
    const notFound = err.response?.status === 404 || err.status === 404 || /does not exist/i.test(err.message || '');
    if (notFound) {
      console.log(`[BLOB] אין מיקום שמור עבור ${phone} (ראשוני/נוקה)`);
    } else {
      console.error(`[BLOB] כשל בטעינת מיקום עבור ${phone}:`, err.message);
    }
    return null;
  }
}

async function clearLastPosition(phone) {
  if (!phone) return;
  try {
    await del(positionBlobKey(phone));
  } catch (err) {
    console.error(`[BLOB] כשל במחיקת מיקום עבור ${phone}:`, err.message);
  }
}

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

/* ---------- שלוחה 2: נושאים אחרונים (כותרת + מטא-דאטה של הנושא, לא ה-teaser) ---------- */

async function recentTopicsFlow(call, page) {
  let data;
  try {
    data = await fetchRecentTopics(page);
  } catch (err) {
    console.error('[recentTopicsFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'לא ניתן לטעון כרגע נושאים אחרונים, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const topics = data.topics || [];
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
      await saveLastPosition(call.phone, { type: 'list', context, index: i });
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
      return categoryFlow(call, cat.cid, cat.slug || '', 1);
    }
    if (key === '9') { i++; continue; }
    if (key === '7') { i = Math.max(0, i - 1); continue; }
    if (key === '0' || key === '*') throw new GoToMainMenu();
    i++;
  }

  throw new GoToMainMenu();
}

/** האזנה לכל האשכולות בקטגוריה נתונה. */
async function categoryFlow(call, cid, slugParam, page) {
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
  if (topics.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'אין אשכולות בקטגוריה זו כרגע', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  await browseTopicList(call, topics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: () => categoryFlow(call, cid, slugParam, page + 1),
    onPrevPage: page > 1 ? () => categoryFlow(call, cid, slugParam, page - 1) : null,
    context: `category:${cid}:${page}`
  });
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
    await saveLastPosition(call.phone, { type: 'topic', tid, slug: slugParam, page, idx });

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

/* ---------- חזרה למיקום האחרון / המשך האזנה ---------- */

async function resumeFlow(call) {
  const pos = await getLastPosition(call.phone);
  if (!pos || pos.type !== 'topic') {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצא מיקום שמור מהשיחה הנוכחית', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }
  return topicFlow(call, pos.tid, pos.slug || '', pos.page || 1, pos.idx || 0);
}

/* ---------- חיפוש ---------- */

async function searchFlow(call) {
  const term = await call.read([
    { type: 'text', data: 'אנא הקליטו את מילת החיפוש ולאחריה הקישו סולמית', removeInvalidChars: true }
  ], 'stt', { max_digits: '' });

  const query = (term || '').trim();
  if (!query) {
    return call.id_list_message([
      { type: 'text', data: 'לא זוהתה מילת חיפוש, נסו שוב מאוחר יותר', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  let data;
  try {
    data = await searchForum(query, 1);
  } catch (err) {
    console.error('[searchFlow] שגיאת שליפה', err.message);
    return call.id_list_message([
      { type: 'text', data: 'שגיאה בביצוע החיפוש, אנא נסו שוב', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const results = data.posts || data.topics || [];
  if (results.length === 0) {
    return call.id_list_message([
      { type: 'text', data: 'לא נמצאו תוצאות התואמות את החיפוש', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const asTopics = results.map((r) => r.topic ? { ...r.topic, tid: r.topic.tid || r.tid } : r);

  await browseTopicList(call, asTopics, {
    onOpen: (t) => topicFlow(call, t.tid, t.slug || '', 1, 0),
    onNextPage: null,
    onPrevPage: null,
    context: `search:${query}`
  });
}

/* ---------- תפריט אישי ---------- */

async function personalFlow(call) {
  const key = await call.read([
    { type: 'text', data: 'תפריט אישי', removeInvalidChars: true },
    { type: 'text', data: 'להמשך האזנה מהמקום האחרון הקישו 1', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה לתפריט הראשי הקישו 0', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (key === '1') return resumeFlow(call);
  throw new GoToMainMenu();
}

/* ---------- עזרה ---------- */

async function helpFlow(call) {
  await call.id_list_message([
    { type: 'text', data: 'מדריך ניווט מהיר', removeInvalidChars: true },
    { type: 'text', data: 'בכל שלב, הקישו 9 למעבר להודעה או פריט הבא', removeInvalidChars: true },
    { type: 'text', data: 'הקישו 7 לחזרה להודעה או לפריט הקודם', removeInvalidChars: true },
    { type: 'text', data: 'הקישו 0 לחזרה לתפריט הקודם או לקטגוריות', removeInvalidChars: true },
    { type: 'text', data: 'הקישו כוכבית בכל עת לחזרה לתפריט הראשי', removeInvalidChars: true },
    { type: 'text', data: 'בתוך אשכול, ניתן להקיש את מספר ההודעה כדי לדלג ישירות אליה', removeInvalidChars: true }
  ], { prependToNextAction: true });
}

/* ---------- הגדרות ---------- */

async function settingsFlow(call) {
  const key = await call.read([
    { type: 'text', data: 'תפריט הגדרות', removeInvalidChars: true },
    { type: 'text', data: 'לניקוי המטמון והבאת תוכן עדכני הקישו 1', removeInvalidChars: true },
    { type: 'text', data: 'לחזרה לתפריט הראשי הקישו 0', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (key === '1') {
    cache.flushAll();
    await call.id_list_message([
      { type: 'text', data: 'המטמון נוקה בהצלחה', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }
}

/* ---------- תפריט מנהל (מוגן בקוד סודי מסביבת ההרצה) ---------- */

async function adminFlow(call) {
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    return call.id_list_message([
      { type: 'text', data: 'תפריט מנהל אינו מוגדר במערכת', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const pin = await call.read([
    { type: 'text', data: 'אנא הקישו את קוד המנהל', removeInvalidChars: true }
  ], 'tap', { max_digits: 10, min_digits: 1, sec_wait: 8, typing_playback_mode: 'No' });

  if (pin !== adminPin) {
    return call.id_list_message([
      { type: 'text', data: 'קוד שגוי', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  const key = await call.read([
    { type: 'text', data: 'תפריט מנהל', removeInvalidChars: true },
    { type: 'text', data: 'לניקוי כל המטמון הקישו 1', removeInvalidChars: true },
    { type: 'text', data: `סטטיסטיקת מטמון: ${cache.keys().length} רשומות`, removeInvalidChars: true },
    { type: 'text', data: 'לחזרה הקישו 0', removeInvalidChars: true }
  ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

  if (key === '1') {
    cache.flushAll();
    await call.id_list_message([
      { type: 'text', data: 'המטמון נוקה', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }
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
        { type: 'text', data: 'לחיפוש הקישו 4', removeInvalidChars: true },
        { type: 'text', data: 'לתפריט אישי הקישו 5', removeInvalidChars: true },
        { type: 'text', data: 'לעזרה הקישו 6', removeInvalidChars: true },
        { type: 'text', data: 'להגדרות הקישו 8', removeInvalidChars: true },
        { type: 'text', data: 'לחזרה למיקום האחרון הקישו 0', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      console.log(`[MAIN] נבחר: ${choice}`);

      switch (choice) {
        case '1': await recentPostsFlow(call, 1); break;
        case '2': await recentTopicsFlow(call, 1); break;
        case '3': await categoriesFlow(call); break;
        case '4': await searchFlow(call); break;
        case '5': await personalFlow(call); break;
        case '6': await helpFlow(call); break;
        case '8': await settingsFlow(call); break;
        case '9': await adminFlow(call); break;
        case '0': await resumeFlow(call); break;
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
  res.json({ status: 'ok', server: SERVER_BASE, cacheKeys: cache.keys().length, time: new Date().toISOString() });
});

// חיבור הראוטר של ימות - נתיב יחיד תואם ל-api_link שהוגדר בשלוחה
app.use('/api/yemot', router.asExpressRouter);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`מתמחים IVR פועל על פורט ${port}`));
}

module.exports = app;
