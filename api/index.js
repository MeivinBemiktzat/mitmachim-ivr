// ============================================================================
// api/index.js
// מודול שער טלפוני (IVR Gateway) מורחב, מתקדם ומבוסס CommonJS
// מותאם במיוחד עבור פורום מתמחים טופ (NodeBB) ומערכות ימות המשיח.
// ============================================================================
// קובץ זה נכתב בארכיטקטורת CommonJS (require) כדי למנוע שגיאות טעינה
// בסביבות שרתים מבוזרים (כגון Vercel Serverless Functions).
// המערכת מממשת תפריטים מהירים עם תמיכה מלאה בקטיעת שמע (Barge-in)
// ללא השמעת הודעות ברירת מחדל מעצבנות כגון "לאישור הקישו 1".
// ============================================================================

const express = require('express');
const https = require('https');

const app = express();

// הגדרת משתני סביבה וקבועים גלובליים של המערכת
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;       // הגבלת אורך מקסימלי לכותרת דיון
const MAX_BODY_CHARS = 980;        // הגבלת אורך מקסימלי לגוף הודעה (מניעת קריסות ב-TTS)
const DEFAULT_TIMEOUT = 12000;     // זמן המתנה מוגדר מראש לקריאות שרת במילישניות (12 שניות)
const MAX_ITEMS_PER_PAGE = 9;      // מקסימום פריטים להשמעה בתפריט (כדי להתאים למקשים 1-9)

// הגדרות Middleware לטיפול בבקשות נכנסות
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// לוג מובנה לבדיקת תקינות עליית השרת
console.log(`[System Boot] IVR Gateway Engine initialized successfully.`);
console.log(`[System Boot] Base Forum Target set to: ${FORUM_URL}`);

// ============================================================================
// פונקציות עזר לבניית הפרוטוקול של ימות המשיח (Yemot IVR Core Helpers)
// ============================================================================

/**
 * המרת מערך של מחרוזות טקסט או קבצים לפורמט id_list_message של ימות המשיח.
 * @param {Array<string>} items - רשימת הודעות להשמעה (למשל תחילית t- לטקסט).
 * @returns {string} מחרוזת מפורמטת כהלכה עבור id_list_message.
 */
function idList(items) {
    if (!items || !Array.isArray(items) || items.length === 0) {
        return 'id_list_message=';
    }
    return `id_list_message=${items.join('.')}`;
}

/**
 * פונקציה חכמה המייצרת פקודת קריאה (Read Command) משולבת המשורשרת לפלט.
 * מונעת לחלוטין את ה-Confirm ("לאישור הקישו 1") ומאפשרת קטיעה (Barge-in).
 * @param {string} valName - שם משתנה החזרה שישלח מהמערכת בבקשה הבאה.
 * @param {number} maxDigits - כמות ספרות מקסימלית להקשה.
 * @param {number} minDigits - כמות ספרות מינימלית להקשה.
 * @param {string} secWait - זמן המתנה להקשה בסיום הדיבור (בשניות).
 * @returns {string} מחרוזת ה-read המבוקשת מושרשרת כהלכה בפרוטוקול ימות המשיח.
 */
function buildFastMenuRead(valName, maxDigits = 1, minDigits = 1, secWait = '7') {
    // פורמט המבנה: read==שם_משתנה,נוסח_אישור,מינימום,מקסימום,המתנה,סוג,קטיעה,השמעה_בזמן_הקשה
    // הגדרת 'no' בנוסח האישור מונעת את "לאישור הקישו 1".
    // הגדרת 'yes' מאפשרת קטיעה מיידית של הדיבור בזמן אמת.
    return `&read==${valName},no,${minDigits},${maxDigits},${secWait},Digits,yes,no`;
}

/**
 * ניקוי טקסטים ותווים מיוחדים המגיעים מהפורום והתאמתם להקראה נקייה במנוע ה-TTS.
 * @param {string} text - הטקסט הגולמי (HTML / Markdown).
 * @param {number} maxLength - הגבלת אורך אופציונלית לטקסט.
 * @returns {string} טקסט נקי לחלוטין ללא תגיות, סימנים או תווים שוברים.
 */
function cleanTextForTTS(text, maxLength = MAX_BODY_CHARS) {
    if (!text) return '';
    
    let clean = text
        .replace(/<[^>]*>/g, '') // הסרת תגיות HTML
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // הסרת קישורי Markdown והשארת טקסט המקור
        .replace(/`{3}[\s\S]*?`{3}/g, ' [בלוק קוד מחשב] ') // החלפת בלוקים גדולים של קוד
        .replace(/`([^`]+)`/g, '$1') // הסרת קוד שורה בודדת
        .replace(/[*_~#>-]/g, ' ') // הסרת סימני עיצוב מיוחדים של Markdown
        .replace(/[\r\n]+/g, ' . ') // החלפת ירידות שורה בנקודות לעצירת נשימה נכונה ברובוט
        .replace(/["]/g, "'") // מניעת שבירת מחרוזות URL על ידי החלפת מרכאות כפולות בבודדות
        .replace(/[&^|]/g, ' ') // הסרת תווים השוברים את הפרוטוקול של ימות המשיח
        .replace(/\s+/g, ' '); // ניקוי רווחים כפולים

    if (clean.length > maxLength) {
        clean = clean.substring(0, maxLength) + '...';
    }
    return clean.trim();
}

/**
 * מנוע פנימי עצמאי מבוסס קור-נוד לביצוע בקשות HTTP/S מאובטחות מול הפורום.
 * מונע שגיאות של חוסר בספריות חיצוניות בענן.
 * @param {string} path - הנתיב הפנימי של הפורום (למשל /recent).
 * @returns {Promise<object|null>} תגובת ה-JSON המלאה מהפורום או null במקרה של תקלה.
 */
function fetchFromForum(path) {
    return new Promise((resolve) => {
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        const url = `${FORUM_URL}/api${cleanPath}`;
        
        console.log(`[Forum Request] Core Native GET to: ${url}`);
        
        const options = {
            headers: {
                'User-Agent': 'Mitmachim-IVR-Native-Core-Gateway/2.5',
                'Accept': 'application/json'
            },
            timeout: DEFAULT_TIMEOUT
        };

        const req = https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                console.error(`[Forum Error Response] Native API returned status code ${res.statusCode} for path ${path}`);
                return resolve(null);
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    resolve(parsedData);
                } catch (e) {
                    console.error(`[JSON Parse Error] Failed to decode API payload from path ${path}:`, e.message);
                    resolve(null);
                }
            });
        });

        req.on('error', (err) => {
            console.error(`[Network Exception] Core Client failure on path ${path}:`, err.message);
            resolve(null);
        });

        req.on('timeout', () => {
            console.error(`[Network Timeout] API Request exceeded maximum threshold of ${DEFAULT_TIMEOUT}ms on path ${path}`);
            req.destroy();
            resolve(null);
        });
    });
}

// ============================================================================
// נתיב ה-API המרכזי של השלוחה (Main Routing Loop)
// ============================================================================

app.all('/api', async (req, res) => {
    // מיזוג פרמטרים מכל סוגי הבקשות (GET/POST) לתמיכה רחבה במערכות IVR היסטוריות וחדשות
    const query = { ...req.query, ...req.body };
    
    // שליפת משתני המצב והניווט
    const currentScreen = query.screen || 'main';
    const callerPhone = query.ApiPhone || '0000000000';
    const callId = query.ApiCallId || 'unknown_call';
    
    console.log(`[Incoming Context] Call: ${callId}, Phone: ${callerPhone}, Screen State: ${currentScreen}`);

    try {
        // ניתוב מצבים מבוסס מסכים (State Machine Pattern)
        if (currentScreen === 'main') {
            return await handleMainScreen(query, res);
        } else if (currentScreen === 'recent') {
            return await handleRecentScreen(query, res);
        } else if (currentScreen === 'topics') {
            return await handleTopicsScreen(query, res);
        } else if (currentScreen === 'categories') {
            return await handleCategoriesScreen(query, res);
        } else if (currentScreen === 'category_view') {
            return await handleCategoryViewScreen(query, res);
        } else if (currentScreen === 'topic_view') {
            return await handleTopicViewScreen(query, res);
        } else {
            console.warn(`[Routing Warning] Detected unknown screen: ${currentScreen}. Enforcing fallback redirection.`);
            return sendFallbackRedirect(res, 'מצב מסך פנימי לא מזוהה במערכת.');
        }
    } catch (globalError) {
        console.error(`[Fatal System Crash] Unhandled exception in main routing loop:`, globalError);
        return sendFallbackRedirect(res, 'חלה שגיאה פנימית קריטית בתהליך עיבוד הנתונים.');
    }
});

// ============================================================================
// מנהלי מסכים ותפריטים (Screen Controllers)
// ============================================================================

/**
 * מסך תפריט ראשי - מציג את הודעת הפתיחה החדשה ובחירת פעולה בצורה קטועה ומהירה
 */
async function handleMainScreen(query, res) {
    const selection = query.mainsel;
    
    // אם אין בחירה (כניסה ראשונית לשלוחה) - משמיעים את הפתיח החדש ומחכים למקש
    if (!selection) {
        const welcomeAudio = [
            't-ברוכים הבאים לפורום מתמחים טופ הטלפוני .',
            't-כאן תוכלו להאזין לפוסטים והנושאים שנוצרו בפורום מתמחים טופ .',
            't-לכניסה לפוסטים האחרונים הקישו 1 .',
            't-לשמיעת הנושאים החדשים ביותר שנפתחו הקישו 2 .',
            't-לכניסה לפי קטגוריות הפורום הקישו 3 .'
        ];
        
        const audioOutput = idList(welcomeAudio);
        const readCommand = buildFastMenuRead('mainsel', 1, 1, '8');
        
        return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
    }
    
    // עיבוד הבחירה וניתוב פנימי ללא ניתוק שיחה או העברות תיקייה
    const cleanSelection = selection.trim();
    if (cleanSelection === '1') {
        query.screen = 'recent';
        delete query.mainsel;
        return await handleRecentScreen(query, res);
    } else if (cleanSelection === '2') {
        query.screen = 'topics';
        delete query.mainsel;
        return await handleTopicsScreen(query, res);
    } else if (cleanSelection === '3') {
        query.screen = 'categories';
        delete query.mainsel;
        return await handleCategoriesScreen(query, res);
    } else {
        // בחירה שגויה בתפריט הראשי - השמעת הודעה קצרה והחזרה לתפריט
        const invalidAudio = idList([
            't-המקש שהוקש אינו תקין .',
            't-לכניסה לפוסטים האחרונים הקישו 1 .',
            't-לשמיעת הנושאים החדשים ביותר שנפתחו הקישו 2 .',
            't-לכניסה לפי קטגוריות הפורום הקישו 3 .'
        ]);
        const readCommand = buildFastMenuRead('mainsel', 1, 1, '8');
        return res.send(`${invalidAudio}${readCommand}&api_add_screen=main`);
    }
}

/**
 * מסך פוסטים אחרונים - מציג את רשימת הפוסטים האחרונים שנכתבו בפורום
 */
async function handleRecentScreen(query, res) {
    const selection = query.recentsel;
    
    // ניווט מהיר לאחור בלחיצה על 0
    if (selection === '0') {
        query.screen = 'main';
        delete query.recentsel;
        return await handleMainScreen(query, res);
    }
    
    // רענון הרשימה בלחיצה על כוכבית
    if (selection === '*') {
        delete query.recentsel;
    }

    // אם המשתמש טרם בחר פוסט, נשלוף ונשמיע את הרשימה הנוכחית
    if (!query.recentsel) {
        const data = await fetchFromForum('/recent');
        if (!data || !data.topics || data.topics.length === 0) {
            return sendFallbackRedirect(res, 'לא נמצאו פוסטים אחרונים במערכת כעת.');
        }

        const audioParts = ['t-הפוסטים האחרונים בפורום .'];
        const topicIdsArray = [];
        
        // הגבלה לעד 9 פריטים שיתאימו למקשים 1 עד 9
        const limitedTopics = data.topics.slice(0, MAX_ITEMS_PER_PAGE);
        
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
        audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס .');

        const audioOutput = idList(audioParts);
        const readCommand = buildFastMenuRead('recentsel', 1, 1, '9');
        const tidsString = topicIdsArray.join('>');

        return res.send(`${audioOutput}${readCommand}&api_add_tids=${tidsString}&api_add_screen=recent`);
    }

    // עיבוד הבחירה של פוסט ספציפי מהרשימה
    const selectedIndex = parseInt(selection) - 1;
    const passedTids = query.api_add_tids ? query.api_add_tids.split('>') : [];
    const targetTid = passedTids[selectedIndex];

    if (!targetTid) {
        const invalidAudio = idList(['t-המספר שהוקש אינו מופיע ברשימה .']);
        const readCommand = buildFastMenuRead('recentsel', 1, 1, '7');
        return res.send(`${invalidAudio}&read=t-אנא בחרו שנית מהרשימה=${readCommand}&api_add_tids=${query.api_add_tids}&api_add_screen=recent`);
    }

    // העברה פנימית מהירה למסך תצוגת הדיון הנבחר
    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    query.api_add_post_idx = '0';
    delete query.recentsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך נושאים חדשים ביותר - מציג את רשימת הדיונים שחודשו או נפתחו לאחרונה
 */
async function handleTopicsScreen(query, res) {
    const selection = query.topicsel;

    if (selection === '0') {
        query.screen = 'main';
        delete query.topicsel;
        return await handleMainScreen(query, res);
    }

    if (selection === '*') {
        delete query.topicsel;
    }

    if (!query.topicsel) {
        const data = await fetchFromForum('/recent');
        if (!data || !data.topics || data.topics.length === 0) {
            return sendFallbackRedirect(res, 'לא נמצאו נושאים חדשים בשרת.');
        }

        const audioParts = ['t-הנושאים החדשים ביותר שנפתחו בפורום .'];
        const topicIdsArray = [];
        const limitedTopics = data.topics.slice(0, MAX_ITEMS_PER_PAGE);

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
        const invalidAudio = idList(['t-בחירה שגויה .']);
        const readCommand = buildFastMenuRead('topicsel', 1, 1, '6');
        return res.send(`${invalidAudio}&read=t-אנא נסו שנית=${readCommand}&api_add_tids=${query.api_add_tids}&api_add_screen=topics`);
    }

    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    query.api_add_post_idx = '0';
    delete query.topicsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך קטגוריות ראשיות - מציג את קטגוריות הפורום לבחירה וסינון
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
            return sendFallbackRedirect(res, 'לא ניתן לטעון את קטגוריות הפורום בשעה זו.');
        }

        const audioParts = ['t-קטגוריות הפורום הראשיות .'];
        const catIdsArray = [];
        
        // סינון קטגוריות ריקות או חסרות שם ולקיחת התפריט המוביל
        const validCategories = data.categories.filter(c => c && c.name).slice(0, MAX_ITEMS_PER_PAGE);

        validCategories.forEach((cat, index) => {
            const displayIndex = index + 1;
            const cleanCatName = cleanTextForTTS(cat.name, 120);
            
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
        const invalidAudio = idList(['t-הקטגוריה שנבחרה אינה קיימת .']);
        const readCommand = buildFastMenuRead('catsel', 1, 1, '6');
        return res.send(`${invalidAudio}&read=t-אנא בחרו שנית=${readCommand}&api_add_cids=${query.api_add_cids}&api_add_screen=categories`);
    }

    query.screen = 'category_view';
    query.api_add_cid = targetCid;
    query.api_add_page = '1';
    delete query.catsel;
    return await handleCategoryViewScreen(query, res);
}

/**
 * מסך תצוגת נושאים בתוך קטגוריה ספציפית
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
            return sendFallbackRedirect(res, 'לא נמצאו נושאים קיימים בתוך קטגוריה זו.');
        }

        const catName = cleanTextForTTS(data.name || 'הנבחרת');
        const audioParts = [`t-נושאים בקטגוריית ${catName}, עמוד ${currentPage} .`];
        const topicIdsArray = [];
        const limitedTopics = data.topics.slice(0, MAX_ITEMS_PER_PAGE);

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
        const invalidAudio = idList(['t-הבחירה שהוקשה אינה תקינה ברשימה הנוכחית .']);
        const readCommand = buildFastMenuRead('catviewsel', 1, 1, '5');
        return res.send(`${invalidAudio}&read=t-נסו שנית=${readCommand}&api_add_cid=${currentCid}&api_add_page=${currentPage}&api_add_tids=${query.api_add_tids}&api_add_screen=category_view`);
    }

    query.screen = 'topic_view';
    query.api_add_tid = targetTid;
    query.api_add_page = '1';
    query.api_add_post_idx = '0';
    delete query.catviewsel;
    return await handleTopicViewScreen(query, res);
}

/**
 * מסך הצגת פוסטים בתוך דיון (Topic View) - ניווט קולי רציף, קטוע ומתקדם
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

    // שליפת הנתונים הנוכחיים של הדיון
    const data = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
    if (!data || !data.posts || data.posts.length === 0) {
        return sendFallbackRedirect(res, 'לא ניתן לטעון את רשימת הפוסטים של נושא זה כעת.');
    }

    const posts = data.posts;
    const topicTitle = cleanTextForTTS(data.title || 'נושא דיון');

    // עיבוד פקודות הניווט הפנימיות בתוך הדיון (1=הבא, 2=הקודם, 3=שמיעה חוזרת)
    if (selection) {
        const navCommand = selection.trim();
        if (navCommand === '1') {
            // מעבר לפוסט הבא
            if (currentPostIndex < posts.length - 1) {
                currentPostIndex++;
            } else {
                // בדיקת דפים הבאים בפורום
                currentPage++;
                const nextData = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
                if (nextData && nextData.posts && nextData.posts.length > 0) {
                    currentPostIndex = 0;
                } else {
                    currentPage--; // חזרה לדף האחרון הקיים
                    const endAudio = idList(['t-הגעתם לסוף הפוסטים בדיון זה .']);
                    const readCommand = buildFastMenuRead('topicnav', 1, 1, '7');
                    const navPrompt = '.t-להודעה הקודמת הקישו 2 . לחזרה לתפריט הקישו אפס .';
                    return res.send(`${endAudio}${navPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
                }
            }
        } else if (navCommand === '2') {
            // מעבר לפוסט הקודם
            if (currentPostIndex > 0) {
                currentPostIndex--;
            } else if (currentPage > 1) {
                currentPage--;
                const prevData = await fetchFromForum(`/topic/${topicId}?page=${currentPage}`);
                if (prevData && prevData.posts && prevData.posts.length > 0) {
                    currentPostIndex = prevData.posts.length - 1;
                }
            } else {
                const startAudio = idList(['t-הגעתם לתחילת הדיון הנוכחי .']);
                const readCommand = buildFastMenuRead('topicnav', 1, 1, '7');
                const navPrompt = '.t-להודעה הבאה הקישו 1 . לחזרה הקישו אפס .';
                return res.send(`${startAudio}${navPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
            }
        } else if (navCommand === '3') {
            // שמיעה חוזרת
            console.log(`[Topic Replay] Re-playing post index ${currentPostIndex}`);
        } else {
            const invalidAudio = idList(['t-מקש ניווט שגוי .']);
            const readCommand = buildFastMenuRead('topicnav', 1, 1, '6');
            const menuPrompt = '.t-להודעה הבאה הקישו 1 , לקודמת הקישו 2 , לחזרה הקישו אפס .';
            return res.send(`${invalidAudio}${menuPrompt}${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_post_idx=${currentPostIndex}&api_add_screen=topic_view`);
        }
    }

    // בניית נתוני הפוסט האקטיבי להקראה
    const activePost = posts[currentPostIndex];
    const postAuthor = cleanTextForTTS(activePost.user ? activePost.user.username : 'משתמש הפורום');
    const postBody = cleanTextForTTS(activePost.content, MAX_BODY_CHARS);
    const totalPostsInTopic = data.postcount || posts.length;

    const audioParts = [];
    
    if (currentPostIndex === 0 && currentPage === 1 && !selection) {
        audioParts.push(`t-פותח את הדיון בנושא , ${topicTitle} .`);
    }

    audioParts.push(`t-הודעה מספר ${activePost.index + 1} מתוך ${totalPostsInTopic} .`);
    audioParts.push(`t-נכתב על ידי , ${postAuthor} .`);
    audioParts.push(`t-${postBody} .`);
    
    // תפריט ניווט מהיר מובנה שמוקרא כחלק מהטקסט ומאפשר קטיעה מיידית
    audioParts.push('t-להודעה הבאה הקישו 1 . לקודמת הקישו 2 . לשמיעה חוזרת הקישו 3 . לחזרה הקישו אפס .');

    const audioOutput = idList(audioParts);
    const readCommand = buildFastMenuRead('topicnav', 1, 1, '12');

    return res.send(
        `${audioOutput}${readCommand}` +
        `&api_add_tid=${topicId}` +
        `&api_add_page=${currentPage}` +
        `&api_add_post_idx=${currentPostIndex}` +
        `&api_add_screen=topic_view`
    );
}

/**
 * מנגנון הגנה וניתוב חזרה לתפריט הראשי במקרה של שגיאות קריטיות (Fallback Safety Handler)
 */
function sendFallbackRedirect(res, msgText) {
    console.warn(`[Fallback Core Triggered] Reason: ${msgText}`);
    const cleanMsg = cleanTextForTTS(msgText, 150);
    
    const audioOutput = idList([
        `t-${cleanMsg}`, 
        't-המערכת נתקלה בקושי , חוזרים כעת באופן אוטומטי לתפריט הראשי של הפורום הטלפוני .'
    ]);
    
    const readCommand = buildFastMenuRead('mainsel', 1, 1, '8');
    return res.send(`${audioOutput}${readCommand}&api_add_screen=main`);
}

// ============================================================================
// סביבת הרצה וניהול שרת לוקאלי או הפצה לענן
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Core System Active] IVR Advanced Forum Gateway Service successfully started on port ${PORT}`);
});

module.exports = app;
