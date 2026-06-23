// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם ומורחב עבור פורום מתמחים טופ (NodeBB)
// נבנה עבור מערכות ה-IVR של ימות המשיח עם תמיכה מלאה ב-Barge-in (קטיעת שמע)
// ============================================================================

import express from 'express';
import fetch from 'node-fetch';

const app = express();

// הגדרות וקבועים
const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\\/+$/, '');
const MAX_TITLE_CHARS = 350;   
const MAX_BODY_CHARS  = 980;   
const DEFAULT_TIMEOUT = 10000; 

// חסימת גישה ישירה מהדפדפן להצגת שגיאה אסתטית
app.get('/', (req, res) => {
  if (!req.query.ApiPhone) {
    return res.status(403).send('Access Denied: IVR Systems Only.');
  }
});

// פונקציית עזר לביצוע Fetch מאובטח עם טיימאאוט
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// פונקציה לניקוי טקסט HTML והתאמתו ל-TTS (הקראה קולית)
function cleanHtmlForTTS(html) {
  if (!html) return '';
  let text = html;
  
  // הסרת תגיות קוד וחסימת הקראה של קוד תכנות ארוך
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, ' [קוד תכנות] ');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, ' [קוד] ');
  
  // הסרת קישורים והחלפתם בטקסט חלופי
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  
  // הסרת שאר תגיות ה-HTML
  text = text.replace(/<\/?[^>]+(>|$)/g, ' ');
  
  // ניקוי תווים מיוחדים של Markdown או ישויות HTML
  text = text.replace(/&quot;/g, '"')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&#39;/g, "'")
             .replace(/[\r\n]+/g, ' ')
             .replace(/\s+/g, ' ')
             .trim();
             
  return text;
}

// פונקציה לבניית פקודת ה-Read המרכזית עם שרשור ה-TTS ישירות בתוכה למניעת תקיעה
// המבנה: read=t-טקסט להקראה=משתנה,no,מינימום,מקסימום,זמן_המתנה,סוג,חסימת_הקשה,קטיעה
function buildFastMenuRead(variableName, promptText, maxDigits = 1) {
  // החלפת פסיקים בנקודות כדי לא לשבור את המבנה של ימות המשיח
  const safePrompt = promptText.replace(/,/g, '.');
  return `read=${safePrompt}=${variableName},no,1,${maxDigits},7,Digits,no,no`;
}

// הראוטר המרכזי של ה-API
app.all('/api', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  
  // איסוף משתנים מימות המשיח (תומך ב-GET ובהזרקת POST)
  const params = { ...req.query, ...req.body };
  const currentScreen = params.screen || 'main';
  const apiPhone = params.ApiPhone || 'unknown';
  
  console.log(`[IVR Request] Phone: ${apiPhone}, Screen: ${currentScreen}`);

  try {
    // ========================================================================
    // מסך 1: תפריט ראשי
    // ========================================================================
    if (currentScreen === 'main') {
      const selection = params.mainsel;
      
      // אם זו כניסה ראשונית או שלא הוקשה בחירה תקינה
      if (!selection) {
        const mainMenuTTS = 
          "t-ברוכים הבאים לפורום מתמחים טופ הטלפוני. " +
          "לשמיעת הפוסטים האחרונים הקישו 1. " +
          "לשמיעת הנושאים החדשים ביותר הקישו 2. " +
          "לכניסה לפי קטגוריות הפורום הקישו 3.";
          
        const readCommand = buildFastMenuRead('mainsel', mainMenuTTS, 1);
        return res.send(`${readCommand}&api_add_screen=main`);
      }
      
      // ניתוב לפי בחירת המשתמש
      if (selection === '1') {
        return res.redirect(307, `./api?screen=recent&ApiPhone=${apiPhone}`);
      } else if (selection === '2') {
        return res.redirect(307, `./api?screen=topics&ApiPhone=${apiPhone}`);
      } else if (selection === '3') {
        return res.redirect(307, `./api?screen=categories&ApiPhone=${apiPhone}`);
      } else {
        // בחירה שגויה - השמעת הודעה וחזרה מיידית לתפריט הראשי באותו ה-Read
        const errorMenuTTS = "t-מקש שגוי. לשמיעת הפוסטים האחרונים הקישו 1. לשמיעת הנושאים החדשים ביותר הקישו 2. לכניסה לפי קטגוריות הפורום הקישו 3.";
        const readCommand = buildFastMenuRead('mainsel', errorMenuTTS, 1);
        return res.send(`${readCommand}&api_add_screen=main`);
      }
    }

    // ========================================================================
    // מסך 2: פוסטים אחרונים (Recent)
    // ========================================================================
    if (currentScreen === 'recent') {
      const selection = params.recentsel;
      
      if (!selection) {
        // משיכת נתונים מה-API של הפורום
        const response = await fetchWithTimeout(`${FORUM_URL}/api/recent`);
        if (!response.ok) throw new Error('Forum API Recent Error');
        const data = await response.json();
        
        const topics = data.topics || [];
        if (topics.length === 0) {
          const emptyRead = buildFastMenuRead('mainsel', "t-לא נמצאו פוסטים אחרונים. לחזרה לתפריט הראשי הקישו אפס.", 1);
          return res.send(`${emptyRead}&api_add_screen=main`);
        }
        
        // בניית רשימת ההקראה המשורשרת לתוך ה-Read
        let ttsBuilder = "t-הפוסטים האחרונים בפורום. ";
        const idMapping = [];
        
        // לוקחים עד 9 נושאים כדי להתאים למקשים 1-9
        const maxItems = Math.min(topics.length, 9);
        for (let i = 0; i < maxItems; i++) {
          const topic = topics[i];
          const cleanTitle = cleanHtmlForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
          const user = topic.user ? topic.user.username : 'משתמש לא ידוע';
          
          ttsBuilder += `לנושא מספר ${i + 1}. ${cleanTitle}. מאת ${user}. הקישו ${i + 1}. `;
          idMapping.push(topic.tid);
        }
        ttsBuilder += "לחזרה לתפריט הראשי הקישו אפס.";
        
        const readCommand = buildFastMenuRead('recentsel', ttsBuilder, 1);
        const tidsString = idMapping.join('>');
        
        return res.send(`${readCommand}&api_add_screen=recent&api_add_tids=${tidsString}`);
      }
      
      // טיפול בבחירה מתוך רשימת הפוסטים האחרונים
      if (selection === '0') {
        return res.redirect(307, `./api?screen=main&ApiPhone=${apiPhone}`);
      }
      
      const digit = parseInt(selection, 10);
      if (digit >= 1 && digit <= 9) {
        const tids = (params.api_add_tids || '').split('>');
        const targetTid = tids[digit - 1];
        if (targetTid) {
          return res.redirect(307, `./api?screen=topicview&topicId=${targetTid}&page=1&ApiPhone=${apiPhone}`);
        }
      }
      
      // אם הוקש מקש לא חוקי, נטען מחדש את המסך
      return res.redirect(307, `./api?screen=recent&ApiPhone=${apiPhone}`);
    }

    // ========================================================================
    // מסך 3: נושאים חדשים (Topics)
    // ========================================================================
    if (currentScreen === 'topics') {
      const selection = params.topicsel;
      
      if (!selection) {
        const response = await fetchWithTimeout(`${FORUM_URL}/api/recent?sort=newest`);
        if (!response.ok) throw new Error('Forum API New Topics Error');
        const data = await response.json();
        
        const topics = data.topics || [];
        if (topics.length === 0) {
          const emptyRead = buildFastMenuRead('mainsel', "t-לא נמצאו נושאים חדשים. לחזרה לתפריט הראשי הקישו אפס.", 1);
          return res.send(`${emptyRead}&api_add_screen=main`);
        }
        
        let ttsBuilder = "t-הנושאים החדשים ביותר שנפתחו בפורום. ";
        const idMapping = [];
        const maxItems = Math.min(topics.length, 9);
        
        for (let i = 0; i < maxItems; i++) {
          const topic = topics[i];
          const cleanTitle = cleanHtmlForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
          const user = topic.user ? topic.user.username : 'משתמש לא ידוע';
          
          ttsBuilder += `לנושא מספר ${i + 1}. ${cleanTitle}. מאת ${user}. הקישו ${i + 1}. `;
          idMapping.push(topic.tid);
        }
        ttsBuilder += "לחזרה לתפריט הראשי הקישו אפס.";
        
        const readCommand = buildFastMenuRead('topicsel', ttsBuilder, 1);
        const tidsString = idMapping.join('>');
        
        return res.send(`${readCommand}&api_add_screen=topics&api_add_tids=${tidsString}`);
      }
      
      if (selection === '0') {
        return res.redirect(307, `./api?screen=main&ApiPhone=${apiPhone}`);
      }
      
      const digit = parseInt(selection, 10);
      if (digit >= 1 && digit <= 9) {
        const tids = (params.api_add_tids || '').split('>');
        const targetTid = tids[digit - 1];
        if (targetTid) {
          return res.redirect(307, `./api?screen=topicview&topicId=${targetTid}&page=1&ApiPhone=${apiPhone}`);
        }
      }
      
      return res.redirect(307, `./api?screen=topics&ApiPhone=${apiPhone}`);
    }

    // ========================================================================
    // מסך 4: קטגוריות (Categories)
    // ========================================================================
    if (currentScreen === 'categories') {
      const selection = params.catsel;
      
      if (!selection) {
        const response = await fetchWithTimeout(`${FORUM_URL}/api/categories`);
        if (!response.ok) throw new Error('Forum API Categories Error');
        const data = await response.json();
        
        const categories = data.categories || [];
        // סינון קטגוריות ראשיות בלבד שאינן מוסתרות
        const mainCats = categories.filter(c => !c.parentCid);
        
        if (mainCats.length === 0) {
          const emptyRead = buildFastMenuRead('mainsel', "t-לא נמצאו קטגוריות. לחזרה לתפריט הראשי הקישו אפס.", 1);
          return res.send(`${emptyRead}&api_add_screen=main`);
        }
        
        let ttsBuilder = "t-קטגוריות הפורום. ";
        const idMapping = [];
        const maxItems = Math.min(mainCats.length, 9);
        
        for (let i = 0; i < maxItems; i++) {
          const cat = mainCats[i];
          const catName = cleanHtmlForTTS(cat.name);
          ttsBuilder += `לפורום ${catName} הקישו ${i + 1}. `;
          idMapping.push(cat.cid);
        }
        ttsBuilder += "לחזרה לתפריט הראשי הקישו אפס.";
        
        const readCommand = buildFastMenuRead('catsel', ttsBuilder, 1);
        const cidsString = idMapping.join('>');
        
        return res.send(`${readCommand}&api_add_screen=categories&api_add_cids=${cidsString}`);
      }
      
      if (selection === '0') {
        return res.redirect(307, `./api?screen=main&ApiPhone=${apiPhone}`);
      }
      
      const digit = parseInt(selection, 10);
      if (digit >= 1 && digit <= 9) {
        const cids = (params.api_add_cids || '').split('>');
        const targetCid = cids[digit - 1];
        if (targetCid) {
          return res.redirect(307, `./api?screen=categoryview&cid=${targetCid}&ApiPhone=${apiPhone}`);
        }
      }
      
      return res.redirect(307, `./api?screen=categories&ApiPhone=${apiPhone}`);
    }

    // ========================================================================
    // מסך 5: רשימת נושאים בתוך קטגוריה ספציפית
    // ========================================================================
    if (currentScreen === 'categoryview') {
      const cid = params.cid;
      const selection = params.cattopicsel;
      
      if (!cid) return res.redirect(307, `./api?screen=categories&ApiPhone=${apiPhone}`);
      
      if (!selection) {
        const response = await fetchWithTimeout(`${FORUM_URL}/api/category/${cid}`);
        if (!response.ok) throw new Error('Forum API Category View Error');
        const data = await response.json();
        
        const topics = data.topics || [];
        const categoryName = cleanHtmlForTTS(data.name || 'הנבחרת');
        
        let ttsBuilder = `t-נושאים בפורום ${categoryName}. `;
        if (topics.length === 0) {
          ttsBuilder += "אין נושאים זמינים בפורום זה. לחזרה לתפריט הקטגוריות הקישו אפס.";
          const readCommand = buildFastMenuRead('cattopicsel', ttsBuilder, 1);
          return res.send(`${readCommand}&api_add_screen=categoryview&api_add_cid=${cid}`);
        }
        
        const idMapping = [];
        const maxItems = Math.min(topics.length, 9);
        
        for (let i = 0; i < maxItems; i++) {
          const topic = topics[i];
          const cleanTitle = cleanHtmlForTTS(topic.title).substring(0, MAX_TITLE_CHARS);
          ttsBuilder += `לנושא ${cleanTitle} הקישו ${i + 1}. `;
          idMapping.push(topic.tid);
        }
        ttsBuilder += "לחזרה לתפריט הקטגוריות הקישו אפס.";
        
        const readCommand = buildFastMenuRead('cattopicsel', ttsBuilder, 1);
        const tidsString = idMapping.join('>');
        
        return res.send(`${readCommand}&api_add_screen=categoryview&api_add_cid=${cid}&api_add_tids=${tidsString}`);
      }
      
      if (selection === '0') {
        return res.redirect(307, `./api?screen=categories&ApiPhone=${apiPhone}`);
      }
      
      const digit = parseInt(selection, 10);
      if (digit >= 1 && digit <= 9) {
        const tids = (params.api_add_tids || '').split('>');
        const targetTid = tids[digit - 1];
        const activeCid = params.api_add_cid || cid;
        if (targetTid) {
          return res.redirect(307, `./api?screen=topicview&topicId=${targetTid}&page=1&returnCid=${activeCid}&ApiPhone=${apiPhone}`);
        }
      }
      
      return res.redirect(307, `./api?screen=categoryview&cid=${cid}&ApiPhone=${apiPhone}`);
    }

    // ========================================================================
    // מסך 6: שמיעת פוסטים בתוך דיון (Topic View) - ניווט מהיר פנימי
    // ========================================================================
    if (currentScreen === 'topicview') {
      const topicId = params.topicId;
      let currentPage = parseInt(params.page || '1', 10);
      let postIndex = parseInt(params.postIdx || '0', 10); // אינדקס הפוסט הנוכחי בעמוד
      const selection = params.topicnav;
      
      if (!topicId) return res.redirect(307, `./api?screen=main&ApiPhone=${apiPhone}`);
      
      // משיכת נתוני הדיון מהפורום
      const response = await fetchWithTimeout(`${FORUM_URL}/api/topic/${topicId}?page=${currentPage}`);
      if (!response.ok) throw new Error('Forum API Topic View Error');
      const data = await response.json();
      
      const posts = data.posts || [];
      const topicTitle = cleanHtmlForTTS(data.title || '');
      
      if (posts.length === 0 || postIndex >= posts.length) {
        const emptyRead = buildFastMenuRead('mainsel', "t-הגעת לסוף הדיון. לחזרה לתפריט הראשי הקישו אפס.", 1);
        return res.send(`${emptyRead}&api_add_screen=main`);
      }
      
      // אם המשתמש הקיש מקש ניווט
      if (selection) {
        if (selection === '1') { // פוסט הבא
          postIndex++;
          if (postIndex >= posts.length) {
            // אם יש עמוד הבא בפורום
            if (currentPage < data.pageCount) {
              currentPage++;
              postIndex = 0;
            } else {
              const endRead = buildFastMenuRead('topicnav', "t-זהו הפוסט האחרון בדיון זה. להודעה הקודמת הקישו 2. לחזרה לתפריט הראשי הקישו אפס.", 1);
              return res.send(`${endRead}&api_add_screen=topicview&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_postIdx=${posts.length - 1}`);
            }
          }
        } else if (selection === '2') { // פוסט קודם
          postIndex--;
          if (postIndex < 0) {
            if (currentPage > 1) {
              currentPage--;
              // טעינת העמוד הקודם ומציאת הפוסט האחרון בו
              const prevResp = await fetchWithTimeout(`${FORUM_URL}/api/topic/${topicId}?page=${currentPage}`);
              if (prevResp.ok) {
                const prevData = await prevResp.json();
                postIndex = (prevData.posts || []).length - 1;
              } else {
                postIndex = 0;
              }
            } else {
              postIndex = 0; // נשארים בראשון
            }
          }
        } else if (selection === '0') {
          if (params.returnCid) {
            return res.redirect(307, `./api?screen=categoryview&cid=${params.returnCid}&ApiPhone=${apiPhone}`);
          }
          return res.redirect(307, `./api?screen=main&ApiPhone=${apiPhone}`);
        }
      }
      
      // שליפת הפוסט הנוכחי להקראה
      const currentPost = posts[postIndex];
      const author = currentPost.user ? currentPost.user.username : 'משתמש';
      const rawContent = currentPost.content || '';
      const cleanContent = cleanHtmlForTTS(rawContent).substring(0, MAX_BODY_CHARS);
      
      // הרכבת ה-TTS המלא של הפוסט יחד עם תפריט הניווט הפנימי שלו בתוך ה-Read
      let postTTS = "";
      if (postIndex === 0 && currentPage === 1 && !selection) {
        postTTS += `תחילת נושא: ${topicTitle}. `;
      }
      
      postTTS += `הודעה מאת ${author}: ${cleanContent}. `;
      postTTS += "להודעה הבאה הקישו 1. להודעה הקודמת הקישו 2. לחזרה לתפריט הקודם הקישו אפס.";
      
      const readCommand = buildFastMenuRead('topicnav', postTTS, 1);
      
      let returnParams = `&api_add_screen=topicview&api_add_tid=${topicId}&api_add_page=${currentPage}&api_add_postIdx=${postIndex}`;
      if (params.returnCid) returnParams += `&api_add_returnCid=${params.returnCid}`;
      
      return res.send(`${readCommand}${returnParams}`);
    }

    // הגנת קצה למקרה של מצב מסך לא מזוהה - החזרה בטוחה לתפריט הראשי
    console.warn(`[Fallback] Unhandled screen state: ${currentScreen}.`);
    const fallbackRead = buildFastMenuRead('mainsel', "t-מערכת חזרה לתפריט הראשי.", 1);
    return res.send(`${fallbackRead}&api_add_screen=main`);

  } catch (globalError) {
    console.error(`[Global Error] ${globalError.message}`, globalError);
    // במקרה של שגיאת רשת קשה - מאפשרים למחייג לנסות שוב על ידי הקשה כלשהי
    const errorRead = buildFastMenuRead('mainsel', "t-חלה שגיאה בתקשורת עם שרתי הפורום. אנא נסו שנית מאוחר יותר. הקישו מקש כלשהו לחזרה.", 1);
    return res.send(`${errorRead}&api_add_screen=main`);
  }
});

// הפעלת השרת המקומי (לסביבות שאינן Serverless במידת הצורך)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Advanced Forum IVR API running perfectly on port ${PORT}`);
});

export default app;
