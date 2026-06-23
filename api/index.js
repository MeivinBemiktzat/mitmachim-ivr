// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ (NodeBB)
// נבנה באופן בלעדי עבור מערכות ה-IVR של ימות המשיח
// 
// ארכיטקטורה: ניהול תפריטים פנימי מהיר ללא go_to_folder וללא "לאישור הקישו 1"
// תמיכה מלאה בקטיעת שמע (Barge-in) והקשה תוך כדי דיבור.
// ============================================================================

// ייבוא משתני סביבה והגדרות קבועים
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS כדי למנוע קריסה בשורות ארוכות
const DEFAULT_TIMEOUT = 8000;  // זמן המתנה מוגדר מראש לקריאות שרת במילישניות

/**
 * פונקציה לביצוע בקשות HTTP בצורה בטוחה ומאובטחת מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיבי המערכת ומעבדת את תגובת ה-JSON.
 * כוללת טיפול מקיף בשגיאות רשת ומצבי קצה.
 * * @param {string} path הנתיב המבוקש בפורום
 * @} returns {Promise<Object>} תגובת ה-JSON של השרת
 */
async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;
  
  // הגדרת קונטרולר לניהול זמני תפוגה של הבקשה (Timeout)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-advanced-ivr/2.0',
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

/**
 * פונקציית עזר מתקדמת לניקוי קוד HTML מקיף, הסרת תגיות, סגנונות, סקריפטים וציטוטים.
 * מכינה את הטקסט בצורה אופטימלית להקראה במנוע ה-TTS של ימות המשיח.
 * מסירה תווים מיוחדים שעלולים לשבש את הפרוטוקול של ימות המשיח (כמו נקודות, מקפים, סימני שרשור).
 * * @param {string} html טקסט גולמי המכיל HTML מהפורום
 * @returns {string} טקסט נקי לחלוטין מותאם להקראה טלפונית
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);
  
  // שלב א: הסרת אלמנטים שאינם רלוונטיים להקראה קולית
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' '); // הסרת ציטוטים ותגובות קודמות
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' קוד מוגן '); // חסימת קטעי קוד ארוכים שמחרבים הקראה
  
  // שלב ב: המרת תגיות מבנה לסימני פיסוק הגיוניים להקראה
  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<\/p>/gi, '. ');
  text = text.replace(/<\/div>/gi, '. ');
  text = text.replace(/<\/li>/gi, '. ');
  text = text.replace(/<\/h[1-6]>/gi, '. ');
  
  // שלב ג: הסרת כל שאר תגיות ה-HTML שנותרו במחרוזת
  text = text.replace(/<[^>]+>/g, ' ');
  
  // שלב ד: המרת ישויות HTML נפוצות לטקסט רגיל או תווים בעברית
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, ' ו ');
  text = text.replace(/&quot;/gi, ' ');
  text = text.replace(/&#39;|&apos;/gi, ' ');
  text = text.replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');
  
  // שלב ה: הסרת קישורי אינטרנט מלאים והחלפתם במילה "קישור"
  text = text.replace(/https?:\/\/\S+/gi, ' קישור המערכת ');
  
  // שלב ו: ניקוי תווים מיוחדים שמשבשים את הפרוטוקול של ימות המשיח (חשוב מאוד עבור מפרידי פקודות)
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');
  
  // שלב ז: צמצום רווחים כפולים ורווחי קצוות
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

/**
 * חותכת את הטקסט הנקי לפי המגבלה שהוגדרה מראש כדי למנוע עומס על שרת ה-TTS.
 * * @param {string} text טקסט המקור
 * @param {number} max אורך מקסימלי מותר
 * @returns {string} טקסט מנוקה וחתוך
 */
function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

/**
 * ממירה חותמת זמן (Timestamp) לביטוי מילולי בעברית המובן היטב בשמיעה טלפונית.
 * * @param {number|string} ts חותמת זמן מילישניות
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

/**
 * בונה מחרוזת פקודה חוקית מסוג id_list_message עבור ימות המשיח.
 * מקבלת מערך של חלקי טקסט, מנקה אותם ומחברת אותם עם מפריד נקודה (.).
 * * @param {string[]} parts מערך של משפטים להשמעה
 * @returns {string} מחרוזת id_list_message מוכנה לשרשור
 */
function idList(parts) {
  const safeParts = parts
    .filter(p => p && String(p).trim() !== '')
    .map(p => {
      let cleaned = String(p)
        .replace(/[.\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return 't-' + cleaned;
    });
  
  if (safeParts.length === 0) return '';
  return 'id_list_message=' + safeParts.join('.');
}

/**
 * פונקציה אסטרטגית לייצור תפריט מהיר פנימי בתוך ה-API עצמו.
 * הפונקציה מחזירה פקודת קלט (read) מוגדרת היטב שמאלצת את ימות המשיח לקלוט ספרה אחת בלבד
 * ללא בקשת אישור קולי וללא "לאישור הקישו 1". היא משתמשת בהודעה קצרה מאוד של "אנא הקישו"
 * כדי לאפשר למשתמש להקיש מיד, בעוד שהתוכן המרכזי של התפריט מושמע דרך ה-id_list_message שקדם לו.
 * * @param {string} paramName שם הפרמטר שיחזור מהמערכת (למשל mainsel)
 * @param {number} waitSec זמן המתנה למקש בשניות (ברירת מחדל 7)
 * @returns {string} פקודת read משורשרת התואמת לתפריט פנימי מהיר
 */
function buildInteractiveRead(paramName, parts, waitSec = 9) {
  const safe = parts
    .filter(Boolean)
    .map(x => `t-${cleanText(x)}`)
    .join(',');

  return `read=${safe}=${paramName},no,1,1,${waitSec},Digits,no,no`;
}

/**
 * מייצרת פקודה פנימית מיוחדת בתוך ה-API שמעבירה את המצב (Screen)
 * ללא שימוש ב-go_to_folder של ימות המשיח. ה-API מחזיר קריאה חוזרת ישירה לאותה שלוחה.
 * * @param {string} targetScreen שם המסך הבא אליו אנו מנתבים בקוד
 * @param {string} extraParams פרמטרים נוספים לשרשור במידת הצורך
 * @returns {string} פקודת שרשור פנימית המדמה מעבר מסך מהיר
 */
function internalRedirect(targetScreen, extraParams = '') {
  let url = `&api_add_screen=${targetScreen}`;
  if (extraParams) {
    url += extraParams;
  }
  // אנו משתמשים בטריק הבא: אנו מחזירים פקודת read ריקה או קצרה שתעביר מיד את השליטה חזרה לשרת עם המסך החדש
  // או שאנו סומכים על כך שהקריאה הנוכחית משנה את הפרמטר ומריצה מחדש
  return url;
}

// ============================================================================
// בניית פונקציות להצגת המסכים והתפריטים השונים (הפקת רשימות טקסט)
// ============================================================================

/**
 * בונה את רשימת המשפטים להשמעת רשימת נושאים מהפורום.
 * * @param {Array} topics מערך הנושאים שהתקבל מה-API
 * @param {string} headerText כותרת הפתיחה של המסך
 * @param {string} footerText הודעת הסיום והניווט
 * @returns {string[]} מערך משפטים מוכן עבור idList
 */
function buildTopicListParts(topics, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  
  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים להצגה כעת במערכת.');
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
 * בונה את רשימת המשפטים להשמעת רשימת קטגוריות מהפורום.
 * * @param {Array} cats מערך קטגוריות
 * @param {string} headerText כותרת פתיחה
 * @returns {string[]} מערך משפטים מוכן
 */
function buildCategoryListParts(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  
  if (!cats || cats.length === 0) {
    parts.push('לא נמצאו קטגוריות זמינות במערכת.');
    return parts;
  }
  
  cats.forEach((c, i) => {
    const num = i + 1;
    const name = cleanText(c.name);
    parts.push(`לקטגוריה מספר ${num}`);
    parts.push(name);
    parts.push(`הקישו ${num}`);
  });
  
  parts.push('לחזרה לתפריט הראשי בכל עת הקישו אפס.');
  return parts;
}

// ============================================================================
// פונקציית הראוטר המרכזית (ה-Serverless Handler של Vercel)
// ============================================================================

module.exports = async (req, res) => {
  // קביעת כותרות מענה התואמות לחלוטין את הקידוד של ימות המשיח
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // איחוד ומיזוג כלל הפרמטרים הנכנסים מתוך בקשות GET או POST מהמערכת הטלפונית
  const queryData = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(queryData, req.body);
  }

  // הדפסת לוג פנימי לצורכי דיבאג ומעקב בשרת ורסל
  console.log(`[IVR Request] Screen: ${queryData.screen}, Mainsel: ${queryData.mainsel}, Full Query:`, JSON.stringify(queryData));

  // שליפת מצב המסך הנוכחי מתוך הפרמטרים (ברירת מחדל היא main)
  let currentScreen = queryData.screen || 'main';

  try {
    // ------------------------------------------------------------------------
    // שלב א': טיפול ועיבוד של הקשות משתמש אקטיביות (עדיפות עליונה למניעת לופים)
    // ------------------------------------------------------------------------
    
    // 1. עיבוד בחירה מהתפריט הראשי
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
        // הקשה שגויה בתפריט הראשי - נשמיע הודעת שגיאה ונציג שוב את התפריט הראשי
        const errorMsg = idList(['המקש שהוקש שגוי, אנא נסו שנית.']);
        const mainMenu = idList([
          'ברוכים הבאים לפורום מתמחים טופ.',
          'לכניסה לפוסטים האחרונים הקישו 1.',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
          'לכניסה לפי קטגוריות הקישו 3.'
        ]);
        const readCmd = buildFastMenuRead('mainsel', 7);
        return res.send(`${errorMsg}.${mainMenu}&${readCmd}&api_add_screen=main`);
      }
    }

    // 2. עיבוד בחירה מתוך מסך פוסטים אחרונים (recent)
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
          // העברה ישירה למסך שמיעת הנושא בתוך אותו ה-API ללא שימוש ב-go_to_folder!
          return res.send(`api_add_screen=topic&api_add_tid=${topicIds[index]}&api_add_page=0&read=t-טוען נושא=dummy,no,1,1,1,Digits,no,no`);
        } else {
          // הקשה שגויה ברשימת נושאים אחרונים
          const errorMsg = idList(['בחירה לא תקינה.']);
          return res.send(`${errorMsg}&api_add_screen=recent&read=t-אנא הקישו שוב=dummy,no,1,1,1,Digits,no,no`);
        }
      }
    }

    // 3. עיבוד בחירה מתוך מסך נושאים חדשים (topics)
    if (queryData.topicsel !== undefined && queryData.topicsel !== '') {
      const selection = String(queryData.topicsel).trim();
      console.log(`[Menu Process] User pressed ${selection} on Newest Topics`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.tids || '').split(',').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(`api_add_screen=topic&api_add_tid=${topicIds[index]}&api_add_page=0&read=t-מיד נשמע את הנושא=dummy,no,1,1,1,Digits,no,no`);
        } else {
          const errorMsg = idList(['בחירה לא תקינה.']);
          return res.send(`${errorMsg}&api_add_screen=topics&read=t-אנא הקישו שוב=dummy,no,1,1,1,Digits,no,no`);
        }
      }
    }

    // 4. עיבוד בחירה מתוך מסך קטגוריות (categories)
    if (queryData.catsel !== undefined && queryData.catsel !== '') {
      const selection = String(queryData.catsel).trim();
      const currentCid = String(queryData.curcid || '');
      console.log(`[Menu Process] User pressed ${selection} on Categories Screen`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '*' && currentCid) {
        // מעבר ישיר לשמיעת נושאים בתוך הקטגוריה הנוכחית
        return res.send(`api_add_screen=cattopics&api_add_cid=${currentCid}&read=t-טוען נושאים בקטגוריה=dummy,no,1,1,1,Digits,no,no`);
      } else {
        const index = parseInt(selection, 10) - 1;
        const categoryIds = String(queryData.cids || '').split(',').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          // טעינת תת-קטגוריה או הצגת הנושאים שלה בתוך אותו ה-API
          return res.send(`api_add_screen=categories&api_add_cid=${categoryIds[index]}&read=t-טוען קטגוריה=dummy,no,1,1,1,Digits,no,no`);
        } else {
          const errorMsg = idList(['הקשה שגויה.']);
          return res.send(`${errorMsg}&api_add_screen=categories${currentCid ? '&api_add_cid=' + currentCid : ''}&read=t-נסו שוב=dummy,no,1,1,1,Digits,no,no`);
        }
      }
    }

    // 5. עיבוד בחירה מתוך נושאים של קטגוריה ספציפית (cattopics)
    if (queryData.cattopicsel !== undefined && queryData.cattopicsel !== '') {
      const selection = String(queryData.cattopicsel).trim();
      if (selection === '0') {
        currentScreen = 'main';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.tids || '').split(',').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(`api_add_screen=topic&api_add_tid=${topicIds[index]}&api_add_page=0&read=t-טוען=dummy,no,1,1,1,Digits,no,no`);
        } else {
          return res.send(`id_list_message=t-בחירה שגויה&api_add_screen=main&read=t-חוזר לתפריט=dummy,no,1,1,1,Digits,no,no`);
        }
      }
    }

    // 6. ניווט מתוך פוסטים בתוך נושא (topicnav)
    if (queryData.topicnav !== undefined && queryData.topicnav !== '') {
      const selection = String(queryData.topicnav).trim();
      const topicId = String(queryData.tid || '');
      const currentPage = parseInt(queryData.page || '0', 10);
      
      console.log(`[Topic Navigation] User pressed ${selection} on Topic ${topicId}, Page ${currentPage}`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '1') {
        // מעבר לפוסט הבא בנושא
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage + 1}&read=t-הבא=dummy,no,1,1,1,Digits,no,no`);
      } else if (selection === '2') {
        // מעבר לפוסט הקודם (מגבילים שלא יירד מתחת ל-0)
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${prevPage}&read=t-הקודם=dummy,no,1,1,1,Digits,no,no`);
      } else if (selection === '3') {
        // הצגת פרטים נוספים על הפוסט הנוכחי
        const details = decodeURIComponent(queryData.details || '').split('|').filter(x => x);
        const detailsAudio = idList(details);
        const readCmd = buildFastMenuRead('detback', 6);
        return res.send(`${detailsAudio}.t-לחזרה לשמיעת ההודעה הקישו 1.&${readCmd}&api_add_screen=detback&api_add_tid=${topicId}&api_add_page=${currentPage}`);
      } else {
        // הקשה לא חוקית בניווט פוסטים - נשארים באותו פוסט
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-שגיאה=dummy,no,1,1,1,Digits,no,no`);
      }
    }

    // 7. חזרה מפרטי הודעה (detback)
    if (queryData.detback !== undefined && queryData.detback !== '') {
      const topicId = String(queryData.tid || '');
      const currentPage = parseInt(queryData.page || '0', 10);
      return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-חוזר=dummy,no,1,1,1,Digits,no,no`);
    }

    // 8. טיפול במסך סיום נושא (topicend)
    if (queryData.topicend !== undefined && queryData.topicend !== '') {
      const selection = String(queryData.topicend).trim();
      const topicId = String(queryData.tid || '');
      
      if (selection === '1') {
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=0&read=t-מהתחלה=dummy,no,1,1,1,Digits,no,no`);
      } else {
        currentScreen = 'main';
      }
    }

    // ------------------------------------------------------------------------
    // שלב ב': הפקת המסכים והתפריטים (הצגת המידע לפי משתנה currentScreen)
    // ------------------------------------------------------------------------

    // ===== מסך תפריט ראשי =====
    if (currentScreen === 'main') {
      const mainMenuMessage = idList([
        'ברוכים הבאים לפורום מתמחים טופ.',
        'לכניסה לפוסטים האחרונים הקישו 1.',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
        'לכניסה לפי קטגוריות הקישו 3.'
      ]);
      const readCommand = buildFastMenuRead('mainsel', 7);
      
      // אנו מחזירים את התפריט כהודעה ואז קלט מהיר. ומגדירים את המסך הבא לדיבאג
      return res.send(`${mainMenuMessage}&${readCommand}&api_add_screen=main`);
    }

    // ===== מסך פוסטים אחרונים מהפורום =====
    if (currentScreen === 'recent') {
      console.log('[Screen Render] Fetching recent posts...');
      const data = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, 9); // לוקחים מקסימום 9 נושאים כדי שיתאימו למקשים 1-9
      
      const audioList = idList(buildTopicListParts(
        topics,
        'הפוסטים האחרונים בפורום.',
        'לרענון רשימה זו הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס.'
      ));
      
      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCommand = buildFastMenuRead('recentsel', 9);
      
      return res.send(`${buildInteractiveRead('recentsel', parts)}&api_add_tids=${topicIdsString}&api_add_screen=recent`);
    }

    // ===== מסך נושאים אחרונים שנפתחו =====
    if (currentScreen === 'topics') {
      console.log('[Screen Render] Fetching newest topics...');
      let data;
      try {
        // ניסיון למשוך לפי מיון של הנושאים החדשים ביותר שנפתחו
        data = await nbFetch('/recent?term=alltime&sort=newest');
      } catch (e) {
        data = await nbFetch('/recent');
      }
      
      let topics = (data.topics || []);
      // סידור הנושאים לפי חותמת הזמן של יצירתם בסדר יורד
      topics = topics.slice().sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, 9);
      
      const audioList = idList(buildTopicListParts(
        topics,
        'הנושאים החדשים ביותר שנפתחו בפורום.',
        'לחזרה לתפריט הראשי הקישו אפס בכל עת.'
      ));
      
      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCommand = buildFastMenuRead('topicsel', 9);
      
      return res.send(`${buildInteractiveRead('recentsel', parts)}&api_add_tids=${topicIdsString}&api_add_screen=topics`);
    }

    // ===== מסך קטגוריות ראשיות ותתי-קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = queryData.cid ? String(queryData.cid) : '';
      console.log(`[Screen Render] Loading categories. Parent CID: ${cid || 'None'}`);
      
      let categoriesList = [];
      let headerText = '';
      
      if (!cid) {
        // טעינת רשימת הקטגוריות הראשיות של פורום מתמחים טופ
        const data = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, 9);
        headerText = 'תפריט קטגוריות ראשיות.';
      } else {
        // טעינת תתי קטגוריות של הקטגוריה שנבחרה
        const data = await nbFetch('/category/' + cid);
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, 9);
        headerText = 'קטגוריית ' + cleanText(data.name || '') + '.';
      }

      if (categoriesList.length > 0) {
        const audioList = idList(buildCategoryListParts(categoriesList, headerText));
        const categoryIdsString = categoriesList.map(c => c.cid).join(',');
        
        let readPrompt = 't-אנא בחרו מספר קטגוריה';
        if (cid) {
          readPrompt += ' או הקישו כוכבית לשמיעת הפוסטים בתוך קטגוריה זו';
        }
        
        const readCommand = buildFastMenuRead('catsel', 9);
        return res.send(`${buildInteractiveRead('recentsel', parts)}&api_add_cids=${categoryIdsString}&api_add_curcid=${cid}&api_add_screen=categories`);
      } else if (cid) {
        // אם אין תתי-קטגוריות, נעביר אוטומטית למסך השמעת הנושאים של קטגוריה זו בתוך ה-API
        return res.send(`api_add_screen=cattopics&api_add_cid=${cid}&read=t-מיד נטען את הנושאים=dummy,no,1,1,1,Digits,no,no`);
      } else {
        const noCats = idList(['לא נמצאו קטגוריות זמינות בפורום כרגע.']);
        return res.send(`${noCats}&api_add_screen=main&read=t-חוזר לתפריט=dummy,no,1,1,1,Digits,no,no`);
      }
    }

    // ===== מסך נושאים בתוך קטגוריה ספציפית =====
    if (currentScreen === 'cattopics') {
      const cid = String(queryData.cid || '');
      if (!cid) {
        return res.send(`api_add_screen=main&read=t-שגיאה חוזר לתפריט=dummy,no,1,1,1,Digits,no,no`);
      }
      
      console.log(`[Screen Render] Loading topics inside category CID: ${cid}`);
      const data = await nbFetch('/category/' + cid);
      const topics = (data.topics || []).slice(0, 9);
      
      const audioList = idList(buildTopicListParts(
        topics,
        'נושאים זמינים בקטגוריית ' + cleanText(data.name || '') + '.',
        'לחזרה לתפריט הראשי הקישו אפס.'
      ));
      
      const topicIdsString = topics.map(t => t.tid).join(',');
      const readCommand = buildFastMenuRead('cattopicsel', 9);
      
      return res.send(`${buildInteractiveRead('recentsel', parts)}&api_add_tids=${topicIdsString}&api_add_screen=cattopics`);
    }

    // ===== מסך שמיעת נושא (השמעת פוסטים והודעות בצורה אינטראקטיבית) =====
    if (currentScreen === 'topic') {
      const topicId = String(queryData.tid || '');
      if (!topicId) {
        return res.send(`api_add_screen=main&read=t-שגיאת מזהה נושא=dummy,no,1,1,1,Digits,no,no`);
      }
      
      const currentPage = parseInt(queryData.page || '0', 10);
      console.log(`[Screen Render] Loading topic ID: ${topicId}, post page index: ${currentPage}`);
      
      const data = await nbFetch('/topic/' + topicId);
      const posts = data.posts || [];
      const topicTitle = ttsCut(data.title, MAX_TITLE_CHARS);

      // בדיקה האם הגענו לסוף הפוסטים הזמינים בנושא זה
      if (currentPage >= posts.length) {
        const endMessage = idList([
          'הגעתם לסוף ההודעות בנושא זה.',
          'להאזנה חוזרת מההתחלה הקישו 1.',
          'לחזרה לתפריט הראשי הקישו 0 או כל מקש אחר.'
        ]);
        const readCommand = buildFastMenuRead('topicend', 8);
        return res.send(`${endMessage}&${readCommand}&api_add_tid=${topicId}&api_add_screen=topicend`);
      }

      // שליפת הפוסט הנוכחי להקראה
      const currentPost = posts[currentPage];
      const postBody = ttsCut(currentPost.content, MAX_BODY_CHARS);
      const authorName = currentPost.user && currentPost.user.username ? currentPost.user.username : 'משתמש הפורום';
      
      const audioParts = [];
      if (currentPage === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle + '.');
      }
      
      audioParts.push(`הודעה מספר ${currentPage + 1} מתוך ${posts.length}.`);
      audioParts.push(`נכתבה על ידי ${authorName}.`);
      audioParts.push(postBody);

      // בניית נתוני מטא-דאטה מורחבים עבור מסך ה"פרטים הנוספים" (מקש 3)
      const postDetailsArray = [
        'פרטים מלאים על ההודעה הנוכחית.',
        'שם המחבר הוא ' + authorName,
        'הודעה זו פורסמה ' + timeAgo(currentPost.timestamp)
      ];
      
      if (currentPost.toPid) {
        const parentPost = posts.find(x => String(x.pid) === String(currentPost.toPid));
        if (parentPost && parentPost.user) {
          postDetailsArray.push('הודעה זו היא תגובה ישירה ל' + parentPost.user.username);
        }
      }
      postDetailsArray.push(`סך הכל ישנם ${data.postcount || posts.length} פוסטים בדיון זה.`);

      const audioOutput = idList(audioParts);
      
      // תפריט ניווט פנימי קולי מהיר בין פוסטים
      const navigationPrompt = idList([
        'להודעה הבאה הקישו 1.',
        'להודעה הקודמת הקישו 2.',
        'לשמיעת פרטי ההודעה המלאים הקישו 3.',
        'לחזרה לתפריט הראשי הקישו אפס.'
      ]);
      
      const readCommand = buildFastMenuRead('topicnav', 15);
      const metadataString = encodeURIComponent(postDetailsArray.join('|'));
      
      return res.send(
        `${audioOutput}.${navigationPrompt}&${readCommand}` +
        `&api_add_tid=${topicId}` +
        `&api_add_page=${currentPage}` +
        `&api_add_screen=topic` +
        `&api_add_details=${metadataString}`
      );
    }

    // הגנת קצה - אם הגענו למצב לא מזוהה, נחזיר לתפריט הראשי פנימית
    console.warn(`[Fallback] Unhandled screen state: ${currentScreen}. Redirecting to main menu.`);
    return res.send(`api_add_screen=main&read=t-טועה מערכת חוזר להתחלה=dummy,no,1,1,1,Digits,no,no`);

  } catch (globalError) {
    console.error('[Global API Exception] Critical failure in module execution:', globalError);
    const systemErrorAudio = idList([
      'אירעה שגיאה זמנית בתקשורת ובטעינת הנתונים משרתי פורום מתמחים טופ.',
      'אנא המתינו מספר שניות ונסו שוב מאוחר יותר.'
    ]);
    return res.send(`${systemErrorAudio}&api_add_screen=main&read=t-אנא המתינו=dummy,no,1,1,2,Digits,no,no`);
  }
};
