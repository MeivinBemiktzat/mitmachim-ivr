// api/index.js
// מודול API טלפוני לפורום NodeBB עבור מערכת IVR של ימות המשיח
// =============================================================

const FORUM_URL = (process.env.FORUM_URL || 'https://mitmachim.top').replace(/\/+$/, '');
const MAX_TITLE_CHARS = 300;   // הגבלת אורך טקסט לקריאת TTS
const MAX_BODY_CHARS  = 950;   // הגבלת אורך גוף הודעה ל-TTS (מקסימום ~1000)

// ---------- כלי עזר ----------

// בקשת JSON מהפורום (NodeBB Read API = הוספת /api לכל נתיב)
async function nbFetch(path) {
  const url = FORUM_URL + '/api' + path;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'yemot-nodebb-bridge/1.0'
    }
  });
  if (!res.ok) throw new Error('NodeBB HTTP ' + res.status + ' for ' + path);
  return res.json();
}

// ניקוי HTML והפיכתו לטקסט נקי שמתאים להקראת TTS
function cleanText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' '); // הסרת ציטוטים מהגוף
  t = t.replace(/<br\s*\/?>/gi, ' ');
  t = t.replace(/<\/(p|div|li|h[1-6])>/gi, '. ');
  t = t.replace(/<[^>]+>/g, ' ');           // הסרת כל שאר התגיות
  t = t.replace(/&nbsp;/gi, ' ');
  t = t.replace(/&amp;/gi, ' ו');
  t = t.replace(/&quot;/gi, ' ');
  t = t.replace(/&#39;|&apos;/gi, ' ');
  t = t.replace(/&lt;/gi, ' ').replace(/&gt;/gi, ' ');
  t = t.replace(/https?:\/\/\S+/gi, ' קישור ');  // הסרת לינקים מהקראה
  t = t.replace(/[._\-=*#@^~`|<>\\\/\[\]{}]+/g, ' '); // הסרת תווים שמשבשים TTS/ימות
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function ttsCut(text, max) {
  const t = cleanText(text);
  if (t.length <= max) return t;
  return t.slice(0, max);
}

// המרת timestamp לטקסט תאריך/שעה עברי-ידידותי לקריאה
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'לפני פחות מדקה';
  if (min < 60) return 'לפני ' + min + ' דקות';
  const hr = Math.floor(min / 60);
  if (hr < 24) return 'לפני ' + hr + ' שעות';
  const day = Math.floor(hr / 24);
  if (day < 30) return 'לפני ' + day + ' ימים';
  const mon = Math.floor(day / 30);
  if (mon < 12) return 'לפני ' + mon + ' חודשים';
  return 'לפני ' + Math.floor(mon / 12) + ' שנים';
}

// בניית מחרוזת id_list_message מתוך פריטי טקסט (t-...) מופרדים בנקודה
function idList(parts) {
  const safe = parts
    .filter(p => p && String(p).trim() !== '')
    .map(p => 't-' + String(p).replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim());
  return 'id_list_message=' + safe.join('.');
}

// תשובת read לימות: השמעת הודעה + קבלת הקשה מהמשתמש
// הגדרת ברירת מחדל של מקסימום תו 1 ומינימום תו 1 כדי למנוע את בקשת האישור ("לאישור הקישו 1")
function readResp(sayText, paramName, opts) {
  opts = opts || {};
  const min = opts.min || 1;
  const maxd = opts.max || 1; // שונה ל-1 כברירת מחדל לתפריטים מהירים
  const wait = opts.wait || 7;
  const say = cleanText(sayText).replace(/[.\-]/g, ' ');
  return 'read=t-' + say + '=' + paramName + ',no,' + maxd + ',' + min + ',' + wait + ',Digits,no,yes';
}

// תשובת go_to_folder
function goFolder(path) {
  return 'go_to_folder=' + path;
}

// ---------- בניית מסכי השמעה ----------

// השמעת רשימת נושאים (topics) עם תפריט בחירה במספר
function buildTopicList(topics, headerText, navHint) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!topics || topics.length === 0) {
    parts.push('לא נמצאו נושאים');
    return idList(parts);
  }
  topics.forEach((tp, i) => {
    const n = i + 1;
    const title = ttsCut(tp.title, MAX_TITLE_CHARS);
    const author = tp.user && tp.user.username ? tp.user.username : '';
    parts.push('לנושא ' + n);
    parts.push(title);
    if (author) parts.push('מאת ' + author);
    parts.push('הקישו ' + n);
  });
  if (navHint) parts.push(navHint);
  return idList(parts);
}

// השמעת רשימת קטגוריות עם תפריט בחירה
function buildCategoryList(cats, headerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (!cats || cats.length === 0) {
    parts.push('לא נמצאו קטגוריות');
    return idList(parts);
  }
  cats.forEach((c, i) => {
    const n = i + 1;
    parts.push('לקטגוריה ' + n);
    parts.push(cleanText(c.name));
    parts.push('הקישו ' + n);
  });
  return idList(parts);
}

// ---------- הראוטר הראשי ----------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // קליטת פרמטרים מ-GET או POST
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object') Object.assign(q, req.body);

  const screen = q.screen || 'main';

  try {
    // תיקון לופ תפריט ראשי: בודקים קודם כל אם חזרה תשובה מהתפריט הראשי!
    if (q.mainsel !== undefined) {
      const s = String(q.mainsel);
      if (s === '1') return res.send(goFolder('recent') + '&api_add_screen=recent');
      if (s === '2') return res.send(goFolder('topics') + '&api_add_screen=topics');
      if (s === '3') return res.send(goFolder('categories') + '&api_add_screen=categories');
      // בחירה לא חוקית - נציג שוב את התפריט הראשי
    }

    // ============ תפריט ראשי ============
    if (screen === 'main') {
      const say =
        'id_list_message=t-ברוכים הבאים לפורום מתמחים טופ.' +
        't-לכניסה לפוסטים האחרונים הקישו 1.' +
        't-לשמיעת הנושאים האחרונים שנפתחו הקישו 2.' +
        't-לכניסה לפי קטגוריות הקישו 3' +
        '&read=t-אנא הקישו את בחירתכם=mainsel,no,1,1,7,Digits,no,yes' +
        '&api_add_screen=main'; // אבטחת הגדרת המסך הבא
      return res.send(say);
    }

    // ============ פוסטים אחרונים (תגובות אחרונות בכל הפורום) ============
    if (screen === 'recent') {
      const data = await nbFetch('/recent');
      const topics = (data.topics || []).slice(0, 9);
      const out = buildTopicList(
        topics,
        'הפוסטים האחרונים בפורום',
        'לרענון הרשימה הקישו כוכבית, לחזרה לתפריט הראשי הקישו אפס'
      );
      const tids = topics.map(t => t.tid).join(',');
      // שונה ל-1,1 כדי למנוע בקשת אישור
      const sel = '&read=t-אנא הקישו את מספר הנושא לשמיעה=recentsel,no,1,1,9,Digits,no,no' +
                  '&api_add_tids=' + tids + '&api_add_screen=recentsel';
      return res.send(out + sel);
    }

    if (screen === 'recentsel') {
      const s = String(q.recentsel || '');
      if (s === '0') return res.send(goFolder('/') + '&api_add_screen=main');
      if (s === '' ) return res.send(goFolder('recent') + '&api_add_screen=recent');
      const tids = String(q.tids || '').split(',').filter(x => x);
      const idx = parseInt(s, 10) - 1;
      if (idx < 0 || idx >= tids.length) return res.send(goFolder('recent') + '&api_add_screen=recent');
      return res.send('go_to_folder=topic&api_add_tid=' + tids[idx] + '&api_add_screen=topic');
    }

    // ============ נושאים אחרונים שנפתחו ============
    if (screen === 'topics') {
      let data;
      try { data = await nbFetch('/recent?term=alltime&sort=newest'); }
      catch (e) { data = await nbFetch('/recent'); }
      let topics = (data.topics || []);
      topics = topics.slice().sort((a, b) =>
        (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
      ).slice(0, 9);
      const out = buildTopicList(
        topics,
        'הנושאים האחרונים שנפתחו בפורום',
        'לחזרה לתפריט הראשי הקישו אפס'
      );
      const tids = topics.map(t => t.tid).join(',');
      // שונה ל-1,1 כדי למנוע בקשת אישור
      const sel = '&read=t-אנא הקישו את מספר הנושא לשמיעה=topicsel,no,1,1,9,Digits,no,no' +
                  '&api_add_tids=' + tids + '&api_add_screen=topicsel';
      return res.send(out + sel);
    }

    if (screen === 'topicsel') {
      const s = String(q.topicsel || '');
      if (s === '0' || s === '') return res.send(goFolder('/') + '&api_add_screen=main');
      const tids = String(q.tids || '').split(',').filter(x => x);
      const idx = parseInt(s, 10) - 1;
      if (idx < 0 || idx >= tids.length) return res.send(goFolder('topics') + '&api_add_screen=topics');
      return res.send('go_to_folder=topic&api_add_tid=' + tids[idx] + '&api_add_screen=topic');
    }

    // ============ קטגוריות ותתי-קטגוריות ============
    if (screen === 'categories') {
      const cid = q.cid ? String(q.cid) : '';
      let cats = [];
      let header = '';
      if (!cid) {
        const data = await nbFetch('/categories');
        cats = (data.categories || []).filter(c => !c.disabled).slice(0, 9);
        header = 'תפריט קטגוריות';
      } else {
        const data = await nbFetch('/category/' + cid);
        cats = (data.children || []).filter(c => !c.disabled).slice(0, 9);
        header = 'קטגוריה ' + cleanText(data.name || '');
      }

      if (cats.length > 0) {
        const out = buildCategoryList(cats, header);
        const cids = cats.map(c => c.cid).join(',');
        let sel = '&read=t-לבחירת קטגוריה הקישו את מספרה';
        if (cid) sel += ' לשמיעת הנושאים שבקטגוריה זו הקישו כוכבית';
        sel += '. לחזרה לתפריט הראשי הקישו אפס=catsel,no,1,1,9,Digits,no,no' +
               '&api_add_cids=' + cids + '&api_add_curcid=' + (cid || '') + '&api_add_screen=catsel';
        return res.send(out + sel);
      } else if (cid) {
        return res.send('go_to_folder=cattopics&api_add_cid=' + cid + '&api_add_screen=cattopics');
      } else {
        return res.send(idList(['לא נמצאו קטגוריות']) + '&go_to_folder=/&api_add_screen=main');
      }
    }

    if (screen === 'catsel') {
      const s = String(q.catsel || '');
      const curcid = String(q.curcid || '');
      if (s === '0') return res.send(goFolder('/') + '&api_add_screen=main');
      if (s === '' && curcid) return res.send('go_to_folder=cattopics&api_add_cid=' + curcid + '&api_add_screen=cattopics');
      const cids = String(q.cids || '').split(',').filter(x => x);
      const idx = parseInt(s, 10) - 1;
      if (idx < 0 || idx >= cids.length) {
        return res.send('go_to_folder=categories' + (curcid ? '&api_add_cid=' + curcid : '') + '&api_add_screen=categories');
      }
      return res.send('go_to_folder=categories&api_add_cid=' + cids[idx] + '&api_add_screen=categories');
    }

    // ============ נושאים בתוך קטגוריה ============
    if (screen === 'cattopics') {
      const cid = String(q.cid || '');
      if (!cid) return res.send(goFolder('/') + '&api_add_screen=main');
      const data = await nbFetch('/category/' + cid);
      const topics = (data.topics || []).slice(0, 9);
      const out = buildTopicList(
        topics,
        'נושאים בקטגוריה ' + cleanText(data.name || ''),
        'לחזרה לתפריט הראשי הקישו אפס'
      );
      const tids = topics.map(t => t.tid).join(',');
      const sel = '&read=t-אנא הקישו את מספר הנושא לשמיעה=cattopicsel,no,1,1,9,Digits,no,no' +
                  '&api_add_tids=' + tids + '&api_add_screen=cattopicsel';
      return res.send(out + sel);
    }

    if (screen === 'cattopicsel') {
      const s = String(q.cattopicsel || '');
      if (s === '0' || s === '') return res.send(goFolder('/') + '&api_add_screen=main');
      const tids = String(q.tids || '').split(',').filter(x => x);
      const idx = parseInt(s, 10) - 1;
      if (idx < 0 || idx >= tids.length) return res.send(goFolder('/') + '&api_add_screen=main');
      return res.send('go_to_folder=topic&api_add_tid=' + tids[idx] + '&api_add_screen=topic');
    }

    // ============ שמיעת נושא (פוסטים) ============
    if (screen === 'topic') {
      const tid = String(q.tid || '');
      if (!tid) return res.send(goFolder('/') + '&api_add_screen=main');
      const page = parseInt(q.page || '0', 10);
      const data = await nbFetch('/topic/' + tid);
      const posts = data.posts || [];
      const title = ttsCut(data.title, MAX_TITLE_CHARS);

      if (page >= posts.length) {
        return res.send(
          idList(['סוף הנושא', 'לחזרה לתפריט הראשי הקישו אפס']) +
          '&read=t-להאזנה מההתחלה הקישו 1, לחזרה לתפריט הראשי הקישו 0=topicend,no,1,1,7,Digits,no,no' +
          '&api_add_tid=' + tid + '&api_add_screen=topicend'
        );
      }

      const p = posts[page];
      const body = ttsCut(p.content, MAX_BODY_CHARS);
      const author = p.user && p.user.username ? p.user.username : 'משתמש';
      const parts = [];
      if (page === 0) parts.push('נושא ' + title);
      parts.push('הודעה ' + (page + 1) + ' מתוך ' + posts.length);
      parts.push('מאת ' + author);
      parts.push(body);

      const detailParts = [
        'פרטי ההודעה',
        'נכתב על ידי ' + author,
        'בזמן ' + timeAgo(p.timestamp)
      ];
      if (p.toPid && data.posts) {
        const parent = data.posts.find(x => String(x.pid) === String(p.toPid));
        if (parent && parent.user) detailParts.push('בתגובה ל ' + parent.user.username);
      }
      detailParts.push('מספר תגובות בנושא ' + (data.postcount || posts.length));

      const menu =
        '&read=t-להודעה הבאה הקישו 1, להודעה הקודמת הקישו 2, לפרטי ההודעה הקישו 3, ' +
        'לחזרה לתפריט הראשי הקישו 0=topicnav,no,1,1,15,Digits,no,no' +
        '&api_add_tid=' + tid +
        '&api_add_page=' + page +
        '&api_add_screen=topicnav' +
        '&api_add_details=' + encodeURIComponent(detailParts.join('|'));

      return res.send(idList(parts) + menu);
    }

    // ניווט בתוך נושא
    if (screen === 'topicnav') {
      const tid = String(q.tid || '');
      const page = parseInt(q.page || '0', 10);
      const s = String(q.topicnav || '');
      if (s === '0') return res.send(goFolder('/') + '&api_add_screen=main');
      if (s === '1') return res.send('go_to_folder=topic&api_add_tid=' + tid + '&api_add_page=' + (page + 1) + '&api_add_screen=topic');
      if (s === '2') {
        const prev = page - 1 < 0 ? 0 : page - 1;
        return res.send('go_to_folder=topic&api_add_tid=' + tid + '&api_add_page=' + prev + '&api_add_screen=topic');
      }
      if (s === '3') {
        const details = decodeURIComponent(q.details || '').split('|').filter(x => x);
        return res.send(
          idList(details) +
          '&read=t-לחזרה להודעה הקישו 1=detback,no,1,1,7,Digits,no,no' +
          '&api_add_tid=' + tid + '&api_add_page=' + page + '&api_add_screen=detback'
        );
      }
      return res.send('go_to_folder=topic&api_add_tid=' + tid + '&api_add_page=' + page + '&api_add_screen=topic');
    }

    if (screen === 'detback') {
      const tid = String(q.tid || '');
      const page = parseInt(q.page || '0', 10);
      return res.send('go_to_folder=topic&api_add_tid=' + tid + '&api_add_page=' + page + '&api_add_screen=topic');
    }

    if (screen === 'topicend') {
      const tid = String(q.tid || '');
      const s = String(q.topicend || '');
      if (s === '1') return res.send('go_to_folder=topic&api_add_tid=' + tid + '&api_add_page=0' + '&api_add_screen=topic');
      return res.send(goFolder('/') + '&api_add_screen=main');
    }

    return res.send(goFolder('/') + '&api_add_screen=main');

  } catch (err) {
    return res.send(
      idList(['אירעה שגיאה בטעינת הנתונים מהפורום', 'אנא נסו שוב מאוחר יותר']) +
      '&go_to_folder=/&api_add_screen=main'
    );
  }
};
