// ============================================================================
// api/index.js  —  מודול API טלפוני עבור פורום מתמחים טופ (NodeBB)  v7.0
// ----------------------------------------------------------------------------
//  *** התיקון הקריטי (v7.0) ***
//  מנוע read של ימות צובר את כל ההקשות הישנות ושולח אותן שוב בכל בקשה
//  (ראינו בלוג: mainsel הופיע 6 פעמים). לכן אסור לבדוק את כל שמות ההקשה –
//  חובה לקרוא אך ורק את ההקשה ששייכת ל-screen הנוכחי, ותמיד לקחת את
//  הערך האחרון (lastVal). זה מה שגרם ל"בחירה שגויה" בכניסה לפוסט/נושא/קטגוריה.
//
//  *** הוסר לחלוטין פיצ'ר החיפוש ***
// ============================================================================

const FORUM_URL       = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS  = 950;
const DEFAULT_TIMEOUT = 9000;
const LIST_SIZE       = 9;
const NB_PAGE_SIZE    = 20;
const ID_SEP          = 'x';

// ============================================================================
// עזרי state / פרמטרים
// ============================================================================

function splitIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw).split(/[x>,]/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
}
function joinIds(ids) {
  if (!ids || !ids.length) return '';
  return ids.map(x => String(x).trim()).filter(Boolean).join(ID_SEP);
}
function getState(q, key) {
  let val = q[key];
  if (Array.isArray(val)) val = val[val.length - 1];
  return val === undefined || val === null ? '' : String(val);
}
// תמיד הערך האחרון – כי ימות צובר הקשות ושולח מערך
function lastVal(val) {
  if (Array.isArray(val)) return val.length ? String(val[val.length - 1]) : '';
  return val === undefined || val === null ? '' : String(val);
}
function pressed(val) {
  const v = lastVal(val);
  return v !== '';
}

// ============================================================================
// תקשורת מול NodeBB Read API
// ============================================================================

async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET', signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'yemot-nodebb-bridge-ivr/7.0',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`NodeBB HTTP ${res.status}`);
    const data = await res.json();
    if (!data) throw new Error('Empty JSON');
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(`[Fetch Error] ${url} -> ${e.message}`);
    throw e;
  }
}
async function fetchTopicPost(tid, postIndex) {
  const nbPage = Math.floor(postIndex / NB_PAGE_SIZE) + 1;
  const data   = await nbFetch('/topic/' + tid + '?page=' + nbPage);
  const posts  = data.posts || [];
  const totalPosts = data.postcount || posts.length;
  const relativeIndex = postIndex - (nbPage - 1) * NB_PAGE_SIZE;
  return { topic: data, post: posts[relativeIndex] || null, totalPosts };
}

// ============================================================================
// עיבוד טקסט ל-TTS
// ============================================================================

function cleanText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ציטוט ');
  t = t.replace(/<code[\s\S]*?<\/code>/gi, ' קטע קוד ').replace(/<pre[\s\S]*?<\/pre>/gi, ' קטע קוד ');
  t = t.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, '. ').replace(/<\/div>/gi, '. ');
  t = t.replace(/<\/li>/gi, '. ').replace(/<\/h[1-6]>/gi, '. ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, ' ו ').replace(/&quot;/gi, ' ');
  t = t.replace(/&#39;|&apos;|&#x27;|&x27;/gi, ' ').replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');
  t = t.replace(/https?:\/\/\S+/gi, ' קישור ');
  t = t.replace(/[._\-+=*#@^~`|<>\\\/\[\]{}]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}
function ttsCut(text, max) {
  const c = cleanText(text);
  return c.length <= max ? c : c.slice(0, max) + ' ';
}
function timeAgo(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - Number(ts)) / 60000);
  if (m < 1) return 'לפני פחות מדקה';
  if (m < 60) return 'לפני ' + m + ' דקות';
  const h = Math.floor(m / 60);
  if (h === 1) return 'לפני שעה';
  if (h === 2) return 'לפני שעתיים';
  if (h < 24) return 'לפני ' + h + ' שעות';
  const d = Math.floor(h / 24);
  if (d === 1) return 'אתמול';
  if (d === 2) return 'לפני יומיים';
  if (d < 30) return 'לפני ' + d + ' ימים';
  const mo = Math.floor(d / 30);
  if (mo === 1) return 'לפני חודש';
  if (mo === 2) return 'לפני חודשיים';
  if (mo < 12) return 'לפני ' + mo + ' חודשים';
  return 'לפני יותר משנה';
}

// ============================================================================
// בניית פקודות ימות
// ============================================================================

function sanitizePart(part) {
  return String(part).replace(/[.,\-_=+&*^>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// read מלא עם 15 פרמטרים, פרמטר 15="no" => ללא בקשת אישור
function buildReadMenu(parts, paramName, opts = {}) {
  const min = opts.min ?? 1, max = opts.max ?? 1, waitSec = opts.waitSec ?? 7;
  const type = opts.type || 'Digits';
  const blockStar = opts.blockStar || 'no', blockZero = opts.blockZero || 'no';
  const cleanParts = parts.filter(p => p && String(p).trim()).map(sanitizePart);
  const promptStr = 't-' + cleanParts.join('. ');
  const readParams = [paramName,'no',max,min,waitSec,type,blockStar,blockZero,'','','','','','','no'];
  return `read=${promptStr}=${readParams.join(',')}`;
}
function buildSilentRead(text) {
  return `read=t-${sanitizePart(text || 'טוען')}=dummy,no,1,1,1,Digits,no,no,,,,,,,no`;
}

// ============================================================================
// בניית רשימות
// ============================================================================

function buildTopicListParts(topics, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!topics || !topics.length) {
    parts.push('לא נמצאו נושאים להצגה');
    if (footerText) parts.push(footerText);
    return parts;
  }
  topics.forEach((tp, i) => {
    const num = i + 1;
    parts.push(`נושא מספר ${num}`);
    parts.push(ttsCut(tp.title, MAX_TITLE_CHARS));
    parts.push(`מאת ${tp.user && tp.user.username ? tp.user.username : 'משתמש'}`);
    const replies = tp.postcount ? Math.max(0, tp.postcount - 1) : 0;
    if (replies === 1) parts.push('תגובה אחת');
    else if (replies > 1) parts.push(`${replies} תגובות`);
    else parts.push('ללא תגובות');
    parts.push(`להאזנה הקישו ${num}`);
  });
  if (footerText) parts.push(footerText);
  return parts;
}
function buildCategoryListParts(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!cats || !cats.length) { parts.push('לא נמצאו קטגוריות זמינות'); return parts; }
  cats.forEach((c, i) => {
    const num = i + 1;
    parts.push(`קטגוריה מספר ${num}`);
    parts.push(cleanText(c.name));
    const cnt = c.topic_count || c.totalTopicCount || 0;
    if (cnt > 0) parts.push(`${cnt} נושאים`);
    parts.push(`לכניסה הקישו ${num}`);
  });
  return parts;
}

// ============================================================================
// בניית תגובה + שמירת state (api_add_<INDEX>=key=value)
// ============================================================================

function sanitizeStateValue(val) {
  return String(val).replace(/[=>*&^.,]/g, '');
}
function buildResponse(readCmd, stateParams = {}) {
  let out = readCmd, index = 0;
  for (const key in stateParams) {
    let val = stateParams[key];
    if (val === undefined || val === null) continue;
    out += `&api_add_${index}=${key}=${sanitizeStateValue(val)}`;
    index++;
  }
  console.log(`[resp] ${out.substring(0, 220)}`);
  return out;
}
function buildTransition(text, stateParams = {}) {
  return buildResponse(buildSilentRead(text), stateParams);
}

// ============================================================================
// Handler
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') Object.assign(q, req.body);

  // המסך הנוכחי קובע איזו הקשה נקרא. כל שאר ההקשות הישנות – מתעלמים מהן!
  const screen = getState(q, 'screen') || 'main';
  console.log(`[REQ] screen=${screen}`);

  try {
    // ========================================================================
    // שלב א': טיפול בהקשה — אך ורק לפי המסך הנוכחי (זה התיקון הקריטי)
    // ========================================================================
    let nextScreen = null;

    // ---------- תפריט ראשי ----------
    if (screen === 'main' && pressed(q.mainsel)) {
      const sel = lastVal(q.mainsel).trim();
      if (sel === '1') nextScreen = 'recent';
      else if (sel === '2') nextScreen = 'topics';
      else if (sel === '3') nextScreen = 'categories';
      else {
        return res.send(buildResponse(buildReadMenu([
          'הבחירה שגויה אנא נסו שנית',
          'לפוסטים האחרונים הקישו 1',
          'לנושאים החדשים שנפתחו הקישו 2',
          'לכניסה לפי קטגוריות הקישו 3'
        ], 'mainsel', { waitSec: 8 }), { screen: 'main' }));
      }
    }

    // ---------- פוסטים אחרונים ----------
    else if (screen === 'recent' && pressed(q.recentsel)) {
      const sel = lastVal(q.recentsel).trim();
      const ids = splitIds(getState(q, 'tids'));
      if (sel === '0') nextScreen = 'main';
      else if (sel === '*') nextScreen = 'recent';
      else {
        const idx = parseInt(sel, 10) - 1;
        if (idx >= 0 && idx < ids.length) {
          return res.send(buildTransition('טוען את הנושא', { screen: 'topic', tid: ids[idx], pidx: '0' }));
        }
        return res.send(buildResponse(buildReadMenu([
          'בחירה לא תקינה',
          ids.length ? 'אנא הקישו מספר בין 1 ל ' + ids.length : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'recentsel', { waitSec: 8 }), { tids: joinIds(ids), screen: 'recent' }));
      }
    }

    // ---------- נושאים חדשים ----------
    else if (screen === 'topics' && pressed(q.topicsel)) {
      const sel = lastVal(q.topicsel).trim();
      const ids = splitIds(getState(q, 'tids'));
      if (sel === '0') nextScreen = 'main';
      else if (sel === '*') nextScreen = 'topics';
      else {
        const idx = parseInt(sel, 10) - 1;
        if (idx >= 0 && idx < ids.length) {
          return res.send(buildTransition('מיד נשמע את הנושא', { screen: 'topic', tid: ids[idx], pidx: '0' }));
        }
        return res.send(buildResponse(buildReadMenu([
          'בחירה לא תקינה',
          ids.length ? 'אנא הקישו מספר בין 1 ל ' + ids.length : 'הרשימה אינה זמינה כעת',
          'לרענון הרשימה הקישו כוכבית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicsel', { waitSec: 8 }), { tids: joinIds(ids), screen: 'topics' }));
      }
    }

    // ---------- קטגוריות ----------
    else if (screen === 'categories' && pressed(q.catsel)) {
      const sel = lastVal(q.catsel).trim();
      const curcid = getState(q, 'curcid');
      const cids = splitIds(getState(q, 'cids'));
      if (sel === '0') nextScreen = 'main';
      else if (sel === '*') {
        if (curcid) return res.send(buildTransition('טוען נושאים בקטגוריה', { screen: 'cattopics', cid: curcid, catpage: '1' }));
        nextScreen = 'categories';
      } else {
        const idx = parseInt(sel, 10) - 1;
        if (idx >= 0 && idx < cids.length) {
          return res.send(buildTransition('טוען קטגוריה', { screen: 'categories', cid: cids[idx] }));
        }
        return res.send(buildResponse(buildReadMenu([
          'בחירה לא תקינה',
          cids.length ? 'אנא הקישו מספר בין 1 ל ' + cids.length : 'הרשימה אינה זמינה כעת',
          curcid ? 'לשמיעת הנושאים בקטגוריה זו הקישו כוכבית' : '',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'catsel', { waitSec: 9 }), { cids: joinIds(cids), curcid: curcid || '', screen: 'categories' }));
      }
    }

    // ---------- נושאים בתוך קטגוריה ----------
    else if (screen === 'cattopics' && pressed(q.cattopicsel)) {
      const sel = lastVal(q.cattopicsel).trim();
      const ids = splitIds(getState(q, 'tids'));
      const cid = getState(q, 'cid');
      const catpage = parseInt(getState(q, 'catpage') || '1', 10);
      if (sel === '0') nextScreen = 'main';
      else if (sel === '*') return res.send(buildTransition('עמוד הבא', { screen: 'cattopics', cid, catpage: String(catpage + 1) }));
      else if (sel === '#') return res.send(buildTransition('עמוד קודם', { screen: 'cattopics', cid, catpage: String(Math.max(1, catpage - 1)) }));
      else {
        const idx = parseInt(sel, 10) - 1;
        if (idx >= 0 && idx < ids.length) {
          return res.send(buildTransition('טוען את הנושא', { screen: 'topic', tid: ids[idx], pidx: '0' }));
        }
        return res.send(buildResponse(buildReadMenu([
          'בחירה שגויה',
          ids.length ? 'אנא הקישו מספר בין 1 ל ' + ids.length : 'הרשימה אינה זמינה כעת',
          'לעמוד הבא הקישו כוכבית. לעמוד הקודם הקישו סולמית',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'cattopicsel', { waitSec: 9 }), { tids: joinIds(ids), cid, catpage: String(catpage), screen: 'cattopics' }));
      }
    }

    // ---------- ניווט בתוך נושא ----------
    else if (screen === 'topic' && pressed(q.topicnav)) {
      const sel = lastVal(q.topicnav).trim();
      const tid = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      if (sel === '0') nextScreen = 'main';
      else if (sel === '1') return res.send(buildTransition('ההודעה הבאה', { screen: 'topic', tid, pidx: String(pidx + 1) }));
      else if (sel === '2') return res.send(buildTransition('ההודעה הקודמת', { screen: 'topic', tid, pidx: String(Math.max(0, pidx - 1)) }));
      else if (sel === '3') return res.send(buildTransition('משמיע שוב', { screen: 'topic', tid, pidx: String(pidx) }));
      else if (sel === '4') return res.send(buildTransition('מדלג חמש הודעות קדימה', { screen: 'topic', tid, pidx: String(pidx + 5) }));
      else if (sel === '5') return res.send(buildTransition('חוזר לתחילת הנושא', { screen: 'topic', tid, pidx: '0' }));
      else if (sel === '6') {
        const details = String(getState(q, 'details') || '').split('|').filter(Boolean);
        details.push('לחזרה לשמיעת ההודעה הקישו 1');
        return res.send(buildResponse(buildReadMenu(details, 'detback', { waitSec: 7 }), { screen: 'detback', tid, pidx: String(pidx) }));
      } else {
        return res.send(buildTransition('בחירה שגויה', { screen: 'topic', tid, pidx: String(pidx) }));
      }
    }

    // ---------- חזרה מפרטי הודעה ----------
    else if (screen === 'detback' && pressed(q.detback)) {
      const tid = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      return res.send(buildTransition('חוזר להודעה', { screen: 'topic', tid, pidx: String(pidx) }));
    }

    // ---------- סיום נושא ----------
    else if (screen === 'topicend' && pressed(q.topicend)) {
      const sel = lastVal(q.topicend).trim();
      const tid = getState(q, 'tid');
      if (sel === '1') return res.send(buildTransition('מתחילים מחדש', { screen: 'topic', tid, pidx: '0' }));
      else if (sel === '2') nextScreen = 'recent';
      else nextScreen = 'main';
    }

    // ========================================================================
    // שלב ב': הצגת המסך (nextScreen אם נקבע, אחרת המסך הנוכחי)
    // ========================================================================
    const render = nextScreen || screen;

    // ===== תפריט ראשי =====
    if (render === 'main') {
      return res.send(buildResponse(buildReadMenu([
        'ברוכים הבאים לפורום מתמחים טופ הטלפוני',
        'לכניסה לפוסטים האחרונים הקישו 1',
        'לשמיעת הנושאים האחרונים שנפתחו הקישו 2',
        'לכניסה לפי קטגוריות הקישו 3'
      ], 'mainsel', { waitSec: 8 }), { screen: 'main' }));
    }

    // ===== פוסטים אחרונים =====
    if (render === 'recent') {
      const data = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, LIST_SIZE);
      const parts = buildTopicListParts(topics, 'הפוסטים האחרונים בפורום',
        'לרענון הרשימה הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס');
      return res.send(buildResponse(buildReadMenu(parts, 'recentsel', { waitSec: 10 }),
        { tids: joinIds(topics.map(t => t.tid)), screen: 'recent' }));
    }

    // ===== נושאים חדשים =====
    if (render === 'topics') {
      let data;
      try { data = await nbFetch('/recent?term=alltime&sort=newest'); }
      catch (e) { data = await nbFetch('/recent'); }
      const topics = (data.topics || []).slice()
        .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
        .slice(0, LIST_SIZE);
      const parts = buildTopicListParts(topics, 'הנושאים החדשים ביותר שנפתחו בפורום',
        'לרענון הרשימה הקישו כוכבית. לחזרה לתפריט הראשי הקישו אפס');
      return res.send(buildResponse(buildReadMenu(parts, 'topicsel', { waitSec: 10 }),
        { tids: joinIds(topics.map(t => t.tid)), screen: 'topics' }));
    }

    // ===== קטגוריות =====
    if (render === 'categories') {
      const cid = getState(q, 'cid');
      let list = [], header = '';
      if (!cid) {
        const data = await nbFetch('/categories');
        list = (data.categories || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        header = 'תפריט קטגוריות ראשיות';
      } else {
        const data = await nbFetch('/category/' + cid);
        list = (data.children || []).filter(c => !c.disabled).slice(0, LIST_SIZE);
        header = 'קטגוריית ' + cleanText(data.name || '');
      }
      if (list.length) {
        const parts = buildCategoryListParts(list, header);
        if (cid) parts.push('לשמיעת הנושאים בקטגוריה זו הקישו כוכבית');
        parts.push('לחזרה לתפריט הראשי הקישו אפס');
        return res.send(buildResponse(buildReadMenu(parts, 'catsel', { waitSec: 10 }),
          { cids: joinIds(list.map(c => c.cid)), curcid: cid || '', screen: 'categories' }));
      } else if (cid) {
        return res.send(buildTransition('טוען נושאים', { screen: 'cattopics', cid, catpage: '1' }));
      } else {
        return res.send(buildResponse(buildReadMenu([
          'לא נמצאו קטגוריות', 'חוזר לתפריט הראשי'
        ], 'mainsel', { waitSec: 4 }), { screen: 'main' }));
      }
    }

    // ===== נושאים בקטגוריה =====
    if (render === 'cattopics') {
      const cid = getState(q, 'cid');
      const catpage = Math.max(1, parseInt(getState(q, 'catpage') || '1', 10));
      if (!cid) return res.send(buildTransition('אירעה שגיאה חוזר לתפריט', { screen: 'main' }));
      const data = await nbFetch('/category/' + cid + '?page=' + catpage);
      const topics = (data.topics || []).slice(0, LIST_SIZE);
      const footer = [];
      if (catpage > 1) footer.push('לעמוד הקודם הקישו סולמית');
      if (topics.length === LIST_SIZE) footer.push('לעמוד הבא הקישו כוכבית');
      footer.push('לחזרה לתפריט הראשי הקישו אפס');
      const parts = buildTopicListParts(topics,
        `נושאים בקטגוריית ${cleanText(data.name || '')} עמוד ${catpage}`, footer.join('. '));
      return res.send(buildResponse(buildReadMenu(parts, 'cattopicsel', { waitSec: 10 }),
        { tids: joinIds(topics.map(t => t.tid)), cid, catpage: String(catpage), screen: 'cattopics' }));
    }

    // ===== שמיעת נושא =====
    if (render === 'topic') {
      const tid = getState(q, 'tid');
      const pidx = parseInt(getState(q, 'pidx') || '0', 10);
      if (!tid) return res.send(buildTransition('שגיאת מזהה נושא', { screen: 'main' }));

      const { topic, post, totalPosts } = await fetchTopicPost(tid, pidx);

      if (!post || pidx >= totalPosts) {
        return res.send(buildResponse(buildReadMenu([
          'הגעתם לסוף ההודעות בנושא זה',
          totalPosts === 1 ? 'הנושא כולל הודעה אחת בלבד' : `הנושא כולל ${totalPosts} הודעות בסך הכל`,
          'להאזנה חוזרת מההתחלה הקישו 1',
          'לרשימת הפוסטים האחרונים הקישו 2',
          'לחזרה לתפריט הראשי הקישו אפס'
        ], 'topicend', { waitSec: 9 }), { tid, screen: 'topicend' }));
      }

      const author = post.user && post.user.username ? post.user.username : 'משתמש';
      const audio = [];
      if (pidx === 0) {
        audio.push('כותרת הנושא היא ' + ttsCut(topic.title, MAX_TITLE_CHARS));
        audio.push(totalPosts === 1 ? 'הנושא מכיל הודעה אחת' : `הנושא מכיל ${totalPosts} הודעות`);
      }
      audio.push(`הודעה מספר ${pidx + 1} מתוך ${totalPosts}`);
      audio.push(`נכתבה על ידי ${author}`);
      audio.push(ttsCut(post.content, MAX_BODY_CHARS));
      audio.push('להודעה הבאה הקישו 1');
      audio.push('להודעה הקודמת הקישו 2');
      audio.push('להאזנה חוזרת הקישו 3');
      audio.push('לדילוג חמש הודעות הקישו 4');
      audio.push('לתחילת הנושא הקישו 5');
      audio.push('לפרטי ההודעה הקישו 6');
      audio.push('לתפריט הראשי הקישו אפס');

      const details = [
        `פרטי הודעה מספר ${pidx + 1}`,
        `המחבר ${author}`,
        `פורסם ${timeAgo(post.timestamp)}`,
        totalPosts === 1 ? 'הנושא כולל הודעה אחת' : `הנושא כולל ${totalPosts} הודעות בסך הכל`
      ].map(sanitizePart).join('|');

      return res.send(buildResponse(buildReadMenu(audio, 'topicnav', { waitSec: 15 }),
        { tid, pidx: String(pidx), screen: 'topic', details }));
    }

    // ===== הגנת קצה =====
    console.warn(`[Fallback] render=${render}`);
    return res.send(buildTransition('חוזר להתחלה', { screen: 'main' }));

  } catch (err) {
    console.error('[Global]', err.message);
    return res.send(buildResponse(buildReadMenu([
      'אירעה שגיאה בטעינת הנתונים מהפורום',
      'אנא נסו שוב מאוחר יותר',
      'לחזרה לתפריט הראשי הקישו אפס'
    ], 'mainsel', { waitSec: 6 }), { screen: 'main' }));
  }
};
