// ============================================================================
// api/index.js
// מודול שער טלפוני (IVR Gateway) מורחב, מתקדם ומבוסס CommonJS
// מותאם במיוחד עבור פורום מתמחים טופ (NodeBB) ומערכות ימות המשיח.
// ============================================================================
// ארכיטקטורה: ניהול תפריטים פנימי מהיר המאפשר קטיעת שמע מלאה (Barge-in).
// מונע את השמעת הודעות "לאישור הקישו 1" ומאפשר הקשה תוך כדי דיבור.
// פותר באופן מלא את בעיית סנכרון ה-POST/GET מול מערכות ימות המשיח.
// ============================================================================

const express = require('express');

const app = express();

// הגדרת משתני סביבה וקבועים גלובליים של המערכת
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;       // הגבלת אורך מקסימלי לכותרת דיון
const MAX_BODY_CHARS = 980;        // הגבלת אורך מקסימלי לגוף הודעה (מניעת קריסות ב-TTS)
const DEFAULT_TIMEOUT = 12000;     // זמן המתנה מוגדר מראש לקריאות שרת במילישניות

// הפעלת מידלוורס לפענוח נתונים נכנסים (תמיכה מלאה ב-POST ו-URL Encoded)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// פונקציות עזר לבניית הפרוטוקול הטלפוני של ימות המשיח
// ============================================================================

/**
 * הופכת מערך של הודעות לחרוזת רצף של קבצי שמע או טקסט להקראה (TTS)
 * @param {Array<string>} items רשימת הודעות (למשל t-שלום או f-001)
 * @returns {string} חרוזת משורשרת בפורמט של ימות המשיח
 */
function idList(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `id_list_message=${items.join('..')}.`;
}

/**
 * בונה פקודת הקלט קולית מהירה (Read) בפורמט הנתמך ע"י ימות המשיח
 * פונקציה זו משתמשת בפורמט המדויק התואם למערכת הניתוב של ה-IVR שלכם.
 */
function buildFastMenuRead(varName, maxDigits = 1, minDigits = 1, timeout = '8') {
  return `&read==${varName},no,${minDigits},${maxDigits},${timeout},Digits,yes,no`;
}

/**
 * מנקה ומכין טקסט מהפורום להקראה קולית נקייה בטכנולוגיית TTS
 * מסירה קודי HTML, תגיות Markdown, קישורים, אמוג'ים ותווים מיוחדים הגורמים לקריסת ה-TTS.
 */
function cleanTextForTTS(rawText, maxLen = 950) {
  if (!rawText || typeof rawText !== 'string') return 'הודעה ריקה';

  let text = rawText;

  // 1. הסרת בלוקים של קוד שנכתבו בפורום (למשל קודי תכנות שלא שייך להקריא)
  text = text.replace(/```[\s\S]*?```/g, ' [קוד חסום] ');
  text = text.replace(/`[\s\S]*?`/g, ' ');

  // 2. הסרת תגיות HTML נפוצות בפורומי NodeBB
  text = text.replace(/<[^>]*>/g, ' ');

  // 3. הסרת קישורים ותמונות בפורמט Markdown
  text = text.replace(/!\[.*?\]\(.*?\)/g, ' [תמונה] ');
  text = text.replace(/\[.*?\]\(.*?\)/g, ' [קישור] ');

  // 4. הסרת סימני עיצוב של מארקדאון (הדגשות, כותרות, קו חוצה)
  text = text.replace(/[\*\_~#\-\+>=\[\]\(\)]/g, ' ');

  // 5. ניקוי רווחים כפולים, ירידות שורה וטאבים בשביל רצף דיבור חלק
  text = text.replace(/\s+/g, ' ').trim();

  // 6. חיתוך הטקסט לאורך המקסימלי המותר כדי למנוע חסימת קו הטלפון
  if (text.length > maxLen) {
    text = text.substring(0, maxLen) + '... המשך ההודעה ארוך מדי לשמיעה בטלפון.';
  }

  return text || 'הודעה ללא תוכן מילולי';
}

/**
 * מבצעת פנייה בטוחה ומאובטחת ל-Read API של פורום מתמחים טופ
 * כוללת הגדרות טיימאאוט ומנגנון הגנה מפני קריסות שרת חיצוני
 */
async function fetchFromForum(apiEndpoint) {
  const targetUrl = `${FORUM_URL}/api/${apiEndpoint.replace(/^\/+/, '')}`;
  console.log(`[HTTP Request] Fetching data from Forum: ${targetUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mitmachim-IVR-Gateway-Pro/2.5 (NodeJS/CommonJS)',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Forum server responded with HTTP status code: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Forum Fetch Error] Endpoint [${apiEndpoint}] failed:`, error.message);
    return null;
  }
}

// ============================================================================
// נתיב ה-API המרכזי של שלוחת ה-IVR
// תומך גם ב-GET וגם ב-POST ומבצע מיזוג פרמטרים מוחלט
// ============================================================================
const apiHandler = async (req, res) => {
  // פתרון באג ה-POST/GET: מאחדים את כל הפרמטרים הנכנסים תחת אובייקט אחד קבוע!
  const params = { ...req.query, ...req.body };

  console.log(`[Incoming Request] Method: ${req.method}, CallId: ${params.ApiCallId || 'Unknown'}`);
  console.log(`[State Tracker] Phone: ${params.ApiPhone || 'Private'}, Screen State: ${params.screen || 'main'}`);

  // בדיקת ניתוק שיחה מוקדם למניעת עיבוד מיותר בשרת
  if (params.hangup === 'yes') {
  console.log(`[Hangup Event] Call ${params.ApiCallId} terminated by user.`);
  return res.status(200).send('hangup=yes');
}

  const currentScreen = params.screen || 'main';

  try {
    // ניתוב מנוע ה-IVR לפי מצב המסך הנוכחי של השיחה
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
      default:
        console.warn(`[Routing Warning] Unidentified screen state requested: ${currentScreen}. Resetting.`);
        return sendFallbackRedirect(res, 'מצב מסך לא מזוהה במערכת.');
    }
  } catch (globalError) {
    console.error(`[Fatal System Error] Critical exception in root handler:`, globalError);
    return sendFallbackRedirect(res, 'שגיאה כללית זמנית במערכת הפורום הטלפוני.');
  }
};

// רישום נתיבי השרת עבור שתי שיטות השילוח האפשריות בימות המשיח
app.get('/api', apiHandler);
app.post('/api', apiHandler);
app.get('/', (req, res) => res.send('Mitmachim Top IVR Gateway Router is Online.'));

// ============================================================================
// מנועי המסכים ותפריטי הניווט הפנימיים
// ============================================================================

/**
 * מסך 1: תפריט ראשי של הפורום הטלפוני
 */
async function handleMainMenu(params, res) {
  // שליפת הבחירה של המשתמש מתוך האובייקט המאוחד (פותר את בעיית ה-POST)
  const selection = params.mainsel;

  if (selection) {
    console.log(`[Main Menu Selection] User selected menu option: ${selection}`);

    if (selection === '1') {
      // מעבר לרשימת נושאים אחרונים
      return res.redirect(`/api?screen=recent_topics&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (selection === '2') {
      // מעבר לרשימת נושאים שלא נקראו / פופולריים
      return res.redirect(`/api?screen=unread_topics&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (selection === '3') {
      // מעבר לרשימת קטגוריות
      return res.redirect(`/api?screen=categories_list&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else {
      // הקשה שגויה - משמיעים הודעת שגיאה ומקריאים את התפריט מחדש
      const audioParts = [
        't-המקש שהוקש שגוי .',
        't-לכניסה לפוסטים האחרונים הקישו 1 .',
        't-לשמיעת הנושאים החדשים ביותר הקישו 2 .',
        't-לכניסה לפי קטגוריות הפורום הקישו 3 .'
      ];
      const audioOutput = idList(audioParts);
      const readCommand = buildFastMenuRead('mainsel', 1, 1, '9');
      return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
    }
  }

  // מצב התחלתי: הקראת הודעת ברוכים הבאים והצגת אפשרויות בחירה
  const welcomeAudio = [
    't-ברוכים הבאים לפורום מתמחים טופ הטלפוני .',
    't-כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ באופליין .',
    't-לכניסה לפוסטים האחרונים הקישו 1 .',
    't-לשמיעת הנושאים החדשים ביותר שנפתחו הקישו 2 .',
    't-לכניסה לפי קטגוריות הפורום הקישו 3 .'
  ];

  const audioOutput = idList(welcomeAudio);
  const readCommand = buildFastMenuRead('mainsel', 1, 1, '10');

  // החזרת התגובה למערכת עם שמירה על המצב הנוכחי דרך api_add_screen
  return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
}

/**
 * מסך 2: רשימת נושאים אחרונים (Recent Topics) הכוללת דפדוף ועמודים
 */
async function handleRecentTopics(params, res) {
  const currentPage = parseInt(params.page || '1', 10);
  const topicSelection = params.topic_sel;

  // קריאת נתונים מהפורום
  const forumData = await fetchFromForum(`recent?page=${currentPage}`);
  if (!forumData || !forumData.topics || forumData.topics.length === 0) {
    return sendFallbackRedirect(res, 'לא הצלחנו לטעון נושאים אחרונים מהשרת.');
  }

  const topics = forumData.topics;

  // עיבוד בחירת המשתמש אם קיימת
  if (topicSelection) {
    console.log(`[Recent Topics Selection] Pressed key: ${topicSelection}`);
    
    if (topicSelection === '0') {
      // חזרה לתפריט הראשי
      return res.redirect(`/api?screen=main&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '7') {
      // עמוד הבא
      const nextPage = currentPage + 1;
      return res.redirect(`/api?screen=recent_topics&page=${nextPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '4' && currentPage > 1) {
      // עמוד קודם
      const prevPage = currentPage - 1;
      return res.redirect(`/api?screen=recent_topics&page=${prevPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else {
      // ניתוח בחירת מספר נושא מהרשימה (אינדקס מ-1 עד 5)
      const selectedIdx = parseInt(topicSelection, 10) - 1;
      if (selectedIdx >= 0 && selectedIdx < topics.length && selectedIdx < 5) {
        const targetTopic = topics[selectedIdx];
        console.log(`[Recent Topics] Going to Topic ID: ${targetTopic.tid}, Title: ${targetTopic.title}`);
        return res.redirect(`/api?screen=topic_view&tid=${targetTopic.tid}&post_idx=0&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else {
        // בחירה שגויה
        const errorAudio = idList(['t-בחירה לא תקפה ברשימת הנושאים. אנא נסו שנית.']);
        const readCommand = buildFastMenuRead('topic_sel', 1, 1, '8');
        return res.send(`${errorAudio}${readCommand}&api_add_screen=recent_topics&api_add_page=${currentPage}`);
      }
    }
  }

  // הפקת רשימת הנושאים להקראה (מקריאים עד 5 נושאים בכל עמוד למניעת עומס קולי)
  const audioParts = [`t-מציג נושאים אחרונים. עמוד ${currentPage} .`];
  const maxItemsToRead = Math.min(topics.length, 5);

  for (let i = 0; i < maxItemsToRead; i++) {
    const cleanTitle = cleanTextForTTS(topics[i].title, MAX_TITLE_CHARS);
    audioParts.push(`t-לנושא מספר ${i + 1} , ${cleanTitle} .`);
  }

  // הוספת הנחיות דפדוף וחזרה לתפריט
  if (topics.length > 5) {
    audioParts.push('t-לעמוד הבא הקישו 7 .');
  }
  if (currentPage > 1) {
    audioParts.push('t-לעמוד הקודם הקישו 4 .');
  }
  audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס .');

  const audioOutput = idList(audioParts);
  const readCommand = buildFastMenuRead('topic_sel', 1, 1, '12');

  return res.send(
    `${audioOutput}${readCommand}` +
    `&api_add_screen=recent_topics` +
    `&api_add_page=${currentPage}`
  );
}

/**
 * מסך 3: נושאים פופולריים או כאלו שלא נקראו (Unread Topics)
 */
async function handleUnreadTopics(params, res) {
  const currentPage = parseInt(params.page || '1', 10);
  const topicSelection = params.topic_sel;

  let forumData = await fetchFromForum(`unread?page=${currentPage}`);
  if (!forumData || !forumData.topics || forumData.topics.length === 0) {
    // פולבק במקרה והמשתמש מחובר כאורח ואין רשימת unread מותאמת אישית - נמשוך נושאים פופולריים
    console.log('[Unread Fallback] No unread topics found, pulling popular topics instead.');
    const popularData = await fetchFromForum('popular');
    if (!popularData || !popularData.topics) {
      return sendFallbackRedirect(res, 'לא נמצאו נושאים חדשים בפורום בשלב זה.');
    }
    forumData = popularData;
  }

  const topics = forumData.topics;

  if (topicSelection) {
    if (topicSelection === '0') {
      return res.redirect(`/api?screen=main&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '7') {
      const nextPage = currentPage + 1;
      return res.redirect(`/api?screen=unread_topics&page=${nextPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '4' && currentPage > 1) {
      const prevPage = currentPage - 1;
      return res.redirect(`/api?screen=unread_topics&page=${prevPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else {
      const selectedIdx = parseInt(topicSelection, 10) - 1;
      if (selectedIdx >= 0 && selectedIdx < topics.length && selectedIdx < 5) {
        const targetTopic = topics[selectedIdx];
        return res.redirect(`/api?screen=topic_view&tid=${targetTopic.tid}&post_idx=0&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else {
        const errorAudio = idList(['t-בחירה שגויה. אנא הקישו שוב מספר מהרשימה .']);
        const readCommand = buildFastMenuRead('topic_sel', 1, 1, '8');
        return res.send(`${errorAudio}${readCommand}&api_add_screen=unread_topics&api_add_page=${currentPage}`);
      }
    }
  }

  const audioParts = [`t-מציג נושאים חמים וחדשים בפורום .`];
  const maxItemsToRead = Math.min(topics.length, 5);

  for (let i = 0; i < maxItemsToRead; i++) {
    const cleanTitle = cleanTextForTTS(topics[i].title, MAX_TITLE_CHARS);
    audioParts.push(`t-לנושא מספר ${i + 1} , ${cleanTitle} .`);
  }

  if (topics.length > 5) audioParts.push('t-לעמוד הבא הקישו 7 .');
  if (currentPage > 1) audioParts.push('t-לעמוד הקודם הקישו 4 .');
  audioParts.push('t-לחזרה לתפריט הראשי של המערכת הקישו אפס .');

  const audioOutput = idList(audioParts);
  const readCommand = buildFastMenuRead('topic_sel', 1, 1, '12');

  return res.send(
    `${audioOutput}${readCommand}` +
    `&api_add_screen=unread_topics` +
    `&api_add_page=${currentPage}`
  );
}

/**
 * מסך 4: רשימת קטגוריות הפורום (Categories List)
 */
async function handleCategoriesList(params, res) {
  const catSelection = params.cat_sel;
  const forumData = await fetchFromForum('categories');

  if (!forumData || !forumData.categories || forumData.categories.length === 0) {
    return sendFallbackRedirect(res, 'לא הצלחנו לטעון את קטגוריות הפורום.');
  }

  // סינון קטגוריות ראשיות בלבד שאינן מוסתרות
  const categories = forumData.categories.filter(c => !c.disabled && (!c.parent || c.parentCid === 0));

  if (catSelection) {
    console.log(`[Categories Menu] Selected input: ${catSelection}`);
    if (catSelection === '0') {
      return res.redirect(`/api?screen=main&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    }

    const selectedIdx = parseInt(catSelection, 10) - 1;
    if (selectedIdx >= 0 && selectedIdx < categories.length && selectedIdx < 8) {
      const targetCategory = categories[selectedIdx];
      console.log(`[Category Matches] Selected Category CID: ${targetCategory.cid}`);
      return res.redirect(`/api?screen=category_view&cid=${targetCategory.cid}&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else {
      const errorAudio = idList(['t-מספר קטגוריה שגוי. אנא נסו שוב .']);
      const readCommand = buildFastMenuRead('cat_sel', 1, 1, '8');
      return res.send(`${errorAudio}${readCommand}&api_add_screen=categories_list`);
    }
  }

  const audioParts = ['t-רשימת הקטגוריות הראשיות בפורום מתמחים טופ .'];
  const maxCats = Math.min(categories.length, 8); // הגבלה ל-8 קטגוריות בתפריט הטלפון

  for (let i = 0; i < maxCats; i++) {
    const cleanCatName = cleanTextForTTS(categories[i].name, 150);
    audioParts.push(`t-לקטגוריית ${cleanCatName} הקישו ${i + 1} .`);
  }
  audioParts.push('t-לחזרה לתפריט הראשי בכל שלב הקישו אפס .');

  const audioOutput = idList(audioParts);
  const readCommand = buildFastMenuRead('cat_sel', 1, 1, '12');

  return res.send(`${audioOutput}${readCommand}&api_add_screen=categories_list`);
}

/**
 * מסך 5: הצגת נושאים בתוך קטגוריה ספציפית (Category View)
 */
async function handleCategoryView(params, res) {
  const cid = params.cid;
  const currentPage = parseInt(params.page || '1', 10);
  const topicSelection = params.topic_sel;

  if (!cid) return sendFallbackRedirect(res, 'מזהה קטגוריה חסר.');

  const forumData = await fetchFromForum(`category/${cid}?page=${currentPage}`);
  if (!forumData || !forumData.topics) {
    return sendFallbackRedirect(res, 'לא הצלחנו לשלוף נושאים מקטגוריה זו.');
  }

  const topics = forumData.topics;
  const categoryName = forumData.name || 'הנבחרת';

  if (topicSelection) {
    if (topicSelection === '0') {
      return res.redirect(`/api?screen=categories_list&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '7') {
      const nextPage = currentPage + 1;
      return res.redirect(`/api?screen=category_view&cid=${cid}&page=${nextPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (topicSelection === '4' && currentPage > 1) {
      const prevPage = currentPage - 1;
      return res.redirect(`/api?screen=category_view&cid=${cid}&page=${prevPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else {
      const selectedIdx = parseInt(topicSelection, 10) - 1;
      if (selectedIdx >= 0 && selectedIdx < topics.length && selectedIdx < 5) {
        const targetTopic = topics[selectedIdx];
        return res.redirect(`/api?screen=topic_view&tid=${targetTopic.tid}&post_idx=0&page=1&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else {
        const errorAudio = idList(['t-בחירה לא מורשית. אנא בחרו שוב מספר מהרשימה .']);
        const readCommand = buildFastMenuRead('topic_sel', 1, 1, '8');
        return res.send(`${errorAudio}${readCommand}&api_add_screen=category_view&api_add_cid=${cid}&api_add_page=${currentPage}`);
      }
    }
  }

  const audioParts = [`t-מציג דיונים בקטגוריית ${cleanTextForTTS(categoryName, 100)} . עמוד ${currentPage} .`];
  const maxItems = Math.min(topics.length, 5);

  for (let i = 0; i < maxItems; i++) {
    const cleanTitle = cleanTextForTTS(topics[i].title, MAX_TITLE_CHARS);
    audioParts.push(`t-לנושא מספר ${i + 1} , ${cleanTitle} .`);
  }

  if (topics.length > 5) audioParts.push('t-לעמוד הבא הקישו 7 .');
  if (currentPage > 1) audioParts.push('t-לעמוד הקודם הקישו 4 .');
  audioParts.push('t-לחזרה לרשימת הקטגוריות הקישו אפס .');

  const audioOutput = idList(audioParts);
  const readCommand = buildFastMenuRead('topic_sel', 1, 1, '12');

  return res.send(
    `${audioOutput}${readCommand}` +
    `&api_add_screen=category_view` +
    `&api_add_cid=${cid}` +
    `&api_add_page=${currentPage}`
  );
}

/**
 * מסך 6: האזנה לפוסטים והודעות בתוך דיון (Topic Post Viewer)
 * כולל מערכת ניווט קולי מלאה ואינטראקטיבית בין ההודעות בדיון
 */
async function handleTopicView(params, res) {
  const topicId = params.tid;
  const currentPostIndex = parseInt(params.post_idx || '0', 10);
  const currentPage = parseInt(params.page || '1', 10);
  const navCommand = params.post_nav;

  if (!topicId) return sendFallbackRedirect(res, 'מזהה דיון חסר במערכת.');

  // שליפת נתוני הדיון והפוסטים שבו מהפורום
  const forumData = await fetchFromForum(`topic/${topicId}?page=${currentPage}`);
  if (!forumData || !forumData.posts || forumData.posts.length === 0) {
    return sendFallbackRedirect(res, 'דיון זה ריק או שאינו זמין יותר בשרת.');
  }

  const posts = forumData.posts;
  const topicTitle = forumData.title || 'דיון כללי';

  // טיפול בפקודות ניווט מתוך ההקשה (1=הבא, 2=קודם, 3=שחזור, וכו')
  if (navCommand) {
    console.log(`[Topic Navigation] Post Index: ${currentPostIndex}, Command Key: ${navCommand}`);

    if (navCommand === '0') {
      // חזרה לתפריט הראשי
      return res.redirect(`/api?screen=main&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (navCommand === '1') {
      // הודעה הבאה בדיון
      if (currentPostIndex + 1 < posts.length) {
        const nextIdx = currentPostIndex + 1;
        return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=${nextIdx}&page=${currentPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else {
        // אם נגמרו הפוסטים בעמוד הנוכחי, נבדוק אם יש עמוד הבא בפורום
        if (forumData.pagination && forumData.pagination.next && forumData.pagination.next.page) {
          const nextPage = forumData.pagination.next.page;
          return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=0&page=${nextPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
        } else {
          // סוף הדיון לחלוטין
          const endAudio = idList(['t-הגעתם לסוף ההודעות בדיון זה. חוזרים לרשימת הנושאים האחרונים.']);
          return res.send(`${endAudio}api_add_screen=recent_topics&page=1`);
        }
      }
    } else if (navCommand === '2') {
      // הודעה קודמת בדיון
      if (currentPostIndex > 0) {
        const prevIdx = currentPostIndex - 1;
        return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=${prevIdx}&page=${currentPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else if (currentPage > 1) {
        // מעבר לעמוד הקודם בדיון, ומיקום המאזין על הפוסט האחרון שבו
        const prevPage = currentPage - 1;
        return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=19&page=${prevPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
      } else {
        const boundaryAudio = idList(['t-זהו הפוסט הראשון בדיון זה. אין הודעות קודמות .']);
        const readCommand = buildFastMenuRead('post_nav', 1, 1, '8');
        return res.send(`${boundaryAudio}${readCommand}&api_add_screen=topic_view&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}`);
      }
    } else if (navCommand === '3') {
      // שמיעה חוזרת של הפוסט הנוכחי
      return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=${currentPostIndex}&page=${currentPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (navCommand === '4') {
      // קפיצה מהירה 5 פוסטים קדימה
      const jumpForward = Math.min(posts.length - 1, currentPostIndex + 5);
      return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=${jumpForward}&page=${currentPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (navCommand === '5') {
      // קפיצה מהירה 5 פוסטים אחורה
      const jumpBackward = Math.max(0, currentPostIndex - 5);
      return res.redirect(`/api?screen=topic_view&tid=${topicId}&post_idx=${jumpBackward}&page=${currentPage}&ApiCallId=${params.ApiCallId}&ApiPhone=${params.ApiPhone}`);
    } else if (navCommand === '6') {
      // הקראת פרטי כותב ההודעה ותאריך הפרסום
      const currentPost = posts[currentPostIndex];
      const authorName = currentPost.user ? (currentPost.user.username || 'משתמש פורום') : 'משתמש פורום';
      const infoAudio = idList([`t-הודעה זו נכתבה על ידי ${cleanTextForTTS(authorName, 80)} .`]);
      const readCommand = buildFastMenuRead('post_nav', 1, 1, '8');
      return res.send(`${infoAudio}${readCommand}&api_add_screen=topic_view&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}`);
    } else {
      const errorAudio = idList(['t-מקש ניווט לא מוכר. הקישו 1 להודעה הבאה או 2 לקודמת .']);
      const readCommand = buildFastMenuRead('post_nav', 1, 1, '8');
      return res.send(`${errorAudio}${readCommand}&api_add_screen=topic_view&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}`);
    }
  }

  // הגנה על גבולות אינדקס פוסטים נכנס
  let safePostIndex = currentPostIndex;
  if (safePostIndex >= posts.length) safePostIndex = posts.length - 1;

  const currentPost = posts[safePostIndex];
  const authorName = currentPost.user ? (currentPost.user.username || 'משתמש') : 'משתמש';
  const cleanBody = cleanTextForTTS(currentPost.content, MAX_BODY_CHARS);

  const audioParts = [];
  
  // אם זה הפוסט הראשון שהמשתמש שומע בדיון, נקריא לו קודם את כותרת הנושא במלואה
  if (safePostIndex === 0 && currentPage === 1) {
    audioParts.push(`t-מאזין לנושא: ${cleanTextForTTS(topicTitle, MAX_TITLE_CHARS)} .`);
  }

  // הקראת תוכן ההודעה הנוכחית ומספרה בדיון
  audioParts.push(`t-הודעה מספר ${safePostIndex + 1 + (currentPage - 1) * 20} , מאת ${cleanTextForTTS(authorName, 60)} .`);
  audioParts.push(`t-${cleanBody}`);
  
  // תפריט ניווט מהיר מובנה שמוקרא כחלק מהטקסט ומאפשר קטיעה מיידית (Barge-in קולי)
  audioParts.push('t-להודעה הבאה הקישו 1 . לקודמת הקישו 2 . לשמיעה חוזרת הקישו 3 . לפרטי הכותב הקישו 6 . לחזרה הקישו אפס .');

  const audioOutput = idList(audioParts);
  const readCommand = buildFastMenuRead('post_nav', 1, 1, '12');

  return res.send(
    `${audioOutput}${readCommand}` +
    `&api_add_tid=${topicId}` +
    `&api_add_page=${currentPage}` +
    `&api_add_post_idx=${safePostIndex}` +
    `&api_add_screen=topic_view`
  );
}

/**
 * מנגנון הגנה וניתוב חזרה לתפריט הראשי במקרה של שגיאות קריטיות (Fallback Safety Handler)
 * מונע מצב של שיחות מנותקות או דממה מוחלטת בטלפון במקרה של בעיות תקשורת
 */
function sendFallbackRedirect(res, msgText) {
  console.warn(`[Fallback Core Triggered] Reason: ${msgText}`);
  const cleanMsg = cleanTextForTTS(msgText, 150);
  
  const audioOutput = idList([
    `t-${cleanMsg}`, 
    't-המערכת נתקלה בקושי תקשורת , חוזרים כעת באופן אוטומטי לתפריט הראשי של הפורום הטלפוני .'
  ]);
  
  // הפעלה מחדש של משתני התפריט הראשי להחזרת המחייג למסלול בטוח
  const readCommand = buildFastMenuRead('mainsel', 1, 1, '8');
  return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
}

// ============================================================================
// סביבת הרצה וניהול שרת מקומי / ענן
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`============================================================================`);
  console.log(`[Production Server Running] Mitmachim Top IVR API is listening on port ${PORT}`);
  console.log(`[Architecture] CommonJS Gateway Setup Configured Successfully.`);
  console.log(`============================================================================`);
});

module.exports = app;
