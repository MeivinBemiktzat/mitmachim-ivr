// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם עבור פורום מתמחים טופ הטלפוני (NodeBB)
// נבנה עבור מערכות ה-IVR של ימות המשיח
// ============================================================================
// ארכיטקטורה v6.0 — תיקוני באגים קריטיים + שכלולים:
// ----------------------------------------------------------------------------
//  *** באג 1 שתוקן: "לאישור הקישו 1" ***
//  ברירת המחדל של ימות היא לבקש אישור אחרי כל הקשה (הפרמטר ה-15 של read).
//  הפתרון: שליחת read עם כל 15 הפרמטרים, כשהפרמטר ה-15 = "no".
//
//  *** באג 2 שתוקן: ה-state (tids) הגיע ריק ***
//  המבנה הנכון של שמירת state בימות הוא:
//      api_add_<INDEX>=<KEY>=<VALUE>
//  ולא api_add_<KEY>=<VALUE> (כפי שהיה בקוד הקודם).
//  בנוסף, התו "=" משמש כמפריד פרוטוקול, ולכן ערך ה-state
//  לא יכול להכיל "=", ">", "*", "&", "^", ".". אנו ממירים אותם.
//  מפריד המזהים הוא "x" (בטוח לחלוטין).
//
//  *** שכלולים ***
//  - הסרה מלאה של פיצ'ר החיפוש.
//  - ביטול מוחלט של "לאישור הקישו 1" בכל המסכים.
//  - תפריט ראשי חדש לגמרי, ניווט נוח, barge-in מלא.
//  - שמיעת נושא עם דפדוף הודעות חכם (עמודי NodeBB).
//  - דילוג קדימה/אחורה, חזרה על הודעה, קפיצה לסוף/התחלה.
//  - פרטי הודעה, מספר תגובות, מחבר, זמן פרסום.
//  - טיפול שגיאות מלא בכל מסך.
// ============================================================================

// ----------------------------------------------------------------------------
// משתני סביבה והגדרות קבועות
// ----------------------------------------------------------------------------
const FORUM_URL       = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS  = 950;
const DEFAULT_TIMEOUT = 9000;
const LIST_SIZE       = 9;
const NB_PAGE_SIZE    = 20;

// מפריד מזהים בטוח (לא מפריד פרוטוקול, לא מופיע במספרים)
const ID_SEP = 'x';

// ============================================================================
// פונקציות עזר לעבודה עם state ופרמטרי ימות
// ============================================================================

/**
 * פיצול מזהים — תומך ב-"x" (החדש), ">", "," (תאימות לאחור).
 */
function splitIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw)
    .split(/[x>,]/)
    .map(s => s.trim())
    .filter(s => s !== '' && /^\d+$/.test(s));
}

/**
 * איחוד מזהים למחרוזת בטוחה (מפריד "x").
 */
function joinIds(ids) {
  if (!ids || !ids.length) return '';
  return ids.map(x => String(x).trim()).filter(x => x !== '').join(ID_SEP);
}

/**
 * קריאת state מהבקשה.
 * אחרי api_add_INDEX=key=value, ימות מחזיר את הערך כ- q.key בבקשה הבאה.
 */
function getState(q, key) {
  const val = q[key];
  return val === undefined || val === null ? '' : String(val);
}

/**
 * בדיקה האם פרמטר הוקש בפועל.
 * חשוב: ימות עלול לשלוח מערך אם אותו שדה נשלח פעמיים — לוקחים את האחרון.
 */
function pressed(val) {
  if (Array.isArray(val)) val = val[val.length - 1];
  return val !== undefined && val !== null && String(val) !== '';
}

/**
 * נירמול ערך שעלול להגיע כמערך (ימות שולח לפעמים [..]) — מחזיר את האחרון.
 */
function lastVal(val) {
  if (Array.isArray(val)) return val.length ? String(val[val.length - 1]) : '';
  return val === undefined || val === null ? '' : String(val);
}

// ============================================================================
// שכבת תקשורת מול ה-Read API של NodeBB
// ============================================================================

async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-ivr/6.0',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`[NodeBB Error] HTTP ${res.status} for path: ${path}`);
      throw new Error(`NodeBB HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data) throw new Error('Empty JSON response');
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Fetch Exception] ${url} →`, error.message);
    throw error;
  }
}

async function fetchTopicPost(tid, postIndex) {
  const nbPage = Math.floor(postIndex / NB_PAGE_SIZE) + 1;
  const data  = await nbFetch('/topic/' + tid + '?page=' + nbPage);
  const posts = data.posts || [];
  const totalPosts = data.postcount || posts.length;
  const relativeIndex = postIndex - (nbPage - 1) * NB_PAGE_SIZE;
  const post = posts[relativeIndex] || null;
  return { topic: data, post, posts, relativeIndex, totalPosts };
}

// ============================================================================
// עיבוד טקסט להקראה (TTS)
// ============================================================================

function cleanText(html) {
  if (!html) return '';
  let text = String(html);

  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ציטוט ');
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' קטע קוד ');
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, ' קטע קוד ');

  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<\/p>/gi, '. ');
  text = text.replace(/<\/div>/gi, '. ');
  text = text.replace(/<\/li>/gi, '. ');
  text = text.replace(/<\/h[1-6]>/gi, '. ');

  text = text.replace(/<[^>]+>/g, ' ');

  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, ' ו ');
  text = text.replace(/&quot;/gi, ' ');
  text = text.replace(/&#39;|&apos;/gi, ' ');
  text = text.replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');
  text = text.replace(/&#x27;/gi, ' ').replace(/&x27;/gi, ' ');

  text = text.replace(/https?:\/\/\S+/gi, ' קישור ');

  // תווים שמשבשים את פרוטוקול ימות
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');

  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff    = Date.now() - Number(ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1)  return 'לפני פחות מדקה';
  if (minutes < 60) return 'לפני ' + minutes + ' דקות';
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'לפני שעה';
  if (hours === 2) return 'לפני שעתיים';
  if (hours < 24)  return 'לפני ' + hours + ' שעות';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'אתמול';
  if (days === 2) return 'לפני יומיים';
  if (days < 30)  return 'לפני ' + days + ' ימים';
  const months = Math.floor(days / 30);
  if (months === 1) return 'לפני חודש';
  if (months === 2) return 'לפני חודשיים';
  if (months < 12)  return 'לפני ' + months + ' חודשים';
  return 'לפני יותר משנה';
}

// ============================================================================
// בניית פקודות ימות המשיח
// ============================================================================

/**
 * ניקוי חלק טקסט מתווים שמשבשים את הפרוטוקול.
 */
function sanitizePart(part) {
  return String(part)
    .replace(/[.,=&*^>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * *** תיקון באג 1: ביטול "לאישור הקישו 1" ***
 *
 * פורמט read מלא של ימות (כל 15 הפרמטרים):
 *   VARNAME, reuse, max, min, timeout, type,
 *   blockStar, blockZero, replaceChar, allowedKeys,
 *   emptyTries, emptyAllowed, emptyText, keyboardChange, CONFIRM
 *
 * הפרמטר ה-15 (האחרון) = "no" → המערכת לא תבקש אישור אחרי הקשה.
 *
 * שדות שאנחנו לא רוצים להגדיר משאירים ריקים (ימות לוקח ברירת מחדל).
 */
function buildReadMenu(parts, paramName, opts = {}) {
  const min       = opts.min ?? 1;
  const max       = opts.max ?? 1;
  const waitSec   = opts.waitSec ?? 7;
  const type      = opts.type || 'Digits';
  const blockStar = opts.blockStar || 'no';
  const blockZero = opts.blockZero || 'no';

  const promptStr = parts
    .filter(p => p && String(p).trim())
    .map(p => 't-' + sanitizePart(p))
    .join('.');

  // מבנה 15 הפרמטרים — הפרמטר האחרון "no" מבטל את בקשת האישור.
  // VARNAME,reuse,max,min,timeout,type,blockStar,blockZero,,,,,,,no
  const readParams = [
    paramName,   // 1 שם משתנה
    'no',        // 2 שימוש חוזר בערך קיים
    max,         // 3 מקסימום ספרות
    min,         // 4 מינימום ספרות
    waitSec,     // 5 timeout
    type,        // 6 סוג השמעה
    blockStar,   // 7 חסימת כוכבית
    blockZero,   // 8 חסימת אפס
    '',          // 9 החלפת תו
    '',          // 10 מקשים מותרים
    '',          // 11 פעמים ל"ריק"
    '',          // 12 ריק מותר
    '',          // 13 טקסט ריק
    '',          // 14 שינוי מקלדת
    'no'         // 15 *** ביטול בקשת אישור ***
  ];

  return `read=${promptStr}=${readParams.join(',')}`;
}

/**
 * read "שקט" קצר למעברים פנימיים — גם הוא ללא אישור (פרמטר 15 = no).
 */
function buildSilentRead(text) {
  const t = sanitizePart(text || 'טוען');
  return `read=t-${t}=dummy,no,1,1,1,Digits,no,no,,,,,,,no`;
}

// ============================================================================
// בניית רשימות תוכן להקראה
// ============================================================================

function buildTopicListParts(topics, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);

  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים להצגה');
    if (footerText) parts.push(footerText);
    return parts;
  }

  topics.forEach((tp, i) => {
    const num      = i + 1;
    const title    = ttsCut(tp.title, MAX_TITLE_CHARS);
    const username = tp.user && tp.user.username ? tp.user.username : 'משתמש';
    const replies  = tp.postcount ? Math.max(0, tp.postcount - 1) : 0;

    parts.push(`נושא מספר ${num}`);
    parts.push(title);
    parts.push(`מאת ${username}`);
    if (replies === 1)      parts.push('תגובה אחת');
    else if (replies > 1)   parts.push(`${replies} תגובות`);
    else                    parts.push('ללא תגובות');
    parts.push(`להאזנה הקישו ${num}`);
  });

  if (footerText) parts.push(footerText);
  return parts;
}

function buildCategoryListParts(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);

  if (!cats || cats.length === 0) {
    parts.push('לא נמצאו קטגוריות זמינות');
    return parts;
  }

  cats.forEach((c, i) => {
    const num  = i + 1;
    const name = cleanText(c.name);
    const cnt  = c.topic_count || c.totalTopicCount || 0;
    parts.push(`קטגוריה מספר ${num}`);
    parts.push(name);
    if (cnt > 0) parts.push(`${cnt} נושאים`);
    parts.push(`לכניסה הקישו ${num}`);
  });

  return parts;
}

// ============================================================================
// *** תיקון באג 2: בניית תגובה עם שמירת state נכונה ***
// ============================================================================

/**
 * ניקוי ערך state מתווים שמשבשים את הפרוטוקול.
 * הערך לא יכול להכיל = > * & ^ . (מפרידי פרוטוקול).
 * מזהים מאוחדים תמיד עם "x" אז הם בטוחים ממילא.
 */
function sanitizeStateValue(val) {
  return String(val).replace(/[=>*&^.,]/g, '');
}

/**
 * *** המבנה הנכון של api_add בימות ***
 *
 * לפי המדריך (עמוד 5):
 *   api_add_0=foo=111
 *   api_add_1=bar=222
 *
 * כלומר: api_add_<INDEX>=<KEY>=<VALUE>
 * חובה על רצף סידורי החל מ-0.
 *
 * בבקשה הבאה ימות מחזיר את הערכים כ- q.foo=111 וכו'.
 */
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  let index = 0;
  for (const key in stateParams) {
    let val = stateParams[key];
    if (val === undefined || val === null) continue;
    val = sanitizeStateValue(val);
    out += `&api_add_${index}=${key}=${val}`;
    index++;
  }
  console.log(`[v0] buildResponse: ${out.substring(0, 240)}`);
  return out;
}

function buildTransition(text, stateParams = {}) {
  return buildResponse(buildSilentRead(text), stateParams);
}

// ============================================================================
// פונקציית הראוטר המרכזית (Serverless Handler של Vercel)
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // איחוד פרמטרים נכנסים (GET + POST)
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(q, req.body);
  }

  // נירמול: אם שדה הגיע כמערך (נשלח פעמיים), קח את האחרון
  for (const k in q) {
    if (Array.isArray(q[k])) q[k] = q[k][q[k].length - 1];
  }

  console.log(`[IVR Request] screen=${getState(q, 'screen')} q=${JSON.stringify(q).substring(0, 300)}`);

  let currentScreen = getState(q, 'screen') || 'main';

  try {
    // ========================================================================
    // שלב א': עיבוד הקשות משתמש
    // ========================================================================

    // ---- 1. תפריט ראשי ----
    if (pressed(q.mainsel)) {
      const sel = lastVal(q.mainsel).trim();
      console.log(`[Menu] mainsel=${sel}`);

      if      (sel === '1') { currentScreen = 'recent'; }
      else if (sel === '2') { currentScreen = 'topics'; }
      else if (sel === '3') { currentScreen = 'categories'; }
      else {
        const readCmd = buildReadMenu([
          'הבחירה שגויה אנא נסו שנית',
          'לפוסטים האחרונים הקישו 1',
          'לנושאים החדשים שנפתחו הקישו 2',
          'לכניסה לפי קטגוריות הקישו 3'
        ], 'mainsel', { waitSec: 8 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ---- 2. מסך פוסטים אחרונים (recent) ----
    if (pressed(q.recentsel)) {
      const sel      = lastVal(q.recentsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      console.log(`[recentsel] sel=${sel}, tids="${getState(q, 'tids')}", count=${topicIds.length}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'recent';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען את הנושא', {
            screen: 'topic', tid: topicIds[index], pidx: '0'
          }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'recentsel', { waitSec: 8 });
        return res.send(buildResponse(readCmd, {
          tids: joinIds(topicIds), screen: 'recent'
        }));
      }
    }

    // ---- 3. מסך נושאים חדשים (topics) ----
    if (pressed(q.topicsel)) {
      const sel      = lastVal(q.topicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      console.log(`[topicsel] sel=${sel}, count=${topicIds.length}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'topics';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', {
            screen: 'topic', tid: topicIds[index], pidx: '0'
          }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicsel', { waitSec: 8 });
        return res.send(buildResponse(readCmd, {
          tids: joinIds(topicIds), screen: 'topics'
        }));
      }
    }

    // ---- 4. מסך קטגוריות (categories) ----
    if (pressed(q.catsel)) {
      const sel         = lastVal(q.catsel).trim();
      const currentCid  = getState(q, 'curcid');
      const categoryIds = splitIds(getState(q, 'cids'));
      console.log(`[catsel] sel=${sel}, cids=${categoryIds.length}, curcid=${currentCid}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        if (currentCid) {
          return res.send(buildTransition('טוען נושאים בקטגוריה', {
            screen: 'cattopics', cid: currentCid, catpage: '1'
          }));
        }
        currentScreen = 'categories';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          return res.send(buildTransition('טוען קטגוריה', {
            screen: 'categories', cid: categoryIds[index]
          }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          categoryIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + categoryIds.length
            : 'הרשימה אינה זמינה כעת',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'catsel', { waitSec: 8 });
        return res.send(buildResponse(readCmd, {
          cids: joinIds(categoryIds), curcid: currentCid || '', screen: 'categories'
        }));
      }
    }

    // ---- 5. נושאים בתוך קטגוריה (cattopicsel) ----
    if (pressed(q.cattopicsel)) {
      const sel      = lastVal(q.cattopicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      const cid      = getState(q, 'cid');
      const catpage  = parseInt(getState(q, 'catpage') || '1', 10);
      console.log(`[cattopicsel] sel=${sel}, count=${topicIds.length}, cid=${cid}, page=${catpage}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        return res.send(buildTransition('עמוד הבא', {
          screen: 'cattopics', cid, catpage: String(catpage + 1)
        }));
      } else if (sel === '#') {
        return res.send(buildTransition('עמוד קודם', {
          screen: 'cattopics', cid, catpage: String(Math.max(1, catpage - 1))
        }));
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען את הנושא', {
            screen: 'topic', tid: topicIds[index], pidx: '0'
          }));
        }
        const readCmd = buildReadMenu([
          'בחירה שגויה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לעמוד הבא הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'cattopicsel', { waitSec: 8, blockStar: 'no' });
        return res.send(buildResponse(readCmd, {
          tids: joinIds(topicIds), cid, catpage: String(catpage), screen: 'cattopics'
        }));
      }
    }

    // ---- 6. ניווט בתוך נושא (topicnav) ----
    if (pressed(q.topicnav)) {
      const sel  = lastVal(q.topicnav).trim();
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      console.log(`[topicnav] sel=${sel}, tid=${tid}, pidx=${pidx}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '1') {
        return res.send(buildTransition('ההודעה הבאה', {
          screen: 'topic', tid, pidx: String(pidx + 1)
        }));
      } else if (sel === '2') {
        return res.send(buildTransition('ההודעה הקודמת', {
          screen: 'topic', tid, pidx: String(Math.max(0, pidx - 1))
        }));
      } else if (sel === '3') {
        return res.send(buildTransition('משמיע שוב', {
          screen: 'topic', tid, pidx: String(pidx)
        }));
      } else if (sel === '4') {
        return res.send(buildTransition('מדלג חמש הודעות קדימה', {
          screen: 'topic', tid, pidx: String(pidx + 5)
        }));
      } else if (sel === '5') {
        return res.send(buildTransition('חוזר לתחילת הנושא', {
          screen: 'topic', tid, pidx: '0'
        }));
      } else if (sel === '6') {
        const details = String(getState(q, 'details') || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        const readCmd = buildReadMenu(details, 'detback', { waitSec: 7 });
        return res.send(buildResponse(readCmd, {
          screen: 'detback', tid, pidx: String(pidx)
        }));
      } else {
        return res.send(buildTransition('בחירה שגויה', {
          screen: 'topic', tid, pidx: String(pidx)
        }));
      }
    }

    // ---- 7. חזרה מפרטי הודעה (detback) ----
    if (pressed(q.detback)) {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      return res.send(buildTransition('חוזר להודעה', {
        screen: 'topic', tid, pidx: String(pidx)
      }));
    }

    // ---- 8. סיום נושא (topicend) ----
    if (pressed(q.topicend)) {
      const sel = lastVal(q.topicend).trim();
      const tid = getState(q, 'tid');
      if (sel === '1') {
        return res.send(buildTransition('מתחילים מחדש', {
          screen: 'topic', tid, pidx: '0'
        }));
      } else if (sel === '2') {
        currentScreen = 'recent';
      } else {
        currentScreen = 'main';
      }
    }

    // ========================================================================
    // שלב ב': הפקת המסכים
    // ========================================================================

    // ===== תפריט ראשי =====
    if (currentScreen === 'main') {
      const readCmd = buildReadMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'mainsel', { waitSec: 8 });
      return res.send(buildResponse(readCmd, { screen: 'main' }));
    }

    // ===== פוסטים אחרונים =====
    if (currentScreen === 'recent') {
      console.log('[Render] recent posts');
      const data   = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, LIST_SIZE);

      const parts = buildTopicListParts(
        topics,
        'הפוסטים האחרונים בפורום',
        'לרענון הרשימה הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס'
      );

      const readCmd = buildReadMenu(parts, 'recentsel', { waitSec: 10 });
      return res.send(buildResponse(readCmd, {
        tids: joinIds(topics.map(t => t.tid)), screen: 'recent'
      }));
    }

    // ===== נושאים חדשים =====
    if (currentScreen === 'topics') {
      console.log('[Render] newest topics');
      let data;
      try {
        data = await nbFetch('/recent?term=alltime&sort=newest');
      } catch (e) {
        data = await nbFetch('/recent');
      }

      const topics = (data.topics || [])
        .slice()
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, LIST_SIZE);

      const parts = buildTopicListParts(
        topics,
        'הנושאים החדשים ביותר שנפתחו בפורום',
        'לרענון הרשימה הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס'
      );

      const readCmd = buildReadMenu(parts, 'topicsel', { waitSec: 10 });
      return res.send(buildResponse(readCmd, {
        tids: joinIds(topics.map(t => t.tid)), screen: 'topics'
      }));
    }

    // ===== קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = getState(q, 'cid');
      console.log(`[Render] categories, cid=${cid || 'root'}`);

      let categoriesList = [];
      let headerText     = '';

      if (!cid) {
        const data     = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        headerText     = 'תפריט קטגוריות ראשיות';
      } else {
        const data     = await nbFetch('/category/' + cid);
        const parentName = cleanText(data.name || '');
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        headerText     = 'קטגוריית ' + parentName;
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        if (cid) parts.push('לשמיעת הנושאים בקטגוריה זו הקישו כוכבית');
        parts.push('לחזרה לתפריט הראשי הקישו אפס');

        const readCmd = buildReadMenu(parts, 'catsel', { waitSec: 10 });
        return res.send(buildResponse(readCmd, {
          cids: joinIds(categoriesList.map(c => c.cid)),
          curcid: cid || '', screen: 'categories'
        }));
      } else if (cid) {
        return res.send(buildTransition('טוען נושאים', {
          screen: 'cattopics', cid, catpage: '1'
        }));
      } else {
        const readCmd = buildReadMenu([
          'לא נמצאו קטגוריות', 'חוזר לתפריט הראשי'
        ], 'mainsel', { waitSec: 4 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ===== נושאים בתוך קטגוריה =====
    if (currentScreen === 'cattopics') {
      const cid     = getState(q, 'cid');
      const catpage = Math.max(1, parseInt(getState(q, 'catpage') || '1', 10));

      if (!cid) {
        return res.send(buildTransition('אירעה שגיאה חוזר לתפריט', { screen: 'main' }));
      }

      console.log(`[Render] cattopics cid=${cid}, page=${catpage}`);
      const data    = await nbFetch('/category/' + cid + '?page=' + catpage);
      const topics  = (data.topics || []).slice(0, LIST_SIZE);
      const catName = cleanText(data.name || '');

      const footerParts = [];
      if (catpage > 1)                 footerParts.push('לעמוד הקודם הקישו סולמית');
      if (topics.length === LIST_SIZE) footerParts.push('לעמוד הבא הקישו כוכבית');
      footerParts.push('לחזרה לתפריט הראשי הקישו אפס');

      const parts = buildTopicListParts(
        topics,
        `נושאים בקטגוריית ${catName} עמוד ${catpage}`,
        footerParts.join('. ')
      );

      const readCmd = buildReadMenu(parts, 'cattopicsel', { waitSec: 10 });
      return res.send(buildResponse(readCmd, {
        tids: joinIds(topics.map(t => t.tid)),
        cid, catpage: String(catpage), screen: 'cattopics'
      }));
    }

    // ===== שמיעת נושא =====
    if (currentScreen === 'topic') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);

      if (!tid) {
        return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));
      }

      console.log(`[Render] topic tid=${tid}, postIndex=${pidx}`);

      const result     = await fetchTopicPost(tid, pidx);
      const topic      = result.topic;
      const post       = result.post;
      const totalPosts = result.totalPosts;
      const topicTitle = ttsCut(topic.title, MAX_TITLE_CHARS);

      if (!post || pidx >= totalPosts) {
        const readCmd = buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          totalPosts === 1 ? 'הנושא כולל הודעה אחת בלבד'
                           : `הנושא כולל ${totalPosts} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לרשימת הפוסטים האחרונים הקישו 2',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 9 });
        return res.send(buildResponse(readCmd, { tid, screen: 'topicend' }));
      }

      const postBody   = ttsCut(post.content, MAX_BODY_CHARS);
      const authorName = post.user && post.user.username ? post.user.username : 'משתמש';

      const audioParts = [];
      if (pidx === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle);
        audioParts.push(totalPosts === 1 ? 'הנושא מכיל הודעה אחת'
                                         : `הנושא מכיל ${totalPosts} הודעות`);
      }
      audioParts.push(`הודעה מספר ${pidx + 1} מתוך ${totalPosts}`);
      audioParts.push(`נכתבה על ידי ${authorName}`);
      audioParts.push(postBody);
      audioParts.push('להודעה הבאה הקישו 1');
      audioParts.push('להודעה הקודמת הקישו 2');
      audioParts.push('להאזנה חוזרת הקישו 3');
      audioParts.push('לדילוג חמש הודעות הקישו 4');
      audioParts.push('לתחילת הנושא הקישו 5');
      audioParts.push('לפרטי ההודעה הקישו 6');
      audioParts.push('לתפריט הראשי הקישו אפס');

      const postDetails = [
        `פרטי הודעה מספר ${pidx + 1}`,
        `המחבר ${authorName}`,
        `פורסם ${timeAgo(post.timestamp)}`,
        totalPosts === 1 ? 'הנושא כולל הודעה אחת'
                         : `הנושא כולל ${totalPosts} הודעות בסך הכל`
      ];
      const detailsSafe = postDetails.map(d => sanitizePart(d)).join('|');

      const readCmd = buildReadMenu(audioParts, 'topicnav', { waitSec: 15 });
      return res.send(buildResponse(readCmd, {
        tid, pidx: String(pidx), screen: 'topic', details: detailsSafe
      }));
    }

    // ===== הגנת קצה =====
    console.warn(`[Fallback] Unhandled screen: ${currentScreen}`);
    return res.send(buildTransition('חוזר להתחלה', { screen: 'main' }));

  } catch (globalError) {
    console.error('[Global Exception]', globalError.message);
    const readCmd = buildReadMenu([
      'אירעה שגיאה בטעינת הנתונים מהפורום',
      'אנא נסו שוב מאוחר יותר',
      'לחזרה לתפריט הראשי הקישו אפס'
    ], 'mainsel', { waitSec: 6 });
    return res.send(buildResponse(readCmd, { screen: 'main' }));
  }
};
