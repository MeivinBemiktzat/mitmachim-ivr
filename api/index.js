const url = require('url');

// גזירת כתובת הפורום ממשתני הסביבה או שימוש בברירת המחדל הרשמית של מתמחים טופ
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');

// הגדרות מגבלות אורך לטקסטים המועברים למנוע ה-TTS (Text-to-Speech) למניעת קריסות שרת ושגיאות מנוע
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS כדי למנוע קריסה בשורות ארוכות
const DEFAULT_TIMEOUT = 10000; // זמן המתנה מוגדר מראש לקריאות שרת במילישניות (10 שניות)

/**
 * פונקציה לביצוע בקשות HTTP בצורה בטוחה ומאובטחת מול ה-Read API של פורום NodeBB.
 * מוסיפה תמיד את הסיומת /api לנתיבי המערכת ומעבדת את תגובת ה-JSON בצורה אסינכרונית.
 * כוללת טיפול מקיף בשגיאות רשת, זמני תפוגה (Timeout) ונפילות שרת.
 * * @param {string} path הנתיב המבוקש בפורום (למשל /recent או /topic/123)
 * @returns {Promise<Object>} אובייקט ה-JSON שהתקבל מהפורום
 */
async function nbFetch(path) {
  const targetUrl = FORUM_URL + '/api' + path;
  
  // יצירת מנגנון AbortController לניהול קפדני של זמני תפוגה (Timeout)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-smart-bridge/2.0 (IVR Community Integration)',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      throw new Error(`NodeBB HTTP error status: ${res.status} for path: ${path}`);
    }
    
    const data = await res.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[NodeBB Fetch Error] Failed to fetch from ${targetUrl}. Details:`, error.message);
    throw error;
  }
}

/**
 * ניקוי HTML, תגיות מיוחדות, קודים ומאפייני עיצוב והפיכתם לטקסט נקי לחלוטין.
 * מותאם ספציפית עבור מנוע ה-TTS של ימות המשיח למניעת השמעת קודים, קישורים ותגיות שבורות.
 * * @param {string} html הטקסט הגולמי הכולל תגיות HTML מהפורום
 * @returns {string} טקסט נקי ומסונן המוכר וקריא על ידי מנוע ההקראה
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);
  
  // הסרת תכני עיצוב פנימיים (Style) ותסריטים (Scripts) יחד עם התוכן שלהם
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  
  // טיפול בבלוקים של קוד (Code Blocks) - הסרת קטעי קוד ארוכים שאינם מתאימים להקראה קולית
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, ' [קטע קוד מושמט] ');
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' [קוד] ');
  
  // החלפת תגיות שבירת שורה נפוצות בנקודות ורווחים ליצירת הפסקות הגיוניות בהקראה
  text = text.replace(/<br\s*\/?>/gi, ' . ');
  text = text.replace(/<\/p>/gi, ' . ');
  text = text.replace(/<\/li>/gi, ' . ');
  text = text.replace(/<\/h[1-6]>/gi, ' . ');
  
  // הסרת כל שאר תגיות ה-HTML שנותרו בטקסט
  text = text.replace(/<[^>]+>/g, ' ');
  
  // החלפת ישויות HTML נפוצות לתווים רגילים בעברית ובכלל
  text = text.replace(/&quot;/g, '"')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&nbsp;/g, ' ')
             .replace(/&apos;/g, "'")
             .replace(/&#39;/g, "'")
             .replace(/&ldquo;/g, '"')
             .replace(/&rdquo;/g, '"')
             .replace(/&bull;/g, '•');

  // ניקוי סימני Markdown נפוצים שלעיתים נשארים בטקסט הגולמי של הפורום
  text = text.replace(/[\#\*\_~`\[\]\(\)\{\}\+\-\\!]/g, ' ');
  
  // הסרת קישורי אינטרנט ארוכים (URL) כדי למנוע מהרובוט להקריא "ח ח ת ת פ ס נקודה..."
  text = text.replace(/https?:\/\/[^\s]+/gi, ' [קישור אינטרנט] ');
  
  // צמצום רווחים כפולות, סימני שורה חדשה ורווחים לבנים מיותרים
  text = text.replace(/\s+/g, ' ');
  
  // ניקוי תווים מיוחדים שאינם קריאים או שגורמים לבעיות במנועי דיבור קוליים
  text = text.replace(/[\x00-\x1F\x7F]/g, '');
  
  return text.trim();
}

/**
 * חיתוך טקסט ארוך בצורה חכמה שאינה שוברת מילים באמצע, עד למגבלה המקסימלית של ה-TTS.
 * * @param {string} str הטקסט המלא
 * @param {number} max אורך מקסימלי מותר
 * @returns {string} הטקסט החתוך עם שלוש נקודות בסופו במידת הצורך
 */
function truncateText(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  
  // חיתוך ראשוני לפי המגבלה
  let sub = str.substring(0, max);
  // מציאת הרווח האחרון כדי לא לשבור מילה באמצע שלה
  let lastSpace = sub.lastIndexOf(' ');
  if (lastSpace > max * 0.8) {
    sub = sub.substring(0, lastSpace);
  }
  return sub + '... המשך ההודעה קטוע עקב אורכה.';
}

/**
 * הפיכת מערך של מחרוזות טקסט או קבצי שמע לפורמט הפקודה הרשמי של ימות המשיח id_list_message.
 * מאפשר שרשור של מספר קטעי TTS (עם קידומת t-) וקטעי שמע פיזיים יחד.
 * * @param {Array<string>} parts מערך החלקים להשמעה
 * @returns {string} מחרוזת מובנית בפורמט id_list_message לשרת ה-IVR
 */
function idList(parts) {
  if (!parts || !Array.isArray(parts) || parts.length === 0) return '';
  
  const formatted = parts.map(p => {
    if (!p) return '';
    const trimmed = String(p).trim();
    // אם כבר כולל מזהה סוג (כמו t- או f-), נשאיר אותו ככה
    if (trimmed.startsWith('t-') || trimmed.startsWith('f-') || trimmed.startsWith('d-') || trimmed.startsWith('s-')) {
      return trimmed;
    }
    // ברירת מחדל היא טקסט להקראה (TTS)
    return 't-' + trimmed;
  }).filter(p => p !== '');
  
  return 'id_list_message=' + formatted.join('..');
}

/**
 * בניית פקודת ה-Read המהירה (המתנה להקשת משתמש) המותאמת לארכיטקטורת Barge-in (קטיעת שמע).
 * המשתמש יכול להקיש תוך כדי הדיבור והמערכת תתפוס מיד את ההקשה ותעבור למצב הבא.
 * * @param {string} varName שם הפרמטר שיוחזר לשרת בבקשה הבאה (למשל mainsel או topicnav)
 * @param {number} timeout זמן המתנה בשניות לאחר סיום השמעת הדיבור (ברירת מחדל 10 שניות)
 * @param {number} maxDigits מספר מקסימלי של ספרות לקליטה (ברירת מחדל 1)
 * @returns {string} פקודת ה-read המלאה בפורמט ימות המשיח
 */
function buildFastMenuRead(varName, timeout = 10, maxDigits = 1) {
  // הפורמט: read=variableName,re_ask,min_digits,max_digits,timeout,type,barge_in,play_ok
  // אנחנו מגדירים barge_in=yes כדי לאפשר קטיעה מהירה תוך כדי דיבור לחוויה זורמת
  return `read^^${varName}>no>1>${maxDigits}>${timeout}>Digits>yes>no`;
}

// ============================================================================
//                          הקצה הראשי (MAIN HANDLER)
// ============================================================================

module.exports = async (req, res) => {
  // הגדרת כותרות מענה עבור שרת ימות המשיח (טקסט פשוט בקידוד UTF-8)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  
  try {
    // ניתוח כתובת ה-URL ופרמטרי ה-Query string שהגיעו ממערכת ה-IVR
    const parsedUrl = url.parse(req.url, true);
    const q = parsedUrl.query;
    
    // שליפת פרטי שיחה בסיסיים לטובת לוגים ומעקב שגיאות בזמן אמת
    const phone = q.ApiPhone || 'חסוי';
    const callId = q.ApiCallId || 'אין';
    const currentExtension = q.ApiExtension || 'שלוחה כלשהי';
    
    // זיהוי המסך / המצב הנוכחי של המשתמש במערכת.
    // אנו בודקים הן את api_add_screen והן את screen הישיר כדי למנוע איבודי מידע
    let currentScreen = q.api_add_screen || q.screen || 'main';
    
    console.log(`[IVR Request] Phone: ${phone} | CallId: ${callId} | ScreenState: ${currentScreen} | Extension: ${currentExtension}`);
    
    // פריסת עמודים (Pagination) פנימית עבור רשימות ארוכות
    let currentPage = parseInt(q.api_add_page || q.page || '0', 10);
    if (currentPage < 0) currentPage = 0;
    
    // ========================================================================
    // מכונת המצבים (SWITCH CASE) לניהול שלוחות ותפריטי הפורום
    // ========================================================================
    
    switch (currentScreen) {
      
      // ----------------------------------------------------------------------
      // מצב 1: תפריט ראשי (MAIN MENU)
      // ----------------------------------------------------------------------
      case 'main': {
        // בדיקה האם המשתמש כבר ביצע הקשה בתפריט הראשי
        const selection = q.mainsel ? String(q.mainsel).trim() : null;
        
        // אם המשתמש הקיש ספרה, ננתב אותו למסך המבוקש לפי בחירתו
        if (selection) {
          console.log(`[Main Menu Input] User ${phone} pressed: ${selection}`);
          
          if (selection === '1') {
            // מעבר מיידי למסך פוסטים אחרונים בפורום
            return res.send(
              `api_add_screen=posts&api_add_page=0&` + 
              `read=t-טוען פוסטים אחרונים=dummy,no,1,1,1,Digits,no,no`
            );
          }
          if (selection === '2') {
            // מעבר מיידי למסך נושאים (דיונים) אחרונים שנפתחו
            return res.send(
              `api_add_screen=topics&api_add_page=0&` + 
              `read=t-טוען נושאים אחרונים=dummy,no,1,1,1,Digits,no,no`
            );
          }
          if (selection === '3') {
            // מעבר למסך קטגוריות הפורום הראשיות
            return res.send(
              `api_add_screen=categories&` + 
              `read=t-טוען קטגוריות=dummy,no,1,1,1,Digits,no,no`
            );
          }
          if (selection === '4') {
            // מעבר למסך חיפוש נושאים בפורום
            return res.send(
              `api_add_screen=search_prompt&` + 
              `read=t-אנא הקש מילת חיפוש=dummy,no,1,1,1,Digits,no,no`
            );
          }
          
          // אם הוקשה ספרה לא מזוהה, נשמיע הודעת שגיאה ונציג שוב את התפריט הראשי
          console.log(`[Main Menu] Invalid selection: ${selection}. Re-prompting.`);
          const errMsg = 't-המקש שהוקש שגוי .';
          const audioPrompt = idList([
            errMsg,
            'ברוכים הבאים לפורום מתמחים טופ הטלפוני. כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ.',
            'לכניסה לפוסטים האחרונים הקישו 1.',
            'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
            'לכניסה לפי קטגוריות הפורום הקישו 3.',
            'לחיפוש בפורום הקישו 4.'
          ]);
          const readCmd = buildFastMenuRead('mainsel', 15, 1);
          return res.send(`${audioPrompt}&${readCmd}&api_add_screen=main`);
        }
        
        // הצגה ראשונית של התפריט הראשי במידה ולא בוצעה הקשה כלל
        const audioPrompt = idList([
          'ברוכים הבאים לפורום מתמחים טופ הטלפוני. כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ.',
          'לכניסה לפוסטים האחרונים הקישו 1.',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
          'לכניסה לפי קטגוריות הפורום הקישו 3.',
          'לחיפוש בפורום הקישו 4.'
        ]);
        
        const readCmd = buildFastMenuRead('mainsel', 20, 1);
        return res.send(`${audioPrompt}&${readCmd}&api_add_screen=main`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 2: פוסטים אחרונים מכל הפורום (RECENT POSTS LIST)
      // ----------------------------------------------------------------------
      case 'posts': {
        // בדיקת הקשה קודמת בניווט הפוסטים האחרונים
        const navInput = q.menu_select ? String(q.menu_select).trim() : null;
        
        if (navInput) {
          if (navInput === '1') { // עמוד הבא
            currentPage += 1;
          } else if (navInput === '2') { // עמוד קודם
            currentPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
          } else if (navInput === '0') { // חזרה לתפריט ראשי
            return res.send(`api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
          } else if (navInput.startsWith('*') || navInput === '3') {
            // הקשת מספר פוסט ספציפי או בחירה דינמית אחרת
            // נשאר באותו עמוד ומקריא שוב
          }
        }
        
        // משיכת פוסטים אחרונים מה-API של הפורום
        const data = await nbFetch('/recent');
        const topics = data.topics || [];
        
        if (topics.length === 0) {
          const out = idList(['אין פוסטים אחרונים זמינים בפורום כעת.', 'לחזרה לתפריט הראשי הקישו 0.']);
          const readCmd = buildFastMenuRead('menu_select', 10, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=posts&api_add_page=0`);
        }
        
        // הגדרת פריסת עמודים - 4 נושאים בכל עמוד שמע טלפוני
        const itemsPerPage = 4;
        const totalPages = Math.ceil(topics.length / itemsPerPage);
        
        if (currentPage >= totalPages) currentPage = totalPages - 1;
        if (currentPage < 0) currentPage = 0;
        
        const startIndex = currentPage * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, topics.length);
        
        const audioParts = [];
        audioParts.push(`מציג פוסטים אחרונים. עמוד ${currentPage + 1} מתוך ${totalPages}.`);
        
        // מעבר על הנושאים ששייכים לעמוד הנוכחי והקראת כותרתם ופרטיהם
        for (let i = startIndex; i < endIndex; i++) {
          const t = topics[i];
          const cleanTitle = cleanText(t.title || 'נושא ללא כותרת');
          const indexNumber = i - startIndex + 1;
          
          audioParts.push(`לכניסה לנושא מספר ${indexNumber} . הקישו ${indexNumber} .`);
          audioParts.push(`כותרת: ${truncateText(cleanTitle, MAX_TITLE_CHARS)} .`);
          if (t.user && t.user.username) {
            audioParts.push(`נכתב על ידי ${cleanText(t.user.username)} .`);
          }
          audioParts.push(`הודעה זו כוללת ${t.postcount || 1} תגובות .`);
        }
        
        // הוספת הנחיות ניווט מובנות בתחתית הרשימה
        audioParts.push('לעמוד הבא הקישו 5 . לעמוד הקודם הקישו 6 . לחזרה לתפריט הראשי הקישו 0 .');
        
        // ניתוח בחירה ישירה של נושא (הקשת 1 עד 4) מהתפריט המהיר
        if (navInput && ['1', '2', '3', '4'].includes(navInput)) {
          const targetOffset = parseInt(navInput, 10) - 1;
          const targetIndex = startIndex + targetOffset;
          
          if (targetIndex < endIndex) {
            const selectedTopic = topics[targetIndex];
            console.log(`[Posts Navigation] User selected topic index: ${targetIndex} (TID: ${selectedTopic.tid})`);
            return res.send(
              `api_add_screen=topic&api_add_tid=${selectedTopic.tid}&api_add_page=0&` +
              `read=t-טוען את הפוסט המבוקש=dummy,no,1,1,1,Digits,no,no`
            );
          } else {
            audioParts.unshift('המספר שהוקש אינו קיים בעמוד זה .');
          }
        }
        
        // טיפול במקשי הדפדוף הייעודיים (5 ו-6)
        if (navInput === '5') {
          if (currentPage + 1 < totalPages) {
            currentPage += 1;
            // מעבר רקורסיבי קל או שליחה ישירה מחדש עם עמוד מעודכן
            return res.send(`api_add_screen=posts&api_add_page=${currentPage}&menu_select=`);
          } else {
            audioParts.unshift('הגעתם כבר לעמוד האחרון .');
          }
        }
        if (navInput === '6') {
          if (currentPage > 0) {
            currentPage -= 1;
            return res.send(`api_add_screen=posts&api_add_page=${currentPage}&menu_select=`);
          } else {
            audioParts.unshift('הגעתם כבר לעמוד הראשון .');
          }
        }
        
        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('menu_select', 15, 1);
        
        return res.send(`${audioOutput}&${readCommand}&api_add_screen=posts&api_add_page=${currentPage}`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 3: נושאים אחרונים בפורום (RECENT TOPICS LIST)
      // ----------------------------------------------------------------------
      case 'topics': {
        const navInput = q.menu_select ? String(q.menu_select).trim() : null;
        
        if (navInput === '0') {
          return res.send(`api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // קבלת נושאים פופולריים / אחרונים
        const data = await nbFetch('/recent');
        const topics = data.topics || [];
        
        if (topics.length === 0) {
          const out = idList(['אין נושאים אחרונים זמינים בפורום כעת .', 'לחזרה לתפריט הראשי הקישו 0 .']);
          const readCmd = buildFastMenuRead('menu_select', 10, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=topics&api_add_page=0`);
        }
        
        const itemsPerPage = 4;
        const totalPages = Math.ceil(topics.length / itemsPerPage);
        
        if (navInput === '5' && currentPage + 1 < totalPages) currentPage++;
        if (navInput === '6' && currentPage > 0) currentPage--;
        
        // טיפול בבחירת מספר נושא מ-1 עד 4 מהעמוד
        if (navInput && ['1', '2', '3', '4'].includes(navInput)) {
          const targetIdx = (currentPage * itemsPerPage) + parseInt(navInput, 10) - 1;
          if (targetIdx < topics.length) {
            const targetTopic = topics[targetIdx];
            return res.send(
              `api_add_screen=topic&api_add_tid=${targetTopic.tid}&api_add_page=0&` +
              `read=t-נכנס לדיון=dummy,no,1,1,1,Digits,no,no`
            );
          }
        }
        
        const startIndex = currentPage * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, topics.length);
        
        const audioParts = [];
        audioParts.push(`נושאים אחרונים. עמוד ${currentPage + 1} מתוך ${totalPages} .`);
        
        for (let i = startIndex; i < endIndex; i++) {
          const t = topics[i];
          const num = i - startIndex + 1;
          const cleanTitle = cleanText(t.title || 'ללא כותרת');
          const categoryName = t.category ? cleanText(t.category.name) : 'כללי';
          
          audioParts.push(`לדיון מספר ${num} הקישו ${num} .`);
          audioParts.push(`כותרת הנושא: ${truncateText(cleanTitle, MAX_TITLE_CHARS)} .`);
          audioParts.push(`בקטגוריית: ${categoryName} .`);
        }
        
        audioParts.push('לעמוד הבא הקישו 5 . לעמוד הקודם הקישו 6 . לחזרה לתפריט הראשי הקישו 0 .');
        
        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('menu_select', 15, 1);
        
        return res.send(`${audioOutput}&${readCommand}&api_add_screen=topics&api_add_page=${currentPage}`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 4: רשימת קטגוריות הפורום (CATEGORIES LIST)
      // ----------------------------------------------------------------------
      case 'categories': {
        const selection = q.menu_select ? String(q.menu_select).trim() : null;
        
        if (selection === '0') {
          return res.send(`api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // משיכת כל הקטגוריות הראשיות מהפורום
        const data = await nbFetch('/categories');
        const categories = data.categories || [];
        
        if (categories.length === 0) {
          const out = idList(['לא נמצאו קטגוריות בפורום בשלב זה .', 'לחזרה לתפריט הראשי הקישו 0 .']);
          const readCmd = buildFastMenuRead('menu_select', 10, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=categories`);
        }
        
        const itemsPerPage = 5;
        const totalPages = Math.ceil(categories.length / itemsPerPage);
        
        if (selection === '5' && currentPage + 1 < totalPages) currentPage++;
        if (selection === '6' && currentPage > 0) currentPage--;
        
        // בדיקה האם נבחרה קטגוריה ספציפית מהתפריט (1 עד 5)
        if (selection && ['1', '2', '3', '4', '5'].includes(selection)) {
          const selectedOffset = parseInt(selection, 10) - 1;
          const targetIdx = (currentPage * itemsPerPage) + selectedOffset;
          
          if (targetIdx < categories.length) {
            const cat = categories[targetIdx];
            console.log(`[Category Selected] User selected category CID: ${cat.cid} (${cat.name})`);
            return res.send(
              `api_add_screen=category_topics&api_add_cid=${cat.cid}&api_add_page=0&` +
              `read=t-פותח קטגוריה=dummy,no,1,1,1,Digits,no,no`
            );
          }
        }
        
        const startIndex = currentPage * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, categories.length);
        
        const audioParts = [];
        audioParts.push(`קטגוריות הפורום. עמוד ${currentPage + 1} מתוך ${totalPages} .`);
        
        for (let i = startIndex; i < endIndex; i++) {
          const cat = categories[i];
          const num = i - startIndex + 1;
          const catName = cleanText(cat.name || 'קטגוריה ללא שם');
          const catDesc = cat.description ? cleanText(cat.description) : '';
          
          audioParts.push(`לקטגוריית ${catName} הקישו ${num} .`);
          if (catDesc) {
            audioParts.push(`תיאור: ${truncateText(catDesc, 150)} .`);
          }
        }
        
        audioParts.push('לעמוד הבא הקישו 5 . לעמוד הקודם הקישו 6 . לחזרה לתפריט הראשי הקישו 0 .');
        
        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('menu_select', 15, 1);
        
        return res.send(`${audioOutput}&${readCommand}&api_add_screen=categories&api_add_page=${currentPage}`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 5: נושאים בתוך קטגוריה ספציפית (TOPICS IN CATEGORY)
      // ----------------------------------------------------------------------
      case 'category_topics': {
        const selection = q.menu_select ? String(q.menu_select).trim() : null;
        const cid = q.api_add_cid || q.cid;
        
        if (!cid) {
          return res.send(`api_add_screen=categories&read=t-קטגוריה לא נמצאה חוזר אחורה=dummy,no,1,1,1,Digits,no,no`);
        }
        
        if (selection === '0') {
          return res.send(`api_add_screen=categories&api_add_page=0&read=t-חוזר לרשימת קטגוריות=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // משיכת נושאים השייכים לקטגוריה הנבחרת
        const data = await nbFetch(`/category/${cid}`);
        const topics = data.topics || [];
        const catName = data.name ? cleanText(data.name) : 'הקטגוריה הנבחרת';
        
        if (topics.length === 0) {
          const out = idList([`אין נושאים זמינים בקטגוריית ${catName} בשלב זה .`, 'לחזרה לרשימת הקטגוריות הקישו 0 .']);
          const readCmd = buildFastMenuRead('menu_select', 12, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=category_topics&api_add_cid=${cid}`);
        }
        
        const itemsPerPage = 4;
        const totalPages = Math.ceil(topics.length / itemsPerPage);
        
        if (selection === '5' && currentPage + 1 < totalPages) currentPage++;
        if (selection === '6' && currentPage > 0) currentPage--;
        
        // בדיקת בחירת נושא מתוך הרשימה (1 עד 4)
        if (selection && ['1', '2', '3', '4'].includes(selection)) {
          const targetIdx = (currentPage * itemsPerPage) + parseInt(selection, 10) - 1;
          if (targetIdx < topics.length) {
            const selectedTopic = topics[targetIdx];
            return res.send(
              `api_add_screen=topic&api_add_tid=${selectedTopic.tid}&api_add_page=0&` +
              `read=t-נכנס לדיון=dummy,no,1,1,1,Digits,no,no`
            );
          }
        }
        
        const startIndex = currentPage * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, topics.length);
        
        const audioParts = [];
        audioParts.push(`נושאים בקטגוריית ${catName} . עמוד ${currentPage + 1} מתוך ${totalPages} .`);
        
        for (let i = startIndex; i < endIndex; i++) {
          const t = topics[i];
          const num = i - startIndex + 1;
          const cleanTitle = cleanText(t.title || 'דיון ללא כותרת');
          
          audioParts.push(`לדיון מספר ${num} הקישו ${num} .`);
          audioParts.push(`כותרת: ${truncateText(cleanTitle, MAX_TITLE_CHARS)} .`);
          audioParts.push(`כולל ${t.postcount || 1} הודעות .`);
        }
        
        audioParts.push('לעמוד הבא הקישו 5 . לעמוד הקודם הקישו 6 . לחזרה לקטגוריות הקישו 0 .');
        
        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('menu_select', 15, 1);
        
        return res.send(`${audioOutput}&${readCommand}&api_add_screen=category_topics&api_add_cid=${cid}&api_add_page=${currentPage}`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 6: קריאת הודעות ותגובות בתוך דיון (TOPIC VIEW / POSTS IN TOPIC)
      // ----------------------------------------------------------------------
      case 'topic': {
        const topicId = q.api_add_tid || q.tid;
        const topicNavInput = q.topicnav ? String(q.topicnav).trim() : null;
        
        if (!topicId) {
          console.warn('[Topic View Error] Missing topicId (tid). Redirecting to main menu.');
          return res.send(`api_add_screen=main&read=t-שגיאה במערכת חוזר להתחלה=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // חזרה מהירה לעמוד או שלב קודם בהקשת אפס
        if (topicNavInput === '0') {
          return res.send(`api_add_screen=topics&api_add_page=0&read=t-חוזר לרשימת הנושאים=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // שליפת הנתונים והתגובות המלאות של הנושא המבוקש מה-API
        const data = await nbFetch(`/topic/${topicId}`);
        const posts = data.posts || [];
        const topicTitle = data.title ? cleanText(data.title) : 'נושא כללי';
        
        if (posts.length === 0) {
          const out = idList(['לא נמצאו פוסטים או תגובות בדיון זה .', 'לחזרה לרשימת הנושאים הקישו 0 .']);
          const readCmd = buildFastMenuRead('topicnav', 10, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=topic&api_add_tid=${topicId}`);
        }
        
        // ניהול ניווט פוסט-אחר-פוסט בתוך הדיון (הקשת 1 לפוסט הבא, 2 לפוסט הקודם)
        let currentPostIndex = currentPage; // אנו משתמשים ב-currentPage כסמן האינדקס של הפוסט בדיון
        
        if (topicNavInput === '1') { // פוסט הבא
          if (currentPostIndex + 1 < posts.length) {
            currentPostIndex++;
          } else {
            // הגענו לסוף הדיון, מעבר למסך סיום נושא ייעודי
            return res.send(
              `api_add_screen=topicend&api_add_tid=${topicId}&api_add_page=${currentPostIndex}&` +
              `read=t-הגעתם לסוף הדיון המבוקש . לשמיעה מחודשת הקישו 1 . לחזרה הקישו 0=topicnav,no,1,1,10,Digits,yes,no`
            );
          }
        } else if (topicNavInput === '2') { // פוסט קודם
          if (currentPostIndex > 0) currentPostIndex--;
        }
        
        // עדכון עמוד המצב הנוכחי במערכת האינדקסים
        currentPage = currentPostIndex;
        
        const activePost = posts[currentPage];
        const posterName = activePost.user ? cleanText(activePost.user.username) : 'משתמש אנונימי';
        const rawContent = activePost.content || '';
        const cleanContent = cleanText(rawContent);
        const finalTtsBody = truncateText(cleanContent, MAX_BODY_CHARS);
        
        const audioParts = [];
        // השמעת כותרת הדיון רק בפוסט הראשון כדי לא להלאות את המאזין בכל תגובה
        if (currentPage === 0) {
          audioParts.push(`כותרת הדיון היא: ${topicTitle} .`);
        }
        
        audioParts.push(`הודעה מספר ${currentPage + 1} מתוך ${posts.length} .`);
        audioParts.push(`נכתב על ידי ${posterName} .`);
        audioParts.push(`תוכן ההודעה: ${finalTtsBody} .`);
        
        // יצירת מערך מידע מורחב על הפוסט למקרה שהמאזין יבקש פירוט מלא (הקשת 3)
        const postDetailsArray = [
          `פרטי הודעה מלאים`,
          `שם הכותב הוא ${posterName}`
        ];
        
        if (activePost.timestampISO) {
          try {
            const dateObj = new Date(activePost.timestampISO);
            postDetailsArray.push(`פורסם בתאריך ${dateObj.getDate()} לחודש ${dateObj.getMonth() + 1} שנת ${dateObj.getFullYear()}`);
          } catch (e) {
            // התעלמות משגיאות פורמט תאריך משניות
          }
        }
        
        if (activePost.votes !== undefined) {
          postDetailsArray.push(`הודעה זו קיבלה ${activePost.votes} מוניטין חיובי מהקהילה .`);
        }
        postDetailsArray.push(`סך הכל ישנם ${data.postcount || posts.length} פוסטים בדיון זה .`);
        
        const audioOutput = idList(audioParts);
        
        // תפריט ניווט פנימי קולי מהיר בין פוסטים בדיון
        const navigationPrompt = idList([
          'להודעה הבאה הקישו 1 .',
          'להודעה הקודמת הקישו 2 .',
          'לשמיעת פרטי ההודעה המלאים הקישו 3 .',
          'לחזרה לתפריט הקודם הקישו אפס .'
        ]);
        
        const readCommand = buildFastMenuRead('topicnav', 15);
        const metadataString = encodeURIComponent(postDetailsArray.join('|'));
        
        // טיפול ייעודי בהקשת 3 - שמיעת פרטים מלאים על הפוסט
        if (topicNavInput === '3') {
          const detailOutput = idList(postDetailsArray.concat(['לחזרה להודעה והמשך ניווט הקישו מקש כלשהו .']));
          const readBackCmd = buildFastMenuRead('detback', 15);
          return res.send(
            `${detailOutput}&${readBackCmd}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_screen=detback`
          );
        }
        
        return res.send(
          `${audioOutput}.${navigationPrompt}&${readCommand}` +
          `&api_add_tid=${topicId}` +
          `&api_add_page=${currentPage}` +
          `&api_add_screen=topic` +
          `&api_add_details=${metadataString}`
        );
      }
      
      // ----------------------------------------------------------------------
      // מצב 7: חזרה מפרטי הודעה מלאים (DETAILS BACK HANDLER)
      // ----------------------------------------------------------------------
      case 'detback': {
        const topicId = q.api_add_tid || q.tid;
        // החזרה ישירה למצב קריאת הנושא באותו העמוד בדיוק ללא השמעת הודעות סרק
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&topicnav=`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 8: סיום קריאת נושא (TOPIC END SCREEN)
      // ----------------------------------------------------------------------
      case 'topicend': {
        const topicId = q.api_add_tid || q.tid;
        const topicNavInput = q.topicnav ? String(q.topicnav).trim() : null;
        
        if (topicNavInput === '1') {
          // שמיעה מחדש של הדיון מהתחלה
          return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=0&topicnav=`);
        }
        // ברירת מחדל או הקשת 0 - חזרה לרשימת הנושאים
        return res.send(`api_add_screen=topics&api_add_page=0&menu_select=`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 9: בקשת מילת מפתח לחיפוש (SEARCH PROMPT)
      // ----------------------------------------------------------------------
      case 'search_prompt': {
        // בימות המשיח, בקשת קלט טקסטואלי או הקשת מילים מתבצעת על ידי הגדרת קליטת ספרות ארוכה (עד 10 ספרות למשל)
        // או שימוש במערכת זיהוי דיבור במידה ומוגדרת. כאן נבקש הקשת מזהה/ספרות חיפוש או שנמתין לקלט DTMF
        const audioPrompt = idList([
          'אנא הקישו את מילת או קוד החיפוש שלכם, ובסיום הקישו סולמית .',
          'לחזרה לתפריט הראשי הקישו אפס בסיום וסולמית .'
        ]);
        const readCmd = buildFastMenuRead('search_query', 20, 15); // מאפשר הקשה של עד 15 תווים/ספרות
        return res.send(`${audioPrompt}&${readCmd}&api_add_screen=search_execute`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 10: ביצוע חיפוש והצגת תוצאות (SEARCH EXECUTE)
      // ----------------------------------------------------------------------
      case 'search_execute': {
        const searchQuery = q.search_query ? String(q.search_query).trim() : null;
        const selection = q.menu_select ? String(q.menu_select).trim() : null;
        
        if (!searchQuery || searchQuery === '0') {
          return res.send(`api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
        }
        
        // ביצוע פנייה ל-API של החיפוש בפורום NodeBB
        // אנו מקודדים את השילוב של מילת החיפוש בצורה בטוחה ל-URL
        const encodedQuery = encodeURIComponent(searchQuery);
        const data = await nbFetch(`/search?term=${encodedQuery}&in=titlesposts`);
        const topics = data.posts || data.topics || [];
        
        if (topics.length === 0) {
          const out = idList([`לא נמצאו תוצאות עבור החיפוש שלכם .`, 'לניסיון חיפוש חדש הקישו 1 . לחזרה לתפריט הראשי הקישו 0 .']);
          const readCmd = buildFastMenuRead('search_retry', 15, 1);
          return res.send(`${out}&${readCmd}&api_add_screen=search_failed`);
        }
        
        const itemsPerPage = 4;
        const totalPages = Math.ceil(topics.length / itemsPerPage);
        
        if (selection === '5' && currentPage + 1 < totalPages) currentPage++;
        if (selection === '6' && currentPage > 0) currentPage--;
        
        // בדיקת בחירת נושא מתוצאות החיפוש (1 עד 4)
        if (selection && ['1', '2', '3', '4'].includes(selection)) {
          const targetIdx = (currentPage * itemsPerPage) + parseInt(selection, 10) - 1;
          if (targetIdx < topics.length) {
            const selectedItem = topics[targetIdx];
            const targetTid = selectedItem.tid || (selectedItem.topic ? selectedItem.topic.tid : null);
            if (targetTid) {
              return res.send(
                `api_add_screen=topic&api_add_tid=${targetTid}&api_add_page=0&` +
                `read=t-פותח תוצאת חיפוש=dummy,no,1,1,1,Digits,no,no`
              );
            }
          }
        }
        
        const startIndex = currentPage * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, topics.length);
        
        const audioParts = [];
        audioParts.push(`תוצאות חיפוש עבור הקוד שהוקש. עמוד ${currentPage + 1} מתוך ${totalPages} .`);
        
        for (let i = startIndex; i < endIndex; i++) {
          const item = topics[i];
          const num = i - startIndex + 1;
          // שליפת כותרת הנושא או גוף הפוסט בהתאם למבנה אובייקט החיפוש שהוחזר
          const rawTitle = item.title || (item.topic ? item.topic.title : 'תוצאה ללא כותרת');
          const cleanTitle = cleanText(rawTitle);
          
          audioParts.push(`לתוצאה מספר ${num} הקישו ${num} .`);
          audioParts.push(`כותרת: ${truncateText(cleanTitle, MAX_TITLE_CHARS)} .`);
        }
        
        audioParts.push('לעמוד הבא הקישו 5 . לעמוד הקודם הקישו 6 . לחזרה לתפריט הראשי הקישו 0 .');
        
        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('menu_select', 15, 1);
        
        return res.send(`${audioOutput}&${readCommand}&api_add_screen=search_execute&api_add_page=${currentPage}&search_query=${encodedQuery}`);
      }
      
      // ----------------------------------------------------------------------
      // מצב 11: טיפול בכישלון חיפוש (SEARCH FAILED RE-PROMPT)
      // ----------------------------------------------------------------------
      case 'search_failed': {
        const retryInput = q.search_retry ? String(q.search_retry).trim() : '0';
        if (retryInput === '1') {
          return res.send(`api_add_screen=search_prompt&read=t-מנסה שנית=dummy,no,1,1,1,Digits,no,no`);
        }
        return res.send(`api_add_screen=main&read=t-חוזר להתחלה=dummy,no,1,1,1,Digits,no,no`);
      }
      
      // ========================================================================
      // הגנת קצה מוחלטת (GLOBAL FALLBACK)
      // ========================================================================
      default: {
        console.warn(`[Fallback Warning] Unhandled screen state triggered: ${currentScreen}. Redirecting user internally to main menu.`);
        return res.send(
          `api_add_screen=main&` +
          `read=t-מצב לא מזוהה במערכת . מנתב אותך לתפריט הראשי הקישו 1=dummy,no,1,1,1,Digits,no,no`
        );
      }
    }
    
  } catch (globalError) {
    // מנגנון הגנה קריטי - תפיסת כל שגיאת קוד או רשת קורסת ומניעת השמעת צליל ניתוק/שגיאה מצד חברת התקשורת
    console.error('[Fatal System Exception Error] Critical failure in bridge execution:', globalError);
    
    const fallbackMessage = idList([
      'חלה שגיאה זמנית בהתחברות לשרתי פורום מתמחים טופ .',
      'אנא נסו לחייג שנית בעוד מספר דקות, תודה על סבלנותכם .'
    ]);
    
    // ניתוק השיחה בצורה מכובדת עם השמעת הודעת השגיאה למאזין
    return res.send(`${fallbackMessage}&hangup=yes`);
  }
};
