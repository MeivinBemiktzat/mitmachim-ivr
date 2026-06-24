// ============================================================================
// api/index.js
// מודול API טלפוני מתקדם עבור פורום מתמחים טופ הטלפוני (NodeBB)
// עבור מערכות ה-IVR של ימות המשיח
//
// גרסה 5.0 — תיקון יסודי + שכלולים
//
// תיקונים מרכזיים מול v4.0:
//   1. תוקן באג שמירת ה-state: ימות המשיח לא החזיר את api_add_tids בין בקשות.
//      הסיבה: שילוב מפריד ">" בערך גרם לשיבוש. המעבר למפריד "." (נקודה)
//      בלבד + שימוש נכון בפורמט api_add_X פתר את הבעיה.
//   2. הוסר לחלוטין פיצ'ר החיפוש בפורום (screen=search/searchresults/searchsel/searchquery).
//   3. שופר ניהול ה-state כך שכל מסך זוכר את ההקשר שלו (cid, page וכו').
//   4. נוספו: ניווט עמודים בפוסטים אחרונים, חזרה אחורה חכמה,
//      קיצורי דרך אחידים, הודעות ברורות יותר, וטיפול שגיאות עמיד.
//
// עקרון הפרוטוקול:
//   ApiAnswer מפריד פרמטרים ב-& וזוגות שם=ערך ב-= (ימות ממירה פנימית ל-* ו-^).
//   שדות api_add_X שמוחזרים בתשובה נשמרים ומוחזרים אלינו בבקשה הבאה כ-X=value.
//   חובה: ערכי state לא יכילו את התווים . , = & * ^ > כי הם מפרידי פרוטוקול.
//   לכן IDs מאוחסנים מופרדים בנקודה "." (בטוח, כי IDs הם ספרות בלבד).
// ============================================================================

const FORUM_URL       = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 350;
const MAX_BODY_CHARS  = 950;
const DEFAULT_TIMEOUT = 9000;
const PAGE_SIZE       = 9;   // כמות פריטים בעמוד רשימה

// ============================================================================
// עזרי state ופרוטוקול
// ============================================================================

// פיצול מזהים — מפריד יחיד ובטוח: נקודה. (תומך גם ב->,, לתאימות אחורה)
function splitIds(raw) {
  if (!raw) return [];
  return String(raw).split(/[.>,]/).map(x => x.trim()).filter(x => /^\d+$/.test(x));
}

// איחוד מזהים למחרוזת state בטוחה
function joinIds(ids) {
  return (ids || []).map(x => String(x).trim()).filter(x => x !== '').join('.');
}

// קריאת ערך state (ימות מחזירה את api_add_X בשם X בבקשה הבאה; בודקים את שניהם)
function getState(q, key) {
  if (q[key] !== undefined && q[key] !== '') return q[key];
  if (q['api_add_' + key] !== undefined) return q['api_add_' + key];
  return '';
}

// ============================================================================
// תקשורת מול NodeBB Read API
// ============================================================================

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
        'User-Agent': 'yemot-nodebb-bridge-ivr/5.0',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`NodeBB HTTP ${res.status}`);
    const data = await res.json();
    if (!data) throw new Error('Empty JSON response');
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[Fetch Exception] ${url} →`, error.message);
    throw error;
  }
}

// ============================================================================
// עיבוד טקסט ל-TTS
// ============================================================================

function cleanText(html) {
  if (!html) return '';
  let text = String(html);
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' [ציטוט] ');
  text = text.replace(/<code[\s\S]*?<\/code>/gi, ' [קוד] ');
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, ' [קוד] ');
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
  text = text.replace(/&#x27;/gi, ' ').replace(/&x27;/gi, ' ');
  text = text.replace(/https?:\/\/\S+/gi, ' [קישור] ');
  // הסרת תווים שמשבשים את פרוטוקול ימות (כולל מפרידי ה-read: . - = * # ^ > & /)
  text = text.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function ttsCut(text, max) {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + ' ';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1)  return 'לפני פחות מדקה';
  if (minutes < 60) return 'לפני ' + minutes + ' דקות';
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'לפני שעה';
  if (hours === 2) return 'לפני שעתיים';
  if (hours < 24)  return 'לפני ' + hours + ' שעות';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'אתמול';
  if (days === 2) return 'לפני יומיים';
  if (days < 30)  return 'לפני ' + days + ' ימים';
  const months = Math.floor(days / 30);
  if (months === 1) return 'לפני חודש';
  if (months === 2) return 'לפני חודשיים';
  if (months < 12)  return 'לפני ' + months + ' חודשים';
  return 'לפני יותר משנה';
}

// ============================================================================
// בניית פקודות ימות המשיח
// ============================================================================

// ניקוי חלק טקסט בודד מתווי פרוטוקול
function sanitizePart(part) {
  return String(part)
    .replace(/[.,=&*^>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// פקודת read שמשמיעה prompt וקולטת הקשה (barge-in)
function buildReadMenu(parts, paramName, opts = {}) {
  const min     = opts.min ?? 1;
  const max     = opts.max ?? 1;
  const waitSec = opts.waitSec ?? 7;
  const type    = opts.type || 'Digits';
  const promptStr = parts
    .filter(p => p && String(p).trim())
    .map(p => 't-' + sanitizePart(p))
    .join('.');
  return `read=${promptStr}=${paramName},no,${max},${min},${waitSec},${type},no,no`;
}

// read "שקט" קצר למעברי מסך פנימיים
function buildSilentRead(text) {
  const t = sanitizePart(text || 'טוען');
  return `read=t-${t}=dummy,no,1,1,2,Digits,no,no`;
}

// ============================================================================
// בניית רשימות תוכן
// ============================================================================

function buildTopicListParts(topics, headerText, footerText, startIndex = 0) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים להצגה');
    return parts;
  }
  topics.forEach((tp, i) => {
    const num      = i + 1;
    const title    = ttsCut(tp.title, MAX_TITLE_CHARS);
    const username = tp.user && tp.user.username ? tp.user.username : 'משתמש';
    const replies  = tp.postcount ? tp.postcount - 1 : 0;
    parts.push(`לנושא מספר ${num}`);
    parts.push(title);
    parts.push(`מאת ${username}`);
    if (replies > 0) parts.push(`${replies} תגובות`);
    parts.push(`הקישו ${num}`);
  });
  if (footerText) parts.push(footerText);
  return parts;
}

function buildCategoryListParts(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!cats || cats.length === 0) {
    parts.push('לא נמצאו קטגוריות זמינות');
    return parts;
  }
  cats.forEach((c, i) => {
    const num  = i + 1;
    const name = cleanText(c.name);
    const cnt  = c.topic_count || c.totalTopicCount || 0;
    parts.push(`לקטגוריה מספר ${num}`);
    parts.push(name);
    if (cnt > 0) parts.push(`${cnt} נושאים`);
    parts.push(`הקישו ${num}`);
  });
  return parts;
}

// ============================================================================
// בניית תגובות מלאות
// ============================================================================

// בונה תגובה: פקודת read + שדות state בפורמט api_add_X=value
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd;
  for (const key in stateParams) {
    const val = stateParams[key];
    if (val === undefined || val === null) continue;
    out += `&api_add_${key}=${val}`;
  }
  console.log(`[v0] buildResponse: ${out.substring(0, 220)}`);
  return out;
}

// מעבר מסך "שקט" עם שמירת state
function buildTransition(text, stateParams = {}) {
  return buildResponse(buildSilentRead(text), stateParams);
}

// ============================================================================
// הראוטר המרכזי
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') Object.assign(q, req.body);

  console.log(`[IVR Request] screen=${getState(q, 'screen')}, query=`, JSON.stringify(q));

  let currentScreen = getState(q, 'screen') || 'main';

  try {
    // ====================================================================
    // שלב א': עיבוד הקשות
    // ====================================================================

    // ---- תפריט ראשי ----
    if (q.mainsel !== undefined && q.mainsel !== '') {
      const sel = String(q.mainsel).trim();
      if      (sel === '1') currentScreen = 'recent';
      else if (sel === '2') currentScreen = 'topics';
      else if (sel === '3') currentScreen = 'categories';
      else {
        const readCmd = buildReadMenu([
          'המקש שהוקש שגוי אנא נסו שנית',
          'לפוסטים האחרונים הקישו 1',
          'לנושאים החדשים הקישו 2',
          'לקטגוריות הקישו 3'
        ], 'mainsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { screen: 'main' }));
      }
    }

    // ---- פוסטים אחרונים ----
    if (q.recentsel !== undefined && q.recentsel !== '') {
      const sel      = String(q.recentsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      const page     = parseInt(getState(q, 'rpage') || '0', 10);

      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        return res.send(buildTransition('עמוד הבא', { screen: 'recent', rpage: page + 1 }));
      } else if (sel === '#') {
        return res.send(buildTransition('עמוד קודם', { screen: 'recent', rpage: Math.max(0, page - 1) }));
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען נושא', { screen: 'topic', tid: topicIds[index], page: 0 }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          'אנא הקישו מספר נושא מהרשימה',
          'לעמוד הבא הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'recentsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { tids: joinIds(topicIds), rpage: page, screen: 'recent' }));
      }
    }

    // ---- נושאים חדשים ----
    if (q.topicsel !== undefined && q.topicsel !== '') {
      const sel      = String(q.topicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        currentScreen = 'topics';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', { screen: 'topic', tid: topicIds[index], page: 0 }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          'אנא הקישו מספר נושא מהרשימה',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { tids: joinIds(topicIds), screen: 'topics' }));
      }
    }

    // ---- קטגוריות ----
    if (q.catsel !== undefined && q.catsel !== '') {
      const sel         = String(q.catsel).trim();
      const currentCid  = getState(q, 'curcid');
      const categoryIds = splitIds(getState(q, 'cids'));
      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        if (currentCid) {
          return res.send(buildTransition('טוען נושאים בקטגוריה', { screen: 'cattopics', cid: currentCid, page: 1 }));
        }
        currentScreen = 'categories';
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < categoryIds.length) {
          return res.send(buildTransition('טוען קטגוריה', { screen: 'categories', cid: categoryIds[index] }));
        }
        const readCmd = buildReadMenu([
          'בחירה לא תקינה',
          'אנא הקישו מספר קטגוריה מהרשימה',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'catsel', { waitSec: 7 });
        return res.send(buildResponse(readCmd, { cids: joinIds(categoryIds), curcid: currentCid || '', screen: 'categories' }));
      }
    }

    // ---- נושאים בתוך קטגוריה ----
    if (q.cattopicsel !== undefined && q.cattopicsel !== '') {
      const sel      = String(q.cattopicsel).trim();
      const topicIds = splitIds(getState(q, 'tids'));
      const cid      = getState(q, 'cid');
      const catPage  = parseInt(getState(q, 'catpage') || '1', 10);
      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '*') {
        return res.send(buildTransition('עמוד הבא', { screen: 'cattopics', cid: cid, page: catPage + 1 }));
      } else if (sel === '#') {
        return res.send(buildTransition('עמוד קודם', { screen: 'cattopics', cid: cid, page: Math.max(1, catPage - 1) }));
      } else {
        const index = parseInt(sel, 10) - 1;
        if (!isNaN(index) && index >= 0 && index < topicIds.length) {
          return res.send(buildTransition('טוען', { screen: 'topic', tid: topicIds[index], page: 0 }));
        }
        const readCmd = buildReadMenu([
          'בחירה שגויה',
          'אנא הקישו מספר נושא מהרשימה'
        ], 'cattopicsel', { waitSec: 6 });
        return res.send(buildResponse(readCmd, { tids: joinIds(topicIds), cid: cid, catpage: catPage, screen: 'cattopics' }));
      }
    }

    // ---- ניווט בתוך נושא ----
    if (q.topicnav !== undefined && q.topicnav !== '') {
      const sel         = String(q.topicnav).trim();
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);
      if (sel === '0') {
        currentScreen = 'main';
      } else if (sel === '1') {
        return res.send(buildTransition('ההודעה הבאה', { screen: 'topic', tid: topicId, page: currentPage + 1 }));
      } else if (sel === '2') {
        return res.send(buildTransition('ההודעה הקודמת', { screen: 'topic', tid: topicId, page: Math.max(0, currentPage - 1) }));
      } else if (sel === '3') {
        const details = String(getState(q, 'details') || '').split('|').filter(x => x);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        const readCmd = buildReadMenu(details, 'detback', { waitSec: 6 });
        return res.send(buildResponse(readCmd, { screen: 'detback', tid: topicId, page: currentPage }));
      } else if (sel === '5') {
        return res.send(buildTransition('חוזר לתחילת הנושא', { screen: 'topic', tid: topicId, page: 0 }));
      } else {
        return res.send(buildTransition('בחירה שגויה', { screen: 'topic', tid: topicId, page: currentPage }));
      }
    }

    // ---- חזרה מפרטי הודעה ----
    if (q.detback !== undefined && q.detback !== '') {
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);
      return res.send(buildTransition('חוזר להודעה', { screen: 'topic', tid: topicId, page: currentPage }));
    }

    // ---- סיום נושא ----
    if (q.topicend !== undefined && q.topicend !== '') {
      const sel     = String(q.topicend).trim();
      const topicId = getState(q, 'tid');
      if (sel === '1') {
        return res.send(buildTransition('מתחילים מחדש', { screen: 'topic', tid: topicId, page: 0 }));
      }
      currentScreen = 'main';
    }

    // ====================================================================
    // שלב ב': הפקת מסכים
    // ====================================================================

    // ===== תפריט ראשי =====
    if (currentScreen === 'main') {
      const readCmd = buildReadMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'mainsel', { waitSec: 7 });
      return res.send(buildResponse(readCmd, { screen: 'main' }));
    }

    // ===== פוסטים אחרונים (עם עימוד) =====
    if (currentScreen === 'recent') {
      const page = Math.max(0, parseInt(getState(q, 'rpage') || '0', 10));
      const data = await nbFetch('/recent');
      const all  = data.topics || [];
      const slice = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

      if (slice.length === 0 && page > 0) {
        return res.send(buildTransition('אין עמוד נוסף חוזר לעמוד הראשון', { screen: 'recent', rpage: 0 }));
      }

      const footer = [];
      if (page > 0) footer.push('לעמוד הקודם הקישו סולמית');
      if (page * PAGE_SIZE + PAGE_SIZE < all.length) footer.push('לעמוד הבא הקישו כוכבית');
      footer.push('לחזרה לתפריט הראשי הקישו אפס');

      const header = page === 0 ? 'הפוסטים האחרונים בפורום' : `הפוסטים האחרונים עמוד ${page + 1}`;
      const parts  = buildTopicListParts(slice, header, footer.join(' '));
      const readCmd = buildReadMenu(parts, 'recentsel', { waitSec: 9 });
      return res.send(buildResponse(readCmd, { tids: joinIds(slice.map(t => t.tid)), rpage: page, screen: 'recent' }));
    }

    // ===== נושאים חדשים =====
    if (currentScreen === 'topics') {
      let data;
      try { data = await nbFetch('/recent?term=alltime&sort=newest'); }
      catch (e) { data = await nbFetch('/recent'); }
      const topics = (data.topics || [])
        .slice()
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, PAGE_SIZE);
      const parts = buildTopicListParts(topics, 'הנושאים החדשים ביותר שנפתחו בפורום',
        'לרענון הרשימה הקישו כוכבית לחזרה לתפריט הראשי הקישו אפס');
      const readCmd = buildReadMenu(parts, 'topicsel', { waitSec: 9 });
      return res.send(buildResponse(readCmd, { tids: joinIds(topics.map(t => t.tid)), screen: 'topics' }));
    }

    // ===== קטגוריות =====
    if (currentScreen === 'categories') {
      const cid = getState(q, 'cid');
      let categoriesList = [];
      let headerText = '';
      if (!cid) {
        const data = await nbFetch('/categories');
        categoriesList = (data.categories || []).filter(c => !c.disabled).slice(0, PAGE_SIZE);
        headerText = 'תפריט קטגוריות ראשיות';
      } else {
        const data = await nbFetch('/category/' + cid);
        const parentName = cleanText(data.name || '');
        categoriesList = (data.children || []).filter(c => !c.disabled).slice(0, PAGE_SIZE);
        headerText = 'קטגוריית ' + parentName;
      }

      if (categoriesList.length > 0) {
        const parts = buildCategoryListParts(categoriesList, headerText);
        if (cid) parts.push('לנושאים בקטגוריה זו הקישו כוכבית');
        parts.push('לחזרה לתפריט הראשי הקישו אפס');
        const readCmd = buildReadMenu(parts, 'catsel', { waitSec: 9 });
        return res.send(buildResponse(readCmd, { cids: joinIds(categoriesList.map(c => c.cid)), curcid: cid || '', screen: 'categories' }));
      } else if (cid) {
        return res.send(buildTransition('טוען נושאים', { screen: 'cattopics', cid: cid, page: 1 }));
      } else {
        return res.send(buildResponse(buildSilentRead('לא נמצאו קטגוריות חוזר לתפריט'), { screen: 'main' }));
      }
    }

    // ===== נושאים בתוך קטגוריה =====
    if (currentScreen === 'cattopics') {
      const cid     = getState(q, 'cid');
      const catPage = Math.max(1, parseInt(getState(q, 'page') || getState(q, 'catpage') || '1', 10));
      if (!cid) return res.send(buildTransition('שגיאה חוזר לתפריט', { screen: 'main' }));

      const data    = await nbFetch('/category/' + cid + '?page=' + catPage);
      const topics  = (data.topics || []).slice(0, PAGE_SIZE);
      const catName = cleanText(data.name || '');

      if (topics.length === 0 && catPage > 1) {
        return res.send(buildTransition('אין עמוד נוסף', { screen: 'cattopics', cid: cid, page: catPage - 1 }));
      }

      const footer = [];
      if (catPage > 1) footer.push('לעמוד הקודם הקישו סולמית');
      if (topics.length === PAGE_SIZE) footer.push('לעמוד הבא הקישו כוכבית');
      footer.push('לתפריט הראשי הקישו אפס');

      const parts = buildTopicListParts(topics, `נושאים בקטגוריית ${catName} עמוד ${catPage}`, footer.join(' '));
      const readCmd = buildReadMenu(parts, 'cattopicsel', { waitSec: 9 });
      return res.send(buildResponse(readCmd, { tids: joinIds(topics.map(t => t.tid)), cid: cid, catpage: catPage, screen: 'cattopics' }));
    }

    // ===== שמיעת נושא =====
    if (currentScreen === 'topic') {
      const topicId     = getState(q, 'tid');
      const currentPage = parseInt(getState(q, 'page') || '0', 10);
      if (!topicId) return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));

      const data       = await nbFetch('/topic/' + topicId);
      const posts      = data.posts || [];
      const topicTitle = ttsCut(data.title, MAX_TITLE_CHARS);

      if (currentPage >= posts.length) {
        const readCmd = buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          `הנושא כולל ${posts.length} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 8 });
        return res.send(buildResponse(readCmd, { tid: topicId, screen: 'topicend' }));
      }

      const currentPost = posts[currentPage];
      const postBody    = ttsCut(currentPost.content, MAX_BODY_CHARS);
      const authorName  = currentPost.user && currentPost.user.username ? currentPost.user.username : 'משתמש הפורום';

      const audioParts = [];
      if (currentPage === 0) {
        audioParts.push('כותרת הנושא היא ' + topicTitle);
        audioParts.push(`הנושא מכיל ${posts.length} הודעות`);
      }
      audioParts.push(`הודעה מספר ${currentPage + 1} מתוך ${posts.length}`);
      audioParts.push(`נכתבה על ידי ${authorName}`);
      audioParts.push(postBody);
      audioParts.push('להודעה הבאה הקישו 1');
      audioParts.push('להודעה הקודמת הקישו 2');
      audioParts.push('לפרטי ההודעה הקישו 3');
      audioParts.push('לתחילת הנושא הקישו 5');
      audioParts.push('לתפריט הראשי הקישו אפס');

      const postDetails = [
        `פרטי הודעה ${currentPage + 1}`,
        `מחבר ${authorName}`,
        `פורסם ${timeAgo(currentPost.timestamp)}`,
        `סך הכל ${data.postcount || posts.length} הודעות בדיון`
      ];
      const detailsSafe = postDetails.map(d => sanitizePart(d)).join('|');

      const readCmd = buildReadMenu(audioParts, 'topicnav', { waitSec: 15 });
      return res.send(buildResponse(readCmd, { tid: topicId, page: currentPage, screen: 'topic', details: detailsSafe }));
    }

    // ===== הגנת קצה =====
    console.warn(`[Fallback] Unhandled screen: ${currentScreen}`);
    return res.send(buildTransition('חוזר להתחלה', { screen: 'main' }));

  } catch (globalError) {
    console.error('[Global Exception]', globalError.message);
    const readCmd = buildReadMenu([
      'אירעה שגיאה בטעינת הנתונים מהפורום',
      'אנא נסו שוב מאוחר יותר'
    ], 'mainsel', { waitSec: 5 });
    return res.send(buildResponse(readCmd, { screen: 'main' }));
  }
};
