// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ (NodeBB)
// נבנה עבור מערכות ה-IVR של ימות המשיח עם ארכיטקטורת תפריטים מהירה
// ============================================================================
// ארכיטקטורה: ניהול תפריטים פנימי מהיר המאפשר קטיעת שמע מלאה (Barge-in).
// מונע את השמעת הודעות "לאישור הקישו 1" ומאפשר הקשה תוך כדי דיבור.
// ============================================================================

import express from 'express';
import fetch from 'node-fetch';

const app = express();

// הגדרת משתני סביבה וקבועים גלובליים
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\\/+$/, '');
const MAX_TITLE_CHARS = 350;   // הגבלת אורך מקסימלי לכותרת נושא עבור TTS
const MAX_BODY_CHARS  = 980;   // הגבלת אורך מקסימלי לגוף הודעה עבור TTS כדי למנוע קריסה בשורות ארוכות
const DEFAULT_TIMEOUT = 8000;  // זמן המתנה מוגדר מראש לקריאות שרת במילישניות

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// פונקציות עזר לבניית הפרוטוקול של ימות המשיח (Yemot IVR Protocol Helpers)
// ============================================================================

/**
 * פונקציה הממירה מערך של מחרוזות טקסט או קבצים לפורמט id_list_message של ימות המשיח
 * @param {Array<string>} items - רשימת הודעות להשמעה (למשל תחילית t- לטקסט)
 * @returns {string} מחרוזת מפורמטת כהלכה עבור id_list_message
 */
function idList(items) {
    if (!items || !Array.isArray(items) || items.length === 0) return '';
    return `id_list_message=${items.join('.')}`;
}

/**
 * פונקציה חכמה המייצרת פקודת קריאה (Read Command) משולבת המונעת את ה-Confirm ("לאישור הקישו 1")
 * ומאפשרת קטיעת שמע (Barge-in) מיידית בזמן השמעת ה-id_list_message.
 * @param {string} valName - שם משתנה החזרה שישלח מהמערכת בבקשה הבאה
 * @param {number} maxDigits - כמות ספרות מקסימלית להקשה
 * @param {number} minDigits - כמות ספרות מינימלית להקשה
 * @param {string} secWait - זמן המתנה להקשה בסיום הדיבור
 * @returns {string} מחרוזת ה-read המבוקשת מושרשרת כהלכה
 */
function buildFastMenuRead(valName, maxDigits = 1, minDigits = 1, secWait = '7') {
    // פורמט המבנה: read=טקסט_ריק=שם_משתנה,נוסח_אישור,מינימום_ספרות,מקסימום_ספרות,זמן_המתנה,סוג_קלט,קטיעה_באמצע,השמעה_בזמן_הקשה
    // הגדרת 'no' בנוסח האישור מונעת את "לאישור הקישו 1".
    // הגדרת 'yes' בסוף מאפשרת קטיעה בזמן אמת של הדיבור.
    return `&read==${valName},no,${minDigits},${maxDigits},${secWait},Digits,yes,no`;
}

/**
 * ניקוי טקסטים המגיעים מהפורום (HTML/Markdown) והתאמתם להקראה נקייה במנוע ה-TTS של ימות המשיח
 * @param {string} text - הטקסט הגולמי מה-API של הפורום
 * @param {number} maxLength - הגבלת אורך אופציונלית לטקסט
 * @returns {string} טקסט נקי לחלוטין ללא תווים מיוחדים
 */
function cleanTextForTTS(text, maxLength = MAX_BODY_CHARS) {
    if (!text) return '';
    
    let clean = text
        .replace(/<[^>]*>/g, '') // הסרת תגיות HTML
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // הסרת לינקים של Markdown והשארת הטקסט שלהם
        .replace(/`{3}[\s\S]*?`{3}/g, '[קוד מחשב]') // החלפת בלוקים של קוד במילה סמנטית
        .replace(/`([^`]+)`/g, '$1') // הסרת קוד אינליין
        .replace(/[*_~#>-]/g, ' ') // הסרת סימני עיצוב של Markdown
        .replace(/[\r\n]+/g, ' . ') // החלפת ירידות שורה בנקודה להפסקת נשימה ב-TTS
        .replace(/["]/g, "'") // החלפת מרכאות כפולות במרכאות בודדות למניעת שבירת מחרוזות URL
        .replace(/[&^|]/g, ' '); // הסרת תווים מיוחדים שעלולים לשבש את הפרוטוקול של ימות המשיח

    if (clean.length > maxLength) {
        clean = clean.substring(0, maxLength) + '...';
    }
    return clean.trim();
}

/**
 * ביצוע בקשת HTTP מאובטחת מול ה-Read API של פורום NodeBB
 * @param {string} path - הנתיב הפנימי של הפורום
 * @returns {Promise<object|null>} תגובת ה-JSON מהפורום או נל במקרה של שגיאה
 */
async function fetchFromForum(path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${FORUM_URL}/api${cleanPath}`;
    
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mitmachim-IVR-Advanced-Gateway' }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.error(`[Forum Error] API returned status ${response.status} for path ${path}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        console.error(`[Network Error] Failed to fetch from forum path ${path}:`, err.message);
        return null;
    }
}

// ============================================================================
// נתיב ה-API המרכזי של השלוחה (Main API Entry Point)
// ============================================================================

app.all('/api', async (req, res) => {
    // מיזוג פרמטרים מ-GET ומ-POST לתמיכה בשתי שיטות השליחה של ימות המשיח
    const query = { ...req.query, ...req.body };
    
    // שליפת פרמטרי הזיהוי והניווט הנוכחיים מה-IVR
    const currentScreen = query.screen || 'main';
    const callerPhone = query.ApiPhone || '0000000000';
    
    console.log(`[Incoming Call Log] Screen: ${currentScreen}, Phone: ${callerPhone}, Query:`, JSON.stringify(query));

    try {
        // ניתוב מבוסס מסכים (State Machine Screen Router)
        switch (currentScreen) {
            case 'main':
                return await handleMainScreen(query, res);
            case 'recent':
                return await handleRecentScreen(query, res);
            case 'topics':
                return await handleTopicsScreen(query, res);
            case 'categories':
                return await handleCategoriesScreen(query, res);
            case 'category_view':
                return await handleCategoryViewScreen(query, res);
            case 'topic_view':
                return await handleTopicViewScreen(query, res);
            default:
                // הגנת קצה - חזרה לתפריט ראשי פנימי במקרה של מסך לא מוכר
                return sendFallbackRedirect(res, 'מצב מסך לא מוכר במערכת, חוזר לתפריט הראשי');
        }
    } catch (globalError) {
        console.error(`[Fatal Exception] Critical failure in main loop:`, globalError);
        return sendFallbackRedirect(res, 'חלה שגיאה כללית בעיבוד הנתונים, אנא נסו שנית מאוחר יותר');
    }
});

// ============================================================================
// מנהלי מסכים (Screen Controllers)
// ============================================================================

/**
 * מסך תפריט ראשי - מציג את הודעת הפתיחה החדשה ובחירת פעולה
 */
async function handleMainScreen(query, res) {
    const selection = query.mainsel;
    
    // אם אין בחירה - משמיעים את התפריט הראשי
    if (!selection) {
        const welcomeAudio = [
            't-ברוכים הבאים לפורום מתמחים טופ הטלפוני.',
            't-כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ.',
            't-לכניסה לפוסטים האחרונים הקישו 1 .',
            't-לשמיעת הנושאים החדשים ביותר שנפתחו הקישו 2 .',
            't-לכניסה לפי קטגוריות הפורום הקישו 3 .'
        ];
        
        const audioOutput = idList(welcomeAudio);
        const readCommand = buildFastMenuRead('mainsel', 1, 1, '7');
        
        return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
    }
    
    // עיבוד הבחירה בתפריט הראשי ומעבר מסך פנימי מהיר (Internal Redirect)
    switch (selection.trim()) {
        case '1':
            query.screen = 'recent';
            delete query.mainsel;
            return await handleRecentScreen(query, res);
        case '2':
            query.screen = 'topics';
            delete query.mainsel;
            return await handleTopicsScreen(query, res);
        case '3':
            query.screen = 'categories';
            delete query.mainsel;
            return await handleCategoriesScreen(query, res);
        default:
            // בחירה שגויה - משמיעים הודעת שגיאה קצרה וחוזרים לתפריט הראשי מיד
            const invalidAudio = idList(['t-המקש שהוקש שגוי.']);
            const readCommand = buildFastMenuRead('mainsel', 1, 1, '5');
            const welcomeAudio = '.t-לכניסה לפוסטים האחרונים הקישו 1.t-לשמיעת הנושאים החדשים הקישו 2.t-לכניסה לפי קטגוריות הקישו 3.';
            return res.send(`${invalidAudio}${welcomeAudio}${readCommand}&api_add_screen=main`);
    }
}

/**
 * מסך פוסטים אחרונים - מציג רשימה של הפוסטים האחרונים שנכתבו בפורום
 */
async function handleRecentScreen(query, res) {
    const selection = query.recentsel;
    
    // אם המשתמש הקיש 0 - נחזיר אותו מיד לתפריט הראשי פנימית ללא קריאת רשת
    if (selection === '0') {
        query.screen = 'main';
        delete query.recentsel;
        return await handleMainScreen(query, res);
    }
    
    // אם המשתמש הקיש כוכבית - נרענן את הרשימה (נמחק את הבחירה ונטען מחדש)
    if (selection === '*') {
        delete query.recentsel;
    }

    // אם אין בחירה של מספר פוסט מסוים, נשלוף את הרשימה מהפורום ונשמיע אותה
    if (!query.recentsel) {
        const data = await fetchFromForum('/recent');
        if (!data || !data.topics || data.topics.length === 0) {
            return sendFallbackRedirect(res, 'לא נמצאו פוסטים אחרונים בשרת.');
        }

        const audioParts = ['t-הפוסטים האחרונים בפורום.'];
        const topicIdsArray = [];

        // ניקח עד 9 פוסטים כדי להתאים למקשים 1-9 בשלט הטלפון
        const limitedTopics = data.topics.slice(0, 9);
        
        limitedTopics.forEach((topic, index) => {
            const displayIndex = index + 1;
            const cleanTitle = cleanTextForTTS(topic.title, MAX_TITLE_CHARS);
            const cleanAuthor = cleanTextForTTS(topic.user ? topic.user.username : 'משתמש אנונימי');
            
            audioParts.push(`t-לנושא מספר ${displayIndex} .`);
            audioParts.push(`t-${cleanTitle} .`);
            audioParts.push(`t-מאת ${cleanAuthor} .`);
            audioParts.push(`t-הקישו ${displayIndex} .`);
            
            topicIdsArray.push(topic.tid);
        });

        audioParts.push('t-לרענון רשימה זו הקישו כוכבית .');
        audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס בכל עת .');

        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('recentsel', 1, 1, '9');
        const tidsString = topicIdsArray.join('>');

        return res.send(`${audioOutput}${readCommand}&api_add_tids=${tidsString}&api_add_screen=recent`);
    }

    // עיבוד בחירת פוסט ספציפי מתוך הרשימה
    const selectedIndex = parseInt(selection) - 1;
    const passedTids = query.api_add_tids ? query.api_add_tids.split('>') : [];
    const targetTid = passedTids[selectedIndex];

    if (!targetTid) {
        // אם ההקשה מחוץ לטווח הנושאים שהושמעו
        const invalidAudio = idList(['t-הבחירה אינה קיימת ברשימה זו.']);
        const readCommand = buildFastMenuRead('recentsel', 1, 1, '6');
        return res.send(`${invalidAudio}&read=t-אנא הקישו בחירה שנית=${readCommand}&api_add_tids=${query.api_add_tids}&api_add_screen=recent`);
    }

    // הפניית המשתמש למסך קריאת הנושא הנבחר
    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    delete query.recentsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך נושאים חדשים ביותר - מציג את הנושאים החדשים שנפתחו
 */
async function handleTopicsScreen(query, res) {
    const selection = query.topicsel;

    if (selection === '0') {
        query.screen = 'main';
        delete query.topicsel;
        return await handleMainScreen(query, res);
    }

    if (!selection || selection === '*') {
        const data = await fetchFromForum('/recent'); // ב-NodeBB נושאים חדשים נשלפים לרוב מנתיב רשימת הנושאים או האחרונים
        if (!data || !data.topics || data.topics.length === 0) {
            return sendFallbackRedirect(res, 'לא נמצאו נושאים חדשים בשרת.');
        }

        const audioParts = ['t-הנושאים החדשים ביותר שנפתחו בפורום.'];
        const topicIdsArray = [];
        const limitedTopics = data.topics.slice(0, 9);

        limitedTopics.forEach((topic, index) => {
            const displayIndex = index + 1;
            const cleanTitle = cleanTextForTTS(topic.title, MAX_TITLE_CHARS);
            const cleanAuthor = cleanTextForTTS(topic.user ? topic.user.username : 'משתמש אנונימי');

            audioParts.push(`t-לנושא מספר ${displayIndex} .`);
            audioParts.push(`t-${cleanTitle} .`);
            audioParts.push(`t-מאת ${cleanAuthor} .`);
            audioParts.push(`t-הקישו ${displayIndex} .`);

            topicIdsArray.push(topic.tid);
        });

        audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס בכל עת .');

        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('topicsel', 1, 1, '9');
        const tidsString = topicIdsArray.join('>');

        return res.send(`${audioOutput}${readCommand}&api_add_tids=${tidsString}&api_add_screen=topics`);
    }

    const selectedIndex = parseInt(selection) - 1;
    const passedTids = query.api_add_tids ? query.api_add_tids.split('>') : [];
    const targetTid = passedTids[selectedIndex];

    if (!targetTid) {
        const invalidAudio = idList(['t-בחירה שגויה.']);
        const readCommand = buildFastMenuRead('topicsel', 1, 1, '6');
        return res.send(`${invalidAudio}&read=t-אנא נסו שנית=${readCommand}&api_add_tids=${query.api_add_tids}&api_add_screen=topics`);
    }

    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    delete query.topicsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך קטגוריות - השמעת רשימת הקטגוריות הראשיות של פורום מתמחים טופ
 */
async function handleCategoriesScreen(query, res) {
    const selection = query.catsel;

    if (selection === '0') {
        query.screen = 'main';
        delete query.catsel;
        return await handleMainScreen(query, res);
    }

    if (!selection) {
        const data = await fetchFromForum('/categories');
        if (!data || !data.categories || data.categories.length === 0) {
            return sendFallbackRedirect(res, 'לא ניתן לטעון את קטגוריות הפורום כעת.');
        }

        const audioParts = ['t-קטגוריות הפורום הראשיות.'];
        const catIdsArray = [];
        
        // סינון קטגוריות ריקות או מוסתרות ולקיחת עד 9 קטגוריות מובילות
        const validCategories = data.categories.filter(c => c && c.name).slice(0, 9);

        validCategories.forEach((cat, index) => {
            const displayIndex = index + 1;
            const cleanCatName = cleanTextForTTS(cat.name, 100);
            
            audioParts.push(`t-לקטגוריית ${cleanCatName} .`);
            audioParts.push(`t-הקישו ${displayIndex} .`);
            
            catIdsArray.push(cat.cid);
        });

        audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס .');

        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('catsel', 1, 1, '8');
        const cidsString = catIdsArray.join('>');

        return res.send(`${audioOutput}${readCommand}&api_add_cids=${cidsString}&api_add_screen=categories`);
    }

    const selectedIndex = parseInt(selection) - 1;
    const passedCids = query.api_add_cids ? query.api_add_cids.split('>') : [];
    const targetCid = passedCids[selectedIndex];

    if (!targetCid) {
        const invalidAudio = idList(['t-קטגוריה לא קיימת.']);
        const readCommand = buildFastMenuRead('catsel', 1, 1, '6');
        return res.send(`${invalidAudio}&read=t-אנא בחרו שנית=${readCommand}&api_add_cids=${query.api_add_cids}&api_add_screen=categories`);
    }

    // מעבר לצפייה בתוך קטגוריה ספציפית
    query.screen = 'category_view';
    query.api_add_cid = targetCid;
    query.api_add_page = '1';
    delete query.catsel;
    return await handleCategoryViewScreen(query, res);
}

/**
 * מסך תצוגת נושאים בתוך קטגוריה נבחרת
 */
async function handleCategoryViewScreen(query, res) {
    const selection = query.catviewsel;
    const currentCid = query.api_add_cid;
    const currentPage = query.api_add_page || '1';

    if (selection === '0') {
        query.screen = 'categories';
        delete query.catviewsel;
        return await handleCategoriesScreen(query, res);
    }

    if (!selection) {
        const data = await fetchFromForum(`/category/${currentCid}?page=${currentPage}`);
        if (!data || !data.topics || data.topics.length === 0) {
            return sendFallbackRedirect(res, 'לא נמצאו נושאים בתוך קטגוריה זו.');
        }

        const catName = cleanTextForTTS(data.name || 'הנבחרת');
        const audioParts = [`t-נושאים בקטגוריית ${catName}, עמוד ${currentPage} .`];
        const topicIdsArray = [];
        const limitedTopics = data.topics.slice(0, 9);

        limitedTopics.forEach((topic, index) => {
            const displayIndex = index + 1;
            const cleanTitle = cleanTextForTTS(topic.title, MAX_TITLE_CHARS);
            
            audioParts.push(`t-לנושא ${cleanTitle} .`);
            audioParts.push(`t-הקישו ${displayIndex} .`);
            
            topicIdsArray.push(topic.tid);
        });

        audioParts.push('t-לחזרה לרשימת הקטגוריות הקישו אפס .');

        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('catviewsel', 1, 1, '9');
        const tidsString = topicIdsArray.join('>');

        return res.send(`${audioOutput}${readCommand}&api_add_cid=${currentCid}&api_add_page=${currentPage}&api_add_tids=${tidsString}&api_add_screen=category_view`);
    }

    const selectedIndex = parseInt(selection) - 1;
    const passedTids = query.api_add_tids ? query.api_add_tids.split('>') : [];
    const targetTid = passedTids[selectedIndex];

    if (!targetTid) {
        const invalidAudio = idList(['t-בחירה שגויה ברשימה הקטגוריונית.']);
        const readCommand = buildFastMenuRead('catviewsel', 1, 1, '5');
        return res.send(`${invalidAudio}&read=t-נסו שנית=${readCommand}&api_add_cid=${currentCid}&api_add_page=${currentPage}&api_add_tids=${query.api_add_tids}&api_add_screen=category_view`);
    }

    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    delete query.catviewsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך הצגת פוסטים בתוך דיון (Topic View) - ניווט קולי מתקדם ומהיר בין ההודעות בדיון
 */
async function handleTopicViewScreen(query, res) {
    const selection = query.topicnav;
    const topicId = query.api_add_tid;
    let currentPage = parseInt(query.api_add_page || '1');
    let currentPostIndex = parseInt(query.api_add_post_idx || '0');

    // ניווט חזרה לתפריט הקודם (0)
    if (selection === '0') {
        query.screen = 'recent';
        delete query.topicnav;
        return await handleRecentScreen(query, res);
    }

    // שליפת המידע המלא של הדיון מהפורום
    const data = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
    if (!data || !data.posts || data.posts.length === 0) {
        return sendFallbackRedirect(res, 'לא ניתן לטעון את הפוסטים של נושא זה כעת.');
    }

    const posts = data.posts;
    const topicTitle = cleanTextForTTS(data.title || 'נושא דיון');

    // עיבוד פעולות משתמש מתוך תפריט הניווט הפנימי בדיון
    if (selection) {
        switch (selection.trim()) {
            case '1': // מעבר לפוסט הבא בדיון
                if (currentPostIndex < posts.length - 1) {
                    currentPostIndex++;
                } else {
                    // הגענו לסוף העמוד הנוכחי, ננסה לעבור לעמוד הבא בפורום אם יש
                    currentPage++;
                    const nextData = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
                    if (nextData && nextData.posts && nextData.posts.length > 0) {
                        currentPostIndex = 0;
                    } else {
                        currentPage--; // ביטול עליית עמוד בגלל שאין דפים נוספים
                        const endAudio = idList(['t-הגעתם לסוף הפוסטים בדיון זה.']);
                        const readCommand = buildFastMenuRead('topicnav', 1, 1, '6');
                        const navPrompt = '.t-להודעה הקודמת הקישו 2 . לחזרה לתפריט הקישו אפס .';
                        return res.send(`${endAudio}${navPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
                    }
                }
                break;

            case '2': // מעבר לפוסט הקודם בדיון
                if (currentPostIndex > 0) {
                    currentPostIndex--;
                } else if (currentPage > 1) {
                    // מעבר לעמוד הקודם בדיון
                    currentPage--;
                    const prevData = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
                    if (prevData && prevData.posts && prevData.posts.length > 0) {
                        currentPostIndex = prevData.posts.length - 1;
                    }
                } else {
                    const startAudio = idList(['t-הגעתם לתחילת הדיון.']);
                    const readCommand = buildFastMenuRead('topicnav', 1, 1, '6');
                    const navPrompt = '.t-להודעה הבאה הקישו 1 . לחזרה הקישו אפס .';
                    return res.send(`${startAudio}${navPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
                }
                break;

            case '3': // שמיעה מחודשת ומלאה של פרטי ההודעה והכותב
                // פשוט נשמיע את אותו המקום ללא שינוי אינדקסים
                break;

            default:
                const invalidAudio = idList(['t-מקש ניווט לא מוכר בדיון.']);
                const readCommand = buildFastMenuRead('topicnav', 1, 1, '5');
                const menuPrompt = '.t-להבא הקישו 1, לקודם 2, לחזרה 0.';
                return res.send(`${invalidAudio}${menuPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
        }
    }

    // שליפת הפוסט הספציפי והקראתו בצורה שקטיעה פעילה בה
    const activePost = posts[currentPostIndex];
    const postAuthor = cleanTextForTTS(activePost.user ? activePost.user.username : 'משתמש');
    const postBody = cleanTextForTTS(activePost.content, MAX_BODY_CHARS);
    const totalPostsInTopic = data.postcount || posts.length;

    const audioParts = [];
    if (currentPostIndex === 0 && currentPage === 1 && !selection) {
        audioParts.push(`t-פותח את הדיון בנושא: ${topicTitle} .`);
    }

    audioParts.push(`t-הודעה מספר ${activePost.index + 1} מתוך ${totalPostsInTopic} .`);
    audioParts.push(`t-נכתב על ידי ${postAuthor} .`);
    audioParts.push(`t-${postBody} .`);
    
    // הצגת תפריט ניווט קולי קצר וקליט המאפשר מעבר תוך כדי דיבור
    audioParts.push('t-להודעה הבאה הקישו 1 . לקודמת הקישו 2 . לשמיעה חוזרת הקישו 3 . לחזרה הקישו אפס .');

    const audioOutput = idList(audioParts);
    const readCommand = buildFastMenuRead('topicnav', 1, 1, '10');

    return res.send(
        `${audioOutput}${readCommand}` +
        `&api_add_tid=${topicId}` +
        `&api_add_page=${currentPage}` +
        `&api_add_post_idx=${currentPostIndex}` +
        `&api_add_screen=topic_view`
    );
}

/**
 * מנגנון הגנה וניתוב חזרה לתפריט הראשי במקרה של שגיאות קריטיות
 * @param {object} res Express Response Object
 * @param {string} msgText הודעת שגיאה שהמערכת תקריא למשתמש לפני הניתוב
 */
function sendFallbackRedirect(res, msgText) {
    console.warn(`[Fallback Triggered] Redirecting to main menu. Reason: ${msgText}`);
    const cleanMsg = cleanTextForTTS(msgText, 150);
    const audioOutput = idList([`t-${cleanMsg}`, 't-חוזר באופן אוטומטי לתפריט הראשי של המערכת .']);
    
    // מנתב מיד למסך המרכזי ומפעיל את קבלת המקשים של התפריט הראשי מחדש
    const readCommand = buildFastMenuRead('mainsel', 1, 1, '7');
    return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
}

// ============================================================================
// סביבת הרצה וניהול שרת לוקאלי או הפצה לענן
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[System Active] IVR Advanced Forum Gateway Engine running on port ${PORT}`);
    console.log(`[Target Forum Base] Connecting to API of: ${FORUM_URL}`);
});

export default app;
