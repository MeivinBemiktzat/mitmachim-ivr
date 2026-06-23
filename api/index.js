// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ (NodeBB)
// נבנה עבור מערכות ה-IVR של ימות המשיח - תמיכה מלאה ב-Barge-in
// ============================================================================

import express from 'express';

const app = express();

// הגדרות וקבועים
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\\/+$/, '');
const MAX_TITLE_CHARS = 350;   
const MAX_BODY_CHARS  = 980;   
const DEFAULT_TIMEOUT = 8000;  

// פונקציית עזר להוספת טיימאאוט לבקשות fetch
const fetchWithTimeout = (url, options = {}, timeout = DEFAULT_TIMEOUT) => {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Network request timed out')), timeout)
    )
  ]);
};

/**
 * פונקציה לבניית פקודת הקראה ותפריט מהיר (Barge-in) משולב עבור ימות המשיח.
 * מקבלת את מערך ההקראות, שם משתנה הקלט, וכמות מקסימלית של ספרות.
 */
function buildFastMenu(audioArray, valName, maxDigits = 1) {
  const textPrompt = audioArray.join('.');
  // יצירת מבנה קריאה המאפשר הקשה תוך כדי דיבור ללא צורך באישור
  return `read=${textPrompt}=${valName},no,${maxDigits},1,7,Digits,no,no`;
}

/**
 * מנקה תגיות HTML ומחזירה טקסט נקי עבור מנוע ה-TTS של ימות המשיח
 */
function cleanHtmlForTTS(html) {
  if (!html) return '';
  let text = html;
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, ' קוד מחשב ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

// ראוטר ראשי לקבלת בקשות ה-API מימות המשיח
app.all('*', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // שליפת הפרמטרים שנשלחו מימות המשיח (תומך ב-GET וב-POST)
  const params = { ...req.query, ...req.body };
  
  const currentScreen = params.screen || 'main';
  const mainSelection = params.mainsel;
  const recentSelection = params.recentsel;
  const topicSelection = params.topicsel;
  const categorySelection = params.catsel;
  const topicNavSelection = params.topicnav;

  try {
    // ========================================================================
    // מסך ראשי (תפריט ראשי)
    // ========================================================================
    if (currentScreen === 'main' && !mainSelection) {
      const audioParts = [
        't-ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        't-לכניסה לפוסטים האחרונים הקישו 1',
        't-לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        't-לכניסה לפי קטגוריות הקישו 3'
      ];
      
      const readCommand = buildFastMenu(audioParts, 'mainsel', 1);
      return res.send(`${readCommand}&api_add_screen=main`);
    }

    // ניתוב מתוך תפריט ראשי
    if (currentScreen === 'main' && mainSelection) {
      if (mainSelection === '1') {
        // מעבר לפוסטים אחרונים
        return res.redirect(307, `${req.path}?screen=recent`);
      } else if (mainSelection === '2') {
        // מעבר לנושאים חדשים
        return res.redirect(307, `${req.path}?screen=topics`);
      } else if (mainSelection === '3') {
        // מעבר לקטגוריות
        return res.redirect(307, `${req.path}?screen=categories`);
      } else {
        // בחירה שגויה בתפריט הראשי
        const audioParts = [
          't-בחירה שגויה',
          't-ברוכים הבאים לפורום מתמחים טופ הטלפוני',
          't-לכניסה לפוסטים האחרונים הקישו 1',
          't-לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
          't-לכניסה לפי קטגוריות הקישו 3'
        ];
        const readCommand = buildFastMenu(audioParts, 'mainsel', 1);
        return res.send(`${readCommand}&api_add_screen=main`);
      }
    }

    // ========================================================================
    // מסך פוסטים אחרונים (Recent)
    // ========================================================================
    if (currentScreen === 'recent' && !recentSelection) {
      const response = await fetchWithTimeout(`${FORUM_URL}/api/recent`);
      if (!response.ok) throw new Error('Failed to fetch recent posts');
      const data = await response.json();
      
      const topics = data.topics || [];
      if (topics.length === 0) {
        return res.send(`id_list_message=t-לא נמצאו פוסטים אחרונים&api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
      }

      const audioParts = ['t-הפוסטים האחרונים בפורום'];
      const tidMap = [];

      // לקיחת עד 9 נושאים כדי להתאים למקשים 1-9
      const maxItems = Math.min(topics.length, 9);
      for (let i = 0; i < maxItems; i++) {
        const t = topics[i];
        const cleanTitle = (t.title || '').substring(0, MAX_TITLE_CHARS);
        const author = t.user ? t.user.username : 'מערכת';
        
        audioParts.push(`t-לנושא מספר ${i + 1}`);
        audioParts.push(`t-${cleanTitle}`);
        audioParts.push(`t-מאת ${author}`);
        audioParts.push(`t-הקישו ${i + 1}`);
        
        tidMap.push(t.tid);
      }

      audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס');
      
      const readCommand = buildFastMenu(audioParts, 'recentsel', 1);
      const tidsString = tidMap.join('>');
      
      return res.send(`${readCommand}&api_add_tids=${tidsString}&api_add_screen=recent`);
    }

    // עיבוד בחירה במסך פוסטים אחרונים
    if (currentScreen === 'recent' && recentSelection) {
      if (recentSelection === '0') {
        return res.send('api_add_screen=main&mainsel='); 
      }
      
      const tids = (params.api_add_tids || '').split('>');
      const index = parseInt(recentSelection, 10) - 1;
      
      if (index >= 0 && index < tids.length) {
        const targetTid = tids[index];
        return res.redirect(307, `${req.path}?screen=topicview&tid=${targetTid}&page=1`);
      }
      
      // במקרה של הקשה שגויה
      return res.send('api_add_screen=recent&recentsel=');
    }

    // ========================================================================
    // מסך נושאים חדשים (Topics)
    // ========================================================================
    if (currentScreen === 'topics' && !topicSelection) {
      const response = await fetchWithTimeout(`${FORUM_URL}/api/recent/new`);
      if (!response.ok) throw new Error('Failed to fetch new topics');
      const data = await response.json();
      
      const topics = data.topics || [];
      if (topics.length === 0) {
        return res.send(`id_list_message=t-לא נמצאו נושאים חדשים&api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
      }

      const audioParts = ['t-הנושאים החדשים ביותר שנפתחו בפורום'];
      const tidMap = [];
      const maxItems = Math.min(topics.length, 9);

      for (let i = 0; i < maxItems; i++) {
        const t = topics[i];
        const cleanTitle = (t.title || '').substring(0, MAX_TITLE_CHARS);
        const author = t.user ? t.user.username : 'מערכת';
        
        audioParts.push(`t-לנושא מספר ${i + 1}`);
        audioParts.push(`t-${cleanTitle}`);
        audioParts.push(`t-מאת ${author}`);
        audioParts.push(`t-הקישו ${i + 1}`);
        
        tidMap.push(t.tid);
      }

      audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס');
      
      const readCommand = buildFastMenu(audioParts, 'topicsel', 1);
      const tidsString = tidMap.join('>');
      
      return res.send(`${readCommand}&api_add_tids=${tidsString}&api_add_screen=topics`);
    }

    if (currentScreen === 'topics' && topicSelection) {
      if (topicSelection === '0') {
        return res.send('api_add_screen=main&mainsel=');
      }
      
      const tids = (params.api_add_tids || '').split('>');
      const index = parseInt(topicSelection, 10) - 1;
      
      if (index >= 0 && index < tids.length) {
        const targetTid = tids[index];
        return res.redirect(307, `${req.path}?screen=topicview&tid=${targetTid}&page=1`);
      }
      
      return res.send('api_add_screen=topics&topicsel=');
    }

    // ========================================================================
    // מסך קטגוריות (Categories)
    // ========================================================================
    if (currentScreen === 'categories' && !categorySelection) {
      const response = await fetchWithTimeout(`${FORUM_URL}/api/categories`);
      if (!response.ok) throw new Error('Failed to fetch categories');
      const data = await response.json();
      
      const categories = data.categories || [];
      if (categories.length === 0) {
        return res.send(`id_list_message=t-לא נמצאו קטגוריות&api_add_screen=main&read=t-חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);
      }

      const audioParts = ['t-רשימת קטגוריות ראשיות'];
      const cidMap = [];
      const maxItems = Math.min(categories.length, 9);

      for (let i = 0; i < maxItems; i++) {
        const c = categories[i];
        audioParts.push(`t-לקטגוריית ${c.name} הקישו ${i + 1}`);
        cidMap.push(c.cid);
      }

      audioParts.push('t-לחזרה לתפריט הראשי הקישו אפס');
      
      const readCommand = buildFastMenu(audioParts, 'catsel', 1);
      const cidsString = cidMap.join('>');
      
      return res.send(`${readCommand}&api_add_cids=${cidsString}&api_add_screen=categories`);
    }

    if (currentScreen === 'categories' && categorySelection) {
      if (categorySelection === '0') {
        return res.send('api_add_screen=main&mainsel=');
      }
      
      const cids = (params.api_add_cids || '').split('>');
      const index = parseInt(categorySelection, 10) - 1;
      
      if (index >= 0 && index < cids.length) {
        const targetCid = cids[index];
        // מעבר לרשימת נושאים בתוך הקטגוריה הספציפית
        return res.redirect(307, `${req.path}?screen=categoryview&cid=${targetCid}`);
      }
      
      return res.send('api_add_screen=categories&catsel=');
    }

    // ========================================================================
    // תצוגת נושאים בתוך קטגוריה (Category View)
    // ========================================================================
    if (currentScreen === 'categoryview') {
      const cid = params.cid;
      if (!cid) return res.send('api_add_screen=main&mainsel=');

      if (!topicSelection) {
        const response = await fetchWithTimeout(`${FORUM_URL}/api/category/${cid}`);
        if (!response.ok) throw new Error('Failed to fetch category topics');
        const data = await response.json();
        
        const topics = data.topics || [];
        if (topics.length === 0) {
          return res.send(`id_list_message=t-אין נושאים בקטגוריה זו&api_add_screen=categories&read=t-חוזר לקטגוריות=dummy,no,1,1,1,Digits,no,no`);
        }

        const audioParts = [`t-נושאים בקטגוריית ${data.name || ''}`];
        const tidMap = [];
        const maxItems = Math.min(topics.length, 9);

        for (let i = 0; i < maxItems; i++) {
          const t = topics[i];
          audioParts.push(`t-לנושא ${t.title} מאת ${t.user ? t.user.username : 'מערכת'} הקישו ${i + 1}`);
          tidMap.push(t.tid);
        }

        audioParts.push('t-לחזרה לתפריט הקטגוריות הקישו אפס');
        
        const readCommand = buildFastMenu(audioParts, 'topicsel', 1);
        return res.send(`${readCommand}&api_add_tids=${tidMap.join('>')}&api_add_screen=categoryview&cid=${cid}`);
      } else {
        if (topicSelection === '0') {
          return res.send('api_add_screen=categories&catsel=');
        }
        const tids = (params.api_add_tids || '').split('>');
        const index = parseInt(topicSelection, 10) - 1;
        if (index >= 0 && index < tids.length) {
          return res.redirect(307, `${req.path}?screen=topicview&tid=${tids[index]}&page=1`);
        }
        return res.send(`api_add_screen=categoryview&cid=${cid}&topicsel=`);
      }
    }

    // ========================================================================
    // שמיעת דיון / פוסט ספציפי (Topic View & Post Navigation)
    // ========================================================================
    if (currentScreen === 'topicview') {
      const topicId = params.tid;
      const currentPage = parseInt(params.page || '1', 10);
      let currentPostIndex = parseInt(params.postidx || '0', 10);

      if (!topicId) return res.send('api_add_screen=main&mainsel=');

      const response = await fetchWithTimeout(`${FORUM_URL}/api/topic/${topicId}/${currentPage}`);
      if (!response.ok) throw new Error('Failed to fetch topic content');
      const data = await response.json();

      const posts = data.posts || [];
      if (posts.length === 0) {
        return res.send(`id_list_message=t-לא נמצאו הודעות בדיון זה&api_add_screen=main&read=t-חזרה להתחלה=dummy,no,1,1,1,Digits,no,no`);
      }

      // תיקון חריגות אינדקס במידה ועברנו את גבולות הפוסטים
      if (currentPostIndex >= posts.length) {
        currentPostIndex = posts.length - 1;
      }
      if (currentPostIndex < 0) {
        currentPostIndex = 0;
      }

      const activePost = posts[currentPostIndex];
      const authorName = activePost.user ? activePost.user.username : 'מערכת';
      const rawContent = cleanHtmlForTTS(activePost.content || '');
      const cleanContent = rawContent.substring(0, MAX_BODY_CHARS);

      // בניית תפריט ההשמעה והניווט עבור הפוסט הנוכחי
      const audioParts = [
        `t-כותרת הנושא היא, ${data.title || ''}`,
        `t-הודעה מספר ${currentPostIndex + 1} מתוך ${posts.length}`,
        `t-נכתב על ידי ${authorName}`,
        `t-תוכן ההודעה`,
        `t-${cleanContent}`,
        `t-סיום תוכן ההודעה`,
        `t-להודעה הבאה הקישו 1`,
        `t-להודעה הקודמת הקישו 2`,
        `t-לחזרה לתפריט הראשי הקישו אפס`
      ];

      if (!topicNavSelection) {
        const readCommand = buildFastMenu(audioParts, 'topicnav', 1);
        return res.send(
          `${readCommand}&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_screen=topicview&api_add_postidx=${currentPostIndex}`
        );
      } else {
        // מעבד את בחירת הניווט בין פוסטים
        const nextIdx = currentPostIndex + 1;
        const prevIdx = currentPostIndex - 1;

        if (topicNavSelection === '1') {
          if (nextIdx < posts.length) {
            return res.redirect(307, `${req.path}?screen=topicview&tid=${topicId}&page=${currentPage}&postidx=${nextIdx}`);
          } else {
            // אם הגענו לסוף העמוד הנוכחי, נבדוק אם יש עמודים נוספים בדיון
            if (data.pageCount && currentPage < data.pageCount) {
              return res.redirect(307, `${req.path}?screen=topicview&tid=${topicId}&page=${currentPage + 1}&postidx=0`);
            } else {
              // הגענו להודעה האחרונה בהחלט
              return res.send(`read=t-הגעתם להודעה האחרונה בהחלט בדיון זה. להודעה הקודמת הקישו 2. לחזרה לתפריט הראשי הקישו אפס=topicnav,no,1,1,7,Digits,no,no&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_screen=topicview&api_add_postidx=${currentPostIndex}`);
            }
          }
        } else if (topicNavSelection === '2') {
          if (prevIdx >= 0) {
            return res.redirect(307, `${req.path}?screen=topicview&tid=${topicId}&page=${currentPage}&postidx=${prevIdx}`);
          } else {
            if (currentPage > 1) {
              return res.redirect(307, `${req.path}?screen=topicview&tid=${topicId}&page=${currentPage - 1}&postidx=19`); // NodeBB בד"כ מציג 20 פוסטים לדף
            } else {
              // הגענו להודעה הראשונה בהחלט
              return res.send(`read=t-הגעתם להודעה הראשונה בדיון זה. להודעה הבאה הקישו 1. לחזרה לתפריט הראשי הקישו אפס=topicnav,no,1,1,7,Digits,no,no&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_screen=topicview&api_add_postidx=${currentPostIndex}`);
            }
          }
        } else if (topicNavSelection === '0') {
          return res.send('api_add_screen=main&mainsel=');
        } else {
          return res.send(`api_add_screen=topicview&tid=${topicId}&page=${currentPage}&postidx=${currentPostIndex}&topicnav=`);
        }
      }
    }

    // הגנת קצה למצבים לא מזוהים במערכת הניתוב
    console.warn(`[Fallback] Unhandled state context. Redirecting to main menu.`);
    return res.send(`api_add_screen=main&read=t-שגיאת מערכת חוזר לתפריט הראשי=dummy,no,1,1,1,Digits,no,no`);

  } catch (globalError) {
    console.error(`[Global Error Interceptor]:`, globalError.message);
    return res.send(`id_list_message=t-מתקשה להתחבר לשרת הפורום כעת. אנא נסו שנית מאוחר יותר&api_add_screen=main&read=t-חזרה לתפריט=dummy,no,1,1,1,Digits,no,no`);
  }
});

// הפעלת שרת Express מקומי במידה ולא רץ כ-Serverless Function
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[IVR Server] Advanced Call Module actively running on port ${PORT}`);
});

export default app;
