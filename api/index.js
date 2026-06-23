// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם, מורחב ומאובטח עבור פורום מתמחים טופ (NodeBB)
// נבנה באופן בלעדי ומותאם אישית עבור מערכות ה-IVR של ימות המשיח
// 
// ארכיטקטורה: ניהול תפריטים פנימי מהיר ללא go_to_folder וללא "לאישור הקישו 1"
// תמיכה מלאה בקטיעת שמע (Barge-in) והקשה תוך כדי דיבור.
// 
// גרסה: 3.5.0 - מתוקנת ומורחבת (כולל מנגנון לכידת פרמטרים משודרג)
// ============================================================================

// ייבוא משתני סביבה והגדרות קבועים של המערכת
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS כדי למנוע קריסה בשורות ארוכות
const DEFAULT_TIMEOUT = 8000;  // זמן המתנה מוגדר מראש לקריאות שרת במילישניות

/**
 * פונקציה לביצוע בקשות HTTP בצורה בטוחה ומאובטחת מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיבי המערכת ומעבדת את תגובת ה-JSON.
 * כוללת טיפול מקיף בשגיאות רשת ומנגנון Timeout פנימי למניעת תקיעת שלוחות.
 * * @param {string} path - הנתיב הפנימי בפורום לקריאת ה-API
 * @returns {Promise<Object>} - אובייקט ה-JSON שהתקבל מהפורום
 */
async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;
  
  console.log(`[NodeBB Fetch] Initiating request to: ${url}`);
  const controller = new AbortController();
  const idTimeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-pro/3.5'
      },
      signal: controller.signal
    });
    
    clearTimeout(idTimeout);

    if (!res.ok) {
      throw new Error(`NodeBB HTTP Error Status: ${res.status} for path: ${path}`);
    }
    
    const jsonResult = await res.json();
    console.log(`[NodeBB Fetch Success] Data fetched successfully for path: ${path}`);
    return jsonResult;
  } catch (error) {
    clearTimeout(idTimeout);
    console.error(`[Fetch Exception] Path: ${path}, Message: ${error.message}`);
    throw error;
  }
}

/**
 * ניקוי HTML והפיכתו לטקסט נקי, קריא ורהוט המתאים באופן מושלם למנוע ההקראה (TTS).
 * מטפל בתגיות עיצוב, קוד, קישורים, תמונות, הדגשות וציטוטים נפוצים בפורום.
 * * @param {string} html - מחרוזת ה-HTML הגולמית מהפורום
 * @returns {string} - טקסט נקי ומפוסק להקראה
 */
function cleanText(html) {
  if (!html) return '';
  let t = String(html);
  
  // הסרת אלמנטים לא רלוונטיים להקראה קולית לחלוטין
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<code[\s\S]*?<\/code>/gi, ' [קוד מחשב קצר] ');
  
  // החלפת תגיות HTML נפוצות ברווחים או סימני פיסוק מתאימים להגייה נכונה
  t = t.replace(/<\/p>/gi, '. ');
  t = t.replace(/<br\s*\/?>/gi, '. ');
  t = t.replace(/<li>/gi, ' * ');
  t = t.replace(/<\/li>/gi, '. ');
  
  // הסרת כל שאר תגיות ה-HTML שנותרו במחרוזת
  t = t.replace(/<[^>]+>/g, ' ');
  
  // החלפת תווים מיוחדים וישויות HTML נפוצות
  t = t.replace(/&quot;/g, '"');
  t = t.replace(/&amp;/g, '&');
  t = t.replace(/&lt;/g, '<');
  t = t.replace(/&gt;/g, '>');
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/&apos;/g, "'");
  t = t.replace(/&#x27;/g, "'");
  t = t.replace(/&#x3D;/g, "=");
  
  // ניקוי רווחים כפולים, טאבים ושורות ריקות מיותרות
  t = t.replace(/\s+/g, ' ');
  
  return t.trim();
}

/**
 * פונקציית עזר המקבלת מערך של מחרוזות טקסט ומחזירה אותו בפורמט id_list_message תקין.
 * כל איבר במערך מקבל את הקידומת 't-' המורה למערכת להקריא אותו בטקסט לדיבור (TTS).
 * * @param {string[]} arr - מערך משפטים להקראה
 * @returns {string} - מחרוזת מפורמטת עבור ימות המשיח
 */
function idList(arr) {
  if (!arr || !arr.length) return '';
  return 'id_list_message=' + arr.map(x => 't-' + String(x).replace(/[|&=^]/g, ' ')).join('.');
}

/**
 * בנייה דינמית ומדויקת של פקודת ה-read עבור תפריטים מהירים (Barge-in).
 * * @param {string} varName - שם המשתנה שיחזור לשרת (לדוגמה mainsel, recentsel)
 * @param {number} maxDigits - כמות מקסימלית של ספרות להקשה
 * @param {string} allowedKeys - מקשים מותרים (ברירת מחדל 1-9, כוכבית ואפס)
 * @returns {string} - פקודת ה-read בפורמט של ימות המשיח
 */
function buildFastMenuRead(varName, maxDigits = 1, allowedKeys = '1,2,3,4,5,6,7,8,9,0,*') {
  // הפרמטרים לפי הסדר במערכת ה-API של ימות המשיח:
  // text_to_read -> ריק, כי הטקסט מושמע דרך ה-id_list_message בצורה חלקה ורציפה
  // return_variable -> שם המשתנה שיחזור בבקשה הבאה
  // barge_in -> 'yes' - קריטי! מאפשר למשתמש להקיש באמצע ההקראה ולקטוע אותה מיד
  // min_digits -> 1
  // max_digits -> כמות הספרות המקסימלית לקליטה
  // timeout -> זמן המתנה לסיום הקשה בשניות (7 שניות ברירת מחדל)
  // input_type -> Digits (ספרות בלבד)
  // confirm -> 'no' - מבטל לחלוטין את ההודעה המרגיזה "לאישור הקישו 1"
  // block_asterisk -> 'no' - מאפשר שימוש בכוכבית לניווט
  return `read==${varName},yes,1,${maxDigits},7,Digits,no,no`;
}

/**
 * פונקציה ראשית של הראוטר (Handler) המטפלת בכל הבקשות הנכנסות מה-IVR.
 * מנהלת את מצב המסך הנוכחי באמצעות משתנה הפנים `screen`.
 */
export default async function handler(req, res) {
  // הגדרת כותרות מענה ל-API בצורה ברורה
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  try {
    // איחוד פרמטרים מ-GET ומ-POST לצורך גמישות מלאה ומניעת אובדן משתנים
    const q = { ...req.query, ...req.body };
    
    // הדפסת לוג מפורט של הפרמטרים הנכנסים לצורך דיבאג עמוק בזמן אמת
    console.log(`[Incoming Request] Parameters: ${JSON.stringify(q)}`);

    // זיהוי המצב/מסך הנוכחי של המשתמש בתוך השלוחה הטלפונית
    const currentScreen = String(q.screen || q.api_add_screen || 'main');
    console.log(`[State Router] Current Screen Detected: ${currentScreen}`);

    // ========================================================================
    // מַסָךְ רָאשִׁי: תפריט הכניסה המרכזי של הפורום הטלפוני
    // ========================================================================
    if (currentScreen === 'main') {
      // תיקון קריטי: שליפת משתנה הבחירה מכל האפשרויות ששרת ימות המשיח עלול לשלוח
      const selection = String(q.mainsel || q.Data || q.data || '').trim();
      console.log(`[Main Screen Menu] Extracted Selection: "${selection}"`);

      // במידה והמשתמש טרם בחר אפשרות, נשמיע את הודעת הפתיחה המשודרגת והתפריט
      if (!selection || selection === 'timeout' || selection === 'null') {
        console.log(`[Main Screen Menu] No selection found. Rendering welcome instructions.`);
        const welcomeSpeech = [
          'ברוכים הבאים לפורום מתמחים טופ הטלפוני.',
          'כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ.',
          'לכניסה לפוסטים האחרונים הקישו 1.',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
          'לכניסה לפי קטגוריות הקישו 3.'
        ];

        const audioOutput = idList(welcomeSpeech);
        const readCommand = buildFastMenuRead('mainsel', 1);

        const responseString = `${audioOutput}&${readCommand}&api_add_screen=main`;
        console.log(`[Main Screen Menu Response] Sending: ${responseString}`);
        return res.send(responseString);
      }

      // ניתוח בחירת המשתמש בתפריט הראשי והעברה פנימית מהירה למסך הבא
      if (selection === '1') {
        console.log(`[Main Screen Menu] User selected 1. Routing to Recent Posts.`);
        return await renderRecentPosts(req, res, q, 0);
      } else if (selection === '2') {
        console.log(`[Main Screen Menu] User selected 2. Routing to New Topics.`);
        return await renderNewTopics(req, res, q, 0);
      } else if (selection === '3') {
        console.log(`[Main Screen Menu] User selected 3. Routing to Categories.`);
        return await renderCategories(req, res, q);
      } else {
        // בחירה שגויה - השמעת שגיאה קצרה וחזרה מיידית לתפריט הראשי ללא ניתוק השיחה
        console.log(`[Main Screen Menu] Invalid selection: "${selection}". Re-rendering main menu.`);
        const errorSpeech = idList(['המקש שהוקש שגוי, אנא נסו שנית.']);
        const welcomeSpeech = [
          'לכניסה לפוסטים האחרונים הקישו 1.',
          'לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
          'לכניסה לפי קטגוריות הקישו 3.'
        ];
        const audioOutput = idList(welcomeSpeech);
        const readCommand = buildFastMenuRead('mainsel', 1);
        return res.send(`${errorSpeech}.${audioOutput}&${readCommand}&api_add_screen=main`);
      }
    }

    // ========================================================================
    // מַסָךְ פוסטים אחרונים (הודעות אחרונות בפורום)
    // ========================================================================
    if (currentScreen === 'recent') {
      const selection = String(q.recentsel || q.Data || q.data || '').trim();
      const currentPage = parseInt(q.page || q.api_add_page || '0', 10);
      const tidsString = String(q.tids || q.api_add_tids || '');
      const tidsArray = tidsString.split('>').filter(x => x);

      console.log(`[Recent Posts Screen] Selection: "${selection}", Page: ${currentPage}, Total TIDs: ${tidsArray.length}`);

      if (!selection || selection === 'timeout' || selection === 'null') {
        return await renderRecentPosts(req, res, q, currentPage);
      }

      if (selection === '0') {
        console.log(`[Recent Posts Screen] Going back to main menu.`);
        return res.send('api_add_screen=main');
      }

      if (selection === '*') {
        console.log(`[Recent Posts Screen] Refreshing current list.`);
        return await renderRecentPosts(req, res, q, currentPage);
      }

      // מעבר לעמוד הבא של רשימת הפוסטים האחרונים
      if (selection === '99') {
        console.log(`[Recent Posts Screen] Moving to next page: ${currentPage + 1}`);
        return await renderRecentPosts(req, res, q, currentPage + 1);
      }

      // מעבר לעמוד הקודם של רשימת הפוסטים האחרונים
      if (selection === '88') {
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        console.log(`[Recent Posts Screen] Moving to previous page: ${prevPage}`);
        return await renderRecentPosts(req, res, q, prevPage);
      }

      // כניסה לשמיעת נושא ספציפי מתוך הרשימה המושמעת (1 עד 9)
      const index = parseInt(selection, 10) - 1;
      if (index >= 0 && index < tidsArray.length) {
        const selectedTopicId = tidsArray[index];
        console.log(`[Recent Posts Screen] Selected topic index ${index + 1}, Topic ID: ${selectedTopicId}`);
        return await renderTopicContent(req, res, selectedTopicId, 0);
      }

      // במקרה של הקשה לא מזוהה או מחוץ לטווח, נרענן את התפריט הנוכחי
      console.log(`[Recent Posts Screen] Unknown selection. Refreshing current view.`);
      return await renderRecentPosts(req, res, q, currentPage);
    }

    // ========================================================================
    // מַסָךְ נושאים חדשים (דיונים שנפתחו לאחרונה)
    // ========================================================================
    if (currentScreen === 'topics') {
      const selection = String(q.topicsel || q.Data || q.data || '').trim();
      const currentPage = parseInt(q.page || q.api_add_page || '0', 10);
      const tidsString = String(q.tids || q.api_add_tids || '');
      const tidsArray = tidsString.split('>').filter(x => x);

      console.log(`[New Topics Screen] Selection: "${selection}", Page: ${currentPage}`);

      if (!selection || selection === 'timeout' || selection === 'null') {
        return await renderNewTopics(req, res, q, currentPage);
      }

      if (selection === '0') {
        return res.send('api_add_screen=main');
      }

      if (selection === '*') {
        return await renderNewTopics(req, res, q, currentPage);
      }

      if (selection === '99') {
        return await renderNewTopics(req, res, q, currentPage + 1);
      }

      if (selection === '88') {
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        return await renderNewTopics(req, res, q, prevPage);
      }

      const index = parseInt(selection, 10) - 1;
      if (index >= 0 && index < tidsArray.length) {
        const selectedTopicId = tidsArray[index];
        console.log(`[New Topics Screen] Selected topic ID: ${selectedTopicId}`);
        return await renderTopicContent(req, res, selectedTopicId, 0);
      }

      return await renderNewTopics(req, res, q, currentPage);
    }

    // ========================================================================
    // מַסָךְ קטגוריות הפורום
    // ========================================================================
    if (currentScreen === 'categories') {
      const selection = String(q.catsel || q.Data || q.data || '').trim();
      const cidsString = String(q.cids || q.api_add_cids || '');
      const cidsArray = cidsString.split('>').filter(x => x);

      console.log(`[Categories Screen] Selection: "${selection}", Total CIDs: ${cidsArray.length}`);

      if (!selection || selection === 'timeout' || selection === 'null') {
        return await renderCategories(req, res, q);
      }

      if (selection === '0') {
        return res.send('api_add_screen=main');
      }

      const index = parseInt(selection, 10) - 1;
      if (index >= 0 && index < cidsArray.length) {
        const selectedCategoryId = cidsArray[index];
        console.log(`[Categories Screen] Entering Category ID: ${selectedCategoryId}`);
        return await renderCategoryTopics(req, res, selectedCategoryId, 0);
      }

      return await renderCategories(req, res, q);
    }

    // ========================================================================
    // מַסָךְ נושאים בתוך קטגוריה ספציפית
    // ========================================================================
    if (currentScreen === 'category_view') {
      const selection = String(q.catviewsel || q.Data || q.data || '').trim();
      const currentCategoryId = String(q.cid || q.api_add_cid || '');
      const currentPage = parseInt(q.page || q.api_add_page || '0', 10);
      const tidsString = String(q.tids || q.api_add_tids || '');
      const tidsArray = tidsString.split('>').filter(x => x);

      console.log(`[Category View Screen] Selection: "${selection}", Category ID: ${currentCategoryId}, Page: ${currentPage}`);

      if (!selection || selection === 'timeout' || selection === 'null') {
        return await renderCategoryTopics(req, res, currentCategoryId, currentPage);
      }

      if (selection === '0') {
        return await renderCategories(req, res, q);
      }

      if (selection === '99') {
        return await renderCategoryTopics(req, res, currentCategoryId, currentPage + 1);
      }

      if (selection === '88') {
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        return await renderCategoryTopics(req, res, currentCategoryId, prevPage);
      }

      const index = parseInt(selection, 10) - 1;
      if (index >= 0 && index < tidsArray.length) {
        const selectedTopicId = tidsArray[index];
        console.log(`[Category View Screen] Routing to Topic ID: ${selectedTopicId}`);
        return await renderTopicContent(req, res, selectedTopicId, 0);
      }

      return await renderCategoryTopics(req, res, currentCategoryId, currentPage);
    }

    // ========================================================================
    // מַסָךְ ניווט והשמעת פוסטים בתוך דיון (Topic)
    // ========================================================================
    if (currentScreen === 'topic') {
      const selection = String(q.topicnav || q.Data || q.data || '').trim();
      const topicId = String(q.tid || q.api_add_tid || '');
      const currentPage = parseInt(q.page || q.api_add_page || '0', 10);

      console.log(`[Topic Navigation Screen] Selection: "${selection}", Topic ID: ${topicId}, Current Page/Post Index: ${currentPage}`);

      if (!selection || selection === 'timeout' || selection === 'null') {
        return await renderTopicContent(req, res, topicId, currentPage);
      }

      if (selection === '0') {
        console.log(`[Topic Navigation Screen] Going back to main menu dynamically.`);
        return res.send('api_add_screen=main');
      }

      // הודעה הבאה (עמוד הבא בדיון)
      if (selection === '1') {
        console.log(`[Topic Navigation Screen] Next post -> index ${currentPage + 1}`);
        return await renderTopicContent(req, res, topicId, currentPage + 1);
      }

      // הודעה קודמת (עמוד קודם בדיון)
      if (selection === '2') {
        const prevPage = currentPage - 1 < 0 ? 0 : currentPage - 1;
        console.log(`[Topic Navigation Screen] Previous post -> index ${prevPage}`);
        return await renderTopicContent(req, res, topicId, prevPage);
      }

      // שמיעת פרטי ההודעה המלאים (תאריך, שם משתמש, דירוג וכד') ואז חזרה לאותו המקום
      if (selection === '3') {
        console.log(`[Topic Navigation Screen] Displaying full metadata details.`);
        const metadataString = decodeURIComponent(q.details || q.api_add_details || '');
        const metadataParts = metadataString.split('|').filter(x => x);
        
        const audioOutput = idList(metadataParts);
        const readCommand = buildFastMenuRead('detback', 1);
        
        return res.send(
          `${audioOutput}.${idList(['לחזרה לשמיעת גוף ההודעה הקישו מקש כלשהו.'])}&${readCommand}` +
          `&api_add_tid=${topicId}` +
          `&api_add_page=${currentPage}` +
          `&api_add_screen=detback`
        );
      }

      // ברירת מחדל במקרה של הקשה לא תקינה - המשך ניווט חופשי באותו פוסט
      console.log(`[Topic Navigation Screen] Invalid key. Refreshing current post view.`);
      return await renderTopicContent(req, res, topicId, currentPage);
    }

    // ========================================================================
    // מַסָךְ חזרה מפרטי הודעה (שכבת ביניים קלה)
    // ========================================================================
    if (currentScreen === 'detback') {
      const topicId = String(q.tid || q.api_add_tid || '');
      const currentPage = parseInt(q.page || q.api_add_page || '0', 10);
      console.log(`[Detail Back Screen] Returning instantly to topic content. Topic ID: ${topicId}, Page: ${currentPage}`);
      // מחזיר מיד להשמעת גוף הפוסט ללא עיכובים מיותרים
      return await renderTopicContent(req, res, topicId, currentPage);
    }

    // הגנת קצה - אם הגענו למצב של מסך לא מזוהה, נחזיר לתפריט הראשי פנימית
    console.warn(`[Fallback Guard] Unhandled screen state: "${currentScreen}". Redirecting to main menu.`);
    return res.send(`api_add_screen=main&read=t-טעות מערכת חוזר להתחלה=dummy,no,1,1,1,Digits,no,no`);

  } catch (globalError) {
    console.error(`[Global Critical Failure] ${globalError.stack || globalError.message}`);
    const systemFailureSpeech = idList([
      'מתנצלים, חלה שגיאת מערכת זמנית בתקשורת עם שרתי הפורום.',
      'אנא נסו שנית מאוחר יותר. תודה.'
    ]);
    return res.send(`${systemFailureSpeech}`);
  }
}

// ============================================================================
// פוּנְקְצִיּוֹת עֵזֶר לְרִנְדּוּר הַתַּפְרִיטִים וְהַנְּתוּנִים מֵהַפּוֹרוּם (API Core)
// ============================================================================

/**
 * משיכה מהשרת והשמעת רשימת הפוסטים האחרונים שנכתבו בפורום
 */
async function renderRecentPosts(req, res, q, page) {
  try {
    console.log(`[Render Recent] Fetching recent data for page index: ${page + 1}`);
    const data = await nbFetch(`/recent?page=${page + 1}`);
    const topics = data.topics || [];

    if (!topics || topics.length === 0) {
      console.log(`[Render Recent] Empty topic list received.`);
      const noDataSpeech = idList(['לא נמצאו פוסטים נוספים ברשימה זו. לחזרה הקישו אפס.']);
      const readCommand = buildFastMenuRead('recentsel', 1);
      return res.send(`${noDataSpeech}&${readCommand}&api_add_screen=recent&api_add_page=${page}`);
    }

    const audioParts = ['הפוסטים האחרונים בפורום.'];
    const tids = [];

    // הגבלה לעד 9 פוסטים לכל עמוד על מנת לאפשר הקשה נוחה במקשים 1-9 במערכת הטלפונית
    const displayCount = Math.min(topics.length, 9);
    for (let i = 0; i < displayCount; i++) {
      const t = topics[i];
      const indexSpeech = i + 1;
      const cleanTitle = cleanText(t.title).substring(0, MAX_TITLE_CHARS);
      const authorName = t.user ? cleanText(t.user.username) : 'משתמש אנונימי';
      
      audioParts.push(`לנושא מספר ${indexSpeech}.`);
      audioParts.push(`${cleanTitle}.`);
      audioParts.push(`מאת ${authorName}.`);
      audioParts.push(`הקישו ${indexSpeech}.`);
      
      tids.push(t.tid);
    }

    // הוספת אפשרויות דפדוף מתקדמות ואינטואיטיביות בתחתית הרשימה
    if (topics.length > 9) {
      audioParts.push('לעמוד הבא הקישו 99.');
    }
    if (page > 0) {
      audioParts.push('לעמוד הקודם הקישו 88.');
    }
    audioParts.push('לרענון רשימה זו הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס.');

    const audioOutput = idList(audioParts);
    // הגדרת כמות ספרות מקסימלית ל-2 (בשביל תמיכה ב-99 ו-88 במקרה הצורך)
    const readCommand = buildFastMenuRead('recentsel', 2);
    const tidsString = tids.join('>');

    const outStr = `${audioOutput}&${readCommand}&api_add_screen=recent&api_add_page=${page}&api_add_tids=${tidsString}`;
    console.log(`[Render Recent] Response ready. Character count: ${outStr.length}`);
    return res.send(outStr);

  } catch (err) {
    console.error(`[Render Recent Failure] ${err.message}`);
    return res.send(`id_list_message=t-שגיאה בטעינת פוסטים אחרונים.&api_add_screen=main`);
  }
}

/**
 * משיכה מהשרת והשמעת רשימת הנושאים החדשים ביותר שנפתחו בפורום
 */
async function renderNewTopics(req, res, q, page) {
  try {
    console.log(`[Render New Topics] Fetching newest topics for page: ${page + 1}`);
    const data = await nbFetch(`/recent?page=${page + 1}&sort=newest`);
    const topics = data.topics || [];

    if (!topics || topics.length === 0) {
      console.log(`[Render New Topics] No newer topics found.`);
      const noDataSpeech = idList(['לא נמצאו נושאים נוספים ברשימה זו. לחזרה הקישו אפס.']);
      const readCommand = buildFastMenuRead('topicsel', 1);
      return res.send(`${noDataSpeech}&${readCommand}&api_add_screen=topics&api_add_page=${page}`);
    }

    const audioParts = ['הנושאים החדשים ביותר שנפתחו בפורום.'];
    const tids = [];

    const displayCount = Math.min(topics.length, 9);
    for (let i = 0; i < displayCount; i++) {
      const t = topics[i];
      const indexSpeech = i + 1;
      const cleanTitle = cleanText(t.title).substring(0, MAX_TITLE_CHARS);
      const authorName = t.user ? cleanText(t.user.username) : 'משתמש אנונימי';

      audioParts.push(`לנושא מספר ${indexSpeech}.`);
      audioParts.push(`${cleanTitle}.`);
      audioParts.push(`מאת ${authorName}.`);
      audioParts.push(`הקישו ${indexSpeech}.`);

      tids.push(t.tid);
    }

    if (topics.length > 9) {
      audioParts.push('לעמוד הבא הקישו 99.');
    }
    if (page > 0) {
      audioParts.push('לעמוד הקודם הקישו 88.');
    }
    audioParts.push('לחזרה לתפריט הראשי הקישו אפס בכל עת.');

    const audioOutput = idList(audioParts);
    const readCommand = buildFastMenuRead('topicsel', 2);
    const tidsString = tids.join('>');

    return res.send(
      `${audioOutput}&${readCommand}` +
      `&api_add_screen=topics` +
      `&api_add_page=${page}` +
      `&api_add_tids=${tidsString}`
    );

  } catch (err) {
    console.error(`[Render New Topics Failure] ${err.message}`);
    return res.send(`id_list_message=t-שגיאה בטעינת נושאים חדשים.&api_add_screen=main`);
  }
}

/**
 * משיכה והשמעה של קטגוריות הפורום הראשיות
 */
async function renderCategories(req, res, q) {
  try {
    console.log(`[Render Categories] Fetching forum root categories list.`);
    const data = await nbFetch('/categories');
    const categories = data.categories || [];

    if (!categories || categories.length === 0) {
      console.log(`[Render Categories] Zero categories found.`);
      const noCatsSpeech = idList(['לא נמצאו קטגוריות בפורום. לחזרה הקישו אפס.']);
      const readCommand = buildFastMenuRead('catsel', 1);
      return res.send(`${noCatsSpeech}&${readCommand}&api_add_screen=main`);
    }

    const audioParts = ['רשימת קטגוריות ראשיות.'];
    const cids = [];

    const displayCount = Math.min(categories.length, 9);
    for (let i = 0; i < displayCount; i++) {
      const c = categories[i];
      const indexSpeech = i + 1;
      const catName = cleanText(c.name);

      audioParts.push(`לקטגוריית ${catName}, הקישו ${indexSpeech}.`);
      cids.push(c.cid);
    }
    audioParts.push('לחזרה לתפריט המרכזי הקישו אפס.');

    const audioOutput = idList(audioParts);
    const readCommand = buildFastMenuRead('catsel', 1);
    const cidsString = cids.join('>');

    return res.send(
      `${audioOutput}&${readCommand}` +
      `&api_add_screen=categories` +
      `&api_add_cids=${cidsString}`
    );

  } catch (err) {
    console.error(`[Render Categories Failure] ${err.message}`);
    return res.send(`id_list_message=t-שגיאה בטעינת קטגוריות.&api_add_screen=main`);
  }
}

/**
 * השמעת רשימת הנושאים הנמצאים בתוך קטגוריה נבחרת
 */
async function renderCategoryTopics(req, res, cid, page) {
  try {
    console.log(`[Render Category Topics] Fetching CID: ${cid}, Page: ${page + 1}`);
    const data = await nbFetch(`/category/${cid}?page=${page + 1}`);
    const categoryName = cleanText(data.name || 'הנבחרת');
    const topics = data.topics || [];

    if (!topics || topics.length === 0) {
      console.log(`[Render Category Topics] No topics available inside CID: ${cid}`);
      const noTopicsSpeech = idList([`לא נמצאו נושאים נוספים בקטגוריית ${categoryName}. לחזרה הקישו אפס.`]);
      const readCommand = buildFastMenuRead('catviewsel', 1);
      return res.send(`${noTopicsSpeech}&${readCommand}&api_add_screen=category_view&api_add_cid=${cid}&api_add_page=${page}`);
    }

    const audioParts = [`נושאים בקטגוריית ${categoryName}.`];
    const tids = [];

    const displayCount = Math.min(topics.length, 9);
    for (let i = 0; i < displayCount; i++) {
      const t = topics[i];
      const indexSpeech = i + 1;
      const cleanTitle = cleanText(t.title).substring(0, MAX_TITLE_CHARS);

      audioParts.push(`לנושא ${cleanTitle}, הקישו ${indexSpeech}.`);
      tids.push(t.tid);
    }

    if (topics.length > 9) {
      audioParts.push('לעמוד הבא הקישו 99.');
    }
    if (page > 0) {
      audioParts.push('לעמוד הקודם הקישו 88.');
    }
    audioParts.push('לחזרה לרשימת הקטגוריות הקישו אפס.');

    const audioOutput = idList(audioParts);
    const readCommand = buildFastMenuRead('catviewsel', 2);
    const tidsString = tids.join('>');

    return res.send(
      `${audioOutput}&${readCommand}` +
      `&api_add_screen=category_view` +
      `&api_add_cid=${cid}` +
      `&api_add_page=${page}` +
      `&api_add_tids=${tidsString}`
    );

  } catch (err) {
    console.error(`[Render Category Topics Failure] ${err.message}`);
    return res.send(`id_list_message=t-שגיאה בטעינת דיוני הקטגוריה.&api_add_screen=categories`);
  }
}

/**
 * השמעת תוכן פוסט (הודעה) ספציפי וניהול הניווט הפנימי בתוכו
 */
async function renderTopicContent(req, res, topicId, page) {
  try {
    console.log(`[Render Topic Content] Requesting topic data for ID: ${topicId}, post offset: ${page}`);
    const data = await nbFetch(`/topic/${topicId}?page=${page + 1}`);
    const topicTitle = cleanText(data.title || 'נושא כללי');
    const posts = data.posts || [];
    const currentPage = parseInt(data.pagination ? data.pagination.currentPage : (page + 1), 10) - 1;

    if (!posts || posts.length === 0) {
      console.log(`[Render Topic Content] End of topic reached for ID: ${topicId}`);
      const topicEndSpeech = idList([
        'הגעתם לסוף הדיון הנוכחי.',
        'להודעה הקודמת הקישו 2. לחזרה לתפריט הראשי הקישו אפס.'
      ]);
      const readCommand = buildFastMenuRead('topicnav', 1);
      return res.send(
        `${topicEndSpeech}&${readCommand}` +
        `&api_add_tid=${topicId}` +
        `&api_add_page=${currentPage}` +
        `&api_add_screen=topic`
      );
    }

    // ניקוי והכנת גוף הפוסט הראשון בעמוד להקראה קולית חלקה ללא תגיות
    const activePost = posts[0];
    const rawContent = activePost.content || '';
    const cleanBody = cleanText(rawContent).substring(0, MAX_BODY_CHARS);
    const posterName = activePost.user ? cleanText(activePost.user.username) : 'משתמש';

    const audioParts = [];
    
    // אם המשתמש נמצא בפוסט הראשון בדיון, נשמיע תחילה את כותרת הדיון הכללית להבנת ההקשר
    if (currentPage === 0) {
      audioParts.push(`דיון בנושא: ${topicTitle}.`);
    }

    audioParts.push(`הודעה מאת ${posterName}:`);
    audioParts.push(cleanBody ? cleanBody : '[הודעה ריקה או קובץ מצורף בלבד]');

    // הרכבת מטא-דאטה מורחב על הודעה זו למקרה שהמאזין יקיש 3 לקבלת פרטים
    const postDetailsArray = [
      `פרטי הודעה מלאים`,
      `שם הכותב הוא ${posterName}`
    ];
    
    if (activePost.timestampISO) {
      try {
        const dateObj = new Date(activePost.timestampISO);
        postDetailsArray.push(`פורסם בתאריך ${dateObj.getDate()} למספר ${dateObj.getMonth() + 1} שנת ${dateObj.getFullYear()}`);
      } catch (e) {
        // התעלמות שקטה משגיאות עיבוד תאריך לא קריטיות
      }
    }
    
    if (activePost.votes !== undefined) {
      postDetailsArray.push(`הודעה זו קיבלה ${activePost.votes} מוניטין חיובי.`);
    }
    postDetailsArray.push(`סך הכל ישנם ${data.postcount || posts.length} פוסטים בדיון זה.`);

    const audioOutput = idList(audioParts);
    
    // תפריט ניווט פנימי קולי מהיר ואינטואיטיבי בין פוסטים בדיון
    const navigationPrompt = idList([
      'להודעה הבאה הקישו 1.',
      'להודעה הקודמת הקישו 2.',
      'לשמיעת פרטי ההודעה המלאים הקישו 3.',
      'לחזרה לתפריט הראשי הקישו אפס.'
    ]);
    
    const readCommand = buildFastMenuRead('topicnav', 2);
    const metadataString = encodeURIComponent(postDetailsArray.join('|'));
    
    const finalResponse = `${audioOutput}.${navigationPrompt}&${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_screen=topic&api_add_details=${metadataString}`;
    console.log(`[Render Topic Content] Dispatched post content view.`);
    return res.send(finalResponse);

  } catch (err) {
    console.error(`[Render Topic Content Failure] ${err.message}`);
    return res.send(`id_list_message=t-שגיאה בטעינת תוכן הדיון.&api_add_screen=main`);
  }
}
