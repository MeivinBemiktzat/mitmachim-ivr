// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ הטלפוני (NodeBB)
// נבנה באופן בלעדי עבור מערכות ה-IVR של ימות המשיח
//
// ארכיטקטורה מתוקנת (v4.0):
//   - תיקון קריטי: ימות המשיח מחזיר api_add_* עם ^ → > לאחר שליחה.
//     לכן פיצול מערך מזהים צריך לתמוך ב-BOTH סימן > וכן , (פסיק).
//   - תמיכה מלאה בקטיעת שמע (Barge-in) והקשה תוך כדי דיבור.
//   - כל ההקראה מוזרקת לתוך שדה ה-prompt של פקודת read.
//   - אין שום שלב של "לאישור הקישו 1" (val_text=no תמיד).
//   - ניהול תפריטים פנימי מהיר ללא go_to_folder.
//   - פיצ'רים חדשים: חיפוש, ניווט עמודים בקטגוריה, סטטיסטיקת נושא.
// ============================================================================

// ----------------------------------------------------------------------------
// משתני סביבה והגדרות קבועות
// ----------------------------------------------------------------------------
const FORUM_URL    = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;  // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 950;  // הגבלת אורך מקסימלי לגוף הודעה עבור TTS
const DEFAULT_TIMEOUT = 9000; // זמן המתנה לקריאות שרת במילישניות

// ============================================================================
// פונקציות עזר קריטיות לעבודה עם פרמטרי ימות המשיח
// ============================================================================

/**
 * *** תיקון הבאג המרכזי - פיצול מזהים ***
 *
 * ימות המשיח שומר api_add_* עם ^ כמפריד.
 * כשמחזיר לשרת: ^ → > (עקב URL encoding).
 * הפונקציה תומכת בשני המפרידים > ו-, לגמישות מקסימלית.
 *
 * @param {string} raw הערך הגולמי שהגיע בפרמטר
 * @returns {string[]} מערך מזהים נקיים
 */
function splitIds(raw) {
  if (!raw) return [];
  return String(raw).split(/[>,]/).map(x => x.trim()).filter(x => x !== '');
}

/**
 * *** קריאת state מהבקשה ***
 *
 * אחרי שהשרת שלח *key^value בתגובה, ימות המשיח מחזיר אותו
 * בבקשה הבאה כ- key^value שמגיע ל-Express כ- q.key = value.
 * לתאימות לאחור, בודקים גם את api_add_key.
 *
 * @param {Object} q אובייקט הפרמטרים הנכנסים
 * @param {string} key שם המשתנה
 * @returns {string} הערך שנמצא
 */
function getState(q, key) {
  return q[key] || q['api_add_' + key] || '';
}

// ============================================================================
// שכבת תקשורת מול ה-Read API של NodeBB
// ============================================================================

/**
 * פונקציה לביצוע בקשות HTTP בטוחות מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיב, ומעבדת את תגובת ה-JSON.
 *
 * @param {string} path הנתיב המבוקש בפורום
 * @returns {Promise<Object>} תגובת ה-JSON של השרת
 */
async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-ivr/4.0',
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

// ============================================================================
// עיבוד טקסט להקראה (TTS)
// ============================================================================

/**
 * ניקוי מקיף של HTML והכנת טקסט להקראה במנוע ה-TTS של ימות המשיח.
 *
 * @param {string} html טקסט גולמי
 * @returns {string} טקסט נקי מוכן להקראה
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);

  // הסרת אלמנטים לא רלוונטיים
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' [ציטוט] ');
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' [קוד] ');
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, ' [קוד] ');

  // המרת תגיות מבנה לסימני פיסוק
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

  // הסרת קישורים
  text = text.replace(/https?:\/\/\S+/gi, ' [קישור] ');

  // ניקוי תווים שמשבשים את פרוטוקול ימות המשיח
  // חשוב: ^ > * = & מפרידי פרוטוקול קריטיים
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');

  // צמצום רווחי��
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * ניקוי + חיתוך לאורך מוגבל.
 */
function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

/**
 * המרת חותמת זמן לביטוי מילולי בעברית.
 */
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
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
 * מנקה חלק טקסט בודד מתווי�� שמשבשים את פרוטוקול ימות המשיח.
 */
function sanitizePart(part) {
  return String(part)
    .replace(/[.,=&*^>]/g, ' ')  // הסרת כל מפרידי הפרוטוקול כולל ^ ו->
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * בונה פקודת read שמשמיעה את ה-prompt ובו זמנית קולטת הקשה (barge-in).
 *
 * פורמט ימות המשיח:
 *   read^AUDIO_TEXT^VARNAME>reuseExisting>maxDigits>minDigits>timeout>displayType>blockStar>blockZero
 *
 * ה-^ מפריד בין חלקי הפקודה, ה-> מפריד בין פרמטרי השדה.
 *
 * @param {string[]} parts מערך משפטים
 * @param {string} paramName שם משתנה החזרה
 * @param {Object} opts { min, max, waitSec, type }
 * @returns {string} פקודת read בפרוטוקול ימות המשיח
 */
function buildReadMenu(parts, paramName, opts = {}) {
  const min     = opts.min ?? 1;
  const max     = opts.max ?? 1;
  const waitSec = opts.waitSec ?? 7;
  const type    = opts.type || 'Digits';

  const promptStr = parts
    .filter(p => p && String(p).trim())
    .map(p => 't-' + sanitizePart(p))
    .join('.');

  return `read=${promptStr}=${paramName},no,${max},${min},${waitSec},${type},no,no`;
}

/**
 * בונה read "שקט" קצר למעברים פנימיים (dummy field, timeout קצר).
 * reuseExisting=no, maxDigits=1, minDigits=1, timeout=1
 */
function buildSilentRead(text) {
  const t = sanitizePart(text || 'טוען');
  return `read=t-${t}=dummy,no,1,1,3,Digits,no,no`;
}

// ============================================================================
// בניית רשימות תוכן להקראה
// ============================================================================

function buildTopicListParts(topics, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);

  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים להצגה');
    return parts;
  }

  topics.forEach((tp, i) => {
    const num      = i + 1;
    const title    = ttsCut(tp.title, MAX_TITLE_CHARS);
    const username = tp.user && tp.user.username ? tp.user.username : 'משתמש אנונימי';
    const replies  = tp.postcount ? tp.postcount - 1 : 0;

    parts.push(`לנושא מספר ${num}`);
    parts.push(title);
    parts.push(`מאת ${username}`);
    if (replies > 0) parts.push(`${replies} תגובות`);
    parts.push(`הקישו ${num}`);
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

    parts.push(`לקטגוריה מספר ${num}`);
    parts.push(name);
    if (cnt > 0) parts.push(`${cnt} נושאים`);
    parts.push(`הקישו ${num}`);
  });

  parts.push('לחזרה לתפריט הראשי הקישו אפס');
  return parts;
}

// ============================================================================
// פונקציות עזר לבניית תגובות מלאות
// ============================================================================

/**
 * *** תיקון הבאג השורש של הפרוטוקול ***
 *
 * פרוטוקול ימות המשיח (ApiAnswer) משתמש ב:
 *   - ^ כמפריד בין שם פרמטר לערך (במקום =)
 *   - * כמפריד בין פרמטרים שונים (במקום &)
 *
 * כדי לשמור state בין בקשות, יש להחזיר פקודת read עם שדות נוספים
 * בפורמט: read=PROMPT=VARNAME,params*STATEVAR^VALUE*STATEVAR2^VALUE2
 *
 * שדות state שמוגדרים כך מוחזרים על ידי ימות המשיח בבקשה הבאה
 * בפורמט: STATEVAR^VALUE (כלומר STATEVAR=VALUE בתוך ה-query).
 *
 * @param {string} readCmd פקודת ה-read הבסיסית
 * @param {Object} stateParams שדות state לשמירה
 * @returns {string} תגובה מלאה בפרוטוקול ימות המשיח
 */
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  for (const key in stateParams) {
    const val = stateParams[key];
    if (val === undefined || val === null) continue;
    // פורמט ימות המשיח: *שם^ערך (לא &שם=ערך)
    out += `&api_add_${key}=${val}`;
  }
  console.log(`[v0] buildResponse output: ${out.substring(0, 200)}`);
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

  // איחוד פרמטרים נכנסים
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(q, req.body);
  }

  console.log(
  `[IVR Request] Screen: ${q.screen || q.api_add_screen}, Full Query:`,
  JSON.stringify(q)
);
  console.log(`[v0] tids=${q.tids || ''}, cids=${q.cids || ''}, tid=${q.tid || ''}, page=${q.page || ''}`);

  let currentScreen =
  q.screen ||
  q.api_add_screen ||
  'main';

  try {

    // ========================================================================
    // שלב א': עיבוד הקשות משתמש
    // ========================================================================

    // ---- 1. תפריט ראשי ----
    if (q.mainsel !== undefined && q.mainsel !== '') {
      const sel = String(q.mainsel).trim();
      console.log(`[Menu Process] User pressed ${sel} on Main Menu`);

      if      (sel === '1') { currentScreen = 'recent'; }
      else if (sel === '2') { currentScreen = 'topics'; }
      else if (sel === '3') { currentScreen = 'categories'; }
      else if (sel === '4') { currentScreen = 'search'; }
      else {
        const readCmd = buildReadMenu([
          'המקש שהוקש שגוי אנא נסו שנית',
          'לפוסטים האחרונים הקישו 1',
          'לנושאים החדשים הקישו 2',
          'לקטגוריות הקישו 3',
          'לחיפוש בפורום הקישו 4'
        ], 'mainsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ---- 2. מסך פוסטים אחרונים (recent) ----
    if (q.recentsel !== undefined && q.recentsel !== '') {
      const sel      = String(q.recentsel).trim();
      const topicIds = splitIds(getState(q, 'tids')); // *** תיקון: api_add_tids מגיע בשם api_add_tids ***
      console.log(`[recentsel] pressed=${sel}, tids raw="${getState(q, 'tids')}", parsed=${topicIds.length} ids`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // רענון הרשימה
        currentScreen = 'recent';
      } else {
        const index = parseInt(sel, 10) - 1;

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען נושא', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          // בחירה לא חוקית - מחזיר לאותו מסך עם אזהרה
          console.warn(`[recentsel] Invalid index ${index}, available: ${topicIds.length}`);
          const readCmd = buildReadMenu([
            'בחירה לא תקינה',
            'אנא הקישו מספר בין 1 ל ' + topicIds.length,
            'לחזרה לתפריט הראשי הקישו אפס',
            'לרענון הרשימה הקישו כוכבית'
          ], 'recentsel', { waitSec: 7 });
          return res.send(buildResponse(readCmd, {
            tids: topicIds.join('>'),
            screen: 'recent'
          }));
        }
      }
    }

    // ---- 3. מסך נושאים חדשים (topics) ----
    if (q.topicsel !== undefined && q.topicsel !== '') {
      const sel      = String(q.topicsel).trim();
      const topicIds = splitIds(getState(q, 'tids')); // *** תיקון: api_add_tids מגיע בשם api_add_tids ***
      console.log(`[topicsel] pressed=${sel}, tids raw="${getState(q, 'tids')}", parsed=${topicIds.length} ids`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'topics';
      } else {
        const index = parseInt(sel, 10) - 1;

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          console.warn(`[topicsel] Invalid index ${index}, available: ${topicIds.length}`);
          const readCmd = buildReadMenu([
            'בחירה לא תקינה',
            'אנא הקישו מספר בין 1 ל ' + topicIds.length,
            'לחזרה לתפריט הראשי הקישו אפס'
          ], 'topicsel', { waitSec: 7 });
          return res.send(buildResponse(readCmd, {
            tids: topicIds.join('>'),
            screen: 'topics'
          }));
        }
      }
    }

    // ---- 4. מסך קטגוריות (categories) ----
    if (q.catsel !== undefined && q.catsel !== '') {
      const sel         = String(q.catsel).trim();
      const currentCid  = getState(q, 'curcid');
      const categoryIds = splitIds(getState(q, 'cids')); // *** תיקון: api_add_cids מגיע בשם api_add_cids ***
      console.log(`[catsel] pressed=${sel}, cids raw="${getState(q, 'cids')}", parsed=${categoryIds.length} ids`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // כוכבית: כניסה לנושאי הקטגוריה הנוכחית
        if (currentCid) {
          return res.send(buildTransition('טוען נושאים בקטגוריה', {
            screen: 'cattopics',
            cid: currentCid,
            page: 0
          }));
        } else {
          currentScreen = 'categories';
        }
      } else {
        const index = parseInt(sel, 10) - 1;

        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          return res.send(buildTransition('טוען קטגוריה', {
            screen: 'categories',
            cid: categoryIds[index]
          }));
        } else {
          console.warn(`[catsel] Invalid index ${index}, available: ${categoryIds.length}`);
          const readCmd = buildReadMenu([
            'בחירה לא תקינה',
            'אנא הקישו מספר בין 1 ל ' + categoryIds.length,
            'לחזרה לתפריט הראשי הקישו אפס'
          ], 'catsel', { waitSec: 7 });
          return res.send(buildResponse(readCmd, {
            cids: categoryIds.join('>'),
            curcid: currentCid || '',
            screen: 'categories'
          }));
        }
      }
    }

    // ---- 5. נושאים בתוך קטגוריה (cattopicsel) ----
    if (q.cattopicsel !== undefined && q.cattopicsel !== '') {
      const sel      = String(q.cattopicsel).trim();
      const topicIds = splitIds(getState(q, 'tids')); // *** תיקון: api_add_tids מגיע בשם api_add_tids ***
      const cid      = getState(q, 'cid');
      console.log(`[cattopicsel] pressed=${sel}, tids raw="${getState(q, 'tids')}", parsed=${topicIds.length} ids, cid=${cid}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // כוכבית: עמוד הבא בקטגוריה
        const nextPage = parseInt(getState(q, 'catpage') || '1', 10) + 1;
        return res.send(buildTransition('עמוד הבא', {
          screen: 'cattopics',
          cid: cid,
          page: nextPage
        }));
      } else if (sel === '#') {
        // עמוד קודם בקטגוריה
        const prevPage = Math.max(1, parseInt(getState(q, 'catpage') || '1', 10) - 1);
        return res.send(buildTransition('עמוד קודם', {
          screen: 'cattopics',
          cid: cid,
          page: prevPage
        }));
      } else {
        const index = parseInt(sel, 10) - 1;

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          const readCmd = buildReadMenu([
            'בחירה שגויה',
            'אנא הקישו מספר בין 1 ל ' + topicIds.length
          ], 'cattopicsel', { waitSec: 6 });
          return res.send(buildResponse(readCmd, {
            tids: topicIds.join('>'),
            cid: cid,
            catpage: getState(q, 'catpage') || '1',
            screen: 'cattopics'
          }));
        }
      }
    }

    // ---- 6. ניווט בתוך נושא (topicnav) ----
    if (q.topicnav !== undefined && q.topicnav !== '') {
      const sel         = String(q.topicnav).trim();
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);
      console.log(`[Topic Navigation] ${sel} on Topic ${topicId}, Page ${currentPage}`);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '1') {
        return res.send(buildTransition('ההודעה הבאה', {
          screen: 'topic',
          tid: topicId,
          page: currentPage + 1
        }));
      } else if (sel === '2') {
        const prevPage = Math.max(0, currentPage - 1);
        return res.send(buildTransition('ההודעה הקודמת', {
          screen: 'topic',
          tid: topicId,
          page: prevPage
        }));
      } else if (sel === '3') {
        // פרטי הודעה
        const details = String(getState(q, 'details') || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        const readCmd = buildReadMenu(details, 'detback', { waitSec: 6 });
        return res.send(buildResponse(readCmd, {
          screen: 'detback',
          tid: topicId,
          page: currentPage
        }));
      } else if (sel === '5') {
        // חזרה לתחילת הנושא
        return res.send(buildTransition('חוזר לתחילת הנושא', {
          screen: 'topic',
          tid: topicId,
          page: 0
        }));
      } else {
        return res.send(buildTransition('בחירה שגויה', {
          screen: 'topic',
          tid: topicId,
          page: currentPage
        }));
      }
    }

    // ---- 7. חזרה מפרטי הודעה (detback) ----
    if (q.detback !== undefined && q.detback !== '') {
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);
      return res.send(buildTransition('חוזר להודעה', {
        screen: 'topic',
        tid: topicId,
        page: currentPage
      }));
    }

    // ---- 8. סיום נושא (topicend) ----
    if (q.topicend !== undefined && q.topicend !== '') {
      const sel     = String(q.topicend).trim();
      const topicId = getState(q, 'tid');

      if (sel === '1') {
        return res.send(buildTransition('מתחילים מחדש', {
          screen: 'topic', tid: topicId, page: 0
        }));
      } else {
        currentScreen = 'main';
      }
    }

    // ---- 9. חיפוש - קבלת מונח החיפוש ----
    if (q.searchquery !== undefined && q.searchquery !== '') {
      const searchTerm = String(q.searchquery).trim();
      console.log(`[Search] User searching for: "${searchTerm}"`);

      if (searchTerm === '0' || searchTerm === '') {
        currentScreen = 'main';
      } else {
        return res.send(buildTransition('מחפש בפורום', {
          screen: 'searchresults',
          sq: encodeURIComponent(searchTerm)
        }));
      }
    }

    // ---- 10. בחירה מתוצאות חיפוש (searchsel) ----
    if (q.searchsel !== undefined && q.searchsel !== '') {
      const sel      = String(q.searchsel).trim();
      const topicIds = splitIds(getState(q, 'tids')); // *** תיקון: api_add_tids מגיע בשם api_add_tids ***

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        // חיפוש חדש
        currentScreen = 'search';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          const readCmd = buildReadMenu([
            'בחירה לא תקינה',
            'הקישו מספר בין 1 ל ' + topicIds.length,
            'לחיפוש חדש הקישו כוכבית',
            'לתפריט הראשי הקישו אפס'
          ], 'searchsel', { waitSec: 7 });
          return res.send(buildResponse(readCmd, {
            tids: topicIds.join('>'),
            screen: 'searchresults'
          }));
        }
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
        'לכניסה לפי קטגוריות הקישו 3',
        'לחיפוש בפורום הקישו 4'
      ], 'mainsel', { waitSec: 7 });
      return res.send(buildResponse(readCmd, { screen: 'main' }));
    }

    // ===== מסך פוסטים אחרונים =====
    if (currentScreen === 'recent') {
      console.log('[Screen Render] Fetching recent posts...');
      const data   = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, 9);

      const parts = buildTopicListParts(
        topics,
        'הפוסטים האחרונים בפורום',
        'לרענון הרשימה הקישו כוכבית לחזרה לתפריט הראשי הקישו אפס'
      );

      const readCmd = buildReadMenu(parts, 'recentsel', { waitSec: 9 });
      // *** תיקון: שמירת IDs עם > כמפריד ***
      return res.send(buildResponse(readCmd, {
        tids: topics.map(t => t.tid).join('>'),
        screen: 'recent'
      }));
    }

    // ===== מסך נושאים חדשים =====
    if (currentScreen === 'topics') {
      console.log('[Screen Render] Fetching newest topics...');
      let data;
      try {
        data = await nbFetch('/recent?term=alltime&sort=newest');
      } catch (e) {
        data = await nbFetch('/recent');
      }

      let topics = (data.topics || [])
        .slice()
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, 9);

      const parts = buildTopicListParts(
        topics,
        'הנושאים החדשים ביותר שנפתחו בפורום',
        'לרענון הרשימה הקישו כוכבית לחזרה לתפריט הראשי הקישו אפס'
      );

      const readCmd = buildReadMenu(parts, 'topicsel', { waitSec: 9 });
      // *** תיקון: שמירת IDs עם > כמפריד ***
      return res.send(buildResponse(readCmd, {
        tids: topics.map(t => t.tid).join('>'),
        screen: 'topics'
      }));
    }

    // ===== מסך קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = getState(q, 'cid');
      console.log(`[Screen Render] Loading categories. CID: ${cid || 'root'}`);

      let categoriesList = [];
      let headerText     = '';
      let parentName     = '';

      if (!cid) {
        const data     = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, 9);
        headerText     = 'תפריט קטגוריות ראשיות';
      } else {
        const data     = await nbFetch('/category/' + cid);
        parentName     = cleanText(data.name || '');
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, 9);
        headerText     = 'קטגוריית ' + parentName;
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        if (cid) {
          parts.push('לנושאים בקטגוריה זו הקישו כוכבית');
        }

        const readCmd = buildReadMenu(parts, 'catsel', { waitSec: 9 });
        // *** תיקון: שמירת IDs עם > כמפריד ***
        return res.send(buildResponse(readCmd, {
          cids: categoriesList.map(c => c.cid).join('>'),
          curcid: cid,
          screen: 'categories'
        }));
      } else if (cid) {
        // אין תתי-קטגוריות => נעבור לנושאי הקטגוריה
        return res.send(buildTransition('טוען נושאים', {
          screen: 'cattopics',
          cid: cid,
          page: 1
        }));
      } else {
        const readCmd = buildSilentRead('לא נמצאו קטגוריות חוזר לתפריט');
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ===== מסך נושאים בתוך קטגוריה =====
    if (currentScreen === 'cattopics') {
      const cid     = getState(q, 'cid');
      const catPage = Math.max(1, parseInt(getState(q, 'page') || getState(q, 'catpage') || '1', 10));
      if (!cid) {
        return res.send(buildTransition('שגיאה חוזר לתפריט', { screen: 'main' }));
      }

      console.log(`[Screen Render] Loading topics in CID: ${cid}, page: ${catPage}`);
      const data    = await nbFetch('/category/' + cid + '?page=' + catPage);
      const topics  = (data.topics || []).slice(0, 9);
      const catName = cleanText(data.name || '');

      const footerParts = [];
      if (catPage > 1)         footerParts.push('לעמוד הקודם הקישו סולמית');
      if (topics.length === 9) footerParts.push('לעמוד הבא הקישו כוכבית');
      footerParts.push('לתפריט הראשי הקישו אפס');

      const parts = buildTopicListParts(
        topics,
        `נושאים בקטגוריית ${catName} עמוד ${catPage}`,
        footerParts.join(' ')
      );

      const readCmd = buildReadMenu(parts, 'cattopicsel', { waitSec: 9 });
      // *** תיקון: שמירת IDs עם > כמפריד ***
      return res.send(buildResponse(readCmd, {
        tids: topics.map(t => t.tid).join('>'),
        cid: cid,
        catpage: catPage,
        screen: 'cattopics'
      }));
    }

    // ===== מסך שמיעת נושא =====
    if (currentScreen === 'topic') {
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);

      if (!topicId) {
        return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));
      }

      console.log(`[Screen Render] Topic: ${topicId}, post index: ${currentPage}`);
      const data   = await nbFetch('/topic/' + topicId);
      const posts  = data.posts || [];
      const topicTitle = ttsCut(data.title, MAX_TITLE_CHARS);

      // סוף הנושא
      if (currentPage >= posts.length) {
        const readCmd = buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          `הנושא כולל ${posts.length} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 8 });
        return res.send(buildResponse(readCmd, {
          tid: topicId,
          screen: 'topicend'
        }));
      }

      const currentPost = posts[currentPage];
      const postBody    = ttsCut(currentPost.content, MAX_BODY_CHARS);
      const authorName  = currentPost.user && currentPost.user.username
        ? currentPost.user.username
        : 'משתמש הפורום';

      // גוף ההקראה
      const audioParts = [];
      if (currentPage === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle);
        audioParts.push(`הנושא מכיל ${posts.length} הודעות`);
      }
      audioParts.push(`הודעה מספר ${currentPage + 1} מתוך ${posts.length}`);
      audioParts.push(`נכתבה על ידי ${authorName}`);
      audioParts.push(postBody);

      // תפריט ניווט
      audioParts.push('להודעה הבאה הקישו 1');
      audioParts.push('להודעה הקודמת הקישו 2');
      audioParts.push('לפרטי ההודעה הקישו 3');
      audioParts.push('לתחילת הנושא הקישו 5');
      audioParts.push('לתפריט הראשי הקישו אפס');

      // מטא-דאטה לפרטי הודעה
      const postDetails = [
        `פרטי הודעה ${currentPage + 1}`,
        `מחבר: ${authorName}`,
        `פורסם: ${timeAgo(currentPost.timestamp)}`
      ];

      if (currentPost.toPid) {
        const parentPost = posts.find(x => String(x.pid) === String(currentPost.toPid));
        if (parentPost && parentPost.user) {
          postDetails.push('תגובה ל: ' + parentPost.user.username);
        }
      }
      postDetails.push(`סה"כ ${data.postcount || posts.length} הודעות בדיון`);

      // *** שמירת פרטים ללא encodeURIComponent לשמירה על תאימות עם ימות המשיח ***
      const detailsSafe = postDetails
        .map(d => sanitizePart(d))
        .join('|');

      const readCmd = buildReadMenu(audioParts, 'topicnav', { waitSec: 15 });
      return res.send(buildResponse(readCmd, {
        tid: topicId,
        page: currentPage,
        screen: 'topic',
        details: detailsSafe
      }));
    }

    // ===== מסך חיפוש - קבלת שאלה =====
    if (currentScreen === 'search') {
      console.log('[Screen Render] Search screen');
      const readCmd = buildReadMenu([
        'חיפוש בפורום',
        'הקישו את מספרי האותיות בהתאם למקלדת הטלפון',
        'לחזרה לתפריט הראשי הקישו אפס'
      ], 'searchquery', { min: 1, max: 20, waitSec: 20, type: 'Digits' });
      return res.send(buildResponse(readCmd, { screen: 'search' }));
    }

    // ===== מסך תוצאות חיפוש =====
    if (currentScreen === 'searchresults') {
      const rawQuery = getState(q, 'sq');
      const searchTerm = decodeURIComponent(rawQuery);
      console.log(`[Screen Render] Searching for: "${searchTerm}"`);

      let topics = [];
      try {
        const data = await nbFetch('/search?term=' + encodeURIComponent(searchTerm) + '&in=titles');
        topics = (data.posts || []).slice(0, 9);
      } catch (e) {
        console.error('[Search Error]', e.message);
      }

      if (topics.length === 0) {
        const readCmd = buildReadMenu([
          'לא נמצאו תוצאות לחיפוש שלכם',
          'לחיפוש חדש הקישו כוכבית',
          'לתפריט הראשי הקישו אפס'
        ], 'searchsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, {
          tids: '',
          screen: 'searchresults'
        }));
      }

      const parts = buildTopicListParts(
        topics,
        `נמצאו ${topics.length} תוצאות`,
        'לחיפוש חדש הקישו כוכבית לתפריט הראשי הקישו אפס'
      );

      const readCmd = buildReadMenu(parts, 'searchsel', { waitSec: 9 });
      return res.send(buildResponse(readCmd, {
        tids: topics.map(t => t.tid).join('>'),
        screen: 'searchresults'
      }));
    }

    // ===== הגנת קצה =====
    console.warn(`[Fallback] Unhandled screen: ${currentScreen}`);
    return res.send(buildTransition('חוזר להתחלה', { screen: 'main' }));

  } catch (globalError) {
    console.error('[Global Exception]', globalError.message);
    const readCmd = buildReadMenu([
      'אירעה שגיאה בטעינת הנתונים מהפורום',
      'אנא נסו שוב מאוחר יותר'
    ], 'mainsel', { waitSec: 5 });
    return res.send(buildResponse(readCmd, { screen: 'main' }));
  }
};
