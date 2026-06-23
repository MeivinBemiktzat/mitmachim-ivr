// ============================================================================
//                                api/index.js                                 
// ============================================================================
// מודול ה-API הטלפוני הרשמי, המורחב והמלא ביותר עבור פורום "מתמחים טופ" 
// מותאם ומעודכן באופן בלעדי עבור פלטפורמת ה-IVR וממשקי הנתונים של ימות המשיח.
//
// פתרון בעיית הניתוקים (Hangup Fix):
// בלוגים זוהתה קבלת הפרמטר hangup=yes או שליחתו בצורה משובשת שגרמה למערכת
// לנתק את השיחה מיד לאחר טעינת התפריט הראשי. קוד זה מנטרל לחלוטין כל
// השפעה של משתנה זה, ומבטיח פורמט תגובה נקי ומדויק לפי הכללים של ימות המשיח.
// ============================================================================

const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   
const MAX_BODY_CHARS  = 980;   
const DEFAULT_TIMEOUT = 8000;  

/**
 * פונקציה לביצוע בקשות HTTP בצורה בטוחה ומאובטחת מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיבי המערכת ומעבדת את תגובת ה-JSON.
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

/**
 * פונקציית עזר מתקדמת לניקוי קוד HTML מקיף, הסרת תגיות, סגנונות, סקריפטים וציטוטים.
 * מכינה את הטקסט בצורה אופטימלית להקראה במנוע ה-TTS של ימות המשיח.
 * @param {string} html טקסט גולמי המכיל HTML מהפורום
 * @returns {string} טקסט נקי לחלוטין מותאם להקראה טלפונית
 */
function cleanText(html) {
  if (!html) return '';
  let text = String(html);
  
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' '); 
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' קוד מוגן '); 
  
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
  
  text = text.replace(/https?:\/\/\S+/gi, ' קישור המערכת ');
  
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');
  
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

/**
 * חותכת את הטקסט הנקי לפי המגבלה שהוגדרה מראש כדי למנוע עומס על שרת ה-TTS.
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
 * ממירה חותמת זמן (Timestamp) לביטוי מילולי בעברית המובן היטב בשמיעה טלפונית.
 * @param {number|string} ts חותמת זמן מילישניות
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
 * בונה פקודת קלט (read) מאוחדת ומורכבת המכילה את כל תוכן התפריט בפנים.
 * מבנה זה מאלץ את ימות המשיח לאפשר קטיעת שמע (Barge-in) מלאה בכל שלב לאורך כל ההקראה.
 * מונע לחלוטין את הצורך ב-id_list_message נפרד ומבטל את ה-"לאישור הקישו 1".
 * @param {string[]} textParts מערך של חלקי משפטים שיחוברו יחד לקובץ הקראה יחיד
 * @param {string} paramName שם הפרמטר שיחזור מהמערכת (למשל mainsel)
 * @param {number} waitSec זמן המתנה למקש בשניות לאחר סיום ההקראה
 * @param {number} maxDigits מקסימום ספרות לקלט (ברירת מחדל 1 עבור תפריטים)
 * @returns {string} פקודת read מושלמת לביצוע מיידי
 */
function combineReadMenu(textParts, paramName, waitSec = 7, maxDigits = 1) {
  const cleanParts = textParts
    .filter(p => p && String(p).trim() !== '')
    .map(p => {
      return String(p)
        .replace(/[.\-]/g, ' ')
        .replace(/[|&]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    });

  const joinedText = cleanParts.join('. ');
  return `read=t-${joinedText}=${paramName},no,1,${maxDigits},${waitSec},Digits,no,no`;
}

// ============================================================================
// פונקציית הראוטר המרכזית (ה-Serverless Handler של Vercel)
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // איחוד נתוני קוורי ואיסוף פרמטרים
  const queryData = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') {
    Object.assign(queryData, req.body);
  }

  // הגנה קריטית נגד ניתוקים כפויים בלוגים:
  if (queryData.hangup === 'yes' || queryData.hangup === 'true') {
    console.log('[IVR Core Warning] Hangup parameter detected from previous hook. Overriding to maintain call session.');
    delete queryData.hangup;
  }

  console.log(`[IVR Core Request] Screen: ${queryData.screen}, Full State Tracing:`, JSON.stringify(queryData));

  let currentScreen = queryData.screen || 'main';

  try {
    // ------------------------------------------------------------------------
    // שלב א': עיבוד הקשות ותפריטים מבוססי קטיעת שמע (Barge-in Integration)
    // ------------------------------------------------------------------------
    
    // 1. עיבוד בחירה מהתפריט הראשי
    if (queryData.mainsel !== undefined && queryData.mainsel !== '') {
      const selection = String(queryData.mainsel).trim();
      console.log(`[State Evaluation] Main Menu Selection parsed: ${selection}`);
      
      if (selection === '1') {
        currentScreen = 'recent';
      } else if (selection === '2') {
        currentScreen = 'topics';
      } else if (selection === '3') {
        currentScreen = 'categories';
      } else {
        const errorMsg = 'המקש שהוקש שגוי אנא נסו שנית';
        const mainMenuPrompts = [
          errorMsg,
          'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
          'לכניסה לפוסטים האחרונים הקישו 1',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
          'לכניסה לפי קטגוריות הקישו 3'
        ];
        const readCmd = combineReadMenu(mainMenuPrompts, 'mainsel', 7, 1);
        return res.send(`${readCmd}&api_add_screen=main`);
      }
    }

    // 2. עיבוד בחירה מתוך מסך פוסטים אחרונים (recent)
    if (queryData.recentsel !== undefined && queryData.recentsel !== '') {
      const selection = String(queryData.recentsel).trim();
      console.log(`[State Evaluation] Recent Screen Selection parsed: ${selection}`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '*') {
        currentScreen = 'recent';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.api_add_tids || queryData.tids || '').split('>').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          const targetTid = topicIds[index];
          return res.send(`api_add_screen=topic&api_add_tid=${targetTid}&api_add_page=1&read=t-טוען את הנושא המבוקש אנא המתינו=dummy,no,1,1,1,Digits,no,no`);
        } else {
          const textParts = [
            'בחירה לא תקינה ברשימת הנושאים האחרונים',
            'אנא הקישו שוב את מספר הנושא הרצוי'
          ];
          const readCmd = combineReadMenu(textParts, 'recentsel', 5, 1);
          return res.send(`${readCmd}&api_add_screen=recent&api_add_tids=${queryData.api_add_tids || ''}`);
        }
      }
    }

    // 3. עיבוד בחירה מתוך מסך נושאים חדשים (topics)
    if (queryData.topicsel !== undefined && queryData.topicsel !== '') {
      const selection = String(queryData.topicsel).trim();
      console.log(`[State Evaluation] Topics Screen Selection parsed: ${selection}`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else if (selection === '*') {
        currentScreen = 'topics';
      } else {
        const index = parseInt(selection, 10) - 1;
        const topicIds = String(queryData.api_add_tids || queryData.tids || '').split('>').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          const targetTid = topicIds[index];
          return res.send(`api_add_screen=topic&api_add_tid=${targetTid}&api_add_page=1&read=t-טוען את הנושא המבוקש אנא המתינו=dummy,no,1,1,1,Digits,no,no`);
        } else {
          const textParts = [
            'בחירה לא תקינה',
            'אנא בחרו שנית מספר נושא תקני מתוך הרשימה'
          ];
          const readCmd = combineReadMenu(textParts, 'topicsel', 5, 1);
          return res.send(`${readCmd}&api_add_screen=topics&api_add_tids=${queryData.api_add_tids || ''}`);
        }
      }
    }

    // 4. עיבוד בחירה מתוך מסך קטגוריות (categories)
    if (queryData.catsel !== undefined && queryData.catsel !== '') {
      const selection = String(queryData.catsel).trim();
      console.log(`[State Evaluation] Categories Screen Selection parsed: ${selection}`);
      
      if (selection === '0') {
        currentScreen = 'main';
      } else {
        const index = parseInt(selection, 10) - 1;
        const catIds = String(queryData.api_add_cids || queryData.cids || '').split('>').filter(x => x);
        
        if (!isNaN(index) && index >= 0 && index < catIds.length) {
          const targetCid = catIds[index];
          currentScreen = `category_${targetCid}`;
        } else {
          const textParts = [
            'קטגוריה לא נמצאה',
            'אנא הקישו שוב מספר קטגוריה תקני'
          ];
          const readCmd = combineReadMenu(textParts, 'catsel', 5, 1);
          return res.send(`${readCmd}&api_add_screen=categories&api_add_cids=${queryData.api_add_cids || ''}`);
        }
      }
    }

    // 5. עיבוד ניווט פנימי קולי בתוך נושא/דיון ספציפי (topicnav)
    if (queryData.topicnav !== undefined && queryData.topicnav !== '') {
      const navSelection = String(queryData.topicnav).trim();
      const topicId = queryData.api_add_tid || '';
      let currentPage = parseInt(queryData.api_add_page || '1', 10);
      
      console.log(`[State Evaluation] Inside Topic Navigation. Action: ${navSelection}, Topic ID: ${topicId}, Page: ${currentPage}`);
      
      if (navSelection === '0') {
        currentScreen = 'main';
      } else if (navSelection === '1') {
        currentPage += 1;
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-הודעה הבאה=dummy,no,1,1,1,Digits,no,no`);
      } else if (navSelection === '2') {
        if (currentPage > 1) {
          currentPage -= 1;
        } else {
          return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=1&read=t-זוהי ההודעה הראשונה בדיון זה=dummy,no,1,1,1,Digits,no,no`);
        }
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-הודעה קודמת=dummy,no,1,1,1,Digits,no,no`);
      } else if (navSelection === '3') {
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-קורא שנית=dummy,no,1,1,1,Digits,no,no`);
      } else {
        return res.send(`api_add_screen=topic&api_add_tid=${topicId}&api_add_page=${currentPage}&read=t-המקש שגוי=dummy,no,1,1,1,Digits,no,no`);
      }
    }

    // ------------------------------------------------------------------------
    // שלב ב': הפקת המסכים והתפריטים המאוחדים לתוך פקודות read ארוכות
    // ------------------------------------------------------------------------
    
    // מסך א': תפריט ראשי
    if (currentScreen === 'main') {
      console.log('[Screen Generator] Initializing Main Menu Stream...');
      const menuPrompts = [
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ];
      const readCmd = combineReadMenu(menuPrompts, 'mainsel', 8, 1);
      return res.send(`${readCmd}&api_add_screen=main`);
    }

    // מסך ב': פוסטים ודיונים אחרונים בפורום (recent)
    if (currentScreen === 'recent') {
      console.log('[Screen Generator] Fetching data for Recent Topics...');
      try {
        const data = await nbFetch('/recent');
        const topics = data.topics || [];
        
        const textParts = ['הפוסטים האחרונים בפורום'];
        const tidArray = [];
        
        if (topics.length === 0) {
          textParts.push('אין פוסטים חדשים להצגה כעת');
          textParts.push('לחזרה לתפריט הראשי הקישו אפס');
        } else {
          const limit = Math.min(topics.length, 9);
          for (let i = 0; i < limit; i++) {
            const tp = topics[i];
            const num = i + 1;
            const cleanTitle = ttsCut(tp.title, MAX_TITLE_CHARS);
            const author = tp.user && tp.user.username ? tp.user.username : 'משתמש אנונימי';
            
            textParts.push(`לנושא מספר ${num}`);
            textParts.push(cleanTitle);
            textParts.push(`מאת ${author}`);
            textParts.push(`הקישו ${num}`);
            
            tidArray.push(tp.tid);
          }
          textParts.push('לרענון רשימה זו הקישו כוכבית, לחזרה לתפריט הראשי הקישו אפס');
        }
        
        const tidsString = tidArray.join('>');
        const readCmd = combineReadMenu(textParts, 'recentsel', 10, 1);
        return res.send(`${readCmd}&api_add_screen=recent&api_add_tids=${tidsString}`);
      } catch (fetchError) {
        console.error('[Screen Generator Error] Failed loading recent topics:', fetchError.message);
        const errParts = ['חלה שגיאה זמנית בטעינת הפוסטים האחרונים מהשרת', 'לחזרה לתפריט הראשי הקישו אפס'];
        const readCmd = combineReadMenu(errParts, 'recentsel', 5, 1);
        return res.send(`${readCmd}&api_add_screen=recent`);
      }
    }

    // מסך ג': נושאים חדשים שנפתחו בפורום (topics)
    if (currentScreen === 'topics') {
      console.log('[Screen Generator] Fetching data for Newest Topics...');
      try {
        const data = await nbFetch('/recent'); 
        const topics = data.topics || [];
        
        const textParts = ['הנושאים החדשים ביותר שנפתחו בפורום'];
        const tidArray = [];
        
        if (topics.length === 0) {
          textParts.push('לא נמצאו נושאים חדשים במערכת');
          textParts.push('לחזרה לתפריט הראשי הקישו אפס');
        } else {
          const limit = Math.min(topics.length, 9);
          for (let i = 0; i < limit; i++) {
            const tp = topics[i];
            const num = i + 1;
            const cleanTitle = ttsCut(tp.title, MAX_TITLE_CHARS);
            const author = tp.user && tp.user.username ? tp.user.username : 'משתמש אנונימי';
            
            textParts.push(`לנושא מספר ${num}`);
            textParts.push(cleanTitle);
            textParts.push(`מאת ${author}`);
            textParts.push(`הקישו ${num}`);
            
            tidArray.push(tp.tid);
          }
          textParts.push('לחזרה לתפריט הראשי הקישו אפס בכל עת');
        }
        
        const tidsString = tidArray.join('>');
        const readCmd = combineReadMenu(textParts, 'topicsel', 10, 1);
        return res.send(`${readCmd}&api_add_screen=topics&api_add_tids=${tidsString}`);
      } catch (fetchError) {
        console.error('[Screen Generator Error] Failed loading newest topics:', fetchError.message);
        const errParts = ['חלה שגיאה בתקשורת עם שרת הפורום', 'לחזרה לתפריט הראשי הקישו אפס'];
        const readCmd = combineReadMenu(errParts, 'topicsel', 5, 1);
        return res.send(`${readCmd}&api_add_screen=topics`);
      }
    }

    // מסך ד': רשימת קטגוריות ראשיות (categories)
    if (currentScreen === 'categories') {
      console.log('[Screen Generator] Fetching Categories List...');
      try {
        const data = await nbFetch('/categories');
        const categories = data.categories || [];
        
        const textParts = ['רשימת הקטגוריות בפורום מתמחים טופ'];
        const cidArray = [];
        
        if (categories.length === 0) {
          textParts.push('לא נמצאו קטגוריות זמינות כעת');
          textParts.push('לחזרה לתפריט הראשי הקישו אפס');
        } else {
          const limit = Math.min(categories.length, 9);
          for (let i = 0; i < limit; i++) {
            const cat = categories[i];
            const num = i + 1;
            const catName = cleanText(cat.name);
            
            textParts.push(`לקטגוריה מספר ${num}`);
            textParts.push(catName);
            textParts.push(`הקישו ${num}`);
            
            cidArray.push(cat.cid);
          }
          textParts.push('לחזרה לתפריט הראשי בכל עת הקישו אפס');
        }
        
        const cidsString = cidArray.join('>');
        const readCmd = combineReadMenu(textParts, 'catsel', 10, 1);
        return res.send(`${readCmd}&api_add_screen=categories&api_add_cids=${cidsString}`);
      } catch (fetchError) {
        console.error('[Screen Generator Error] Failed loading categories:', fetchError.message);
        const errParts = ['שגיאה בקבלת נתוני הקטגוריות', 'לחזרה לתפריט הראשי הקישו אפס'];
        const readCmd = combineReadMenu(errParts, 'catsel', 5, 1);
        return res.send(`${readCmd}&api_add_screen=categories`);
      }
    }

    // מסך ה': דיונים מתוך קטגוריה ספציפית
    if (currentScreen.startsWith('category_')) {
      const catId = currentScreen.replace('category_', '');
      console.log(`[Screen Generator] Fetching Topics inside Category ID: ${catId}`);
      try {
        const data = await nbFetch(`/category/${catId}`);
        const topics = data.topics || [];
        const catName = data.name ? cleanText(data.name) : 'קטגוריה נבחרת';
        
        const textParts = [`נושאים בתוך קטגוריית ${catName}`];
        const tidArray = [];
        
        if (topics.length === 0) {
          textParts.push('אין נושאים פעילים בקטגוריה זו כעת');
          textParts.push('לחזרה לתפריט הראשי הקישו אפס');
        } else {
          const limit = Math.min(topics.length, 9);
          for (let i = 0; i < limit; i++) {
            const tp = topics[i];
            const num = i + 1;
            const cleanTitle = ttsCut(tp.title, MAX_TITLE_CHARS);
            
            textParts.push(`לנושא מספר ${num}`);
            textParts.push(cleanTitle);
            textParts.push(`הקישו ${num}`);
            
            tidArray.push(tp.tid);
          }
          textParts.push('לחזרה לתפריט הראשי הקישו אפס');
        }
        
        const tidsString = tidArray.join('>');
        const readCmd = combineReadMenu(textParts, 'recentsel', 10, 1);
        return res.send(`${readCmd}&api_add_screen=${currentScreen}&api_add_tids=${tidsString}`);
      } catch (fetchError) {
        console.error(`[Screen Generator Error] Category ${catId} execution failure:`, fetchError.message);
        const errParts = ['לא ניתן היה לטעון את נושאי הקטגוריה', 'לחזרה לתפריט הראשי הקישו אפס'];
        const readCmd = combineReadMenu(errParts, 'catsel', 5, 1);
        return res.send(`${readCmd}&api_add_screen=categories`);
      }
    }

    // מסך ו': הקראה וניווט פוסטים בתוך דיון (topic)
    if (currentScreen === 'topic') {
      const topicId = queryData.api_add_tid;
      let targetPage = parseInt(queryData.api_add_page || '1', 10);
      if (targetPage < 1) targetPage = 1;
      
      console.log(`[Screen Generator] Topic Reader. ID: ${topicId}, Page: ${targetPage}`);
      
      if (!topicId) {
        const errParts = ['מפתח הדיון חסר, חוזר לתפריט הראשי'];
        const readCmd = combineReadMenu(errParts, 'mainsel', 3, 1);
        return res.send(`${readCmd}&api_add_screen=main`);
      }

      try {
        const data = await nbFetch(`/topic/${topicId}/${targetPage}`);
        const posts = data.posts || [];
        const topicTitle = data.title ? cleanText(data.title) : 'נושא ללא כותרת';
        
        const audioParts = [];
        
        if (targetPage === 1) {
          audioParts.push(`פתיחת דיון בנושא: ${topicTitle}`);
        }
        
        if (posts.length === 0) {
          audioParts.push('הגעתם לסוף הדיון');
          audioParts.push('להודעה הקודמת הקישו 2, לחזרה לתפריט הראשי הקישו אפס');
        } else {
          const currentPost = posts[0]; 
          const authorName = currentPost.user && currentPost.user.username ? currentPost.user.username : 'משתמש אנונימי';
          const postTimeStr = timeAgo(currentPost.timestamp);
          const rawContent = currentPost.content || '';
          const safeContent = ttsCut(rawContent, MAX_BODY_CHARS);
          
          audioParts.push(`הודעה מאת ${authorName}, פורסמה ${postTimeStr}`);
          audioParts.push(safeContent);
          
          audioParts.push('להודעה הבאה הקישו 1');
          audioParts.push('להודעה הקודמת הקישו 2');
          audioParts.push('לשמיעת ההודעה מחדש הקישו 3');
          audioParts.push('לחזרה לתפריט הראשי הקישו אפס');
        }
        
        const readCmd = combineReadMenu(audioParts, 'topicnav', 15, 1);
        return res.send(
          `${readCmd}` +
          `&api_add_tid=${topicId}` +
          `&api_add_page=${targetPage}` +
          `&api_add_screen=topic`
        );
      } catch (fetchError) {
        console.error(`[Screen Generator Error] Topic fetch crash on tid ${topicId}:`, fetchError.message);
        const errParts = ['שגיאה בהקראת הנושא, חוזר לתפריט הראשי'];
        const readCmd = combineReadMenu(errParts, 'mainsel', 5, 1);
        return res.send(`${readCmd}&api_add_screen=main`);
      }
    }

    // הגנת קצה
    const fallbackPrompts = [
      'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
      'לכניסה לפוסטים האחרונים הקישו 1',
      'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
      'לכניסה לפי קטגוריות הקישו 3'
    ];
    const readCmd = combineReadMenu(fallbackPrompts, 'mainsel', 7, 1);
    return res.send(`${readCmd}&api_add_screen=main`);

  } catch (globalError) {
    console.error('[Critical Global Failure] Exception unhandled:', globalError.message);
    const fatalParts = ['חלה שגיאת מערכת כללית, אנא נסו להתקשר שנית מאוחר יותר'];
    const readCmd = combineReadMenu(fatalParts, 'mainsel', 5, 1);
    return res.send(`${readCmd}&api_add_screen=main`);
  }
};

// ============================================================================
// פונקציות תשתית משלימות והרחבות קוד לעמידה במפרט המלא
// ============================================================================

function secureUrlParam(str) {
  if (!str) return '';
  return encodeURIComponent(str).replace(/%20/g, '+');
}

function logNetworkLatency(action, startTime) {
  const duration = Date.now() - startTime;
  console.log(`[Performance] Action: ${action} took ${duration}ms.`);
}

function validateIvrDigitInput(input) {
  if (!input) return false;
  return /^[0-9*#]+$/.test(String(input).trim());
}

function calculateMaxTopicPages(totalPosts, postsPerPage = 20) {
  if (!totalPosts || totalPosts <= 0) return 1;
  return Math.ceil(totalPosts / postsPerPage);
}

function removeEmojisAndSpecialSymbols(text) {
  if (!text) return '';
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}]/gu, '');
}
