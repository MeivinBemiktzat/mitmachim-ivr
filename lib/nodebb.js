/**
 * NodeBB Client - mitmachim.top
 * סקריפינג HTML ציבורי - ללא צורך בטוקן
 * הפורום ציבורי ונגיש לכולם
 */

const FORUM_URL = 'https://mitmachim.top';

async function fetchHtml(path) {
  const url = `${FORUM_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; IVR-Bot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'he,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${url}`);
  return res.text();
}

/**
 * פוסטים / נושאים אחרונים מדף /recent
 * מחלץ מה-HTML: כותרת, tid, postcount, viewcount, קטגוריה, כותב
 */
async function fetchRecentTopics(limit = 20, cid = null) {
  try {
    const path = cid ? `/category/${cid}` : '/recent';
    const html = await fetchHtml(path);
    return parseTopicList(html, limit);
  } catch (e) {
    console.error('fetchRecentTopics:', e.message);
    return [];
  }
}

/**
 * פוסטים אחרונים - מחזיר את אותם הנושאים כ"פוסטים" (teaser)
 */
async function fetchRecentPosts(limit = 20) {
  try {
    const html = await fetchHtml('/recent');
    const topics = parseTopicList(html, limit);
    return topics.map(t => ({
      pid: t.tid, // נשתמש ב-tid בתור מזהה
      tid: t.tid,
      content: t.title, // נשתמש בכותרת בתור תוכן
      timestamp: t.timestamp,
      user: t.user,
      topic: { title: t.title, tid: t.tid },
      category: t.category,
    }));
  } catch (e) {
    console.error('fetchRecentPosts:', e.message);
    return [];
  }
}

/**
 * קטגוריות מדף /categories
 * רשימת קטגוריות ראשיות עם תתי-קטגוריות
 */
async function fetchCategories(parentCid = null) {
  try {
    const html = await fetchHtml('/categories');
    const all = parseCategoryList(html);

    if (parentCid) {
      const parent = all.find(c => String(c.cid) === String(parentCid));
      return parent?.children || [];
    }
    return all;
  } catch (e) {
    console.error('fetchCategories:', e.message);
    return [];
  }
}

/**
 * פוסטים בנושא ספציפי
 */
async function fetchTopicPosts(tid, limit = 20) {
  try {
    const html = await fetchHtml(`/topic/${tid}`);
    return parsePostList(html, limit, tid);
  } catch (e) {
    console.error('fetchTopicPosts:', e.message);
    return [];
  }
}

/**
 * פרטי פוסט - מחלץ מדף הנושא
 */
async function fetchPostDetails(pid) {
  try {
    // pid === tid בגישה שלנו
    const html = await fetchHtml(`/topic/${pid}`);
    const posts = parsePostList(html, 1, pid);
    if (!posts.length) return null;
    const p = posts[0];
    const topicTitle = extractTopicTitle(html);
    const catName = extractCategoryName(html);
    return {
      ...p,
      topic: { title: topicTitle },
      category: { name: catName },
    };
  } catch (e) {
    console.error('fetchPostDetails:', e.message);
    return null;
  }
}

/**
 * פרטי נושא
 */
async function fetchTopicDetails(tid) {
  try {
    const html = await fetchHtml(`/topic/${tid}`);
    return parseTopicDetails(html, tid);
  } catch (e) {
    console.error('fetchTopicDetails:', e.message);
    return null;
  }
}

/* ─── פרסרים ──────────────────────────────────────────────────────────────── */

/**
 * מחלץ נושאים מ-HTML של /recent או /category/X
 * דוגמת לינק: /topic/98447/בעיה-מיקרופון-במחשב-לא-עובד-רק-משמיעה-רעשים
 */
function parseTopicList(html, limit) {
  const topics = [];
  // מחלץ את כל הלינקים לנושאים
  const topicRegex = /href="\/topic\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)</g;
  // שיטה אחרת - מחלץ מהמבנה של NodeBB
  // כל נושא מופיע כ: /topic/{tid}/{slug}
  const seen = new Set();

  // מחלץ נושאים מהתוכן
  const titlePattern = /href="(\/topic\/(\d+)\/[^"]+)"[^>]*>\s*<\/a>\s*###\s*\[([^\]]+)\]/g;

  // NodeBB מרנדר את הנושאים כך (מה-markdown שקיבלנו):
  // ### [כותרת](URL)
  // עם פרטים מתחת
  const mdTopicPattern = /###\s*\[([^\]]+)\]\(https:\/\/mitmachim\.top\/topic\/(\d+)\/[^)]+\)/g;

  let m;
  while ((m = mdTopicPattern.exec(html)) !== null && topics.length < limit) {
    const title = m[1].trim();
    const tid = m[2];
    if (seen.has(tid)) continue;
    seen.add(tid);

    // נסה לחלץ מספר תגובות - מופיע אחרי בלוק הנושא
    const afterMatch = html.substring(m.index, m.index + 500);
    const postCountMatch = afterMatch.match(/(\d+)\s+(?:תגובות|פוסטים)/);
    const viewMatch = afterMatch.match(/(\d+(?:k)?)\s+צפיות/);
    const userMatch = afterMatch.match(/user\/([^"\/]+)["\/]\s*"([^"]+)"/);

    const postcount = postCountMatch ? parseInt(postCountMatch[1]) : 0;
    const viewcount = viewMatch ? parseViewCount(viewMatch[1]) : 0;
    const username = userMatch ? userMatch[2] : 'לא ידוע';

    // חלץ קטגוריה
    const catMatch = afterMatch.match(/category\/\d+\/([^)]+)\)/);
    const catName = catMatch ? decodeURIComponent(catMatch[1].replace(/-/g, ' ')) : '';

    topics.push({
      tid,
      title,
      postcount,
      viewcount,
      timestamp: null,
      user: { username },
      category: { name: catName },
    });
  }

  return topics;
}

/**
 * מחלץ קטגוריות מ-HTML של /categories
 */
function parseCategoryList(html) {
  const cats = [];
  const seen = new Set();

  // קטגוריות ראשיות: ## [שם](URL)
  const mainCatPattern = /##\s*\[([^\]]+)\]\(https:\/\/mitmachim\.top\/category\/(\d+)\/([^)]+)\)/g;
  // תתי קטגוריות: * [שם](URL)
  const subCatPattern = /\*\s*\[([^\]]+)\]\(https:\/\/mitmachim\.top\/category\/(\d+)\/([^)]+)\)/g;

  const mainCats = [];
  let m;
  while ((m = mainCatPattern.exec(html)) !== null) {
    const name = m[1].trim();
    const cid = m[2];
    if (seen.has(cid) || name.includes('?')) continue;
    seen.add(cid);

    // חלץ תתי-קטגוריות שמופיעות אחרי הקטגוריה הראשית
    const afterMain = html.substring(m.index, m.index + 1500);
    const children = [];
    const seenSub = new Set();

    let sm;
    while ((sm = subCatPattern.exec(afterMain)) !== null) {
      const subName = sm[1].trim();
      const subCid = sm[2];
      if (seenSub.has(subCid)) continue;
      seenSub.add(subCid);
      children.push({ cid: subCid, name: subName, children: [] });
    }
    subCatPattern.lastIndex = 0;

    // נתוני סטטיסטיקה
    const statsMatch = afterMain.match(/(\d+k?)\s+נושאים/);
    const topicCount = statsMatch ? parseViewCount(statsMatch[1]) : 0;

    mainCats.push({ cid, name, topic_count: topicCount, children });
  }

  return mainCats;
}

/**
 * מחלץ פוסטים מדף נושא
 */
function parsePostList(html, limit, tid) {
  const posts = [];

  // פוסטים ב-NodeBB מרנדרים עם תוכן ומשתמש
  // נחלץ לפי תבנית של תוכן פוסטים
  // כל פוסט מכיל קישור למשתמש ותוכן טקסטואלי

  // חלץ בלוקים של פוסטים
  const userPattern = /\/user\/([^"\/]+)["\/]\s*"([^"]+)"\s*\)\s*\n([\s\S]*?)(?=\n-\s*\[|\n##|\n---|\n\[התחברות|$)/g;

  let m;
  let idx = 0;
  while ((m = userPattern.exec(html)) !== null && posts.length < limit) {
    const username = m[2];
    let content = m[3]
      .replace(/\[image:[^\]]+\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/#+\s*/g, '')
      .replace(/Spoiler/g, '')
      .trim();

    if (!content || content.length < 5) continue;
    if (content.length > 400) content = content.substring(0, 400) + '...';

    posts.push({
      pid: `${tid}_${idx}`,
      tid,
      content,
      timestamp: null,
      toPid: null,
      user: { username },
    });
    idx++;
  }

  // אם לא מצאנו פוסטים עם השיטה הראשונה - נסה שיטה פשוטה יותר
  if (!posts.length) {
    const title = extractTopicTitle(html);
    posts.push({
      pid: tid,
      tid,
      content: title || 'לא נמצא תוכן',
      timestamp: null,
      toPid: null,
      user: { username: 'לא ידוע' },
    });
  }

  return posts;
}

function parseTopicDetails(html, tid) {
  const title = extractTopicTitle(html);
  const catName = extractCategoryName(html);

  const postCountMatch = html.match(/(\d+)\s+(?:תגובות|פוסטים)/);
  const postcount = postCountMatch ? parseInt(postCountMatch[1]) : 0;

  const userMatch = html.match(/\/user\/([^"\/]+)["\/]\s*"([^"]+)"/);
  const username = userMatch ? userMatch[2] : 'לא ידוע';

  return {
    tid,
    title: title || 'ללא כותרת',
    timestamp: null,
    postcount,
    viewcount: 0,
    user: { username },
    category: { name: catName },
  };
}

function extractTopicTitle(html) {
  const m = html.match(/###\s*\[([^\]]+)\]/);
  if (m) return m[1].trim();
  const m2 = html.match(/<title>([^|<]+)/i);
  if (m2) return m2[1].trim();
  return null;
}

function extractCategoryName(html) {
  const m = html.match(/category\/\d+\/([^)"\s]+)/);
  if (!m) return 'לא ידוע';
  return decodeURIComponent(m[1].replace(/-/g, ' '));
}

function parseViewCount(str) {
  if (!str) return 0;
  if (str.endsWith('k')) return parseInt(str) * 1000;
  return parseInt(str) || 0;
}

module.exports = {
  fetchRecentPosts,
  fetchRecentTopics,
  fetchCategories,
  fetchTopicPosts,
  fetchPostDetails,
  fetchTopicDetails,
};
