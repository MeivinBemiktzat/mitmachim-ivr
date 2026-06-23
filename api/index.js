// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ (NodeBB)
// נבנה באופן בלעדי עבור מערכות ה-IVR של ימות המשיח
// 
// ארכיטקטורה: ניהול תפריטים פנימי מהיר ללא go_to_folder וללא "לאישור הקישו 1"
// תמיכה מלאה בקטיעת שמע (Barge-in) והקשה תוך כדי דיבור.
// ============================================================================

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// משתני סביבה והגדרות קבועים
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS כדי למנוע קריסה בשורות ארוכות
const DEFAULT_TIMEOUT = 8000;  // זמן המתנה מוגדר מראש לקריאות שרת במילישניות

/**
 * פונקציה לביצוע בקשות HTTP בצורה בטוחה ומאובטחת מול ה-Read API של הפורום.
 * מוסיפה תמיד את הסיומת /api לנתיבי המערכת ומעבדת את תגובת ה-JSON.
 */
async function fetchFromForum(apiPath) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    
    // ניקוי נתיבים כפולים אם קיימים
    const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const targetUrl = `${FORUM_URL}/api${cleanPath}`;
    
    try {
        const response = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mitmachim-IVR-Gateway/2.0 (Node.js)'
            }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.error(`[Forum API Error] Status ${response.status} on path ${cleanPath}`);
            return null;
        }
        
        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[Forum Fetch Exception] Path: ${cleanPath}, Error:`, error.message);
        return null;
    }
}

/**
 * פונקציית עזר לניקוי טקסט עשיר וסימני HTML/Markdown כדי להתאים אותו בצורה מושלמת לרובוט TTS קולי.
 * מנקה תגיות HTML, קישורים, קוד, סמלים מיוחדים ורווחים כפולים.
 */
function cleanTextForTTS(rawText) {
    if (!rawText) return '';
    
    let text = String(rawText);
    
    // הסרת תגיות HTML קלאסיות
    text = text.replace(/<[^>]*>/g, ' ');
    
    // הסרת קישורי Markdown בלוקים [טקסט](קישור) -> משאיר רק את הטקסט
    text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    
    // הסרת בלוקים של קוד וציטוטים מורחבים
    text = text.replace(/```[\s\S]*?```/g, ' [קוד מחשב] ');
    text = text.replace(/`([^`]+)`/g, '$1');
    
    // החלפת תווים בעייתיים בימות המשיח המפריעים למחרוזות (כמו גרש, מרכאות וסימני אחוז)
    text = text.replace(/'/g, "''");
    text = text.replace(/"/g, "''");
    text = text.replace(/%/g, ' אחוז ');
    text = text.replace(/&/g, ' ו ');
    text = text.replace(/\^/g, ' ');
    text = text.replace(/\*/g, ' ');
    
    // החלפת קיצורים נפוצים להקראה חלקה יותר
    text = text.replace(/\bוואטסאפ\b/gi, 'ווצאפ');
    text = text.replace(/\bF21\b/gi, 'אף 21');
    text = text.replace(/\bQIN\b/gi, 'קין');
    text = text.replace(/\bS1\b/gi, 'אס 1');
    
    // צמצום רווחים כפולים ושורות חדשות
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;
}

/**
 * מחולל רשימת קבצים וטקסטים במבנה הרשמי של ימות המשיח (id_list_message)
 * מקבל מערך של מחרוזות או קבצים ומחזיר פורמט משורשר של t-Text או f-File
 */
function generateIdList(partsArray) {
    if (!partsArray || partsArray.length === 0) return '';
    return `id_list_message=${partsArray.join('.')}`;
}

/**
 * הלב של הארכיטקטורה המהירה - בניית פקודת ה-Read של ימות המשיח.
 * מגדיר את הפרמטר השני כ-'no' כדי למנוע את הודעת "לאישור הקישו 1".
 * מאפשר קטיעה מהירה תוך כדי דיבור (Barge-in).
 * * @param {string} variableName - שם המשתנה שיחזור בבקשה הבאה
 * @param {number} maxDigits - כמות ספרות מקסימלית להקשה (למשל 1 לתפריט, 9 לנושאים)
 * @param {number} timeout - זמן המתנה להקשה בשניות (דיפולט 7)
 */
function buildFastMenuRead(variableName, maxDigits = 1, timeout = 7) {
    // פורמט: read=הודעה=משתנה,אישור_הקשה,מקסימום_ספרות,מינימום_ספרות,זמן_המתנה,סוג_הקשה
    // הגדרת הודעה כריק ("") מכיוון שהתוכן כבר מושמע בתוך ה-id_list_message שקודם לו, מה שמאפשר קטיעה חלקה.
    return `read==${variableName},no,${maxDigits},1,${timeout},Digits,no,no`;
}

// ============================================================================
// נתיב ה-API המרכזי - מטפל בכל בקשות ה-IVR המגיעות מימות המשיח
// ============================================================================
app.all('/api', async (res, req) => {
    // תמיכה בשליפת פרמטרים גם מ-GET וגם מ-POST
    const query = { ...res.query, ...res.body };
    
    // שליפת נתוני השיחה הבסיסיים מימות המשיח
    const callId = query.ApiCallId || 'unknown';
    const phone = query.ApiPhone || 'unknown';
    const currentScreen = query.screen || 'main';
    
    console.log(`[Call ${callId}] Phone: ${phone} | Screen: ${currentScreen}`);

    try {
        // ====================================================================
        // מסך 1: תפריט ראשי (Main Menu)
        // ====================================================================
        if (currentScreen === 'main') {
            const userSelection = query.mainsel;
            
            // אם המשתמש עדיין לא בחר כלום, נשמיע את הודעת הפתיחה והתפריט הראשי
            if (!userSelection) {
                const welcomePrompts = [
                    't-ברוכים הבאים לפורום מתמחים טופ הטלפוני.',
                    't-כאן תוכלו להאזין לפוסטים והנושאים האחרונים שנוצרו בפורום מתמחים טופ.',
                    't-לכניסה לפוסטים האחרונים הקישו 1.',
                    't-לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
                    't-לכניסה לפי קטגוריות הפורום הקישו 3.'
                ];
                
                const audioOutput = generateIdList(welcomePrompts);
                const readCommand = buildFastMenuRead('mainsel', 1, 10);
                
                return req.send(`${audioOutput}&${readCommand}&api_add_screen=main`);
            }
            
            // עיבוד בחירת המשתמש מהתפריט הראשי
            switch (userSelection) {
                case '1': // מעבר לפוסטים אחרונים
                    return await renderRecentPostsScreen(req, query);
                case '2': // מעבר לנושאים חדשים
                    return await renderNewTopicsScreen(req, query);
                case '3': // מעבר לתפריט קטגוריות
                    return await renderCategoriesMenuScreen(req, query);
                default: // הקשה שגויה - רענון התפריט הראשי עם הודעת שגיאה קצרה
                    const errorPrompts = [
                        't-הקשה שגויה.',
                        't-לכניסה לפוסטים האחרונים הקישו 1.',
                        't-לשמיעת הנושאים האחרונים שנפתחו הקישו 2.',
                        't-לכניסה לפי קטגוריות הפורום הקישו 3.'
                    ];
                    return req.send(`${generateIdList(errorPrompts)}&${buildFastMenuRead('mainsel', 1, 8)}&api_add_screen=main`);
            }
        }

        // ====================================================================
        // מסך 2: פוסטים אחרונים (Recent Posts Menu)
        // ====================================================================
        if (currentScreen === 'recent') {
            const postSelection = query.recentsel;
            const savedTidsString = query.tids || '';
            
            if (!postSelection) {
                return await renderRecentPostsScreen(req, query);
            }
            
            // חזרה לתפריט ראשי
            if (postSelection === '0') {
                return req.send(`api_add_screen=main&mainsel=`);
            }
            
            // רענון הרשימה הנוכחית
            if (postSelection === '*') {
                return await renderRecentPostsScreen(req, query);
            }
            
            // כניסה לנושא ספציפי מתוך הרשימה על בסיס מפתח ה-TIDs השמור
            const tidsArray = savedTidsString.split('>');
            const index = parseInt(postSelection, 10) - 1;
            
            if (index >= 0 && index < tidsArray.length) {
                const targetTopicId = tidsArray[index];
                // העברה פנימית למסך האזנה לנושא
                return await renderTopicReaderScreen(req, targetTopicId, 1, 0);
            }
            
            // בחירה לא תקינה ברשימה
            const invalidListPrompts = [
                't-המספר שהוקש אינו ברשימה.',
                't-אנא נסו שנית או הקישו אפס לחזרה.'
            ];
            const readCommand = buildFastMenuRead('recentsel', 1, 7);
            return req.send(`${generateIdList(invalidListPrompts)}&${readCommand}&api_add_screen=recent&api_add_tids=${savedTidsString}`);
        }

        // ====================================================================
        // מסך 3: נושאים חדשים (New Topics Menu)
        // ====================================================================
        if (currentScreen === 'topics') {
            const topicSelection = query.topicsel;
            const savedTidsString = query.tids || '';
            
            if (!topicSelection) {
                return await renderNewTopicsScreen(req, query);
            }
            
            if (topicSelection === '0') {
                return req.send(`api_add_screen=main&mainsel=`);
            }
            
            if (topicSelection === '*') {
                return await renderNewTopicsScreen(req, query);
            }
            
            const tidsArray = savedTidsString.split('>');
            const index = parseInt(topicSelection, 10) - 1;
            
            if (index >= 0 && index < tidsArray.length) {
                const targetTopicId = tidsArray[index];
                return await renderTopicReaderScreen(req, targetTopicId, 1, 0);
            }
            
            const invalidPrompts = ['t-בחירה שגויה.', 't-אנא בחרו מספר מהרשימה או הקישו אפס.'];
            return req.send(`${generateIdList(invalidPrompts)}&${buildFastMenuRead('topicsel', 1, 7)}&api_add_screen=topics&api_add_tids=${savedTidsString}`);
        }

        // ====================================================================
        // מסך 4: קטגוריות ראשיות (Categories Menu)
        // ====================================================================
        if (currentScreen === 'categories') {
            const categorySelection = query.catsel;
            const savedCidsString = query.cids || '';
            
            if (!categorySelection) {
                return await renderCategoriesMenuScreen(req, query);
            }
            
            if (categorySelection === '0') {
                return req.send(`api_add_screen=main&mainsel=`);
            }
            
            const cidsArray = savedCidsString.split('>');
            const index = parseInt(categorySelection, 10) - 1;
            
            if (index >= 0 && index < cidsArray.length) {
                const targetCategoryId = cidsArray[index];
                // מעבר למסך רשימת נושאים בתוך הקטגוריה שנבחרה
                return await renderCategoryTopicsScreen(req, targetCategoryId, 1);
            }
            
            const invalidPrompts = ['t-קטגוריה לא קיימת.', 't-נסו שנית.'];
            return req.send(`${generateIdList(invalidPrompts)}&${buildFastMenuRead('catsel', 1, 7)}&api_add_screen=categories&api_add_cids=${savedCidsString}`);
        }

        // ====================================================================
        // מסך 5: רשימת נושאים בתוך קטגוריה (Category Topics List)
        // ====================================================================
        if (currentScreen === 'category_view') {
            const selection = query.cattopicsel;
            const currentCategoryId = query.cid_active;
            const currentPage = parseInt(query.page_active || '1', 10);
            const savedTidsString = query.tids || '';
            
            if (!selection) {
                return await renderCategoryTopicsScreen(req, currentCategoryId, currentPage);
            }
            
            if (selection === '0') {
                return req.send(`api_add_screen=categories&catsel=`);
            }
            
            // עמוד הבא בקטגוריה
            if (selection === '9') {
                return await renderCategoryTopicsScreen(req, currentCategoryId, currentPage + 1);
            }
            
            // עמוד קודם בקטגוריה
            if (selection === '7' && currentPage > 1) {
                return await renderCategoryTopicsScreen(req, currentCategoryId, currentPage - 1);
            }
            
            const tidsArray = savedTidsString.split('>');
            const index = parseInt(selection, 10) - 1;
            
            if (index >= 0 && index < tidsArray.length) {
                const targetTopicId = tidsArray[index];
                return await renderTopicReaderScreen(req, targetTopicId, 1, 0);
            }
            
            return await renderCategoryTopicsScreen(req, currentCategoryId, currentPage);
        }

        // ====================================================================
        // מסך 6: נגן והאזנה לפוסטים בתוך נושא (Topic Reader & Navigation)
        // ====================================================================
        if (currentScreen === 'topic') {
            const navigationDigit = query.topicnav;
            const topicId = query.api_add_tid;
            const currentPage = parseInt(query.api_add_page || '1', 10);
            const currentPostIndex = parseInt(query.api_add_pindex || '0', 10);
            
            if (!navigationDigit) {
                return await renderTopicReaderScreen(req, topicId, currentPage, currentPostIndex);
            }
            
            // חזרה לתפריט הקודם (כאן נחזיר לברירת המחדל - נושאים אחרונים)
            if (navigationDigit === '0') {
                return req.send(`api_add_screen=main&mainsel=`);
            }
            
            // מעבר לפוסט הבא בדיון
            if (navigationDigit === '1') {
                return await renderTopicReaderScreen(req, topicId, currentPage, currentPostIndex + 1);
            }
            
            // מעבר לפוסט הקודם בדיון
            if (navigationDigit === '2' && currentPostIndex > 0) {
                return await renderTopicReaderScreen(req, topicId, currentPage, currentPostIndex - 1);
            }
            
            // שמיעה חוזרת ומורחבת של פרטי הפוסט המלאים
            if (navigationDigit === '3') {
                return await renderTopicReaderScreen(req, topicId, currentPage, currentPostIndex, true);
            }
            
            // אם הוקש מקש לא נתמך, ננגן שוב את הפוסט הנוכחי
            return await renderTopicReaderScreen(req, topicId, currentPage, currentPostIndex);
        }

        // הגנת קצה - תפריט ראשי כברירת מחדל אולטימטיבית
        return req.send(`api_add_screen=main&mainsel=`);

    } catch (globalError) {
        console.error('[Global Emergency Fallback Error]:', globalError);
        const systemErrorAudio = generateIdList(['t-חלה שגיאה במערכת, אנא נסו שנית מאוחר יותר.']);
        return req.send(`${systemErrorAudio}&api_add_screen=main&mainsel=`);
    }
});

// ============================================================================
// פונקציות עזר עצמאיות לבניית ורינדור המסכים (Controllers)
// ============================================================================

/**
 * מאחזר ומציג את רשימת הפוסטים האחרונים בפורום
 */
async function renderRecentPostsScreen(res, query) {
    const data = await fetchFromForum('/recent');
    if (!data || !data.topics || data.topics.length === 0) {
        const noDataAudio = generateIdList(['t-לא ניתן למשוך פוסטים אחרונים כעת.', 't-חוזר לתפריט הראשי.']);
        return res.send(`${noDataAudio}&api_add_screen=main&mainsel=`);
    }

    const audioParts = ['t-הפוסטים האחרונים בפורום.'];
    const tidsArray = [];
    
    // ניקח מקסימום 9 נושאים כדי להתאים למקשים 1 עד 9 בשלט הטלפון
    const itemsCount = Math.min(data.topics.length, 9);
    for (let i = 0; i < itemsCount; i++) {
        const topic = data.topics[i];
        const indexNumber = i + 1;
        const cleanTitle = cleanTextForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
        const cleanAuthor = cleanTextForTTS(topic.user ? topic.user.username : 'מערכת');
        
        audioParts.push(`t-לנושא מספר ${indexNumber}.`);
        audioParts.push(`t-${cleanTitle}.`);
        audioParts.push(`t-מאת ${cleanAuthor}.`);
        audioParts.push(`t-הקישו ${indexNumber}.`);
        
        tidsArray.push(topic.tid);
    }
    
    audioParts.push('t-לרענון רשימה זו הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס בכל עת.');
    
    const audioOutput = generateIdList(audioParts);
    const readCommand = buildFastMenuRead('recentsel', 1, 9);
    const tidsString = tidsArray.join('>');
    
    return res.send(`${audioOutput}&${readCommand}&api_add_tids=${tidsString}&api_add_screen=recent`);
}

/**
 * מאחזר ומציג את רשימת הנושאים החדשים ביותר שנפתחו
 */
async function renderNewTopicsScreen(res, query) {
    // ב-NodeBB קבלת הנושאים החדשים מתבצעת לרוב על ידי פרמטר מיון או נתיב ייעודי
    const data = await fetchFromForum('/recent?sort=newest');
    if (!data || !data.topics || data.topics.length === 0) {
        const noDataAudio = generateIdList(['t-לא ניתן למשוך נושאים חדשים.', 't-חוזר לתפריט הראשי.']);
        return res.send(`${noDataAudio}&api_add_screen=main&mainsel=`);
    }

    const audioParts = ['t-הנושאים החדשים ביותר שנפתחו בפורום.'];
    const tidsArray = [];
    
    const itemsCount = Math.min(data.topics.length, 9);
    for (let i = 0; i < itemsCount; i++) {
        const topic = data.topics[i];
        const indexNumber = i + 1;
        const cleanTitle = cleanTextForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
        const cleanAuthor = cleanTextForTTS(topic.user ? topic.user.username : 'מערכת');
        
        audioParts.push(`t-לנושא מספר ${indexNumber}.`);
        audioParts.push(`t-${cleanTitle}.`);
        audioParts.push(`t-מאת ${cleanAuthor}.`);
        audioParts.push(`t-הקישו ${indexNumber}.`);
        
        tidsArray.push(topic.tid);
    }
    
    audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס בכל עת.');
    
    const audioOutput = generateIdList(audioParts);
    const readCommand = buildFastMenuRead('topicsel', 1, 9);
    const tidsString = tidsArray.join('>');
    
    return res.send(`${audioOutput}&${readCommand}&api_add_tids=${tidsString}&api_add_screen=topics`);
}

/**
 * מאחזר ומציג את רשימת הקטגוריות הראשיות של הפורום
 */
async function renderCategoriesMenuScreen(res, query) {
    const data = await fetchFromForum('/categories');
    if (!data || !data.categories || data.categories.length === 0) {
        const noDataAudio = generateIdList(['t-שירות קטגוריות אינו זמין כעת.']);
        return res.send(`${noDataAudio}&api_add_screen=main&mainsel=`);
    }

    const audioParts = ['t-קטגוריות הפורום הראשיות.'];
    const cidsArray = [];
    
    // סינון והצגה רק של קטגוריות אב רלוונטיות
    const rootCategories = data.categories.filter(c => !c.parentCid);
    const itemsCount = Math.min(rootCategories.length, 9);
    
    for (let i = 0; i < itemsCount; i++) {
        const category = rootCategories[i];
        const indexNumber = i + 1;
        const cleanName = cleanTextForTTS(category.name);
        
        audioParts.push(`t-לקטגוריית ${cleanName} הקישו ${indexNumber}.`);
        cidsArray.push(category.cid);
    }
    
    audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס.');
    
    const audioOutput = generateIdList(audioParts);
    const readCommand = buildFastMenuRead('catsel', 1, 9);
    const cidsString = cidsArray.join('>');
    
    return res.send(`${audioOutput}&${readCommand}&api_add_cids=${cidsString}&api_add_screen=categories`);
}

/**
 * מציג רשימת נושאים בתוך קטגוריה ספציפית כולל חלוקה לעמודים (דפדוף)
 */
async function renderCategoryTopicsScreen(res, cid, page = 1) {
    const data = await fetchFromForum(`/category/${cid}?page=${page}`);
    if (!data || !data.topics || data.topics.length === 0) {
        const errorAudio = generateIdList(['t-אין נושאים נוספים בקטגוריה זו.', 't-חוזר לתפריט הקטגוריות.']);
        return res.send(`${errorAudio}&api_add_screen=categories&catsel=`);
    }

    const categoryName = cleanTextForTTS(data.name || 'הנבחרת');
    const audioParts = [`t-נושאים בקטגוריית ${categoryName}. עמוד מספר ${page}.`];
    const tidsArray = [];
    
    // מציגים מקסימום 6 נושאים בכל עמוד כדי להשאיר מקשים לניווט דפדוף (7 ו-9)
    const itemsCount = Math.min(data.topics.length, 6);
    for (let i = 0; i < itemsCount; i++) {
        const topic = data.topics[i];
        const indexNumber = i + 1;
        const cleanTitle = cleanTextForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
        
        audioParts.push(`t-לנושא ${cleanTitle} הקישו ${indexNumber}.`);
        tidsArray.push(topic.tid);
    }
    
    // הוספת לחצני דפדוף קבועים
    audioParts.push('t-לעמוד הבא הקישו 9.');
    if (page > 1) {
        audioParts.push('t-לעמוד הקודם הקישו 7.');
    }
    audioParts.push('t-לחזרה לתפריט קטגוריות הקישו אפס.');
    
    const audioOutput = generateIdList(audioParts);
    const readCommand = buildFastMenuRead('cattopicsel', 1, 9);
    const tidsString = tidsArray.join('>');
    
    return res.send(
        `${audioOutput}&${readCommand}` +
        `&api_add_tids=${tidsString}` +
        `&api_add_screen=category_view` +
        `&api_add_cid_active=${cid}` +
        `&api_add_page_active=${page}`
    );
}

/**
 * מנגן קורא פוסטים אינטראקטיבי עבור נושא מסוים
 * תומך במעבר דינמי בין פוסטים ובמעבר עמודים אוטומטי במידת הצורך
 */
async function renderTopicReaderScreen(res, topicId, page = 1, postIndex = 0, forceDetailedView = false) {
    const data = await fetchFromForum(`/topic/${topicId}?page=${page}`);
    if (!data || !data.posts || data.posts.length === 0) {
        const errAudio = generateIdList(['t-לא ניתן לקרוא את הנושא המבוקש.', 't-חוזר לתפריט.']);
        return res.send(`${errAudio}&api_add_screen=main&mainsel=`);
    }

    const posts = data.posts;
    let currentPostIndex = postIndex;
    let currentPage = page;

    // טיפול במצב שבו הגענו לסוף הפוסטים בעמוד הנוכחי - בדיקת מעבר עמוד הבא
    if (currentPostIndex >= posts.length) {
        if (currentPage < data.pageCount) {
            currentPage += 1;
            currentPostIndex = 0;
            return await renderTopicReaderScreen(res, topicId, currentPage, currentPostIndex);
        } else {
            // הגענו לסוף הדיון לחלוטין
            const endOfTopicAudio = generateIdList([
                't-הגעתם לסוף ההודעות בדיון זה.',
                't-להאזנה מחדש להודעה האחרונה הקישו 2.',
                't-לחזרה לתפריט הראשי הקישו אפס.'
            ]);
            const readCommand = buildFastMenuRead('topicnav', 1, 8);
            return res.send(
                `${endOfTopicAudio}&${readCommand}` +
                `&api_add_tid=${topicId}` +
                `&api_add_page=${currentPage}` +
                `&api_add_pindex=${posts.length - 1}` +
                `&api_add_screen=topic`
            );
        }
    }

    const activePost = posts[currentPostIndex];
    const authorName = cleanTextForTTS(activePost.user ? activePost.user.username : 'משתמש פורום');
    const rawContent = activePost.content || '';
    const cleanContent = cleanTextForTTS(rawContent).substring(0, MAX_BODY_CHARS);
    const topicTitle = cleanTextForTTS(data.title || '');

    const audioParts = [];
    
    // רק בפוסט הראשון בהאזנה או בלחיצה על מידע מלא נשמיע את כותרת הנושא המלאה
    if (currentPostIndex === 0 && currentPage === 1 && !forceDetailedView) {
        audioParts.push(`t-אתם מאזינים לנושא: ${topicTitle}.`);
    }

    // קריינות פרטי הפוסט
    audioParts.push(`t-הודעה מספר ${activePost.index + 1}. מאת ${authorName}.`);
    audioParts.push(`t-${cleanContent}`);

    // יצירת מטא-דאטה קצר עבור תצוגה בלוגים של המערכת במידת הצורך
    const postDetailsArray = [];
    postDetailsArray.push(`סך הכל ישנם ${data.postcount || posts.length} פוסטים בדיון זה.`);

    const audioOutput = generateIdList(audioParts);
    
    // תפריט ניווט פנימי קולי מהיר בין פוסטים (Barge-in מופעל)
    const navigationPrompt = generateIdList([
        't-להודעה הבאה הקישו 1.',
        't-להודעה הקודמת הקישו 2.',
        't-לשמיעת פרטי ההודעה המלאים הקישו 3.',
        't-לחזרה לתפריט הראשי הקישו אפס.'
    ]).replace('id_list_message=', ''); // נשרשר אותו ל-id_list הקיים

    const readCommand = buildFastMenuRead('topicnav', 1, 15);
    const metadataString = encodeURIComponent(postDetailsArray.join('|'));
    
    return res.send(
        `${audioOutput}.${navigationPrompt}&${readCommand}` +
        `&api_add_tid=${topicId}` +
        `&api_add_page=${currentPage}` +
        `&api_add_pindex=${currentPostIndex}` +
        `&api_add_screen=topic` +
        `&api_add_details=${metadataString}`
    );
}

// ============================================================================
// האזנה של השרת בפורט המוגדר (עבור סביבות הרצה מקומיות או ענן חיצוני)
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[IVR Server Ready] Application running smoothly on port ${PORT}`);
});

export default app;
