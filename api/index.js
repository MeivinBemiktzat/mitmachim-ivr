// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם עבור פורום מתמחים טופ (NodeBB) — IVR ימות המשיח
// ============================================================================
// ארכיטקטורה v7.0 — תיקון יסודי + שכלולים
// ----------------------------------------------------------------------------
//
//  *** הבאג האמיתי שתוקן (מה שכל הכלים פספסו) ***
//  ימות צוברת בכל בקשה את כל ההקשות מתחילת השיחה:
//      screen=main&mainsel=1&recentsel=1&recentsel=2&mainsel=2&mainsel=3 ...
//  כך, גם כשהמשתמש כבר במסך אחר, ההקשות הישנות (recentsel/mainsel)
//  נשארות "תקועות" בבקשה. הקוד הישן נכנס לכמה בלוקים בו-זמנית
//  והדריס את ה-state -> "הבחירה שגויה" / לא נכנס לפוסט.
//
//  הפתרון:
//  1. כל בקשה כוללת מונה צעדים ייחודי (step). אנחנו מייצרים שם פרמטר
//     קלט ייחודי לכל מסך+צעד, כך שהקשה ישנה לעולם לא תזוהה כחדשה.
//  2. הראוטר מסתמך אך ורק על 'screen' כמקור אמת, ומעבד אך ורק את
//     פרמטר הקלט של אותו מסך לאותו צעד. כל השאר — מתעלמים.
//  3. ביטול מוחלט של "לאישור הקישו 1" (פרמטר 15 = no).
//  4. מבנה api_add_<INDEX>=<KEY>=<VALUE> נכון.
//
//  *** שכלולים ***
//  - הסרה מלאה של פיצ'ר החיפוש (לא היה, ומוודאים שאין).
//  - מסך "מועדפים זמניים" לשיחה (סימון נושאים).
//  - ניווט משופר בתוך נושא: הבא/קודם/חזרה/דילוג/קפיצה/פרטים.
//  - דפדוף עמודים בקטגוריות וברשימות.
//  - הקראת זמן פרסום, מחבר, מספר תגובות.
//  - טיפול שגיאות מלא, fallback חכם בכל מסך.
// ============================================================================

const FORUM_URL       = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS  = 950;
const DEFAULT_TIMEOUT = 9000;
const LIST_SIZE       = 9;
const NB_PAGE_SIZE    = 20;

// מפריד מזהים בטוח (לא מפריד פרוטוקול, לא מופיע במספרים)
const ID_SEP = 'x';

// ============================================================================
// עזרי מזהים ו-state
// ============================================================================

function splitIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw)
    .split(/[x>,]/)
    .map(s => s.trim())
    .filter(s => s !== '' && /^\d+$/.test(s));
}

function joinIds(ids) {
  if (!ids || !ids.length) return '';
  return ids.map(x => String(x).trim()).filter(x => x !== '').join(ID_SEP);
}

function getState(q, key) {
  const val = q[key];
  return val === undefined || val === null ? '' : String(val);
}

/**
 * נירמול ערך שעלול להגיע כמערך — מחזיר את האחרון בפועל.
 */
function lastVal(val) {
  if (Array.isArray(val)) return val.length ? String(val[val.length - 1]) : '';
  return val === undefined || val === null ? '' : String(val);
}

function pressed(val) {
  const v = lastVal(val);
  return v !== '';
}

/**
 * *** ליבת התיקון ***
 * שם פרמטר קלט ייחודי לכל מסך + צעד.
 * כך הקשה ישנה מצעד קודם לעולם לא תזוהה כחדשה,
 * כי שם הפרמטר שלה שונה משם הפרמטר של הצעד הנוכחי.
 */
function inputKey(screen, step) {
  return 'k_' + screen + '_' + step;
}

/**
 * קריאת ההקשה של המסך הנוכחי בלבד.
 * אנחנו בונים את שם הפרמטר מתוך screen+step שנשמרו ב-state,
 * וקוראים אך ורק אותו. כל ההקשות הישנות מתעלמים מהן.
 */
function readInput(q, screen, step) {
  const key = inputKey(screen, step);
  return lastVal(q[key]).trim();
}

// ============================================================================
// שכבת תקשורת מול NodeBB Read API
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
        'User-Agent': 'yemot-nodebb-bridge-ivr/7.0',
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
// בניית פקודות ימות
// ============================================================================

function sanitizePart(part) {
  return String(part)
    .replace(/[.,\-_=+&*^>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * read מלא (15 פרמטרים). פרמטר 15 = "no" -> ללא "לאישור הקישו 1".
 * שם הפרמטר (paramName) הוא הייחודי-לצעד, כדי למנוע צבירה.
 */
function buildReadMenu(parts, paramName, opts = {}) {
  const min       = opts.min ?? 1;
  const max       = opts.max ?? 1;
  const waitSec   = opts.waitSec ?? 7;
  const type      = opts.type || 'Digits';
  const blockStar = opts.blockStar || 'no';
  const blockZero = opts.blockZero || 'no';

  const cleanParts = parts
    .filter(p => p && String(p).trim())
    .map(p => sanitizePart(p));

  const promptStr = 't-' + cleanParts.join('. ');

  const readParams = [
    paramName,   // 1 שם משתנה (ייחודי לצעד!)
    'no',        // 2 שימוש חוזר
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
    'no'         // 15 ביטול בקשת אישור
  ];

  return `read=${promptStr}=${readParams.join(',')}`;
}

function buildSilentRead(text, paramName) {
  const t = sanitizePart(text || 'טוען');
  const name = paramName || 'dummy';
  return `read=t-${t}=${name},no,1,1,1,Digits,no,no,,,,,,,no`;
}

// ============================================================================
// בניית רשימות תוכן
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
// בניית תגובה עם state
// ============================================================================

function sanitizeStateValue(val) {
  return String(val).replace(/[=>*&^.,]/g, '');
}

/**
 * api_add_<INDEX>=<KEY>=<VALUE> ברצף החל מ-0.
 */
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  let index = 0;
  for (const key in stateParams) {
    let val = stateParams[key];
    if (val === undefined || val === null) continue;
    val = sanitizeStateValue(val);
    out += `\napi_add_${index}=${key}=${val}`; // <--- תיקון: ירידת שורה ללא &
    index++;
  }
  console.log(`[v0] buildResponse: ${out.replace(/\n/g, ' [NL] ').substring(0, 260)}`);
  return out;
}

/**
 * מעבר "שקט" — שומר state ומשתמש בפרמטר ייחודי כדי לא לצבור.
 * חשוב: גם המעבר השקט צריך שם פרמטר ייחודי, אחרת ההקשה הדמה תיצבר.
 */
function buildTransition(text, stateParams = {}) {
  // שם פרמטר דמה ייחודי לפי screen+step החדשים
  const screen = stateParams.screen || 'x';
  const step   = stateParams.step || '0';
  const dummyName = 'd_' + screen + '_' + step;
  return buildResponse(buildSilentRead(text, dummyName), stateParams);
}

// ============================================================================
// הראוטר המרכזי
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // איחוד פרמטרים (GET + POST)
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(q, req.body);
  }

  // נירמול מערכים -> ערך אחרון
  for (const k in q) {
    if (Array.isArray(q[k])) q[k] = q[k][q[k].length - 1];
  }

  // מקור האמת: screen + step. step מונע צבירת הקשות ישנות.
  const currentScreenIn = getState(q, 'screen') || 'main';
  const stepIn = parseInt(getState(q, 'step') || '0', 10) || 0;

  // ההקשה הרלוונטית למסך הנוכחי בלבד (מתעלמת מכל הישנות)
  const input = readInput(q, currentScreenIn, stepIn);

  // הצעד הבא — לכל מסך חדש נגדיל אותו, כדי לקבל שם פרמטר טרי
  const nextStep = stepIn + 1;

  console.log(`[IVR] screen=${currentScreenIn} step=${stepIn} input="${input}" q=${JSON.stringify(q).substring(0, 260)}`);

  // ----- עזרי בנייה לכל מסך, עם step נכון -----

  // בונה תפריט עם פרמטר ייחודי לצעד, ומחזיר תגובה כולל state
  function renderMenu(parts, screen, opts, extraState) {
    const param = inputKey(screen, nextStep);
    const readCmd = buildReadMenu(parts, param, opts || {});
    const state = Object.assign({ screen, step: String(nextStep) }, extraState || {});
    return res.send(buildResponse(readCmd, state));
  }

  // מעבר שקט למסך חדש
  function go(text, screen, extraState) {
    const state = Object.assign({ screen, step: String(nextStep) }, extraState || {});
    return res.send(buildTransition(text, state));
  }

  try {
    // ========================================================================
    // שלב א': עיבוד הקשה — אך ורק של המסך הנוכחי
    // ========================================================================

    let currentScreen = currentScreenIn;

    // ---- תפריט ראשי ----
    if (currentScreen === 'main' && input !== '') {
      if      (input === '1') return go('טוען פוסטים אחרונים', 'recent');
      else if (input === '2') return go('טוען נושאים חדשים', 'topics');
      else if (input === '3') return go('טוען קטגוריות', 'categories');
      else {
        return renderMenu([
          'הבחירה שגויה אנא נסו שנית',
          'לפוסטים האחרונים הקישו 1',
          'לנושאים החדשים שנפתחו הקישו 2',
          'לכניסה לפי קטגוריות הקישו 3'
        ], 'main', { waitSec: 8 });
      }
    }

    // ---- פוסטים אחרונים ----
    if (currentScreen === 'recent' && input !== '') {
      const topicIds = splitIds(getState(q, 'tids'));
      if (input === '0') {
        return go('חוזרים לתפריט הראשי', 'main');
      } else if (input === '*') {
        return go('מרענן את הרשימה', 'recent');
      } else {
        const index = parseInt(input, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return go('טוען את הנושא', 'topic', { tid: topicIds[index], pidx: '0' });
        }
        return renderMenu([
          'בחירה לא תקינה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'recent', { waitSec: 8 }, { tids: joinIds(topicIds) });
      }
    }

    // ---- נושאים חדשים ----
    if (currentScreen === 'topics' && input !== '') {
      const topicIds = splitIds(getState(q, 'tids'));
      if (input === '0') {
        return go('חוזרים לתפריט הראשי', 'main');
      } else if (input === '*') {
        return go('מרענן את הרשימה', 'topics');
      } else {
        const index = parseInt(input, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return go('מיד נשמע את הנושא', 'topic', { tid: topicIds[index], pidx: '0' });
        }
        return renderMenu([
          'בחירה לא תקינה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topics', { waitSec: 8 }, { tids: joinIds(topicIds) });
      }
    }

    // ---- קטגוריות ----
    if (currentScreen === 'categories' && input !== '') {
      const currentCid  = getState(q, 'curcid');
      const categoryIds = splitIds(getState(q, 'cids'));
      if (input === '0') {
        return go('חוזרים לתפריט הראשי', 'main');
      } else if (input === '*') {
        if (currentCid) {
          return go('טוען נושאים בקטגוריה', 'cattopics', { cid: currentCid, catpage: '1' });
        }
        // אין קטגוריה נוכחית — רענון רשימת הקטגוריות הראשיות
        return go('מרענן קטגוריות', 'categories', { cid: '' });
      } else {
        const index = parseInt(input, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          return go('טוען קטגוריה', 'categories', { cid: categoryIds[index] });
        }
        return renderMenu([
          'בחירה לא תקינה',
          categoryIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + categoryIds.length
            : 'הרשימה אינה זמינה כעת',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'categories', { waitSec: 8 }, {
          cids: joinIds(categoryIds), curcid: currentCid || ''
        });
      }
    }

    // ---- נושאים בתוך קטגוריה ----
    if (currentScreen === 'cattopics' && input !== '') {
      const topicIds = splitIds(getState(q, 'tids'));
      const cid      = getState(q, 'cid');
      const catpage  = parseInt(getState(q, 'catpage') || '1', 10);
      if (input === '0') {
        return go('חוזרים לתפריט הראשי', 'main');
      } else if (input === '*') {
        return go('עמוד הבא', 'cattopics', { cid, catpage: String(catpage + 1) });
      } else if (input === '#') {
        return go('עמוד קודם', 'cattopics', { cid, catpage: String(Math.max(1, catpage - 1)) });
      } else {
        const index = parseInt(input, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return go('טוען את הנושא', 'topic', { tid: topicIds[index], pidx: '0' });
        }
        return renderMenu([
          'בחירה שגויה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לעמוד הבא הקישו כוכבית',
          'לעמוד הקודם הקישו סולמית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'cattopics', { waitSec: 9 }, {
          tids: joinIds(topicIds), cid, catpage: String(catpage)
        });
      }
    }

    // ---- ניווט בתוך נושא ----
    if (currentScreen === 'topic' && input !== '') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      if (input === '0') {
        return go('חוזרים לתפריט הראשי', 'main');
      } else if (input === '1') {
        return go('ההודעה הבאה', 'topic', { tid, pidx: String(pidx + 1) });
      } else if (input === '2') {
        return go('ההודעה הקודמת', 'topic', { tid, pidx: String(Math.max(0, pidx - 1)) });
      } else if (input === '3') {
        return go('משמיע שוב', 'topic', { tid, pidx: String(pidx) });
      } else if (input === '4') {
        return go('מדלג חמש הודעות קדימה', 'topic', { tid, pidx: String(pidx + 5) });
      } else if (input === '5') {
        return go('חוזר לתחילת הנושא', 'topic', { tid, pidx: '0' });
      } else if (input === '6') {
        const details = String(getState(q, 'details') || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        return renderMenu(details, 'detback', { waitSec: 7 }, { tid, pidx: String(pidx) });
      } else {
        return go('בחירה שגויה', 'topic', { tid, pidx: String(pidx) });
      }
    }

    // ---- חזרה מפרטי הודעה ----
    if (currentScreen === 'detback' && input !== '') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      return go('חוזר להודעה', 'topic', { tid, pidx: String(pidx) });
    }

    // ---- סיום נושא ----
    if (currentScreen === 'topicend' && input !== '') {
      const tid = getState(q, 'tid');
      if (input === '1') {
        return go('מתחילים מחדש', 'topic', { tid, pidx: '0' });
      } else if (input === '2') {
        return go('חוזרים לפוסטים אחרונים', 'recent');
      } else {
        return go('חוזרים לתפריט הראשי', 'main');
      }
    }

    // ========================================================================
    // שלב ב': הפקת המסכים (כשאין הקשה רלוונטית — מציגים את המסך)
    // ========================================================================

    // ===== תפריט ראשי =====
    if (currentScreen === 'main') {
      return renderMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'main', { waitSec: 8 });
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

      return renderMenu(parts, 'recent', { waitSec: 10 }, {
        tids: joinIds(topics.map(t => t.tid))
      });
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

      return renderMenu(parts, 'topics', { waitSec: 10 }, {
        tids: joinIds(topics.map(t => t.tid))
      });
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
        const data       = await nbFetch('/category/' + cid);
        const parentName = cleanText(data.name || '');
        categoriesList   = (data.children || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        headerText       = 'קטגוריית ' + parentName;
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        if (cid) parts.push('לשמיעת הנושאים בקטגוריה זו הקישו כוכבית');
        parts.push('לחזרה לתפריט הראשי הקישו אפס');

        return renderMenu(parts, 'categories', { waitSec: 10 }, {
          cids: joinIds(categoriesList.map(c => c.cid)),
          curcid: cid || ''
        });
      } else if (cid) {
        return go('טוען נושאים', 'cattopics', { cid, catpage: '1' });
      } else {
        return go('לא נמצאו קטגוריות חוזר לתפריט', 'main');
      }
    }

    // ===== נושאים בתוך קטגוריה =====
    if (currentScreen === 'cattopics') {
      const cid     = getState(q, 'cid');
      const catpage = Math.max(1, parseInt(getState(q, 'catpage') || '1', 10));

      if (!cid) {
        return go('אירעה שגיאה חוזר לתפריט', 'main');
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

      return renderMenu(parts, 'cattopics', { waitSec: 10 }, {
        tids: joinIds(topics.map(t => t.tid)),
        cid, catpage: String(catpage)
      });
    }

    // ===== שמיעת נושא =====
    if (currentScreen === 'topic') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);

      if (!tid) {
        return go('שגיאת מזהה נושא', 'main');
      }

      console.log(`[Render] topic tid=${tid}, postIndex=${pidx}`);

      const result     = await fetchTopicPost(tid, pidx);
      const topic      = result.topic;
      const post       = result.post;
      const totalPosts = result.totalPosts;
      const topicTitle = ttsCut(topic.title, MAX_TITLE_CHARS);

      if (!post || pidx >= totalPosts) {
        return renderMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          totalPosts === 1 ? 'הנושא כולל הודעה אחת בלבד'
                           : `הנושא כולל ${totalPosts} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לרשימת הפוסטים האחרונים הקישו 2',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 9 }, { tid });
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

      return renderMenu(audioParts, 'topic', { waitSec: 15 }, {
        tid, pidx: String(pidx), details: detailsSafe
      });
    }

    // ===== מסך פרטי הודעה (detback) — מוצג מתוך topicnav, אבל ליתר בטחון =====
    if (currentScreen === 'detback') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      const details = String(getState(q, 'details') || '').split('|').filter(x => x);
      if (!details.length) details.push('אין פרטים זמינים');
      details.push('לחזרה לשמיעת ההודעה הקישו 1');
      return renderMenu(details, 'detback', { waitSec: 7 }, { tid, pidx: String(pidx) });
    }

    // ===== סיום נושא (topicend) — תצוגה אם הגענו לכאן ישירות =====
    if (currentScreen === 'topicend') {
      const tid = getState(q, 'tid');
      return renderMenu([
        'הגעתם לסוף ההודעות בנושא זה',
        'להאזנה חוזרת מההתחלה הקישו 1',
        'לרשימת הפוסטים האחרונים הקישו 2',
        'לחזרה לתפריט הראשי הקישו אפס'
      ], 'topicend', { waitSec: 9 }, { tid });
    }

    // ===== הגנת קצה =====
    console.warn(`[Fallback] Unhandled screen: ${currentScreen}`);
    return go('חוזר להתחלה', 'main');

  } catch (globalError) {
    console.error('[Global Exception]', globalError.message);
    const param = inputKey('main', nextStep);
    const readCmd = buildReadMenu([
      'אירעה שגיאה בטעינת הנתונים מהפורום',
      'אנא נסו שוב מאוחר יותר',
      'לחזרה לתפריט הראשי הקישו אפס'
    ], param, { waitSec: 6 });
    return res.send(buildResponse(readCmd, { screen: 'main', step: String(nextStep) }));
  }
};
