const express = require('express');
const axios = require('axios');
const app = express();

const FORUM_URL = 'https://mitmachim.top'; // שנה לכתובת הפורום שלך במידת הצורך

// פונקציית עזר לניקוי תגיות HTML ו-Markdown מהטקסט
function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, '') // הסרת HTML
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // השארת טקסט הקישור
        .replace(/[*_~`#\-]/g, '') // הסרת סימני עיצוב Markdown
        .replace(/&quot;/g, '"') // המרת מרכאות
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

// פונקציה להמרת תאריך ידידותי מפורמט ה-Timestamp של הפורום
function parseDate(timestamp) {
    if (!timestamp) return 'תאריך לא ידוע';
    const date = new Date(timestamp);
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

app.get('/api', async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    // קריאת הפרמטרים מימות המשיח
    const step = req.query.step || 'main_menu'; // הצעד הנוכחי במערכת
    const userInput = req.query.ApiEnter || req.query.selection; // המקש שהמשתמש הקיש
    
    // פרמטרי ניווט עמוקים (נשמרים בתוך ה-URL של השלב הבא)
    const currentCid = req.query.cid; // מזהה קטגוריה נוכחית
    const currentTid = req.query.tid; // mזהה אשכול/נושא נוכחי
    const postIndex = parseInt(req.query.p_idx) || 0; // אינדקס הפוסט הנוכחי באשכול

    try {
        // ==========================================
// 1. תפריט ראשי - מתוקן ללא תווים מיוחדים
// ==========================================
if (step === 'main_menu') {
    // הוסר התו < והוחלף בפסיק רגיל או בנקודה
    let menuTts = 'לתפריט קטגוריות הקישו 1. לשמיעת נושאים אחרונים שנפתחו הקישו 2. לשמיעת פוסטים אחרונים בפורום הקישו 3.';
    return res.send(`read=t-${menuTts}=ApiEnter,yes,1,1,1,3,Number&step=process_main`);
}

        if (step === 'process_main') {
            if (userInput === '1') { // מעבר לקטגוריות ראשיות
                return res.send(`go_to_api=yes&step=categories&cid=0`);
            }
            if (userInput === '2') { // נושאים אחרונים שנפתחו
                return res.send(`go_to_api=yes&step=recent_topics`);
            }
            if (userInput === '3') { // פוסטים אחרונים בפורום
                return res.send(`go_to_api=yes&step=recent_posts`);
            }
            return res.send(`go_to_api=yes&step=main_menu`); // בחירה שגויה - חזרה לתפריט
        }

        // ==========================================
        // 2. תפריט קטגוריות (ותתי קטגוריות)
        // ==========================================
        if (step === 'categories') {
            // שליפת מבנה הקטגוריות של NodeBB
            const response = await axios.get(`${FORUM_URL}/api/categories`);
            let categories = response.data.categories || [];

            // סינון קטגוריות לפי האם אנחנו בשורש (cid=0) או בתוך קטגוריית אב
            if (currentCid && currentCid !== '0') {
                const parentId = parseInt(currentCid);
                // מוצאים את תתי הקטגוריות שה-parent שלהן הוא ה-cid הנוכחי
                categories = categories.filter(c => c.parentCid === parentId);
            } else {
                // קטגוריות ראשיות בלבד (אין להן אב)
                categories = categories.filter(c => !c.parentCid || c.parentCid === 0);
            }

            if (categories.length === 0) {
                // אם אין תתי קטגוריות, ננסה להציג ישירות את הנושאים שבתוך הקטגוריה הזו
                return res.send(`go_to_api=yes&step=category_topics&cid=${currentCid}`);
            }

            // לוקחים מקסימום 7 קטגוריות להשמעה נוחה בטלפון
            const items = categories.slice(0, 7);
            let tts = `בחרת קטגוריות. `;
            items.forEach((cat, index) => {
                tts += `ל${cat.name}, הקישו ${index + 1}. `;
            });
            tts += 'לחזרה לתפריט הראשי, הקישו 9.';

            // שמירת המזהים של הקטגוריות שהושמעו כדי לדעת למי לשלוח בשלב הבא
            const idsMapping = items.map(c => c.cid).join(',');
            return res.send(`read=t-${tts}=ApiEnter,yes,1,1,1,9,Number&step=process_category&cid=${currentCid}&cat_map=${idsMapping}`);
        }

        if (step === 'process_category') {
            if (userInput === '9') return res.send(`go_to_api=yes&step=main_menu`);
            
            const catMap = (req.query.cat_map || '').split(',');
            const selectedIdx = parseInt(userInput) - 1;
            
            if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= catMap.length) {
                return res.send(`say_tts=בחירה שגויה. חזרה לתפריט הקודם.&go_to_api=yes&step=categories&cid=${currentCid}`);
            }

            const nextCid = catMap[selectedIdx];
            // מעבר לבדיקה האם יש תתי קטגוריות או נושאים בתוך הקטגוריה שנבחרה
            return res.send(`go_to_api=yes&step=category_decision&cid=${nextCid}`);
        }

        // שלב ביניים שמחליט האם להציג תת קטגוריה או להציג נושאים
        if (step === 'category_decision') {
            const response = await axios.get(`${FORUM_URL}/api/category/${currentCid}`);
            const children = response.data.children || [];
            
            if (children.length > 0) {
                // יש תתי קטגוריות - נשמיע אותן
                return res.send(`go_to_api=yes&step=categories&cid=${currentCid}`);
            } else {
                // אין תתי קטגוריות - נשמיע את הנושאים שבפנים
                return res.send(`go_to_api=yes&step=category_topics&cid=${currentCid}`);
            }
        }

        // נושאים בתוך קטגוריה ספציפית
        if (step === 'category_topics') {
            const response = await axios.get(`${FORUM_URL}/api/category/${currentCid}`);
            const topics = response.data.topics || [];

            if (topics.length === 0) {
                return res.send(`say_tts=אין נושאים בקטגוריה זו. חזרה לתפריט הראשי.&go_to_api=yes&step=main_menu`);
            }

            const items = topics.slice(0, 5);
            let tts = 'הנושאים בקטגוריה זו הם: ';
            items.forEach((t, index) => {
                tts += `לנושא ${index + 1}: ${t.title}. `;
            });
            tts += 'לחזרה, הקישו 9.';

            const tidsMapping = items.map(t => t.tid).join(',');
            return res.send(`read=t-${tts}=ApiEnter,yes,1,1,1,9,Number&step=process_topics&tids_map=${tidsMapping}&cid=${currentCid}`);
        }

        if (step === 'process_topics') {
            if (userInput === '9') return res.send(`go_to_api=yes&step=main_menu`);
            const tidsMap = (req.query.tids_map || '').split(',');
            const selectedIdx = parseInt(userInput) - 1;

            if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= tidsMap.length) {
                return res.send(`say_tts=בחירה שגויה.&go_to_api=yes&step=category_topics&cid=${currentCid}`);
            }

            const targetTid = tidsMap[selectedIdx];
            return res.send(`go_to_api=yes&step=read_topic&tid=${targetTid}&p_idx=0`);
        }

        // ==========================================
        // 3. נושאים אחרונים (גלובלי)
        // ==========================================
        if (step === 'recent_topics') {
            const response = await axios.get(`${FORUM_URL}/api/recent`);
            const topics = response.data.topics ? response.data.topics.slice(0, 5) : [];

            let tts = 'הנושאים האחרונים שנפתחו בפורום הם: ';
            topics.forEach((t, index) => {
                tts += `לנושא ${index + 1}: ${t.title}. `;
            });
            tts += 'לרענון ועדכון רשימה זו, הקישו 8. לחזרה לתפריט, הקישו 9.';

            const tidsMapping = topics.map(t => t.tid).join(',');
            return res.send(`read=t-${tts}=ApiEnter,yes,1,1,1,9,Number&step=process_recent_topics&tids_map=${tidsMapping}`);
        }

        if (step === 'process_recent_topics') {
            if (userInput === '9') return res.send(`go_to_api=yes&step=main_menu`);
            if (userInput === '8') return res.send(`go_to_api=yes&step=recent_topics`); // רענון מחדש

            const tidsMap = (req.query.tids_map || '').split(',');
            const selectedIdx = parseInt(userInput) - 1;

            if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= tidsMap.length) {
                return res.send(`say_tts=בחירה שגויה.&go_to_api=yes&step=recent_topics`);
            }

            return res.send(`go_to_api=yes&step=read_topic&tid=${tidsMap[selectedIdx]}&p_idx=0`);
        }

        // ==========================================
        // 4. פוסטים אחרונים (גלובלי)
        // ==========================================
        if (step === 'recent_posts') {
            const response = await axios.get(`${FORUM_URL}/api/recent/posts`);
            const posts = response.data || [];

            if (posts.length === 0) {
                return res.send(`say_tts=אין פוסטים אחרונים. חזרה לתפריט.&go_to_api=yes&step=main_menu`);
            }

            // השמעת הפוסט הנוכחי מתוך רשימת האחרונים
            const post = posts[postIndex];
            const cleanContent = cleanText(post.content);
            const author = post.user ? post.user.username : 'משתמש מהפורום';
            const topicTitle = post.topic ? post.topic.title : 'נושא כללי';

            let tts = `פוסט מתוך הנושא: ${topicTitle}. נכתב על ידי ${author}. תוכן הפוסט: ${cleanContent}. `;
            tts += 'לפוסט הבא, הקישו 6. לפוסט הקודם, הקישו 4. לשמיעת פרטי הפוסט המלאים, הקישו 5. לרענון רשימת הפוסטים מההתחלה, הקישו 8. לחזרה לתפריט, הקישו 9.';

            return res.send(`read=t-${tts}=ApiEnter,yes,1,1,1,9,Number&step=process_recent_posts&p_idx=${postIndex}&tid=${post.tid}`);
        }

        if (step === 'process_recent_posts') {
            if (userInput === '9') return res.send(`go_to_api=yes&step=main_menu`);
            if (userInput === '8') return res.send(`go_to_api=yes&step=recent_posts&p_idx=0`); // רענון מההתחלה
            
            // שמיעת פרטים מלאים על הפוסט האחרון
            if (userInput === '5') {
                return res.send(`go_to_api=yes&step=post_metadata&tid=${currentTid}&p_idx=${postIndex}&back_to=recent_posts`);
            }

            let nextIdx = postIndex;
            if (userInput === '6') nextIdx = postIndex + 1; // קדימה
            if (userInput === '4') nextIdx = Math.max(0, postIndex - 1); // אחורה

            return res.send(`go_to_api=yes&step=recent_posts&p_idx=${nextIdx}`);
        }

        // ==========================================
        // 5. קריאת אשכול/נושא ספציפי (השמעת הודעות רציפה)
        // ==========================================
        if (step === 'read_topic') {
            const response = await axios.get(`${FORUM_URL}/api/topic/${currentTid}`);
            const posts = response.data.posts || [];
            const topicTitle = response.data.title || 'נושא';

            if (posts.length === 0 || postIndex >= posts.length) {
                return res.send(`say_tts=סיימתם לשמוע את כל ההודעות באשכול זה. חזרה לתפריט הראשי.&go_to_api=yes&step=main_menu`);
            }

            const post = posts[postIndex];
            const cleanContent = cleanText(post.content);
            const author = post.user ? post.user.username : 'משתמש מהפורום';

            let tts = `הודעה מספר ${postIndex + 1} באשכול ${topicTitle}. מאת ${author}: ${cleanContent}. `;
            tts += 'להודעה הבאה, הקישו 6. להודעה הקודמת, הקישו 4. לשמיעת פרטי הודעה זו, הקישו 5. לחזרה לתפריט, הקישו 9.';

            return res.send(`read=t-${tts}=ApiEnter,yes,1,1,1,9,Number&step=process_read_topic&tid=${currentTid}&p_idx=${postIndex}`);
        }

        if (step === 'process_read_topic') {
            if (userInput === '9') return res.send(`go_to_api=yes&step=main_menu`);
            
            // שמיעת פרטי פוסט בתוך אשכול
            if (userInput === '5') {
                return res.send(`go_to_api=yes&step=post_metadata&tid=${currentTid}&p_idx=${postIndex}&back_to=read_topic`);
            }

            let nextIdx = postIndex;
            if (userInput === '6') nextIdx = postIndex + 1;
            if (userInput === '4') nextIdx = Math.max(0, postIndex - 1);

            return res.send(`go_to_api=yes&step=read_topic&tid=${currentTid}&p_idx=${nextIdx}`);
        }

        // ==========================================
        // 6. השמעת פרטי פוסט / נושא (מטא-דאטה)
        // ==========================================
        if (step === 'post_metadata') {
            const backTo = req.query.back_to || 'main_menu';
            let author = 'לא ידוע', dateStr = 'לא ידוע', repliesCount = '0', views = '0';

            if (backTo === 'recent_posts') {
                const response = await axios.get(`${FORUM_URL}/api/recent/posts`);
                const post = response.data[postIndex];
                if (post) {
                    author = post.user ? post.user.username : author;
                    dateStr = parseDate(post.timestamp);
                }
            } else {
                const response = await axios.get(`${FORUM_URL}/api/topic/${currentTid}`);
                const post = response.data.posts[postIndex];
                if (post) {
                    author = post.user ? post.user.username : author;
                    dateStr = parseDate(post.timestamp);
                }
                repliesCount = response.data.postcount ? (response.data.postcount - 1).toString() : '0';
                views = response.data.viewcount || '0';
            }

            let metaTts = `פרטי פוסט: נכתב על ידי המשתמש ${author}. פורסם בתאריך ${dateStr}. `;
            if (backTo === 'read_topic') {
                metaTts += `באשכול זה יש סך הכל ${repliesCount} תגובות, והוא נצפה ${views} פעמים. `;
            }
            metaTts += 'לחזרה להשמעת הפוסט, הקישו מקש כלשהו או המתינו.';

            return res.send(`read=t-${metaTts}=ApiEnter,yes,1,1,1,,Number&step=return_from_meta&back_to=${backTo}&tid=${currentTid}&p_idx=${postIndex}`);
        }

        if (step === 'return_from_meta') {
            const backTo = req.query.back_to || 'main_menu';
            return res.send(`go_to_api=yes&step=${backTo}&tid=${currentTid}&p_idx=${postIndex}`);
        }

    } catch (error) {
        console.error('Error:', error.message);
        return res.send('say_tts=אירעה שגיאה בתקשורת עם הפורום. חזרה לתפריט הראשי.&go_to_api=yes&step=main_menu');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server connected on port ${PORT}`));

module.exports = app;
