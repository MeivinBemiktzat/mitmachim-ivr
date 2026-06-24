// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם עבור פורום מתמחים טופ הטלפוני (NodeBB)
// נבנה באופן בלעדי עבור מערכות ה-IVR של ימות המשיח
//
// ============================================================================
// ארכיטקטורה מתוקנת (v5.0) - תיקון באג קריטי + שכלולים:
// ----------------------------------------------------------------------------
//   *** הבאג הקריטי שתוקן ***
//   ימות המשיח לא יכול לשמור את התו ">" בערך של api_add_X, מכיוון
//   שהתו ">" הוא המפריד בין פרמטרי שדה ה-read (לדוגמה:
//   recentsel>no>1>1>9>Digits>no>no). לכן כשניסינו לשמור
//   api_add_tids^98442>95707, התו ">" שיבש את כל הפרמטר וגרם לכך
//   שהוא הגיע ריק בבקשה הבאה. התוצאה: רשימת המזהים תמיד הייתה ריקה,
//   ולכן בכל ניסיון להיכנס לנושא/קטגוריה התקבל "הקישו מספר בין 1 ל 0".
//
//   *** הפתרון ***
//   שימוש בתו "x" כמפריד בין מזהים. התו "x" בטוח לחלוטין - הוא לא
//   מפריד פרוטוקול ולא מופיע במזהים מספריים. בקריאת ה-state אנחנו
//   תומכים גם ב-x וגם ב->/, לתאימות לאחור.
//
//   *** שכלולים נוספים ***
//   - הסרה מלאה של פיצ'ר החיפוש (לפי בקשת המשתמש).
//   - תפריט ראשי חדש: מועדפים/דפדוף, ניווט משופר.
//   - שמיעת נושא עם דפדוף הודעות חכם (תמיכה בעמודים של NodeBB).
//   - דילוג קדימה/אחורה בין הודעות, חזרה, חזרה על הודעה.
//   - תצוגת מספר תגובות, מחבר, וזמן פרסום.
//   - טיפול שגיאות מלא בכל מסך עם הודעות ברורות.
//   - barge-in (קטיעת שמע בהקשה) בכל המסכים.
// ============================================================================

// ----------------------------------------------------------------------------
// משתני סביבה והגדרות קבועות
// ----------------------------------------------------------------------------
const FORUM_URL       = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   // אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 950;   // אורך מקסימלי לגוף הודעה עבור TTS
const DEFAULT_TIMEOUT = 9000;  // זמן המתנה לקריאות שרת (מילישניות)
const LIST_SIZE       = 9;     // כמות פריטים מקסימלית ברשימה (1-9)
const NB_PAGE_SIZE    = 20;    // כמות הודעות בעמוד NodeBB (קבוע ידוע)

// *** המפריד הבטוח בין מזהים - התיקון המרכזי של כל המערכת ***
const ID_SEP = 'x';

// ============================================================================
// פונקציות עזר קריטיות לעבודה עם פרמטרי ימות המשיח
// ============================================================================

/**
 * *** תיקון הבאג המרכזי - פיצול מזהים ***
 *
 * תומך במפריד "x" (החדש והבטוח), וגם ב->, "," לתאימות לאחור.
 * מסנן ערכים ריקים ולא-מספריים.
 *
 * @param {string} raw הערך הגולמי שהגיע בפרמטר
 * @returns {string[]} מערך מזהים נקיים
 */
function splitIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw)
    .split(/[x>,]/)
    .map(s => s.trim())
    .filter(s => s !== '');
}

/**
 * *** איחוד מזהים למחרוזת state בטוחה ***
 *
 * משתמש במפריד "x" כדי שהערך יישמר בבטחה ב-api_add_X.
 *
 * @param {Array} ids מערך מזהים
 * @returns {string} מחרוזת מאוחדת
 */
function joinIds(ids) {
  if (!ids || !ids.length) return '';
  return ids.map(x => String(x).trim()).filter(x => x !== '').join(ID_SEP);
}

/**
 * *** קריאת state מהבקשה ***
 *
 * אחרי ששלחנו api_add_key^value בתגובה, ימות המשיח מחזיר אותו
 * בבקשה הבאה כ- key^value (כלומר q.key = value). לתאימות לאחור,
 * בודקים גם את api_add_key.
 *
 * @param {Object} q אובייקט הפרמטרים הנכנסים
 * @param {string} key שם המשתנה
 * @returns {string} הערך שנמצא (מחרוזת ריקה אם לא קיים)
 */
function getState(q, key) {
  const val = q[key] !== undefined ? q[key] : q['api_add_' + key];
  return val === undefined || val === null ? '' : String(val);
}

/**
 * בדיקה האם פרמטר הוקש בפועל (לא ריק ולא undefined).
 *
 * @param {*} val הערך לבדיקה
 * @returns {boolean}
 */
function pressed(val) {
  return val !== undefined && val !== null && String(val) !== '';
}

// ============================================================================
// שכבת תקשורת מול ה-Read API של NodeBB
// ============================================================================

/**
 * ביצוע בקשת HTTP בטוחה מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיב ומעבדת את תגובת ה-JSON.
 *
 * @param {string} path הנתיב המבוקש בפורום
 * @returns {Promise<Object>} תגובת ה-JSON של השרת
 */
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
        'User-Agent': 'yemot-nodebb-bridge-ivr/5.0',
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

/**
 * שליפת נושא שלם מ-NodeBB כולל כל ההודעות.
 *
 * NodeBB מחזיר רק 20 הודעות בעמוד. פונקציה זו שולפת את העמוד הראשון,
 * ואם יש יותר הודעות מ-20 ונדרשת הודעה בעמוד מאוחר יותר, שולפת את
 * העמוד המתאים. כדי לחסוך בקריאות, אנו שולפים לפי צורך (lazy).
 *
 * @param {string} tid מזהה נושא
 * @param {number} postIndex אינדקס ההודעה הרצויה (0-based)
 * @returns {Promise<Object>} { topic, post, totalPosts }
 */
async function fetchTopicPost(tid, postIndex) {
  // קביעת מספר עמוד NodeBB לפי אינדקס ההודעה
  const nbPage = Math.floor(postIndex / NB_PAGE_SIZE) + 1;

  const data  = await nbFetch('/topic/' + tid + '?page=' + nbPage);
  const posts = data.posts || [];

  // סך כל ההודעות בנושא (postcount כולל את ההודעה הראשית)
  const totalPosts = data.postcount || data.postercount || posts.length;

  // חישוב האינדקס היחסי בתוך העמוד שנשלף
  const relativeIndex = postIndex - (nbPage - 1) * NB_PAGE_SIZE;
  const post = posts[relativeIndex] || null;

  return {
    topic: data,
    post: post,
    posts: posts,
    relativeIndex: relativeIndex,
    totalPosts: totalPosts
  };
}

// ============================================================================
// עיבוד טקסט להקראה (TTS)
// ============================================================================

/**
 * ניקוי מקיף של HTML והכנת טקסט להקראה במנוע ה-TTS.
 *
 * @param {string} html טקסט גולמי
 * @returns {string} טקסט נקי מוכן להקראה
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);

  // הסרת אלמנטים לא רלוונטיים להקראה
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ציטוט ');
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' קטע קוד ');
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, ' קטע קוד ');

  // המרת תגיות מבנה לרווחים/פיסוק
  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<\/p>/gi, '. ');
  text = text.replace(/<\/div>/gi, '. ');
  text = text.replace(/<\/li>/gi, '. ');
  text = text.replace(/<\/h[1-6]>/gi, '. ');

  // הסרת כל שאר התגיות
  text = text.replace(/<[^>]+>/g, ' ');

  // המרת ישויות HTML
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, ' ו ');
  text = text.replace(/&quot;/gi, ' ');
  text = text.replace(/&#39;|&apos;/gi, ' ');
  text = text.replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');
  text = text.replace(/&#x27;/gi, ' ').replace(/&x27;/gi, ' ');

  // הסרת קישורים מלאים
  text = text.replace(/https?:\/\/\S+/gi, ' קישור ');

  // ניקוי תווים שמשבשים את פרוטוקול ימות המשיח:
  // ^ > * = & . - הם מפרידי פרוטוקול קריטיים, וכן תווים מיוחדים אחרים
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');

  // צמצום רווחים
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * ניקוי + חיתוך לאורך מוגבל.
 *
 * @param {string} text טקסט גולמי
 * @param {number} max אורך מקסימלי
 * @returns {string} טקסט נקי וחתוך
 */
function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

/**
 * המרת חותמת זמן לביטוי מילולי בעברית.
 *
 * @param {number} ts חותמת זמן במילישניות
 * @returns {string} ביטוי מילולי
 */
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
 * מנקה חלק טקסט בודד מתווים שמשבשים את פרוטוקול ימות המשיח.
 * חשוב במיוחד עבור כותרות נושאים ושמות משתמשים.
 *
 * @param {string} part חלק טקסט
 * @returns {string} טקסט מנוקה
 */
function sanitizePart(part) {
  return String(part)
    .replace(/[.,=&*^>]/g, ' ')  // הסרת כל מפרידי הפרוטוקול
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * בונה פקודת read שמשמיעה את ה-prompt ובו זמנית קולטת הקשה (barge-in).
 *
 * פורמט ימות המשיח:
 *   read=t-AUDIO1.t-AUDIO2=VARNAME,reuse,maxDigits,minDigits,timeout,type,blockStar,blockZero
 *
 * @param {string[]} parts מערך משפטים להשמעה
 * @param {string} paramName שם משתנה החזרה
 * @param {Object} opts { min, max, waitSec, type, blockStar, blockZero }
 * @returns {string} פקודת read
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

  return `read=${promptStr}=${paramName},no,${max},${min},${waitSec},${type},${blockStar},${blockZero}`;
}

/**
 * בונה read "שקט" קצר למעברים פנימיים (שדה דמה, timeout קצר).
 * משמש לאחר בחירת המשתמש כדי להציג מסך הבא ללא המתנה ארוכה.
 *
 * @param {string} text טקסט קצר להשמעה ("טוען...")
 * @returns {string} פקודת read שקטה
 */
function buildSilentRead(text) {
  const t = sanitizePart(text || 'טוען');
  return `read=t-${t}=dummy,no,1,1,2,Digits,no,no`;
}

// ============================================================================
// בניית רשימות תוכן להקראה
// ============================================================================

/**
 * בונה רשימת נושאים להשמעה.
 *
 * @param {Array} topics מערך נושאים
 * @param {string} headerText כותרת
 * @param {string} footerText סיומת (הוראות ניווט)
 * @returns {string[]} מערך משפטים
 */
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

/**
 * בונה רשימת קטגוריות להשמעה.
 *
 * @param {Array} cats מערך קטגוריות
 * @param {string} headerText כותרת
 * @returns {string[]} מערך משפטים
 */
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
// פונקציות עזר לבניית תגובות מלאות עם שמירת state
// ============================================================================

/**
 * *** בניית תגובה מלאה בפרוטוקול ימות המשיח ***
 *
 * מצרף פקודת read בסיסית עם שדות state שיישמרו לבקשה הבאה.
 * כל שדה state נשלח כ-&api_add_KEY=VALUE.
 *
 * חשוב: הערכים חייבים להיות נקיים מהתווים & = ^ > * .
 * מזהים מאוחדים תמיד עם המפריד "x" (ראה joinIds).
 *
 * @param {string} readCmd פקודת ה-read הבסיסית
 * @param {Object} stateParams שדות state לשמירה
 * @returns {string} תגובה מלאה
 */
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  for (const key in stateParams) {
    let val = stateParams[key];
    if (val === undefined || val === null) continue;
    val = String(val);
    out += `&api_add_${key}=${val}`;
  }
  console.log(`[v0] buildResponse: ${out.substring(0, 220)}`);
  return out;
}

/**
 * בונה תגובת מעבר שקטה עם שמירת state.
 *
 * @param {string} text טקסט קצר ("טוען...")
 * @param {Object} stateParams שדות state
 * @returns {string} תגובה מלאה
 */
function buildTransition(text, stateParams = {}) {
  return buildResponse(buildSilentRead(text), stateParams);
}

// ============================================================================
// פונקציית הראוטר המרכזית (Serverless Handler של Vercel)
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // ----- איחוד פרמטרים נכנסים (GET + POST) -----
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(q, req.body);
  }

  console.log(`[IVR Request] screen=${getState(q, 'screen')} query=${JSON.stringify(q).substring(0, 300)}`);

  let currentScreen = getState(q, 'screen') || 'main';

  try {
    // ========================================================================
    // שלב א': עיבוד הקשות משתמש
    // ========================================================================

    // ---- 1. תפריט ראשי ----
    if (pressed(q.mainsel)) {
      const sel = String(q.mainsel).trim();
      console.log(`[Menu] mainsel=${sel}`);

      if      (sel === '1') { currentScreen = 'recent'; }
      else if (sel === '2') { currentScreen = 'topics'; }
      else if (sel === '3') { currentScreen = 'categories'; }
      else {
        // בחירה לא חוקית בתפריט הראשי
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
      const sel      = String(q.recentsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      console.log(`[recentsel] sel=${sel}, tids="${getState(q, 'tids')}", count=${topicIds.length}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'recent'; // רענון
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען את הנושא', {
            screen: 'topic',
            tid: topicIds[index],
            pidx: 0
          }));
        }
        // בחירה לא תקינה - נשארים במסך עם הרשימה השמורה
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'recentsel', { waitSec: 8 });
        return res.send(buildResponse(readCmd, {
          tids: joinIds(topicIds),
          screen: 'recent'
        }));
      }
    }

    // ---- 3. מסך נושאים חדשים (topics) ----
    if (pressed(q.topicsel)) {
      const sel      = String(q.topicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      console.log(`[topicsel] sel=${sel}, count=${topicIds.length}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'topics'; // רענון
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', {
            screen: 'topic',
            tid: topicIds[index],
            pidx: 0
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
          tids: joinIds(topicIds),
          screen: 'topics'
        }));
      }
    }

    // ---- 4. מסך קטגוריות (categories) ----
    if (pressed(q.catsel)) {
      const sel         = String(q.catsel).trim();
      const currentCid  = getState(q, 'curcid');
      const categoryIds = splitIds(getState(q, 'cids'));
      console.log(`[catsel] sel=${sel}, cids count=${categoryIds.length}, curcid=${currentCid}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // כוכבית: כניסה לנושאי הקטגוריה הנוכחית (אם אנו בתוך קטגוריה)
        if (currentCid) {
          return res.send(buildTransition('טוען נושאים בקטגוריה', {
            screen: 'cattopics',
            cid: currentCid,
            catpage: 1
          }));
        }
        currentScreen = 'categories';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          return res.send(buildTransition('טוען קטגוריה', {
            screen: 'categories',
            cid: categoryIds[index]
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
          cids: joinIds(categoryIds),
          curcid: currentCid || '',
          screen: 'categories'
        }));
      }
    }

    // ---- 5. נושאים בתוך קטגוריה (cattopicsel) ----
    if (pressed(q.cattopicsel)) {
      const sel      = String(q.cattopicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      const cid      = getState(q, 'cid');
      const catpage  = parseInt(getState(q, 'catpage') || '1', 10);
      console.log(`[cattopicsel] sel=${sel}, count=${topicIds.length}, cid=${cid}, page=${catpage}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // עמוד הבא בקטגוריה
        return res.send(buildTransition('עמוד הבא', {
          screen: 'cattopics',
          cid: cid,
          catpage: catpage + 1
        }));
      } else if (sel === '#') {
        // עמוד קודם בקטגוריה
        return res.send(buildTransition('עמוד קודם', {
          screen: 'cattopics',
          cid: cid,
          catpage: Math.max(1, catpage - 1)
        }));
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען את הנושא', {
            screen: 'topic',
            tid: topicIds[index],
            pidx: 0
          }));
        }
        const readCmd = buildReadMenu([
          'בחירה שגויה',
          topicIds.length > 0
            ? 'אנא הקישו מספר בין 1 ל ' + topicIds.length
            : 'הרשימה אינה זמינה כעת',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'cattopicsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, {
          tids: joinIds(topicIds),
          cid: cid,
          catpage: catpage,
          screen: 'cattopics'
        }));
      }
    }

    // ---- 6. ניווט בתוך נושא (topicnav) ----
    if (pressed(q.topicnav)) {
      const sel  = String(q.topicnav).trim();
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      console.log(`[topicnav] sel=${sel}, tid=${tid}, pidx=${pidx}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '1') {
        // הודעה הבאה
        return res.send(buildTransition('ההודעה הבאה', {
          screen: 'topic', tid: tid, pidx: pidx + 1
        }));
      } else if (sel === '2') {
        // הודעה קודמת
        return res.send(buildTransition('ההודעה הקודמת', {
          screen: 'topic', tid: tid, pidx: Math.max(0, pidx - 1)
        }));
      } else if (sel === '3') {
        // האזנה חוזרת לאותה הודעה
        return res.send(buildTransition('משמיע שוב', {
          screen: 'topic', tid: tid, pidx: pidx
        }));
      } else if (sel === '4') {
        // קפיצה 5 הודעות קדימה
        return res.send(buildTransition('מדלג חמש הודעות קדימה', {
          screen: 'topic', tid: tid, pidx: pidx + 5
        }));
      } else if (sel === '5') {
        // חזרה לתחילת הנושא
        return res.send(buildTransition('חוזר לתחילת הנושא', {
          screen: 'topic', tid: tid, pidx: 0
        }));
      } else if (sel === '6') {
        // פרטי ההודעה
        const details = String(getState(q, 'details') || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        const readCmd = buildReadMenu(details, 'detback', { waitSec: 7 });
        return res.send(buildResponse(readCmd, {
          screen: 'detback', tid: tid, pidx: pidx
        }));
      } else {
        // בחירה לא תקינה - חוזרים לאותה הודעה
        return res.send(buildTransition('בחירה שגויה', {
          screen: 'topic', tid: tid, pidx: pidx
        }));
      }
    }

    // ---- 7. חזרה מפרטי הודעה (detback) ----
    if (pressed(q.detback)) {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      return res.send(buildTransition('חוזר להודעה', {
        screen: 'topic', tid: tid, pidx: pidx
      }));
    }

    // ---- 8. סיום נושא (topicend) ----
    if (pressed(q.topicend)) {
      const sel = String(q.topicend).trim();
      const tid = getState(q, 'tid');

      if (sel === '1') {
        return res.send(buildTransition('מתחילים מחדש', {
          screen: 'topic', tid: tid, pidx: 0
        }));
      } else if (sel === '2') {
        currentScreen = 'recent';
      } else {
        currentScreen = 'main';
      }
    }

    // ========================================================================
    // שלב ב': הפקת המסכים לפי currentScreen
    // ========================================================================

    // ===== מסך תפריט ראשי =====
    if (currentScreen === 'main') {
      const readCmd = buildReadMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'mainsel', { waitSec: 8 });
      return res.send(buildResponse(readCmd, { screen: 'main' }));
    }

    // ===== מסך פוסטים אחרונים =====
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
        tids: joinIds(topics.map(t => t.tid)),
        screen: 'recent'
      }));
    }

    // ===== מסך נושאים חדשים =====
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
        tids: joinIds(topics.map(t => t.tid)),
        screen: 'topics'
      }));
    }

    // ===== מסך קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = getState(q, 'cid');
      console.log(`[Render] categories, cid=${cid || 'root'}`);

      let categoriesList = [];
      let headerText     = '';
      let parentName     = '';

      if (!cid) {
        const data     = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        headerText     = 'תפריט קטגוריות ראשיות';
      } else {
        const data     = await nbFetch('/category/' + cid);
        parentName     = cleanText(data.name || '');
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        headerText     = 'קטגוריית ' + parentName;
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        if (cid) {
          parts.push('לשמיעת הנושאים בקטגוריה זו הקישו כוכבית');
        }
        parts.push('לחזרה לתפריט הראשי הקישו אפס');

        const readCmd = buildReadMenu(parts, 'catsel', { waitSec: 10 });
        return res.send(buildResponse(readCmd, {
          cids: joinIds(categoriesList.map(c => c.cid)),
          curcid: cid || '',
          screen: 'categories'
        }));
      } else if (cid) {
        // אין תתי-קטגוריות → מעבר ישיר לנושאי הקטגוריה
        return res.send(buildTransition('טוען נושאים', {
          screen: 'cattopics',
          cid: cid,
          catpage: 1
        }));
      } else {
        const readCmd = buildReadMenu([
          'לא נמצאו קטגוריות',
          'חוזר לתפריט הראשי'
        ], 'mainsel', { waitSec: 4 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ===== מסך נושאים בתוך קטגוריה =====
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
        `נושאים בקטגוריית ${catName}. עמוד ${catpage}`,
        footerParts.join('. ')
      );

      const readCmd = buildReadMenu(parts, 'cattopicsel', { waitSec: 10 });
      return res.send(buildResponse(readCmd, {
        tids: joinIds(topics.map(t => t.tid)),
        cid: cid,
        catpage: catpage,
        screen: 'cattopics'
      }));
    }

    // ===== מסך שמיעת נושא =====
    if (currentScreen === 'topic') {
      const tid  = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);

      if (!tid) {
        return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));
      }

      console.log(`[Render] topic tid=${tid}, postIndex=${pidx}`);

      // שליפת ההודעה הספציפית (כולל טיפול בעמודים של NodeBB)
      const result     = await fetchTopicPost(tid, pidx);
      const topic      = result.topic;
      const post       = result.post;
      const totalPosts = result.totalPosts;
      const topicTitle = ttsCut(topic.title, MAX_TITLE_CHARS);

      // הגעה לסוף הנושא
      if (!post || pidx >= totalPosts) {
        const readCmd = buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          totalPosts === 1
            ? 'הנושא כולל הודעה אחת בלבד'
            : `הנושא כולל ${totalPosts} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לרשימת הפוסטים האחרונים הקישו 2',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 9 });
        return res.send(buildResponse(readCmd, {
          tid: tid,
          screen: 'topicend'
        }));
      }

      const postBody   = ttsCut(post.content, MAX_BODY_CHARS);
      const authorName = post.user && post.user.username ? post.user.username : 'משתמש';

      // בניית גוף ההקראה
      const audioParts = [];
      if (pidx === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle);
        audioParts.push(totalPosts === 1
          ? 'הנושא מכיל הודעה אחת'
          : `הנושא מכיל ${totalPosts} הודעות`);
      }
      audioParts.push(`הודעה מספר ${pidx + 1} מתוך ${totalPosts}`);
      audioParts.push(`נכתבה על ידי ${authorName}`);
      audioParts.push(postBody);

      // תפריט ניווט קצר וברור
      audioParts.push('להודעה הבאה הקישו 1');
      audioParts.push('להודעה הקודמת הקישו 2');
      audioParts.push('להאזנה חוזרת הקישו 3');
      audioParts.push('לדילוג חמש הודעות הקישו 4');
      audioParts.push('לתחילת הנושא הקישו 5');
      audioParts.push('לפרטי ההודעה הקישו 6');
      audioParts.push('לתפריט הראשי הקישו אפס');

      // הכנת מטא-דאטה לפרטי ההודעה
      const postDetails = [
        `פרטי הודעה מספר ${pidx + 1}`,
        `המחבר ${authorName}`,
        `פורסם ${timeAgo(post.timestamp)}`,
        totalPosts === 1
          ? 'הנושא כולל הודעה אחת'
          : `הנושא כולל ${totalPosts} הודעות בסך הכל`
      ];
      const detailsSafe = postDetails.map(d => sanitizePart(d)).join('|');

      const readCmd = buildReadMenu(audioParts, 'topicnav', { waitSec: 15 });
      return res.send(buildResponse(readCmd, {
        tid: tid,
        pidx: pidx,
        screen: 'topic',
        details: detailsSafe
      }));
    }

    // ===== הגנת קצה: מסך לא מוכר =====
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
