const express = require('express');
const axios = require('axios');
const app = express();

// הגדרת כתובת הפורום (ללא לוכסן בסוף)
const FORUM_URL = 'https://mitmachim.top'; 

// פונקציית עזר לניקוי תגיות HTML ו-Markdown מהטקסט כדי שה-TTS יקריא בצורה נקייה
function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, '') // הסרת תגיות HTML
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // השארת הטקסט של הקישור בלבד
        .replace(/[*_~`#\-]/g, '') // הסרת סימני עיצוב של Markdown
        .replace(/\s+/g, ' ') // ניקוי רווחים כפולים
        .trim();
}

// נתיב ה-API הראשי שאליו ה-IVR יפנה
app.get('/api', async (req, res) => {
    // קבלת הפרמטרים שימות המשיח שולחים אוטומטית בכל פנייה
    const selection = req.query.selection; // הבחירה של המשתמש (אם הקיש משהו)
    
    // שליחת כותרת תגובה מתאימה לעברית במערכת ימות המשיח
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    try {
        // שלב א': אם המשתמש רק נכנס לשלוחה ועדיין לא בחר נושא
        if (!selection) {
            // פנייה ל-API המובנה של NodeBB לקבלת הנושאים האחרונים
            const response = await axios.get(`${FORUM_URL}/api/recent`);
            const topics = response.data.topics ? response.data.topics.slice(0, 5) : [];

            if (topics.length === 0) {
                return res.send('say_tts=לא נמצאו נושאים אחרונים בפורום כעת. להתראות.&hangup=yes');
            }

            // בניית הודעת התפריט להקראה למשתמש
            let ttsMessage = 'ברוכים הבאים לפורום. להלן חמשת הנושאים האחרונים. ';
            topics.forEach((topic, index) => {
                ttsMessage += `לנושא ${index + 1}: ${topic.title}. `;
            });
            ttsMessage += 'אנא הקישו את מספר הנושא הרצוי.';

            // פקודת קליטת נתונים (read) לפי התיעוד של ימות המשיח
            // מחכה לספרה 1 בין הטווח 1 ל-5, ושומרת את התשובה במשתנה selection בפנייה הבאה
            return res.send(`read=t-${ttsMessage}=selection,yes,1,1,1,5,Number`);
        }

        // שלב ב': המשתמש הקיש מספר נושא (1 עד 5)
        const topicIndex = parseInt(selection) - 1;
        if (isNaN(topicIndex) || topicIndex < 0 || topicIndex >= 5) {
            return res.send('say_tts=בחירה שגויה. המערכת תתנתק כעת.&hangup=yes');
        }

        // שליפת הנושאים שוב כדי למצוא את ה-ID (או ה-Slug) של הנושא שנבחר
        const recentResponse = await axios.get(`${FORUM_URL}/api/recent`);
        const selectedTopic = recentResponse.data.topics[topicIndex];

        if (!selectedTopic) {
            return res.send('say_tts=הנושא המבוקש אינו זמין כעת.&hangup=yes');
        }

        // פנייה ל-API של האשכול הספציפי כדי לקרוא את הפוסט הראשון בתוכו
        const topicResponse = await axios.get(`${FORUM_URL}/api/topic/${selectedTopic.tid}`);
        const posts = topicResponse.data.posts || [];
        
        if (posts.length === 0) {
            return res.send('say_tts=לא נמצאו הודעות באשכול זה.&hangup=yes');
        }

        // לקיחת הפוסט הראשון באשכול וניקוי שלו
        const rawContent = posts[0].content;
        const authorName = posts[0].user ? posts[0].user.username : 'משתמש מהפורום';
        const cleanContent = cleanText(rawContent);

        // השמעת תוכן הפוסט למשתמש וניתוק השיחה בסיום (או חזרה לתפריט לפי הגדרה)
        const finalTts = `נושא: ${selectedTopic.title}. נכתב על ידי ${authorName}. תוכן ההודעה: ${cleanContent}`;
        return res.send(`say_tts=${finalTts}&hangup=yes`);

    } catch (error) {
        console.error('Error in bridge:', error.message);
        return res.send('say_tts=מתנצלים, אירעה שגיאה בתקשורת עם שרת הפורום.&hangup=yes');
    }
});

// הפעלת השרת (רלוונטי רק להרצה מקומית, ורסל מנהלת את זה לבד)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
