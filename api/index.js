// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ הטלפוני (NodeBB)
// נבנה באופן בלעדי עבור מערכות ה-IVR של ימות המשיח
//
// ארכיטקטורה מתוקנת (v3.0):
//   - תמיכה מלאה בקטיעת שמע (Barge-in) והקשה תוך כדי דיבור.
//   - כל ההקראה מוזרקת לתוך שדה ה-prompt של פקודת read (ולא id_list_message נפרד).
//   - אין שום שלב של "לאישור הקישו 1" (val_text=no תמיד).
//   - ניהול תפריטים פנימי מהיר ללא go_to_folder.
// ============================================================================

// ----------------------------------------------------------------------------
// משתני סביבה והגדרות קבועות
// ----------------------------------------------------------------------------
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS
const DEFAULT_TIMEOUT = 8000;  // זמן המתנה לקריאות שרת במילישניות

// ============================================================================
// שכבת תקשורת מול ה-Read API של NodeBB
// ============================================================================

/**
 * פונקציה לביצוע בקשות HTTP בטוחות מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיב, ומעבדת את תגובת ה-JSON.
 * כוללת טיפול בשגיאות רשת, timeout ומצבי קצה.
 *
 * @param {string} path הנתיב המבוקש בפורום
 * @returns {Promise<Object>} תגובת ה-JSON של השרת
 */
async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;

  // קונטרולר לניהול timeout של הבקשה
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-advanced-ivr/3.0',
        'Cache-Control': 'no-cache'
      }
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[NodeBB Error] HTTP Status ${res.status} for path: ${path}`);
      throw new Error(`NodeBB HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data) {
      throw new Error('Empty JSON response received from forum API');
    }
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Fetch Exception] Failed to retrieve data from ${url}. Details:`, error.message);
    throw error;
  }
}

// ============================================================================
// עיבוד טקסט להקראה (TTS)
// ============================================================================

/**
 * ניקוי מקיף של HTML והכנת טקסט להקראה במנוע ה-TTS של ימות המשיח.
 * מסירה תגיות, סקריפטים, סגנונות, ציטוטים, ומנקה תווים מיוחדים
 * שעלולים לשבש את פרוטוקול ימות המשיח (מפרידי פקודות).
 *
 * @param {string} html טקסט גולמי המכיל HTML
 * @returns {string} טקסט נקי המותאם להקראה טלפונית
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);

  // שלב א: הסרת אלמנטים שאינם רלוונטיים להקראה קולית
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' '); // הסרת ציטוטים
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' קוד מוגן ');     // חסימת קטעי קוד

  // שלב ב: המרת תגיות מבנה לסימני פיסוק הגיוניים
  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<\/p>/gi, '. ');
  text = text.replace(/<\/div>/gi, '. ');
  text = text.replace(/<\/li>/gi, '. ');
  text = text.replace(/<\/h[1-6]>/gi, '. ');

  // שלב ג: הסרת כל שאר התגיות
  text = text.replace(/<[^>]+>/g, ' ');

  // שלב ד: המרת ישויות HTML
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, ' ו ');
  text = text.replace(/&quot;/gi, ' ');
  text = text.replace(/&#39;|&apos;/gi, ' ');
  text = text.replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');

  // שלב ה: הסרת קישורים
  text = text.replace(/https?:\/\/\S+/gi, ' קישור ');

  // שלב ו: ניקוי תווים מיוחדים שמשבשים את פרוטוקול ימות המשיח
  // חשוב מאוד: נקודה, פסיק, מפריד (.), שלוש המפרידים הקריטיים הם . , = & *
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');

  // שלב ז: צמצום רווחים
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * חיתוך טקסט נקי לפי המגבלה שהוגדרה.
 *
 * @param {string} text טקסט המקור
 * @param {number} max אורך מקסימלי מותר
 * @returns {string} טקסט מנוקה וחתוך
 */
function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

/**
 * המרת חותמת זמן לביטוי מילולי בעברית המובן בשמיעה טלפונית.
 *
 * @param {number|string} ts חותמת זמן במילישניות
 * @returns {string} ביטוי זמן בעברית
 */
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'לפני פחות מדקה';
  if (minutes < 60) return 'לפני ' + minutes + ' דקות';

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'לפני שעה';
  if (hours === 2) return 'לפני שעתיים';
  if (hours < 24) return 'לפני ' + hours + ' שעות';

  const days = Math.floor(hours / 24);
  if (days === 1) return 'אתמול';
  if (days === 2) return 'לפני יומיים';
  if (days < 30) return 'לפני ' + days + ' ימים';

  const months = Math.floor(days / 30);
  if (months === 1) return 'לפני חודש';
  if (months === 2) return 'לפני חודשיים';
  if (months < 12) return 'לפני ' + months + ' חודשים';

  return 'לפני יותר משנה';
}

// ============================================================================
// בניית פקודות ימות המשיח (הליבה של התיקון)
// ============================================================================

/**
 * מנקה חלק טקסט בודד מתווים שעלולים לשבש את פרוטוקול ימות המשיח.
 * מסירה נקודות (מפריד בין הודעות), פסיקים (מפריד פרמטרים),
 * סימני שווה ואמפרסנד (מפרידי פקודות).
 *
 * @param {string} part משפט בודד
 * @returns {string} משפט נקי לשרשור
 */
function sanitizePart(part) {
  return String(part)
    .replace(/[.,=&*]/g, ' ')   // הסרת מפרידי פרוטוקול קריטיים
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * *** ליבת התיקון ***
 * בונה פקודת read מלאה שמשמיעה את כל ההקראה כ-prompt ובו זמנית קולטת הקשה.
 * זהו המפתח ל-barge-in: כשההקראה היא ה-prompt של ה-read עצמו,
 * ימות המשיח קולטת הקשה תוך כדי הדיבור ומפסיקה אותו מיד (קטיעת שמע).
 *
 * הפורמט: read=<prompt משורשר>=<var>,<mode>,<min>,<max>,<timeout>,<type>,<no>,<no>
 *   - השדה השביעי (yes_no / val) מוגדר ל-no  => אין שום "לאישור הקישו 1".
 *   - השדה השמיני (block) מוגדר ל-no.
 *
 * @param {string[]} parts מערך משפטים להשמעה (כל אחד יהפוך ל-t-...)
 * @param {string} paramName שם המשתנה שיחזור (למשל mainsel)
 * @param {Object} opts אפשרויות: { min, max, waitSec, type }
 * @returns {string} פקודת read מוכנה
 */
function buildReadMenu(parts, paramName, opts = {}) {
  const min     = opts.min     !== undefined ? opts.min     : 1;
  const max     = opts.max     !== undefined ? opts.max     : 1;
  const waitSec = opts.waitSec !== undefined ? opts.waitSec : 7;
  const type    = opts.type    || 'Digits';

  // בניית שרשור ה-prompt: כל חלק הופך ל "t-<טקסט נקי>" ומופרדים בנקודה
  const promptStr = parts
    .filter(p => p && String(p).trim() !== '')
    .map(p => 't-' + sanitizePart(p))
    .join('.');

  // val_text=no (שדה 7) => אין בקשת אישור. block=no (שדה 8).
  return `read=${promptStr}=${paramName},no,${min},${max},${waitSec},${type},no,no`;
}

/**
 * בונה פקודת read "שקטה" קצרה שמשמשת רק כדי להחזיר את השליטה לשרת
 * עם מסך חדש (מעבר מסך פנימי), ללא הקראה משמעותית.
 * timeout קצר מאוד (1 שניה) כדי שהמעבר יהיה כמעט מיידי.
 *
 * @param {string} text טקסט קצר (למשל "טוען נושא")
 * @returns {string} פקודת read מינימלית
 */
function buildSilentRead(text) {
  const t = sanitizePart(text || 'טוען');
  return `read=t-${t}=dummy,no,1,1,1,Digits,no,no`;
}

// ============================================================================
// בניית רשימות תוכן להקראה
// ============================================================================

/**
 * בונה את מערך המשפטים להשמעת רשימת נושאים.
 *
 * @param {Array} topics מערך הנושאים מה-API
 * @param {string} headerText כותרת פתיחה
 * @param {string} footerText הודעת ניווט בסיום
 * @returns {string[]} מערך משפטים מוכן
 */
function buildTopicListParts(topics, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);

  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים להצגה כעת במערכת');
    return parts;
  }

  topics.forEach((tp, i) => {
    const num = i + 1;
    const title = ttsCut(tp.title, MAX_TITLE_CHARS);
    const username = tp.user && tp.user.username ? tp.user.username : 'משתמש אנונימי';

    parts.push(`לנושא מספר ${num}`);
    parts.push(title);
    parts.push(`מאת ${username}`);
    parts.push(`הקישו ${num}`);
  });

  if (footerText) parts.push(footerText);
  return parts;
}

/**
 * בונה את מערך המשפטים להשמעת רשימת קטגוריות.
 *
 * @param {Array} cats מערך קטגוריות
 * @param {string} headerText כותרת פתיחה
 * @returns {string[]} מערך משפטים מוכן
 */
function buildCategoryListParts(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);

  if (!cats || cats.length === 0) {
    parts.push('לא נמצאו קטגוריות זמינות במערכת');
    return parts;
  }

  cats.forEach((c, i) => {
    const num = i + 1;
    const name = cleanText(c.name);
    parts.push(`לקטגוריה מספר ${num}`);
    parts.push(name);
    parts.push(`הקישו ${num}`);
  });

  parts.push('לחזרה לתפריט הראשי בכל עת הקישו אפס');
  return parts;
}

// ============================================================================
// פונקציות עזר לבניית תגובות מלאות (read + פרמטרי api_add)
// ============================================================================

/**
 * מאחדת פקודת read עם פרמטרי api_add_* (state) לתגובה אחת תקינה.
 *
 * @param {string} readCmd פקודת read מוכנה
 * @param {Object} stateParams מילון של פרמטרי מצב (screen, tids, וכו')
 * @returns {string} מחרוזת התגובה המלאה
 */
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  for (const key in stateParams) {
    if (stateParams[key] === undefined || stateParams[key] === null) continue;
    out += `&api_add_${key}=${stateParams[key]}`;
  }
  return out;
}

/**
 * תגובת "מעבר מסך פנימי" - read שקט קצר + פרמטרי מצב חדשים.
 *
 * @param {string} text טקסט קצר להשמעה בזמן המעבר
 * @param {Object} stateParams פרמטרי המצב החדשים
 * @returns {string} מחרוזת תגובה מלאה
 */
function buildTransition(text, stateParams = {}) {
  return buildResponse(buildSilentRead(text), stateParams);
}

// ============================================================================
// פונקציית הראוטר המרכזית (Serverless Handler של Vercel)
// ============================================================================

module.exports = async (req, res) => {
  // כותרות מענה התואמות לקידוד של ימות המשיח
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // איחוד פרמטרים נכנסים מ-GET או POST
  const queryData = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(queryData, req.body);
  }

  // לוג דיבאג
  console.log(`[IVR Request] Screen: ${queryData.screen}, Mainsel: ${queryData.mainsel}, Full Query:`, JSON.stringify(queryData));

  // מצב המסך הנוכחי (ברירת מחדל main)
  let currentScreen = queryData.screen || 'main';

  try {
    // ========================================================================
    // שלב א': עיבוד הקשות משתמש אקטיביות (עדיים)
    // ========================================================================

    // ---- 1. עיבוד בחירה מהתפריט הראשי ----
    if (queryData.mainsel !== undefined && queryData.mainsel !== '') {
      const selection = String(queryData.mainsel).trim();
      console.log(`[Menu Process] User pressed ${selection} on Main Menu`);

      if (selection === '1') {
        currentScreen = 'recent';
      } else if (selection === '2') {
        currentScreen = 'topics';
      } else if (selection === '3') {
        currentScreen = 'categories';
      } else {
        // הקשה שגויה - נשמיע שגיאה ונחזור לתפריט הראשי (הכל בתוך read אחד עם barge-in)
        const readCmd = buildReadMenu([
          'המקש שהוקש שגוי אנא נסו שנית',
          'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
          'לכניסה לפוסטים האחרונים הקישו 1',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
          'לכניסה לפי קטגוריות הקישו 3'
        ], 'mainsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ---- 2. עיבוד בחירה ממסך פוסטים אחרונים (recent) ----
    if (queryData.recentsel !== undefined && queryData.recentsel !== '') {
      const selection = String(queryData.recentsel).trim();
      console.log(`[Menu Process] User pressed ${selection} on Recent Topics`);

      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '*') {
        currentScreen = 'recent';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.tids || '').split(',').filter(x => x);

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          // מעבר ישיר למסך שמיעת הנושא, ללא go_to_folder
          return res.send(buildTransition('טוען נושא', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          const readCmd = buildSilentRead('בחירה לא תקינה אנא הקישו שוב');
          return res.send(buildResponse(readCmd, { screen: 'recent' }));
        }
      }
    }

    // ---- 3. עיבוד בחירה ממסך נושאים חדשים (topics) ----
    if (queryData.topicsel !== undefined && queryData.topicsel !== '') {
      const selection = String(queryData.topicsel).trim();
      console.log(`[Menu Process] User pressed ${selection} on Newest Topics`);

      if (selection === '0') {
        currentScreen = 'main';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.tids || '').split(',').filter(x => x);

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          const readCmd = buildSilentRead('בחירה לא תקינה אנא הקישו שוב');
          return res.send(buildResponse(readCmd, { screen: 'topics' }));
        }
      }
    }

    // ---- 4. עיבוד בחירה ממסך קטגוריות (categories) ----
    if (queryData.catsel !== undefined && queryData.catsel !== '') {
      const selection = String(queryData.catsel).trim();
      const currentCid = String(queryData.curcid || '');
      console.log(`[Menu Process] User pressed ${selection} on Categories Screen`);

      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '*' && currentCid) {
        // מעבר ישיר לשמיעת נושאים בקטגוריה הנוכחית
        return res.send(buildTransition('טוען נושאים בקטגוריה', {
          screen: 'cattopics',
          cid: currentCid
        }));
      } else {
        const index = parseInt(selection, 10) - 1;
        const categoryIds = String(queryData.cids || '').split(',').filter(x => x);

        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          // טעינת תת-קטגוריה / הצגת נושאיה
          return res.send(buildTransition('טוען קטגוריה', {
            screen: 'categories',
            cid: categoryIds[index]
          }));
        } else {
          const readCmd = buildSilentRead('הקשה שגויה נסו שוב');
          return res.send(buildResponse(readCmd, {
            screen: 'categories',
            cid: currentCid || undefined
          }));
        }
      }
    }

    // ---- 5. עיבוד בחירה מתוך נושאים של קטגוריה ספציפית (cattopics) ----
    if (queryData.cattopicsel !== undefined && queryData.cattopicsel !== '') {
      const selection = String(queryData.cattopicsel).trim();
      if (selection === '0') {
        currentScreen = 'main';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.tids || '').split(',').filter(x => x);

        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען', {
            screen: 'topic',
            tid: topicIds[index],
            page: 0
          }));
        } else {
          const readCmd = buildSilentRead('בחירה שגויה חוזר לתפריט');
          return res.send(buildResponse(readCmd, { screen: 'main' }));
        }
      }
    }

    // ---- 6. ניווט מתוך פוסטים בתוך נושא (topicnav) ----
    if (queryData.topicnav !== undefined && queryData.topicnav !== '') {
      const selection = String(queryData.topicnav).trim();
      const topicId = String(queryData.tid || '');
      const currentPage = parseInt(queryData.page || '0', 10);

      console.log(`[Topic Navigation] User pressed ${selection} on Topic ${topicId}, Page ${currentPage}`);

      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '1') {
        // הודעה הבאה
        return res.send(buildTransition('ההודעה הבאה', {
          screen: 'topic',
          tid: topicId,
          page: currentPage + 1
        }));
      } else if (selection === '2') {
        // הודעה קודמת (לא יורד מתחת ל-0)
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        return res.send(buildTransition('ההודעה הקודמת', {
          screen: 'topic',
          tid: topicId,
          page: prevPage
        }));
      } else if (selection === '3') {
        // פרטים נוספים על ההודעה הנוכחית - הכל בתוך read אחד עם barge-in
        const details = decodeURIComponent(queryData.details || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        const readCmd = buildReadMenu(details, 'detback', { waitSec: 6 });
        return res.send(buildResponse(readCmd, {
          screen: 'detback',
          tid: topicId,
          page: currentPage
        }));
      } else {
        // הקשה לא חוקית - נשארים באותה הודעה
        return res.send(buildTransition('בחירה שגויה', {
          screen: 'topic',
          tid: topicId,
          page: currentPage
        }));
      }
    }

    // ---- 7. חזרה מפרטי הודעה (detback) ----
    if (queryData.detback !== undefined && queryData.detback !== '') {
      const topicId = String(queryData.tid || '');
      const currentPage = parseInt(queryData.page || '0', 10);
      return res.send(buildTransition('חוזר להודעה', {
        screen: 'topic',
        tid: topicId,
        page: currentPage
      }));
    }

    // ---- 8. מסך סיום נושא (topicend) ----
    if (queryData.topicend !== undefined && queryData.topicend !== '') {
      const selection = String(queryData.topicend).trim();
      const topicId = String(queryData.tid || '');

      if (selection === '1') {
        return res.send(buildTransition('מתחילים מחדש', {
          screen: 'topic',
          tid: topicId,
          page: 0
        }));
      } else {
        currentScreen = 'main';
      }
    }

    // ========================================================================
    // שלב ב': הפקת המסכים והתפריטים לפי currentScreen
    // ========================================================================

    // ===== מסך תפריט ראשי =====
    if (currentScreen === 'main') {
      // כל ההקראה היא ה-prompt של ה-read עצמו => barge-in מלא, ניתן להקיש מיד.
      // הברכה היא חלק מהתפריט - אין מסך נפרד שמיד מנתב חזרה.
      const readCmd = buildReadMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'mainsel', { waitSec: 7 });

      return res.send(buildResponse(readCmd, { screen: 'main' }));
    }

    // ===== מסך פוסטים אחרונים =====
    if (currentScreen === 'recent') {
      console.log('[Screen Render] Fetching recent posts...');
      const data = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, 9); // עד 9 כדי להתאים למקשים 1-9

      const parts = buildTopicListParts(
        topics,
        'הפוסטים האחרונים בפורום',
        'לרענון רשימה זו הקישו כוכבית לחזרה לתפריט הראשי הקישו אפס'
      );

      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCmd = buildReadMenu(parts, 'recentsel', { waitSec: 9, type: 'Digits' });

      return res.send(buildResponse(readCmd, {
        tids: topicIdsString,
        screen: 'recent'
      }));
    }

    // ===== מסך נושאים חדשים שנפתחו =====
    if (currentScreen === 'topics') {
      console.log('[Screen Render] Fetching newest topics...');
      let data;
      try {
        data = await nbFetch('/recent?term=alltime&sort=newest');
      } catch (e) {
        data = await nbFetch('/recent');
      }

      let topics = (data.topics || []);
      topics = topics.slice()
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, 9);

      const parts = buildTopicListParts(
        topics,
        'הנושאים החדשים ביותר שנפתחו בפורום',
        'לחזרה לתפריט הראשי הקישו אפס בכל עת'
      );

      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCmd = buildReadMenu(parts, 'topicsel', { waitSec: 9 });

      return res.send(buildResponse(readCmd, {
        tids: topicIdsString,
        screen: 'topics'
      }));
    }

    // ===== מסך קטגוריות ראשיות / תתי-קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = queryData.cid ? String(queryData.cid) : '';
      console.log(`[Screen Render] Loading categories. Parent CID: ${cid || 'None'}`);

      let categoriesList = [];
      let headerText = '';

      if (!cid) {
        const data = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, 9);
        headerText = 'תפריט קטגוריות ראשיות';
      } else {
        const data = await nbFetch('/category/' + cid);
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, 9);
        headerText = 'קטגוריית ' + cleanText(data.name || '');
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        // הוספת אפשרות כוכבית רק כשנמצאים בתוך קטגוריה
        if (cid) {
          parts.push('לשמיעת הפוסטים בתוך קטגוריה זו הקישו כוכבית');
        }

        const categoryIdsString = categoriesList.map(c => c.cid).join(',');
        const readCmd = buildReadMenu(parts, 'catsel', { waitSec: 9 });

        return res.send(buildResponse(readCmd, {
          cids: categoryIdsString,
          curcid: cid,
          screen: 'categories'
        }));
      } else if (cid) {
        // אין תתי-קטגוריות => מעבר לשמיעת נושאי הקטגוריה
        return res.send(buildTransition('מיד נטען את הנושאים', {
          screen: 'cattopics',
          cid: cid
        }));
      } else {
        const readCmd = buildSilentRead('לא נמצאו קטגוריות זמינות חוזר לתפריט');
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ===== מסך נושאים בתוך קטגוריה ספציפית =====
    if (currentScreen === 'cattopics') {
      const cid = String(queryData.cid || '');
      if (!cid) {
        return res.send(buildTransition('שגיאה חוזר לתפריט', { screen: 'main' }));
      }

      console.log(`[Screen Render] Loading topics inside category CID: ${cid}`);
      const data = await nbFetch('/category/' + cid);
      const topics = (data.topics || []).slice(0, 9);

      const parts = buildTopicListParts(
        topics,
        'נושאים זמינים בקטגוריית ' + cleanText(data.name || ''),
        'לחזרה לתפריט הראשי הקישו אפס'
      );

      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCmd = buildReadMenu(parts, 'cattopicsel', { waitSec: 9 });

      return res.send(buildResponse(readCmd, {
        tids: topicIdsString,
        screen: 'cattopics'
      }));
    }

    // ===== מסך שמיעת נושא (השמעת פוסטים אינטראקטיבית) =====
    if (currentScreen === 'topic') {
      const topicId = String(queryData.tid || '');
      if (!topicId) {
        return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));
      }

      const currentPage = parseInt(queryData.page || '0', 10);
      console.log(`[Screen Render] Loading topic ID: ${topicId}, post page index: ${currentPage}`);

      const data = await nbFetch('/topic/' + topicId);
      const posts = data.posts || [];
      const topicTitle = ttsCut(data.title, MAX_TITLE_CHARS);

      // בדיקה אם הגענו לסוף ההודעות
      if (currentPage >= posts.length) {
        const readCmd = buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לחזרה לתפריט הראשי הקישו אפס או כל מקש אחר'
        ], 'topicend', { waitSec: 8 });

        return res.send(buildResponse(readCmd, {
          tid: topicId,
          screen: 'topicend'
        }));
      }

      // הפוסט הנוכחי
      const currentPost = posts[currentPage];
      const postBody = ttsCut(currentPost.content, MAX_BODY_CHARS);
      const authorName = currentPost.user && currentPost.user.username
        ? currentPost.user.username
        : 'משתמש הפורום';

      // בניית גוף ההקראה
      const audioParts = [];
      if (currentPage === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle);
      }
      audioParts.push(`הודעה מספר ${currentPage + 1} מתוך ${posts.length}`);
      audioParts.push(`נכתבה על ידי ${authorName}`);
      audioParts.push(postBody);

      // תפריט ניווט (חלק מאותו read => barge-in מלא בזמן ההקראה)
      audioParts.push('להודעה הבאה הקישו 1');
      audioParts.push('להודעה הקודמת הקישו 2');
      audioParts.push('לשמיעת פרטי ההודעה המלאים הקישו 3');
      audioParts.push('לחזרה לתפריט הראשי הקישו אפס');

      // מטא-דאטה למסך הפרטים (מקש 3)
      const postDetailsArray = [
        'פרטים מלאים על ההודעה הנוכחית',
        'שם המחבר הוא ' + authorName,
        'הודעה זו פורסמה ' + timeAgo(currentPost.timestamp)
      ];

      if (currentPost.toPid) {
        const parentPost = posts.find(x => String(x.pid) === String(currentPost.toPid));
        if (parentPost && parentPost.user) {
          postDetailsArray.push('הודעה זו היא תגובה ישירה ל' + parentPost.user.username);
        }
      }
      postDetailsArray.push(`סך הכל ישנם ${data.postcount || posts.length} פוסטים בדיון זה`);

      const metadataString = encodeURIComponent(postDetailsArray.join('|'));

      // waitSec ארוך (15) כדי לתת זמן לשמוע את כל הפוסט לפני שצריך להקיש,
      // אבל ה-barge-in פעיל לכל אורך ההקראה ולכן אפשר להקיש מיד.
      const readCmd = buildReadMenu(audioParts, 'topicnav', { waitSec: 15 });

      return res.send(buildResponse(readCmd, {
        tid: topicId,
        page: currentPage,
        screen: 'topic',
        details: metadataString
      }));
    }

    // ===== הגנת קצה - מצב לא מזוהה =====
    console.warn(`[Fallback] Unhandled screen state: ${currentScreen}. Redirecting to main menu.`);
    return res.send(buildTransition('חוזר להתחלה', { screen: 'main' }));

  } catch (globalError) {
    console.error('[Global API Exception] Critical failure in module execution:', globalError);
    const readCmd = buildReadMenu([
      'אירעה שגיאה זמנית בתקשורת ובטעינת הנתונים משרתי הפורום',
      'אנא המתינו מספר שניות ונסו שוב מאוחר יותר'
    ], 'mainsel', { waitSec: 5 });
    return res.send(buildResponse(readCmd, { screen: 'main' }));
  }
};
