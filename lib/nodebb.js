/**
 * NodeBB API Client
 * תקשורת מול NodeBB REST API
 */

const FORUM_URL = process.env.NODEBB_URL || 'https://your-forum.com';
const API_TOKEN = process.env.NODEBB_TOKEN || '';

const headers = {
  'Authorization': `Bearer ${API_TOKEN}`,
  'Accept': 'application/json',
};

async function apiFetch(path) {
  const url = `${FORUM_URL}/api/${path}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`NodeBB API error: ${res.status} ${path}`);
  }
  return res.json();
}

/**
 * פוסטים אחרונים בפורום
 */
async function fetchRecentPosts(limit = 20) {
  try {
    const data = await apiFetch(`recent?term=alltime`);
    const topics = data.topics || [];
    // מחלץ את הפוסט הראשון מכל נושא אחרון
    const posts = topics.slice(0, limit).map(t => ({
      pid: t.mainPid,
      tid: t.tid,
      content: t.teaser?.content || t.title || '',
      timestamp: t.lastposttime,
      user: { username: t.teaser?.user?.username || t.user?.username || 'לא ידוע' },
      topic: { title: t.title, tid: t.tid },
    }));
    return posts;
  } catch (e) {
    console.error('fetchRecentPosts:', e.message);
    return [];
  }
}

/**
 * נושאים אחרונים
 */
async function fetchRecentTopics(limit = 20, cid = null) {
  try {
    let path = `recent?term=alltime`;
    if (cid) path = `category/${cid}`;

    const data = await apiFetch(path);
    const topics = (data.topics || []).slice(0, limit);
    return topics.map(t => ({
      tid: t.tid,
      title: t.title,
      postcount: t.postcount,
      viewcount: t.viewcount,
      timestamp: t.timestamp,
      lastposttime: t.lastposttime,
      cid: t.cid,
      user: { username: t.user?.username || 'לא ידוע' },
    }));
  } catch (e) {
    console.error('fetchRecentTopics:', e.message);
    return [];
  }
}

/**
 * רשימת קטגוריות
 */
async function fetchCategories(parentCid = null) {
  try {
    const data = await apiFetch('categories');
    let cats = data.categories || [];

    if (parentCid) {
      // חפש תת-קטגוריות של הקטגוריה האב
      const parent = findCategory(cats, parseInt(parentCid));
      cats = parent?.children || [];
    } else {
      // רק קטגוריות ראשיות (ללא הורה)
      cats = cats.filter(c => !c.parentCid || c.parentCid === 0);
    }

    return cats.map(c => ({
      cid: c.cid,
      name: c.name,
      description: c.description,
      post_count: c.post_count,
      topic_count: c.topic_count,
      children: c.children || [],
    }));
  } catch (e) {
    console.error('fetchCategories:', e.message);
    return [];
  }
}

function findCategory(cats, cid) {
  for (const cat of cats) {
    if (cat.cid === cid) return cat;
    if (cat.children) {
      const found = findCategory(cat.children, cid);
      if (found) return found;
    }
  }
  return null;
}

/**
 * פוסטים בנושא ספציפי
 */
async function fetchTopicPosts(tid, limit = 20) {
  try {
    const data = await apiFetch(`topic/${tid}`);
    const posts = (data.posts || []).slice(0, limit);
    return posts.map(p => ({
      pid: p.pid,
      tid: p.tid,
      content: p.content || '',
      timestamp: p.timestamp,
      toPid: p.toPid || null,
      user: { username: p.user?.username || 'לא ידוע' },
    }));
  } catch (e) {
    console.error('fetchTopicPosts:', e.message);
    return [];
  }
}

/**
 * פרטי פוסט בודד
 */
async function fetchPostDetails(pid) {
  try {
    const data = await apiFetch(`post/${pid}`);
    return {
      pid: data.pid,
      tid: data.tid,
      content: data.content || '',
      timestamp: data.timestamp,
      toPid: data.toPid || null,
      user: { username: data.user?.username || 'לא ידוע' },
      topic: { title: data.topic?.title || '' },
      category: { name: data.category?.name || '' },
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
    const data = await apiFetch(`topic/${tid}`);
    return {
      tid: data.tid,
      title: data.title,
      timestamp: data.timestamp,
      postcount: data.postcount,
      viewcount: data.viewcount,
      user: { username: data.author?.username || 'לא ידוע' },
      category: { name: data.category?.name || '' },
    };
  } catch (e) {
    console.error('fetchTopicDetails:', e.message);
    return null;
  }
}

module.exports = {
  fetchRecentPosts,
  fetchRecentTopics,
  fetchCategories,
  fetchTopicPosts,
  fetchPostDetails,
  fetchTopicDetails,
};
