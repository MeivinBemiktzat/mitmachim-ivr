// ============================================================================
// api/index.js
// מודול שער טלפוני (IVR Gateway) מורחב, מתקדם ומבוסס Serverless / CommonJS
// מותאם במיוחד עבור פורום מתמחים טופ (NodeBB) ומערכות ימות המשיח.
// ----------------------------------------------------------------------------
// ארכיטקטורה Serverless: module.exports = async (req, res)
// אין Express ואין app.listen — הקובץ מיועד לפלטפורמות Serverless (Vercel וכו').
// ----------------------------------------------------------------------------
// תיקון באגים קריטיים:
//   • הוסר לחלוטין כל שימוש ב-res.redirect — כל מעבר מסך מתבצע אך ורק
//     באמצעות פרוטוקול ימות המשיח: api_add_screen / api_add_tid / api_add_page ...
//   • תוקן באג ה-read הכפול: כעת הפקודה היא read= (ולא read==).
//   • נמנעים לופים אינסופיים של חזרה לתפריט הראשי.
//   • fallback חכם במקרה של תקלות API.
// ----------------------------------------------------------------------------
// יכולות חדשות:
//   • חיפוש בפורום (search) — קליטת מילות חיפוש בהקלטה המתומללת ע"י מנוע
//     זיהוי הדיבור המובנה של ימות המשיח (read מסוג voice), והשמעת התוצאות.
//   • מסך משתמשים (users) — תפריט בחירה בין "המפרסמים ביותר" לבין
//     "בעלי המוניטין הגבוה ביותר", והשמעת רשימת המשתמשים.
// ============================================================================

'use strict';

// ============================================================================
// קבועים גלובליים של המערכת
// ============================================================================
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');

const MAX_TITLE_CHARS = 300;       // הגבלת אורך מקסימלי לכותרת דיון להקראה
const MAX_BODY_CHARS = 950;        // הגבלת אורך מקסימלי לגוף הודעה (מניעת קריסות TTS)
const MAX_NAME_CHARS = 80;         // הגבלת אורך לשם משתמש להקראה
const MAX_SEARCH_CHARS = 120;      // הגבלת אורך למחרוזת חיפוש שתישלח לפורום
const DEFAULT_TIMEOUT = 12000;     // זמן המתנה לקריאות שרת חיצוני (מילישניות)
const ITEMS_PER_PAGE = 5;          // כמות נושאים מקסימלית להקראה בכל עמוד
const MAX_CATEGORIES = 8;          // כמות קטגוריות מקסימלית בתפריט
const MAX_USERS_TO_READ = 8;       // כמות משתמשים מקסימלית להקראה בכל עמוד
const POSTS_PER_PAGE = 20;         // הנחת ברירת מחדל לכמות פוסטים בעמוד NodeBB

// ============================================================================
// פונקציות עזר לבניית הפרוטוקול הטלפוני של ימות המשיח
// ============================================================================

/**
 * בריחת תווים שעלולים לשבש את פרוטוקול ימות המשיח בתוך טקסט TTS.
 * התווים נקודה (.) ומקף (-) משמשים כמפרידים בפקודות id_list_message
 * ולכן אסור שיופיעו בגוף הטקסט.
 * @param {string} text
 * @returns {string}
 */
function sanitizeTtsSegment(text) {
  if (text === undefined || text === null) return '';
  let s = String(text);
  // החלפת מפרידים קריטיים של הפרוטוקול ברווח כדי לא לשבור את ההשמעה
  s = s.replace(/[.\-]/g, ' ');
  // ניקוי רווחים מיותרים
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * הופכת מערך של הודעות לחרוזת רצף בפורמט id_list_message של ימות המשיח.
 * @param {Array<string>} items רשימת הודעות (למשל t-שלום או f-001)
 * @returns {string} חרוזת משורשרת בפורמט ימות המשיח, או מחרוזת ריקה
 */
function idList(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const cleaned = items
    .filter((it) => typeof it === 'string' && it.length > 0);
  if (cleaned.length === 0) return '';
  return `id_list_message=${cleaned.join('.')}.`;
}

/**
 * בונה פקודת הקלט קולית מהירה (read) בפורמט הנתמך ע"י ימות המשיח.
 * שימו לב: הפקודה הנכונה היא read= (ולא read==) — הבאג הכפול תוקן.
 *
 * הפורמט: read=t-הודעה=שם_משתנה,no,min,max,timeout,Digits,yes,no
 *
 * @param {string} varName שם המשתנה שיוחזר
 * @param {string} promptText טקסט להשמעה (יעבור ניקוי בסיסי)
 * @param {number} maxDigits כמות ספרות מקסימלית
 * @param {number} minDigits כמות ספרות מינימלית
 * @param {string|number} timeout זמן המתנה בשניות
 * @returns {string} פקודת read מלאה
 */
function buildRead(varName, promptText, maxDigits = 1, minDigits = 1, timeout = '8') {
  const safePrompt = sanitizeTtsSegment(promptText) || 'אנא הקישו את בחירתכם';
  // החלק הראשון: ההודעה להשמעה. החלק השני: הגדרת קליטת ההקשה.
  return `read=t-${safePrompt}=${varName},no,${minDigits},${maxDigits},${timeout},Digits,yes,no`;
}

/**
 * בונה פקודת read לקליטת הקלטה קולית והמרתה לטקסט (זיהוי דיבור מובנה).
 * מנוע הזיהוי של ימות המשיח (voice) ממיר את דיבור המשתמש לטקסט ושולח אותו
 * חזרה תחת שם המשתנה — כך מתאפשר חיפוש קולי בפורום ללא ספרייה חיצונית.
 *
 * @param {string} varName שם המשתנה שיכיל את הטקסט המתומלל
 * @param {string} promptText טקסט הנחיה להשמעה
 * @returns {string} פקודת read מסוג voice
 */
function buildVoiceRead(varName, promptText) {
  const safePrompt = sanitizeTtsSegment(promptText) || 'אנא אמרו את מילות החיפוש';
  // voice = מנוע זיהוי דיבור המובנה של ימות המשיח, ממיר דיבור לטקסט
  return `read=t-${safePrompt}=${varName},no,voice`;
}

/**
 * בונה פקודת read לקליטת טקסט במקלדת עברית (גיבוי לזיהוי הדיבור).
 * משמש כאשר רוצים שהמשתמש יקליד את מילות החיפוש על מקשי הטלפון.
 *
 * @param {string} varName שם המשתנה שיכיל את הטקסט שהוקלד
 * @param {string} promptText טקסט הנחיה להשמעה
 * @returns {string} פקודת read מסוג HebrewKeyboard
 */
function buildHebrewKeyboardRead(varName, promptText) {
  const safePrompt = sanitizeTtsSegment(promptText) || 'אנא הקלידו את מילות החיפוש';
  return `read=t-${safePrompt}=${varName},no,,,,HebrewKeyboard`;
}

/**
 * מנקה ומכין טקסט מהפורום להקראה קולית נקייה בטכנולוגיית TTS.
 * מסירה קוד, תגיות HTML, קישורים, אמוג'ים ותווים מיוחדים שגורמים לקריסת TTS
 * או לשיבוש פרוטוקול ימות המשיח.
 *
 * @param {string} rawText הטקסט הגולמי מהפורום
 * @param {number} maxLen אורך מקסימלי מותר
 * @returns {string} טקסט נקי ובטוח להקראה
 */
function cleanTextForTTS(rawText, maxLen = MAX_BODY_CHARS) {
  if (rawText === undefined || rawText === null) return 'הודעה ריקה';
  if (typeof rawText !== 'string') {
    try {
      rawText = String(rawText);
    } catch (e) {
      return 'הודעה ריקה';
    }
  }

  let text = rawText;

  // 1. הסרת בלוקים של קוד שנכתבו בפורום
  text = text.replace(/```[\s\S]*?```/g, ' קוד חסום ');
  text = text.replace(/`[^`]*`/g, ' ');

  // 2. הסרת ציטוטים מובנים של NodeBB (לדוגמה: @user כתב:)
  text = text.replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, ' ציטוט ');

  // 3. הסרת תגיות HTML נפוצות
  text = text.replace(/<[^>]*>/g, ' ');

  // 4. פענוח ישויות HTML בסיסיות
  text = text.replace(/&amp;/g, ' ');
  text = text.replace(/&quot;/g, ' ');
  text = text.replace(/&#x27;/g, ' ');
  text = text.replace(/&#39;/g, ' ');
  text = text.replace(/&lt;/g, ' ');
  text = text.replace(/&gt;/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&[a-zA-Z0-9#]+;/g, ' ');

  // 5. הסרת קישורים ותמונות בפורמט Markdown
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' תמונה ');
  text = text.replace(/\[image:[^\]]*\]/gi, ' תמונה ');
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, ' קישור ');

  // 6. הסרת כתובות URL חשופות
  text = text.replace(/https?:\/\/[^\s]+/g, ' קישור ');
  text = text.replace(/www\.[^\s]+/g, ' קישור ');

  // 7. הסרת תוויות מיוחדות של מנגנון התצוגה (Spoiler וכו')
  text = text.replace(/Spoiler/gi, ' ');

  // 8. הסרת אמוג'ים ותווים שאינם עבריים/לטיניים/ספרות/פיסוק בסיסי
  //    שומרים על אותיות עברית, לטינית, ספרות ורווחים.
  text = text.replace(/[^\u0590-\u05FFa-zA-Z0-9\s.,?!]/g, ' ');

  // 9. החלפת מפרידי הפרוטוקול הקריטיים (נקודה ומקף) ברווח כדי לא לשבור TTS
  text = text.replace(/[.\-]/g, ' ');

  // 10. ניקוי רווחים כפולים, ירידות שורה וטאבים
  text = text.replace(/\s+/g, ' ').trim();

  // 11. חיתוך לאורך המקסימלי המותר
  if (text.length > maxLen) {
    text = text.substring(0, maxLen).trim() + ' המשך ההודעה ארוך מדי לשמיעה בטלפון';
  }

  return text || 'הודעה ללא תוכן מילולי';
}

/**
 * מנקה מחרוזת חיפוש שהתקבלה מהמשתמש (תמלול דיבור או הקלדה) לפני שליחה לפורום.
 * @param {string} raw
 * @returns {string}
 */
function cleanSearchTerm(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let term = raw;
  // הסרת תווים מיוחדים שעלולים לשבש את הבקשה
  term = term.replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ');
  term = term.replace(/\s+/g, ' ').trim();
  if (term.length > MAX_SEARCH_CHARS) {
    term = term.substring(0, MAX_SEARCH_CHARS).trim();
  }
  return term;
}

// ============================================================================
// שכבת תקשורת עם הפורום (NodeBB Read API)
// ============================================================================

/**
 * מבצעת פנייה בטוחה ומאובטחת ל-Read API של פורום מתמחים טופ.
 * כוללת טיימאאוט ומנגנון הגנה מפני קריסות שרת חיצוני.
 *
 * @param {string} apiEndpoint נתיב ה-API (יחסי, ללא קידומת /api/)
 * @returns {Promise<object|null>} אובייקט JSON או null במקרה של תקלה
 */
async function fetchFromForum(apiEndpoint) {
  const cleanEndpoint = String(apiEndpoint || '').replace(/^\/+/, '');
  const targetUrl = `${FORUM_URL}/api/${cleanEndpoint}`;
  console.log(`[HTTP Request] Fetching data from Forum: ${targetUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mitmachim-IVR-Gateway-Pro/3.0 (NodeJS/Serverless)',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[Forum Fetch Error] HTTP status ${response.status} for ${cleanEndpoint}`);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = (error && error.message) ? error.message : 'unknown error';
    console.error(`[Forum Fetch Error] Endpoint [${cleanEndpoint}] failed: ${msg}`);
    return null;
  }
}

// ============================================================================
// פונקציות עזר לבניית מחרוזות מצב (api_add_*) — מחליפות לחלוטין את res.redirect
// ============================================================================

/**
 * בונה מחרוזת פרמטרי מצב לשמירת ניווט בפרוטוקול ימות המשיח.
 * כל מעבר מסך מתבצע אך ורק כך — ללא שום שימוש ב-res.redirect.
 *
 * @param {object} state אובייקט עם המפתחות screen/tid/cid/page/post_idx
 * @returns {string} מחרוזת api_add_* משורשרת
 */
function buildScreenState(state) {
  let out = '';
  if (state.screen !== undefined && state.screen !== null) {
    out += `&api_add_screen=${state.screen}`;
  }
  if (state.tid !== undefined && state.tid !== null) {
    out += `&api_add_tid=${state.tid}`;
  }
  if (state.cid !== undefined && state.cid !== null) {
    out += `&api_add_cid=${state.cid}`;
  }
  if (state.page !== undefined && state.page !== null) {
    out += `&api_add_page=${state.page}`;
  }
  if (state.post_idx !== undefined && state.post_idx !== null) {
    out += `&api_add_post_idx=${state.post_idx}`;
  }
  if (state.usort !== undefined && state.usort !== null) {
    out += `&api_add_usort=${state.usort}`;
  }
  if (state.search_term !== undefined && state.search_term !== null) {
    out += `&api_add_search_term=${encodeURIComponent(state.search_term)}`;
  }
  return out;
}

// ============================================================================
// נתיב ה-API המרכזי — Serverless Handler
// תומך גם ב-GET וגם ב-POST ומבצע מיזוג פרמטרים מוחלט (query + body).
// ============================================================================

/**
 * מנתח את גוף הבקשה במקרה שהפלטפורמה לא פירשה אותו אוטומטית.
 * מבטיח תאימות לכל סוגי ה-runtime ה-Serverless.
 * @param {object} req
 * @returns {object}
 */
function extractBody(req) {
  if (!req || req.body === undefined || req.body === null) return {};
  // אם הגוף כבר אובייקט מפוענח
  if (typeof req.body === 'object') return req.body;
  // אם הגוף הוא מחרוזת — ננסה לפענח JSON ואז URL-encoded
  if (typeof req.body === 'string') {
    const raw = req.body.trim();
    if (raw.length === 0) return {};
    // ניסיון JSON
    try {
      return JSON.parse(raw);
    } catch (e) {
      // ניסיון URL-encoded
      try {
        const params = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        return obj;
      } catch (e2) {
        return {};
      }
    }
  }
  return {};
}

/**
 * נקודת הכניסה הראשית (Serverless). אין Express ואין app.listen.
 */
module.exports = async (req, res) => {
  // איחוד מלא של כל הפרמטרים הנכנסים — פותר באג POST/GET
  const query = (req && req.query) ? req.query : {};
  const body = extractBody(req);
  const params = Object.assign({}, query, body);

  // לוגים לאבחון (ניתן לכבות בפרודקשן)
  try {
    console.log('[Incoming] Method:', req && req.method);
    console.log('[Incoming] QUERY:', JSON.stringify(query));
    console.log('[Incoming] BODY:', JSON.stringify(body));
    console.log('[Incoming] CallId:', params.ApiCallId || 'Unknown',
      '| Phone:', params.ApiPhone || 'Private',
      '| Screen:', params.screen || 'main');
  } catch (e) {
    // התעלמות משגיאות לוג בלבד
  }

  // הגנת ניתוק שיחה מוקדם — מונע עיבוד מיותר
  if (params.hangup === 'yes') {
    console.log(`[Hangup Event] Call ${params.ApiCallId || 'Unknown'} terminated by user.`);
    return safeSend(res, 'hangup=yes');
  }

  const currentScreen = params.screen || 'main';

  try {
    switch (currentScreen) {
      case 'main':
        return await handleMainMenu(params, res);
      case 'recent_topics':
        return await handleRecentTopics(params, res);
      case 'unread_topics':
        return await handleUnreadTopics(params, res);
      case 'categories_list':
        return await handleCategoriesList(params, res);
      case 'category_view':
        return await handleCategoryView(params, res);
      case 'topic_view':
        return await handleTopicView(params, res);
      case 'search':
        return await handleSearch(params, res);
      case 'users_menu':
        return await handleUsersMenu(params, res);
      case 'users_list':
        return await handleUsersList(params, res);
      default:
        console.warn(`[Routing Warning] Unidentified screen: ${currentScreen}. Resetting to main.`);
        return sendFallbackToMain(res, 'מצב מסך לא מזוהה במערכת');
    }
  } catch (globalError) {
    const msg = (globalError && globalError.message) ? globalError.message : 'unknown';
    console.error(`[Fatal System Error] Critical exception in root handler: ${msg}`);
    return sendFallbackToMain(res, 'שגיאה כללית זמנית במערכת הפורום הטלפוני');
  }
};

/**
 * שליחת תגובה בטוחה — עוטף res.send/res.status בטיפול שגיאות.
 * @param {object} res
 * @param {string} payload
 */
function safeSend(res, payload) {
  try {
    if (res && typeof res.status === 'function') {
      return res.status(200).send(payload);
    }
    if (res && typeof res.send === 'function') {
      return res.send(payload);
    }
    // fallback ל-runtime שאינו Express-like
    if (res && typeof res.end === 'function') {
      try { res.statusCode = 200; } catch (e) { /* ignore */ }
      return res.end(payload);
    }
  } catch (e) {
    console.error('[safeSend Error]', e && e.message);
  }
  return payload;
}

// ============================================================================
// מסך 1: תפריט ראשי
// ============================================================================

/**
 * מסך 1: תפריט ראשי של הפורום הטלפוני.
 * כולל: נושאים אחרונים, נושאים חדשים, קטגוריות, חיפוש בפורום, משתמשים.
 */
async function handleMainMenu(params, res) {
  const selection = params.mainsel;

  if (selection !== undefined && selection !== null && selection !== '') {
    console.log(`[Main Menu Selection] User selected: ${selection}`);

    switch (String(selection)) {
      case '1':
        // נושאים אחרונים — מעבר באמצעות api_add_* בלבד
        return safeSend(res,
          `${idList(['t-מעבר לפוסטים האחרונים'])}` +
          buildScreenState({ screen: 'recent_topics', page: 1 }));

      case '2':
        // נושאים חדשים / פופולריים
        return safeSend(res,
          `${idList(['t-מעבר לנושאים החדשים'])}` +
          buildScreenState({ screen: 'unread_topics', page: 1 }));

      case '3':
        // רשימת קטגוריות
        return safeSend(res,
          `${idList(['t-מעבר לקטגוריות הפורום'])}` +
          buildScreenState({ screen: 'categories_list' }));

      case '4':
        // חיפוש בפורום
        return safeSend(res,
          `${idList(['t-מעבר לחיפוש בפורום'])}` +
          buildScreenState({ screen: 'search' }));

      case '5':
        // רשימת משתמשים
        return safeSend(res,
          `${idList(['t-מעבר לרשימת המשתמשים'])}` +
          buildScreenState({ screen: 'users_menu' }));

      default: {
        // הקשה שגויה — השמעת שגיאה והקראת התפריט מחדש
        const audioParts = [
          't-המקש שהוקש שגוי',
          't-לכניסה לפוסטים האחרונים הקישו 1',
          't-לשמיעת הנושאים החדשים ביותר הקישו 2',
          't-לכניסה לפי קטגוריות הקישו 3',
          't-לחיפוש בפורום הקישו 4',
          't-לרשימת המשתמשים הקישו 5'
        ];
        const audioOutput = idList(audioParts);
        const readCommand = buildRead('mainsel', '', 1, 1, '9');
        return safeSend(res, `${readCommand}${audioOutput}&api_add_screen=main`);
      }
    }
  }

  // מצב התחלתי — ברכת פתיחה + תפריט
  const welcomeAudio = [
    't-ברוכים הבאים לפורום מתמחים טופ הטלפוני',
    't-כאן תוכלו להאזין לפוסטים ולנושאים שנוצרו בפורום מתמחים טופ באופליין',
    't-לכניסה לפוסטים האחרונים הקישו 1',
    't-לשמיעת הנושאים החדשים ביותר שנפתחו הקישו 2',
    't-לכניסה לפי קטגוריות הפורום הקישו 3',
    't-לחיפוש בפורום הקישו 4',
    't-לרשימת המשתמשים הבולטים בפורום הקישו 5'
  ];

  const audioOutput = idList(welcomeAudio);
  const readCommand = buildRead('mainsel', '', 1, 1, '10');
  return safeSend(res, `${readCommand}${audioOutput}&api_add_screen=main`);
}

// ============================================================================
// מסך 2: נושאים אחרונים (Recent Topics)
// ============================================================================

async function handleRecentTopics(params, res) {
  const currentPage = normalizePage(params.page);
  const topicSelection = params.topic_sel;

  const forumData = await fetchFromForum(`recent?page=${currentPage}`);
  const topics = extractTopics(forumData);

  if (topics === null) {
    return sendFallbackToMain(res, 'לא הצלחנו לטעון נושאים אחרונים מהשרת');
  }

  if (topics.length === 0) {
    // אין נושאים בעמוד זה — מעבר חכם אחורה ללא לופ
    if (currentPage > 1) {
      return safeSend(res,
        `${idList(['t-אין יותר נושאים בעמוד זה, חוזרים לעמוד הקודם'])}` +
        buildScreenState({ screen: 'recent_topics', page: currentPage - 1 }));
    }
    return sendFallbackToMain(res, 'לא נמצאו נושאים אחרונים בשלב זה');
  }

  // עיבוד בחירת המשתמש
  if (topicSelection !== undefined && topicSelection !== null && topicSelection !== '') {
    const navResult = handleTopicListNavigation({
      selection: topicSelection,
      topics,
      currentPage,
      screen: 'recent_topics',
      backScreen: 'main',
      hasNextPage: listHasNextPage(forumData, topics)
    });
    if (navResult) return safeSend(res, navResult);

    // בחירה שגויה
    const errorAudio = idList(['t-בחירה לא תקפה ברשימת הנושאים, אנא נסו שנית']);
    const readCommand = buildRead('topic_sel', '', 1, 1, '8');
    return safeSend(res,
      `${errorAudio}${readCommand}` +
      buildScreenState({ screen: 'recent_topics', page: currentPage }));
  }

  // הקראת רשימת הנושאים
  return safeSend(res, buildTopicListResponse({
    headerText: `מציג נושאים אחרונים. עמוד ${currentPage}`,
    topics,
    currentPage,
    screen: 'recent_topics',
    backLabel: 'לחזרה לתפריט הראשי הקישו אפס',
    hasNextPage: listHasNextPage(forumData, topics)
  }));
}

// ============================================================================
// מסך 3: נושאים חדשים / פופולריים (Unread / Popular)
// ============================================================================

async function handleUnreadTopics(params, res) {
  const currentPage = normalizePage(params.page);
  const topicSelection = params.topic_sel;

  let forumData = await fetchFromForum(`unread?page=${currentPage}`);
  let topics = extractTopics(forumData);

  // פולבק: אם אין נושאים שלא נקראו, ננסה נושאים פופולריים
  if (topics === null || topics.length === 0) {
    console.log('[Unread Fallback] Pulling popular topics instead.');
    const popularData = await fetchFromForum(`popular?page=${currentPage}`);
    const popularTopics = extractTopics(popularData);
    if (popularTopics === null) {
      return sendFallbackToMain(res, 'לא נמצאו נושאים חדשים בפורום בשלב זה');
    }
    if (popularTopics.length === 0) {
      if (currentPage > 1) {
        return safeSend(res,
          `${idList(['t-אין יותר נושאים בעמוד זה, חוזרים לעמוד הקודם'])}` +
          buildScreenState({ screen: 'unread_topics', page: currentPage - 1 }));
      }
      return sendFallbackToMain(res, 'לא נמצאו נושאים חדשים בפורום בשלב זה');
    }
    forumData = popularData;
    topics = popularTopics;
  }

  if (topicSelection !== undefined && topicSelection !== null && topicSelection !== '') {
    const navResult = handleTopicListNavigation({
      selection: topicSelection,
      topics,
      currentPage,
      screen: 'unread_topics',
      backScreen: 'main',
      hasNextPage: listHasNextPage(forumData, topics)
    });
    if (navResult) return safeSend(res, navResult);

    const errorAudio = idList(['t-בחירה שגויה, אנא הקישו שוב מספר מהרשימה']);
    const readCommand = buildRead('topic_sel', '', 1, 1, '8');
    return safeSend(res,
      `${errorAudio}${readCommand}` +
      buildScreenState({ screen: 'unread_topics', page: currentPage }));
  }

  return safeSend(res, buildTopicListResponse({
    headerText: 'מציג נושאים חמים וחדשים בפורום',
    topics,
    currentPage,
    screen: 'unread_topics',
    backLabel: 'לחזרה לתפריט הראשי הקישו אפס',
    hasNextPage: listHasNextPage(forumData, topics)
  }));
}

// ============================================================================
// מסך 4: רשימת קטגוריות (Categories List)
// ============================================================================

async function handleCategoriesList(params, res) {
  const catSelection = params.cat_sel;
  const forumData = await fetchFromForum('categories');

  if (!forumData || !Array.isArray(forumData.categories) || forumData.categories.length === 0) {
    return sendFallbackToMain(res, 'לא הצלחנו לטעון את קטגוריות הפורום');
  }

  // סינון קטגוריות ראשיות שאינן מוסתרות
  const categories = forumData.categories.filter((c) => {
    if (!c) return false;
    if (c.disabled) return false;
    // קטגוריות ראשיות בלבד (ללא הורה)
    if (c.parentCid && c.parentCid !== 0) return false;
    if (c.parent && c.parent.cid) return false;
    return true;
  });

  if (categories.length === 0) {
    return sendFallbackToMain(res, 'לא נמצאו קטגוריות ראשיות זמינות בפורום');
  }

  if (catSelection !== undefined && catSelection !== null && catSelection !== '') {
    if (String(catSelection) === '0') {
      return safeSend(res,
        `${idList(['t-חוזרים לתפריט הראשי'])}` +
        buildScreenState({ screen: 'main' }));
    }

    const selectedIdx = parseInt(catSelection, 10) - 1;
    if (Number.isInteger(selectedIdx) &&
        selectedIdx >= 0 &&
        selectedIdx < categories.length &&
        selectedIdx < MAX_CATEGORIES) {
      const targetCategory = categories[selectedIdx];
      const cid = targetCategory.cid;
      if (cid === undefined || cid === null) {
        const errorAudio = idList(['t-מספר קטגוריה שגוי, אנא נסו שוב']);
        const readCommand = buildRead('cat_sel', '', 1, 1, '8');
        return safeSend(res, `${errorAudio}${readCommand}&api_add_screen=categories_list`);
      }
      return safeSend(res,
        `${idList(['t-נכנסים לקטגוריה הנבחרת'])}` +
        buildScreenState({ screen: 'category_view', cid: cid, page: 1 }));
    }

    const errorAudio = idList(['t-מספר קטגוריה שגוי, אנא נסו שוב']);
    const readCommand = buildRead('cat_sel', '', 1, 1, '8');
    return safeSend(res, `${errorAudio}${readCommand}&api_add_screen=categories_list`);
  }

  // הקראת רשימת הקטגוריות
  const audioParts = ['t-רשימת הקטגוריות הראשיות בפורום מתמחים טופ'];
  const maxCats = Math.min(categories.length, MAX_CATEGORIES);

  for (let i = 0; i < maxCats; i++) {
    const cleanCatName = cleanTextForTTS(categories[i].name, 150);
    audioParts.push(`t-לקטגוריית ${cleanCatName} הקישו ${i + 1}`);
  }
  audioParts.push('t-לחזרה לתפריט הראשי בכל שלב הקישו אפס');

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('cat_sel', '', 1, 1, '12');
  return safeSend(res, `${audioOutput}${readCommand}&api_add_screen=categories_list`);
}

// ============================================================================
// מסך 5: נושאים בתוך קטגוריה (Category View)
// ============================================================================

async function handleCategoryView(params, res) {
  const cid = params.cid;
  const currentPage = normalizePage(params.page);
  const topicSelection = params.topic_sel;

  if (cid === undefined || cid === null || cid === '') {
    return sendFallbackToMain(res, 'מזהה קטגוריה חסר במערכת');
  }

  const forumData = await fetchFromForum(`category/${encodeURIComponent(cid)}?page=${currentPage}`);
  const topics = extractTopics(forumData);

  if (topics === null) {
    return sendFallbackToMain(res, 'לא הצלחנו לשלוף נושאים מקטגוריה זו');
  }

  const categoryName = (forumData && forumData.name) ? forumData.name : 'הנבחרת';

  if (topics.length === 0) {
    if (currentPage > 1) {
      return safeSend(res,
        `${idList(['t-אין יותר נושאים בקטגוריה זו, חוזרים לעמוד הקודם'])}` +
        buildScreenState({ screen: 'category_view', cid: cid, page: currentPage - 1 }));
    }
    return safeSend(res,
      `${idList(['t-אין נושאים זמינים בקטגוריה זו, חוזרים לרשימת הקטגוריות'])}` +
      buildScreenState({ screen: 'categories_list' }));
  }

  if (topicSelection !== undefined && topicSelection !== null && topicSelection !== '') {
    // ניווט מיוחד לקטגוריה (מקש 0 חוזר לרשימת הקטגוריות)
    const sel = String(topicSelection);

    if (sel === '0') {
      return safeSend(res,
        `${idList(['t-חוזרים לרשימת הקטגוריות'])}` +
        buildScreenState({ screen: 'categories_list' }));
    }
    if (sel === '7') {
      return safeSend(res,
        `${idList(['t-עוברים לעמוד הבא'])}` +
        buildScreenState({ screen: 'category_view', cid: cid, page: currentPage + 1 }));
    }
    if (sel === '4' && currentPage > 1) {
      return safeSend(res,
        `${idList(['t-עוברים לעמוד הקודם'])}` +
        buildScreenState({ screen: 'category_view', cid: cid, page: currentPage - 1 }));
    }

    const selectedIdx = parseInt(sel, 10) - 1;
    if (Number.isInteger(selectedIdx) &&
        selectedIdx >= 0 &&
        selectedIdx < topics.length &&
        selectedIdx < ITEMS_PER_PAGE) {
      const targetTopic = topics[selectedIdx];
      const tid = getTopicId(targetTopic);
      if (tid === null) {
        return categoryListError(res, cid, currentPage);
      }
      return safeSend(res,
        `${idList(['t-נכנסים לנושא הנבחר'])}` +
        buildScreenState({ screen: 'topic_view', tid: tid, post_idx: 0, page: 1 }));
    }

    return categoryListError(res, cid, currentPage);
  }

  // הקראת רשימת הנושאים בקטגוריה
  const cleanCatName = cleanTextForTTS(categoryName, 100);
  const audioParts = [`t-מציג דיונים בקטגוריית ${cleanCatName}. עמוד ${currentPage}`];
  const maxItems = Math.min(topics.length, ITEMS_PER_PAGE);

  for (let i = 0; i < maxItems; i++) {
    const cleanTitle = cleanTextForTTS(getTopicTitle(topics[i]), MAX_TITLE_CHARS);
    audioParts.push(`t-לנושא מספר ${i + 1}, ${cleanTitle}`);
  }

  if (listHasNextPage(forumData, topics)) {
    audioParts.push('t-לעמוד הבא הקישו 7');
  }
  if (currentPage > 1) {
    audioParts.push('t-לעמוד הקודם הקישו 4');
  }
  audioParts.push('t-לחזרה לרשימת הקטגוריות הקישו אפס');

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('topic_sel', '', 1, 1, '12');
  return safeSend(res,
    `${audioOutput}${readCommand}` +
    buildScreenState({ screen: 'category_view', cid: cid, page: currentPage }));
}

/**
 * תגובת שגיאה לבחירה לא תקפה במסך קטגוריה.
 */
function categoryListError(res, cid, currentPage) {
  const errorAudio = idList(['t-בחירה לא תקפה, אנא בחרו שוב מספר מהרשימה']);
  const readCommand = buildRead('topic_sel', '', 1, 1, '8');
  return safeSend(res,
    `${errorAudio}${readCommand}` +
    buildScreenState({ screen: 'category_view', cid: cid, page: currentPage }));
}

// ============================================================================
// מסך 6: האזנה לפוסטים בתוך דיון (Topic View)
// ============================================================================

async function handleTopicView(params, res) {
  const topicId = params.tid;
  const currentPostIndex = normalizeIndex(params.post_idx);
  const currentPage = normalizePage(params.page);
  const navCommand = params.post_nav;

  if (topicId === undefined || topicId === null || topicId === '') {
    return sendFallbackToMain(res, 'מזהה דיון חסר במערכת');
  }

  const forumData = await fetchFromForum(`topic/${encodeURIComponent(topicId)}?page=${currentPage}`);

  if (!forumData || !Array.isArray(forumData.posts)) {
    return sendFallbackToMain(res, 'דיון זה אינו זמין יותר בשרת');
  }

  const posts = forumData.posts;

  if (posts.length === 0) {
    // עמוד ריק — חזרה לעמוד קודם או לרשימת הנושאים האחרונים (ללא לופ)
    if (currentPage > 1) {
      return safeSend(res,
        `${idList(['t-אין הודעות בעמוד זה, חוזרים לעמוד הקודם'])}` +
        buildScreenState({ screen: 'topic_view', tid: topicId, post_idx: 0, page: currentPage - 1 }));
    }
    return safeSend(res,
      `${idList(['t-דיון זה ריק, חוזרים לרשימת הנושאים האחרונים'])}` +
      buildScreenState({ screen: 'recent_topics', page: 1 }));
  }

  const topicTitle = (forumData && forumData.title) ? forumData.title : 'דיון כללי';

  // טיפול בפקודות ניווט
  if (navCommand !== undefined && navCommand !== null && navCommand !== '') {
    const nav = String(navCommand);
    console.log(`[Topic Nav] tid=${topicId}, idx=${currentPostIndex}, page=${currentPage}, key=${nav}`);

    switch (nav) {
      case '0':
        // חזרה לתפריט הראשי
        return safeSend(res,
          `${idList(['t-חוזרים לתפריט הראשי'])}` +
          buildScreenState({ screen: 'main' }));

      case '1': {
        // הודעה הבאה
        if (currentPostIndex + 1 < posts.length) {
          return safeSend(res,
            buildScreenState({
              screen: 'topic_view',
              tid: topicId,
              post_idx: currentPostIndex + 1,
              page: currentPage
            }).replace(/^&/, '')); // אין צורך בהודעה — מעבר שקט מהיר
        }
        // סוף העמוד — בדיקת עמוד הבא
        const nextPage = getNextPage(forumData);
        if (nextPage && nextPage > currentPage) {
          return safeSend(res,
            buildScreenState({
              screen: 'topic_view',
              tid: topicId,
              post_idx: 0,
              page: nextPage
            }).replace(/^&/, ''));
        }
        // סוף הדיון לחלוטין
        return safeSend(res,
          `${idList(['t-הגעתם לסוף ההודעות בדיון זה, חוזרים לרשימת הנושאים האחרונים'])}` +
          buildScreenState({ screen: 'recent_topics', page: 1 }));
      }

      case '2': {
        // הודעה קודמת
        if (currentPostIndex > 0) {
          return safeSend(res,
            buildScreenState({
              screen: 'topic_view',
              tid: topicId,
              post_idx: currentPostIndex - 1,
              page: currentPage
            }).replace(/^&/, ''));
        }
        if (currentPage > 1) {
          // מעבר לעמוד הקודם — מיקום על הפוסט האחרון המשוער
          return safeSend(res,
            buildScreenState({
              screen: 'topic_view',
              tid: topicId,
              post_idx: POSTS_PER_PAGE - 1,
              page: currentPage - 1
            }).replace(/^&/, ''));
        }
        // אין הודעות קודמות
        const boundaryAudio = idList(['t-זהו הפוסט הראשון בדיון זה, אין הודעות קודמות']);
        const readCommand = buildRead('post_nav', '', 1, 1, '8');
        return safeSend(res,
          `${boundaryAudio}${readCommand}` +
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            page: currentPage,
            post_idx: currentPostIndex
          }));
      }

      case '3':
        // שמיעה חוזרת של הפוסט הנוכחי
        return safeSend(res,
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            post_idx: currentPostIndex,
            page: currentPage
          }).replace(/^&/, ''));

      case '4': {
        // קפיצה 5 פוסטים קדימה
        const jumpForward = Math.min(posts.length - 1, currentPostIndex + 5);
        return safeSend(res,
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            post_idx: jumpForward,
            page: currentPage
          }).replace(/^&/, ''));
      }

      case '5': {
        // קפיצה 5 פוסטים אחורה
        const jumpBackward = Math.max(0, currentPostIndex - 5);
        return safeSend(res,
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            post_idx: jumpBackward,
            page: currentPage
          }).replace(/^&/, ''));
      }

      case '6': {
        // הקראת פרטי כותב ההודעה
        const safeIdx = clampIndex(currentPostIndex, posts.length);
        const currentPost = posts[safeIdx];
        const authorName = getPostAuthor(currentPost);
        const infoAudio = idList([`t-הודעה זו נכתבה על ידי ${cleanTextForTTS(authorName, MAX_NAME_CHARS)}`]);
        const readCommand = buildRead('post_nav', '', 1, 1, '8');
        return safeSend(res,
          `${infoAudio}${readCommand}` +
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            page: currentPage,
            post_idx: safeIdx
          }));
      }

      default: {
        const errorAudio = idList(['t-מקש ניווט לא מוכר, הקישו 1 להודעה הבאה או 2 לקודמת']);
        const readCommand = buildRead('post_nav', '', 1, 1, '8');
        return safeSend(res,
          `${errorAudio}${readCommand}` +
          buildScreenState({
            screen: 'topic_view',
            tid: topicId,
            page: currentPage,
            post_idx: currentPostIndex
          }));
      }
    }
  }

  // הקראת הפוסט הנוכחי
  const safePostIndex = clampIndex(currentPostIndex, posts.length);
  const currentPost = posts[safePostIndex];
  const authorName = getPostAuthor(currentPost);
  const cleanBody = cleanTextForTTS(getPostContent(currentPost), MAX_BODY_CHARS);

  const audioParts = [];

  // בפוסט הראשון בדיון — הקראת כותרת הנושא
  if (safePostIndex === 0 && currentPage === 1) {
    audioParts.push(`t-מאזין לנושא: ${cleanTextForTTS(topicTitle, MAX_TITLE_CHARS)}`);
  }

  const globalPostNumber = safePostIndex + 1 + (currentPage - 1) * POSTS_PER_PAGE;
  audioParts.push(`t-הודעה מספר ${globalPostNumber}, מאת ${cleanTextForTTS(authorName, MAX_NAME_CHARS)}`);
  audioParts.push(`t-${cleanBody}`);
  audioParts.push('t-להודעה הבאה הקישו 1. לקודמת הקישו 2. לשמיעה חוזרת הקישו 3. לקפיצה קדימה הקישו 4. לקפיצה אחורה הקישו 5. לפרטי הכותב הקישו 6. לתפריט הראשי הקישו אפס');

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('post_nav', '', 1, 1, '12');

  return safeSend(res,
    `${audioOutput}${readCommand}` +
    buildScreenState({
      screen: 'topic_view',
      tid: topicId,
      page: currentPage,
      post_idx: safePostIndex
    }));
}

// ============================================================================
// מסך 7 (חדש): חיפוש בפורום (Search)
// ============================================================================

/**
 * מסך חיפוש בפורום.
 * שלב א': קליטת מילות החיפוש בהקלטה המתומללת ע"י מנוע זיהוי הדיבור המובנה
 *         של ימות המשיח (read מסוג voice). זהו הפתרון המומלץ — אינטגרציה
 *         מלאה ללא ספרייה חיצונית, התמלול מגיע ישירות כטקסט.
 * שלב ב': שליחת מילות החיפוש ל-Read API של הפורום והשמעת התוצאות.
 *
 * הערה: נקודת הקצה /api/search בפורום עשויה לדרוש הרשאה. במקרה כזה מופעל
 *       fallback חכם שמודיע למשתמש וחוזר לתפריט ללא לופ.
 */
async function handleSearch(params, res) {
  const searchTerm = params.search_query;
  const resultSelection = params.search_sel;
  const currentPage = normalizePage(params.page);

  // שלב א': אם עדיין אין מילות חיפוש — בקשת קלט קולי
  if (searchTerm === undefined || searchTerm === null || String(searchTerm).trim() === '') {
    // השמעת הנחיה + קליטת דיבור והמרתו לטקסט
    const promptAudio = idList([
      't-ברוכים הבאים לחיפוש בפורום',
      't-לאחר הצליל אמרו בקול ברור את מילות החיפוש, ובסיום הקישו סולמית'
    ]);
    const voiceRead = buildVoiceRead('search_query', 'אמרו את מילות החיפוש לאחר הצליל');
    return safeSend(res, `${promptAudio}${voiceRead}&api_add_screen=search`);
  }

  const cleanTerm = cleanSearchTerm(String(searchTerm));

  if (cleanTerm.length < 2) {
    // טקסט קצר מדי / לא זוהה — בקשת קלט מחדש (ללא לופ אינסופי, חזרה למצב קלט)
    const retryAudio = idList([
      't-לא הצלחנו לזהות את מילות החיפוש',
      't-לאחר הצליל אמרו שוב את מילות החיפוש בקול ברור, ובסיום הקישו סולמית'
    ]);
    const voiceRead = buildVoiceRead('search_query', 'אמרו שוב את מילות החיפוש');
    return safeSend(res, `${retryAudio}${voiceRead}&api_add_screen=search`);
  }

  // ביצוע החיפוש מול הפורום
  const encodedTerm = encodeURIComponent(cleanTerm);
  const searchData = await fetchFromForum(
    `search?term=${encodedTerm}&in=titlesposts&matchWords=any&sortBy=relevance&page=${currentPage}`
  );

  const results = extractSearchResults(searchData);

  // fallback חכם: אם החיפוש אינו זמין (הרשאה / תקלה) — הודעה וחזרה לתפריט
  if (results === null) {
    return safeSend(res,
      `${idList([
        't-שירות החיפוש אינו זמין כעת או שאינו פתוח לגישה ציבורית',
        't-חוזרים לתפריט הראשי'
      ])}` +
      buildScreenState({ screen: 'main' }));
  }

  if (results.length === 0) {
    // לא נמצאו תוצאות — אפשרות לחפש שוב
    const noResultsAudio = idList([
      `t-לא נמצאו תוצאות עבור החיפוש ${cleanTerm}`,
      't-לחיפוש חדש הקישו 1, לחזרה לתפריט הראשי הקישו אפס'
    ]);
    const readCommand = buildRead('search_retry', '', 1, 1, '8');
    return safeSend(res, `${noResultsAudio}${readCommand}&api_add_screen=search_retry`);
  }

  // עיבוד בחירת תוצאה
  if (resultSelection !== undefined && resultSelection !== null && resultSelection !== '') {
    const sel = String(resultSelection);

    if (sel === '0') {
      return safeSend(res,
        `${idList(['t-חוזרים לתפריט הראשי'])}` +
        buildScreenState({ screen: 'main' }));
    }
    if (sel === '9') {
      // חיפוש חדש — איפוס מילות החיפוש
      const promptAudio = idList(['t-לאחר הצליל אמרו את מילות החיפוש החדשות, ובסיום הקישו סולמית']);
      const voiceRead = buildVoiceRead('search_query', 'אמרו את מילות החיפוש החדשות');
      return safeSend(res, `${promptAudio}${voiceRead}&api_add_screen=search`);
    }
    if (sel === '7') {
      // עמוד תוצאות הבא
      return safeSend(res,
        `${idList(['t-עוברים לעמוד התוצאות הבא'])}` +
        buildScreenState({ screen: 'search', search_term: cleanTerm, page: currentPage + 1 }));
    }
    if (sel === '4' && currentPage > 1) {
      return safeSend(res,
        `${idList(['t-עוברים לעמוד התוצאות הקודם'])}` +
        buildScreenState({ screen: 'search', search_term: cleanTerm, page: currentPage - 1 }));
    }

    const selectedIdx = parseInt(sel, 10) - 1;
    if (Number.isInteger(selectedIdx) &&
        selectedIdx >= 0 &&
        selectedIdx < results.length &&
        selectedIdx < ITEMS_PER_PAGE) {
      const tid = getTopicId(results[selectedIdx]);
      if (tid === null) {
        return searchListError(res, cleanTerm, currentPage);
      }
      return safeSend(res,
        `${idList(['t-נכנסים לנושא הנבחר'])}` +
        buildScreenState({ screen: 'topic_view', tid: tid, post_idx: 0, page: 1 }));
    }

    return searchListError(res, cleanTerm, currentPage);
  }

  // הקראת תוצאות החיפוש
  const audioParts = [`t-נמצאו תוצאות עבור החיפוש ${cleanTerm}. עמוד ${currentPage}`];
  const maxItems = Math.min(results.length, ITEMS_PER_PAGE);

  for (let i = 0; i < maxItems; i++) {
    const cleanTitle = cleanTextForTTS(getTopicTitle(results[i]), MAX_TITLE_CHARS);
    audioParts.push(`t-לתוצאה מספר ${i + 1}, ${cleanTitle}`);
  }

  if (results.length >= ITEMS_PER_PAGE) {
    audioParts.push('t-לעמוד התוצאות הבא הקישו 7');
  }
  if (currentPage > 1) {
    audioParts.push('t-לעמוד התוצאות הקודם הקישו 4');
  }
  audioParts.push('t-לחיפוש חדש הקישו 9. לחזרה לתפריט הראשי הקישו אפס');

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('search_sel', '', 1, 1, '12');
  return safeSend(res,
    `${audioOutput}${readCommand}` +
    buildScreenState({ screen: 'search', search_term: cleanTerm, page: currentPage }));
}

/**
 * תגובת שגיאה לבחירה לא תקפה בתוצאות חיפוש.
 */
function searchListError(res, term, page) {
  const errorAudio = idList(['t-בחירה לא תקפה, אנא בחרו שוב מספר מהרשימה']);
  const readCommand = buildRead('search_sel', '', 1, 1, '8');
  return safeSend(res,
    `${errorAudio}${readCommand}` +
    buildScreenState({ screen: 'search', search_term: term, page: page }));
}

// ============================================================================
// מסך עזר: טיפול בבחירה לאחר "אין תוצאות חיפוש"
// ============================================================================

/**
 * מסך ביניים — לאחר הודעת "לא נמצאו תוצאות".
 * 1 = חיפוש חדש, אפס = תפריט ראשי.
 */
async function handleSearchRetry(params, res) {
  const choice = params.search_retry;
  if (String(choice) === '1') {
    const promptAudio = idList(['t-לאחר הצליל אמרו את מילות החיפוש החדשות, ובסיום הקישו סולמית']);
    const voiceRead = buildVoiceRead('search_query', 'אמרו את מילות החיפוש החדשות');
    return safeSend(res, `${promptAudio}${voiceRead}&api_add_screen=search`);
  }
  return safeSend(res,
    `${idList(['t-חוזרים לתפריט הראשי'])}` +
    buildScreenState({ screen: 'main' }));
}

// ============================================================================
// מסך 8 (חדש): תפריט בחירת סוג רשימת המשתמשים
// ============================================================================

/**
 * תפריט המשתמשים — בחירה בין "המפרסמים ביותר" ל"בעלי המוניטין הגבוה ביותר".
 */
async function handleUsersMenu(params, res) {
  const selection = params.users_sel;

  if (selection !== undefined && selection !== null && selection !== '') {
    const sel = String(selection);
    if (sel === '1') {
      return safeSend(res,
        `${idList(['t-מציג את המשתמשים המפרסמים ביותר'])}` +
        buildScreenState({ screen: 'users_list', usort: 'posts' }));
    }
    if (sel === '2') {
      return safeSend(res,
        `${idList(['t-מציג את המשתמשים בעלי המוניטין הגבוה ביותר'])}` +
        buildScreenState({ screen: 'users_list', usort: 'reputation' }));
    }
    if (sel === '0') {
      return safeSend(res,
        `${idList(['t-חוזרים לתפריט הראשי'])}` +
        buildScreenState({ screen: 'main' }));
    }
    // בחירה שגויה
    const errAudio = idList([
      't-המקש שהוקש שגוי',
      't-למשתמשים המפרסמים ביותר הקישו 1',
      't-למשתמשים בעלי המוניטין הגבוה ביותר הקישו 2',
      't-לחזרה לתפריט הראשי הקישו אפס'
    ]);
    const readCommand = buildRead('users_sel', '', 1, 1, '9');
    return safeSend(res, `${errAudio}${readCommand}&api_add_screen=users_menu`);
  }

  const audioParts = [
    't-רשימת המשתמשים הבולטים בפורום מתמחים טופ',
    't-לשמיעת המשתמשים המפרסמים ביותר הקישו 1',
    't-לשמיעת המשתמשים בעלי המוניטין הגבוה ביותר הקישו 2',
    't-לחזרה לתפריט הראשי הקישו אפס'
  ];
  const audioOutput = idList(audioParts);
  const readCommand = buildRead('users_sel', '', 1, 1, '10');
  return safeSend(res, `${audioOutput}${readCommand}&api_add_screen=users_menu`);
}

// ============================================================================
// מסך 9 (חדש): רשימת המשתמשים (Users List)
// ============================================================================

/**
 * השמעת רשימת המשתמשים לפי המיון שנבחר (posts / reputation).
 * משתמש בנקודת הקצה הציבורית /api/users?section=sort-posts|sort-reputation.
 */
async function handleUsersList(params, res) {
  const usort = (params.usort === 'reputation') ? 'reputation' : 'posts';
  const section = (usort === 'reputation') ? 'sort-reputation' : 'sort-posts';
  const userSelection = params.user_sel;

  const data = await fetchFromForum(`users?section=${section}`);

  if (!data || !Array.isArray(data.users)) {
    return safeSend(res,
      `${idList([
        't-לא הצלחנו לטעון את רשימת המשתמשים',
        't-חוזרים לתפריט המשתמשים'
      ])}` +
      buildScreenState({ screen: 'users_menu' }));
  }

  const users = data.users.filter((u) => u && (u.username || u.displayname));

  if (users.length === 0) {
    return safeSend(res,
      `${idList(['t-לא נמצאו משתמשים זמינים, חוזרים לתפריט המשתמשים'])}` +
      buildScreenState({ screen: 'users_menu' }));
  }

  // עיבוד בחירת משתמש (השמעת פרטיו)
  if (userSelection !== undefined && userSelection !== null && userSelection !== '') {
    const sel = String(userSelection);
    if (sel === '0') {
      return safeSend(res,
        `${idList(['t-חוזרים לתפריט המשתמשים'])}` +
        buildScreenState({ screen: 'users_menu' }));
    }

    const selectedIdx = parseInt(sel, 10) - 1;
    if (Number.isInteger(selectedIdx) &&
        selectedIdx >= 0 &&
        selectedIdx < users.length &&
        selectedIdx < MAX_USERS_TO_READ) {
      const u = users[selectedIdx];
      const uname = cleanTextForTTS(getUserName(u), MAX_NAME_CHARS);
      const posts = sanitizeNumber(u.postcount);
      const rep = sanitizeNumber(u.reputation);
      const detailAudio = idList([
        `t-פרטי המשתמש ${uname}`,
        `t-מספר הפרסומים ${posts}`,
        `t-המוניטין ${rep}`,
        't-לחזרה לרשימת המשתמשים הקישו אפס'
      ]);
      const readCommand = buildRead('user_sel', '', 1, 1, '10');
      return safeSend(res,
        `${detailAudio}${readCommand}` +
        buildScreenState({ screen: 'users_list', usort: usort }));
    }

    // בחירה שגויה
    const errAudio = idList(['t-בחירה לא תקפה, אנא בחרו שוב מספר מהרשימה']);
    const readCommand = buildRead('user_sel', '', 1, 1, '8');
    return safeSend(res,
      `${errAudio}${readCommand}` +
      buildScreenState({ screen: 'users_list', usort: usort }));
  }

  // הקראת רשימת המשתמשים
  const headerText = (usort === 'reputation')
    ? 'המשתמשים בעלי המוניטין הגבוה ביותר'
    : 'המשתמשים המפרסמים ביותר';
  const audioParts = [`t-${headerText}`];
  const maxItems = Math.min(users.length, MAX_USERS_TO_READ);

  for (let i = 0; i < maxItems; i++) {
    const uname = cleanTextForTTS(getUserName(users[i]), MAX_NAME_CHARS);
    if (usort === 'reputation') {
      const rep = sanitizeNumber(users[i].reputation);
      audioParts.push(`t-למשתמש מספר ${i + 1}, ${uname}, בעל מוניטין ${rep}, הקישו ${i + 1}`);
    } else {
      const posts = sanitizeNumber(users[i].postcount);
      audioParts.push(`t-למשתמש מספר ${i + 1}, ${uname}, עם ${posts} פרסומים, הקישו ${i + 1}`);
    }
  }
  audioParts.push('t-לחזרה לתפריט המשתמשים הקישו אפס');

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('user_sel', '', 1, 1, '12');
  return safeSend(res,
    `${audioOutput}${readCommand}` +
    buildScreenState({ screen: 'users_list', usort: usort }));
}

// ============================================================================
// פונקציות עזר לניווט וברירת מחדל ברשימות נושאים
// ============================================================================

/**
 * מטפל בלוגיקת הניווט המשותפת לרשימות נושאים (אחרונים / חדשים).
 * מחזיר מחרוזת תגובה מוכנה, או null אם הבחירה אינה מזוהה (כדי לאפשר
 * לפונקציה הקוראת לטפל בשגיאה בעצמה).
 *
 * @returns {string|null}
 */
function handleTopicListNavigation(opts) {
  const { selection, topics, currentPage, screen, backScreen, hasNextPage } = opts;
  const sel = String(selection);

  if (sel === '0') {
    return `${idList(['t-חוזרים לתפריט הראשי'])}` +
      buildScreenState({ screen: backScreen });
  }
  if (sel === '7') {
    if (hasNextPage) {
      return `${idList(['t-עוברים לעמוד הבא'])}` +
        buildScreenState({ screen: screen, page: currentPage + 1 });
    }
    return `${idList(['t-אין עמוד נוסף, זהו העמוד האחרון'])}` +
      buildScreenState({ screen: screen, page: currentPage });
  }
  if (sel === '4') {
    if (currentPage > 1) {
      return `${idList(['t-עוברים לעמוד הקודם'])}` +
        buildScreenState({ screen: screen, page: currentPage - 1 });
    }
    return `${idList(['t-זהו העמוד הראשון, אין עמוד קודם'])}` +
      buildScreenState({ screen: screen, page: currentPage });
  }

  const selectedIdx = parseInt(sel, 10) - 1;
  if (Number.isInteger(selectedIdx) &&
      selectedIdx >= 0 &&
      selectedIdx < topics.length &&
      selectedIdx < ITEMS_PER_PAGE) {
    const tid = getTopicId(topics[selectedIdx]);
    if (tid === null) return null;
    return `${idList(['t-נכנסים לנושא הנבחר'])}` +
      buildScreenState({ screen: 'topic_view', tid: tid, post_idx: 0, page: 1 });
  }

  // בחירה לא מזוהה
  return null;
}

/**
 * בונה תגובת הקראת רשימת נושאים (משותף לאחרונים / חדשים).
 * @returns {string}
 */
function buildTopicListResponse(opts) {
  const { headerText, topics, currentPage, screen, backLabel, hasNextPage } = opts;

  const audioParts = [`t-${sanitizeTtsSegment(headerText)}`];
  const maxItems = Math.min(topics.length, ITEMS_PER_PAGE);

  for (let i = 0; i < maxItems; i++) {
    const cleanTitle = cleanTextForTTS(getTopicTitle(topics[i]), MAX_TITLE_CHARS);
    audioParts.push(`t-לנושא מספר ${i + 1}, ${cleanTitle}`);
  }

  if (hasNextPage) {
    audioParts.push('t-לעמוד הבא הקישו 7');
  }
  if (currentPage > 1) {
    audioParts.push('t-לעמוד הקודם הקישו 4');
  }
  audioParts.push(`t-${sanitizeTtsSegment(backLabel)}`);

  const audioOutput = idList(audioParts);
  const readCommand = buildRead('topic_sel', '', 1, 1, '12');
  return `${audioOutput}${readCommand}` +
    buildScreenState({ screen: screen, page: currentPage });
}

// ============================================================================
// פונקציות חילוץ נתונים בטוחות מתגובות הפורום
// ============================================================================

/**
 * מחלץ מערך נושאים מתגובת הפורום.
 * @returns {Array|null} מערך נושאים, מערך ריק, או null במקרה של תקלת תקשורת
 */
function extractTopics(forumData) {
  if (forumData === null || forumData === undefined) return null;
  if (Array.isArray(forumData.topics)) return forumData.topics;
  // חלק מנקודות הקצה מחזירות תחת מפתחות אחרים
  if (Array.isArray(forumData.posts) && forumData.topics === undefined) {
    // לא נושאים — נתעלם
    return null;
  }
  return null;
}

/**
 * מחלץ תוצאות חיפוש מתגובת הפורום.
 * @returns {Array|null}
 */
function extractSearchResults(searchData) {
  if (searchData === null || searchData === undefined) return null;
  // מבנה תקין של תוצאות חיפוש NodeBB
  if (Array.isArray(searchData.posts)) {
    // כל תוצאה כוללת topic; ננרמל למבנה אחיד עם tid/title
    return searchData.posts.map((p) => {
      if (p && p.topic) {
        return {
          tid: p.topic.tid,
          title: p.topic.title || (p.topic.titleRaw) || 'ללא כותרת'
        };
      }
      return {
        tid: (p && p.tid) ? p.tid : null,
        title: (p && p.content) ? p.content : 'ללא כותרת'
      };
    }).filter((r) => r.tid !== null && r.tid !== undefined);
  }
  if (Array.isArray(searchData.topics)) {
    return searchData.topics;
  }
  // תגובת שגיאת הרשאה / מבנה לא צפוי
  if (searchData.status && searchData.status.code &&
      searchData.status.code !== 'ok') {
    return null;
  }
  return [];
}

/**
 * מחזיר את מזהה הנושא (tid) באופן בטוח.
 * @returns {string|number|null}
 */
function getTopicId(topic) {
  if (!topic) return null;
  if (topic.tid !== undefined && topic.tid !== null) return topic.tid;
  if (topic.topic && topic.topic.tid !== undefined) return topic.topic.tid;
  return null;
}

/**
 * מחזיר את כותרת הנושא באופן בטוח.
 */
function getTopicTitle(topic) {
  if (!topic) return 'נושא ללא כותרת';
  if (topic.title) return topic.title;
  if (topic.titleRaw) return topic.titleRaw;
  if (topic.topic && topic.topic.title) return topic.topic.title;
  return 'נושא ללא כותרת';
}

/**
 * מחזיר את שם כותב הפוסט באופן בטוח.
 */
function getPostAuthor(post) {
  if (!post) return 'משתמש פורום';
  if (post.user) {
    if (post.user.displayname) return post.user.displayname;
    if (post.user.username) return post.user.username;
  }
  if (post.username) return post.username;
  return 'משתמש פורום';
}

/**
 * מחזיר את תוכן הפוסט באופן בטוח.
 */
function getPostContent(post) {
  if (!post) return 'הודעה ריקה';
  if (typeof post.content === 'string' && post.content.length > 0) return post.content;
  if (typeof post.sourceContent === 'string' && post.sourceContent.length > 0) return post.sourceContent;
  return 'הודעה ריקה';
}

/**
 * מחזיר שם משתמש לתצוגה.
 */
function getUserName(user) {
  if (!user) return 'משתמש';
  if (user.displayname) return user.displayname;
  if (user.username) return user.username;
  if (user.userslug) return user.userslug;
  return 'משתמש';
}

// ============================================================================
// פונקציות עזר לנרמול ולוגיקת עמודים
// ============================================================================

/**
 * נרמול מספר עמוד — מבטיח מספר שלם חיובי (מינימום 1).
 */
function normalizePage(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > 100000) return 100000; // הגנה מפני קלט חריג
  return n;
}

/**
 * נרמול אינדקס פוסט — מבטיח מספר שלם לא שלילי.
 */
function normalizeIndex(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  if (n > 100000) return 100000;
  return n;
}

/**
 * מגביל אינדקס לטווח התקין של מערך.
 */
function clampIndex(idx, length) {
  if (length <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= length) return length - 1;
  return idx;
}

/**
 * נרמול מספר להצגה (postcount / reputation).
 */
function sanitizeNumber(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * בודק האם קיים עמוד נוסף ברשימת נושאים.
 * משתמש ב-nextStart / pagination / כמות הנושאים שהתקבלה.
 */
function listHasNextPage(forumData, topics) {
  if (!forumData) return false;
  // NodeBB מחזיר nextStart כאשר יש עוד תוכן
  if (forumData.nextStart !== undefined && forumData.nextStart !== null) {
    // אם topicCount קיים ו-nextStart מעבר לכמות — אין עוד
    if (forumData.topicCount !== undefined &&
        forumData.nextStart >= forumData.topicCount) {
      return false;
    }
    return true;
  }
  // אינדיקציה לפי pagination
  if (forumData.pagination &&
      forumData.pagination.next &&
      forumData.pagination.next.page) {
    return true;
  }
  // הערכה: אם התקבלה כמות מלאה של נושאים בעמוד, ייתכן שיש עוד
  if (Array.isArray(topics) && topics.length >= ITEMS_PER_PAGE) {
    return true;
  }
  return false;
}

/**
 * מחזיר את מספר העמוד הבא בתוך דיון, אם קיים.
 * @returns {number|null}
 */
function getNextPage(forumData) {
  if (!forumData) return null;
  if (forumData.pagination &&
      forumData.pagination.next &&
      forumData.pagination.next.page) {
    const p = parseInt(forumData.pagination.next.page, 10);
    if (Number.isInteger(p) && p > 0) return p;
  }
  // הערכה לפי postcount מול עמוד נוכחי
  if (forumData.postcount && forumData.pagination &&
      forumData.pagination.currentPage) {
    const cur = parseInt(forumData.pagination.currentPage, 10);
    const totalPages = Math.ceil(forumData.postcount / POSTS_PER_PAGE);
    if (Number.isInteger(cur) && cur < totalPages) return cur + 1;
  }
  return null;
}

// ============================================================================
// מנגנון הגנה וניתוב בטוח חזרה לתפריט הראשי (Fallback Safety Handler)
// מונע מצב של שיחות מנותקות או דממה. אינו יוצר לופ — תמיד מחזיר לתפריט הראשי
// עם אפשרות בחירה חדשה.
// ============================================================================

/**
 * שולח את המשתמש בחזרה לתפריט הראשי בצורה מאובטחת, עם הודעת הסבר.
 * משתמש אך ורק ב-api_add_screen (ללא redirect).
 *
 * @param {object} res
 * @param {string} msgText הסבר קצר על הסיבה
 */
function sendFallbackToMain(res, msgText) {
  console.warn(`[Fallback] Reason: ${msgText}`);
  const cleanMsg = cleanTextForTTS(msgText, 150);

  const audioOutput = idList([
    `t-${cleanMsg}`,
    't-חוזרים כעת לתפריט הראשי של הפורום הטלפוני',
    't-לכניסה לפוסטים האחרונים הקישו 1',
    't-לשמיעת הנושאים החדשים הקישו 2',
    't-לכניסה לפי קטגוריות הקישו 3',
    't-לחיפוש בפורום הקישו 4',
    't-לרשימת המשתמשים הקישו 5'
  ]);

  const readCommand = buildRead('mainsel', '', 1, 1, '10');
  return safeSend(res, `${readCommand}${audioOutput}&api_add_screen=main`);
}

// ============================================================================
// הרחבת הראוטר: טיפול במסך search_retry שנשכח בטבלת הניתוב המרכזית
// (מובטח שכל מסך נתמך — תאימות מלאה)
// ============================================================================

// עוטף את ה-handler הראשי כדי להוסיף תמיכה ב-search_retry מבלי לשבור את
// המבנה הקיים. אנו מרחיבים את module.exports באמצעות wrapper שקוף.
const __originalHandler = module.exports;
module.exports = async (req, res) => {
  try {
    const query = (req && req.query) ? req.query : {};
    const body = extractBody(req);
    const params = Object.assign({}, query, body);

    if (params.hangup === 'yes') {
      return safeSend(res, 'hangup=yes');
    }

    if ((params.screen || 'main') === 'search_retry') {
      return await handleSearchRetry(params, res);
    }
  } catch (e) {
    console.error('[Wrapper Error]', e && e.message);
    return sendFallbackToMain(res, 'שגיאה כללית זמנית במערכת');
  }
  return __originalHandler(req, res);
};
