/**
 * מודול IVR לפורום NodeBB - מתמחים טופ
 * Vercel Serverless Function
 */

const { fetchRecentPosts, fetchRecentTopics, fetchCategories, fetchTopicPosts, fetchPostDetails, fetchTopicDetails } = require('../lib/nodebb');
const { sayText, sayMenu, askWithState, endCall } = require('../lib/yemot');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const params = req.method === 'POST'
    ? { ...req.query, ...(req.body || {}) }
    : { ...req.query };

  const ctx = {
    pressed:     params.ApiDtmf || '',
    step:        params.step || 'main',
    index:       parseInt(params.index || '0', 10),
    topicId:     params.topicId || '',
    categoryId:  params.categoryId || '',
    parentCatId: params.parentCatId || '',
    postId:      params.postId || '',
  };

  try {
    let output = '';
    switch (ctx.step) {
      case 'main':          output = buildMainMenu(ctx); break;
      case 'recent_posts':  output = await handleRecentPosts(ctx); break;
      case 'recent_topics': output = await handleRecentTopics(ctx); break;
      case 'categories':    output = await handleCategories(ctx); break;
      case 'topic_posts':   output = await handleTopicPosts(ctx); break;
      case 'post_details':  output = await handlePostDetails(ctx); break;
      case 'topic_details': output = await handleTopicDetails(ctx); break;
      default:              output = buildMainMenu({ ...ctx, pressed: '' });
    }
    console.log('========== IVR RESPONSE ==========');
console.log(output);
console.log('==================================');

res.status(200).send(output);
  } catch (err) {
    console.error('IVR Error:', err);
    res.status(200).send(sayText('שגיאה, נסה שוב') + endCall());
  }
};

/* ========= תפריט ראשי ========= */

function buildMainMenu(ctx) {
  switch (ctx.pressed) {
    case '1': return askWithState('recent_posts',  { index: 0 }, ctx);
    case '2': return askWithState('recent_topics', { index: 0 }, ctx);
    case '3': return askWithState('categories',    { index: 0 }, ctx);
    case '0': return sayText('להתראות') + endCall();
    default:
      return (
        sayText('ברוכים הבאים לפורום מתמחים טופ') +
        sayMenu(['1 פוסטים אחרונים', '2 נושאים אחרונים', '3 קטגוריות', '0 ניתוק'],
                'main', {}, ctx)
      );
  }
}

/* ========= פוסטים אחרונים ========= */

async function handleRecentPosts(ctx) {
  const { pressed, index } = ctx;
  const posts = await fetchRecentPosts(20);
  if (!posts.length) return sayText('לא נמצאו פוסטים') + askWithState('main', {}, ctx);

  const i = pressed === '5' ? 0
          : pressed === '6' ? Math.min(index + 1, posts.length - 1)
          : pressed === '4' ? Math.max(index - 1, 0)
          : index;

  if (pressed === '8') return askWithState('post_details', { postId: String(posts[i]?.pid || '') }, ctx);
  if (pressed === '9') return askWithState('main', {}, ctx);

  const p = posts[i];
  const text = cleanHtml(p.content || '').substring(0, 280);
  return (
    sayText(`פוסט ${i + 1} מתוך ${posts.length}`) +
    sayText(text) +
    sayMenu(['6 פוסט הבא', '4 פוסט קודם', '8 פרטי הפוסט', '5 ראש הרשימה', '9 תפריט ראשי'],
            'recent_posts', { index: i }, ctx)
  );
}

/* ========= נושאים אחרונים ========= */

async function handleRecentTopics(ctx) {
  const { pressed, index } = ctx;
  const topics = await fetchRecentTopics(20);
  if (!topics.length) return sayText('לא נמצאו נושאים') + askWithState('main', {}, ctx);

  const i = pressed === '5' ? 0
          : pressed === '6' ? Math.min(index + 1, topics.length - 1)
          : pressed === '4' ? Math.max(index - 1, 0)
          : index;

  if (pressed === '1') return askWithState('topic_posts', { topicId: String(topics[i]?.tid || ''), index: 0 }, ctx);
  if (pressed === '8') return askWithState('topic_details', { topicId: String(topics[i]?.tid || '') }, ctx);
  if (pressed === '9') return askWithState('main', {}, ctx);

  const t = topics[i];
  return (
    sayText(`נושא ${i + 1} מתוך ${topics.length}`) +
    sayText(t.title || 'ללא כותרת') +
    sayText(`${t.postcount || 0} תגובות`) +
    sayMenu(['1 כנס לפוסטים', '6 נושא הבא', '4 נושא קודם', '8 פרטי הנושא', '5 ראש הרשימה', '9 תפריט ראשי'],
            'recent_topics', { index: i }, ctx)
  );
}

/* ========= קטגוריות ========= */

async function handleCategories(ctx) {
  const { pressed, categoryId, parentCatId, index } = ctx;

  if (categoryId) {
    // אנחנו בתוך קטגוריה, הצג נושאים
    const topics = await fetchRecentTopics(20, categoryId);
    if (!topics.length) return sayText('אין נושאים') + askWithState('categories', { index: 0 }, ctx);

    const i = pressed === '6' ? Math.min(index + 1, topics.length - 1)
            : pressed === '4' ? Math.max(index - 1, 0)
            : index;

    if (pressed === '1') return askWithState('topic_posts', { topicId: String(topics[i]?.tid || ''), index: 0 }, ctx);
    if (pressed === '8') return askWithState('topic_details', { topicId: String(topics[i]?.tid || '') }, ctx);
    if (pressed === '7') return askWithState('categories', { index: 0 }, ctx);
    if (pressed === '9') return askWithState('main', {}, ctx);

    const t = topics[i];
    return (
      sayText(`נושא ${i + 1} מתוך ${topics.length}`) +
      sayText(t.title || 'ללא כותרת') +
      sayText(`${t.postcount || 0} תגובות`) +
      sayMenu(['1 האזן לפוסטים', '6 נושא הבא', '4 נושא קודם', '8 פרטי הנושא', '7 חזרה לקטגוריות', '9 תפריט ראשי'],
              'categories', { categoryId, index: i }, ctx)
    );
  }

  // רשימת קטגוריות
  const cats = await fetchCategories(parentCatId || null);
  if (!cats.length) return sayText('אין קטגוריות') + askWithState('main', {}, ctx);

  const i = pressed === '6' ? Math.min(index + 1, cats.length - 1)
          : pressed === '4' ? Math.max(index - 1, 0)
          : index;

  if (pressed === '1') {
    const cat = cats[i];
    if (cat.children && cat.children.length > 0)
      return askWithState('categories', { parentCatId: String(cat.cid), index: 0 }, ctx);
    return askWithState('categories', { categoryId: String(cat.cid), index: 0 }, ctx);
  }
  if (pressed === '7') return askWithState('categories', { index: 0 }, ctx);
  if (pressed === '9') return askWithState('main', {}, ctx);

  const cat = cats[i];
  const hasChildren = cat.children && cat.children.length > 0;
  const opts = [
    `1 ${hasChildren ? 'תת קטגוריות' : 'נושאים בקטגוריה'}`,
    '6 קטגוריה הבאה',
    '4 קטגוריה קודמת',
    ...(parentCatId ? ['7 חזרה לקטגוריות ראשיות'] : []),
    '9 תפריט ראשי',
  ];

  return (
    sayText(`קטגוריה ${i + 1} מתוך ${cats.length}`) +
    sayText(cat.name || 'ללא שם') +
    (cat.topic_count ? sayText(`${cat.topic_count} נושאים`) : '') +
    sayMenu(opts, 'categories', { index: i, parentCatId: parentCatId || '' }, ctx)
  );
}

/* ========= פוסטים בנושא ========= */

async function handleTopicPosts(ctx) {
  const { pressed, topicId, index } = ctx;
  if (!topicId) return askWithState('main', {}, ctx);

  const posts = await fetchTopicPosts(topicId, 20);
  if (!posts.length) return sayText('אין פוסטים') + askWithState('main', {}, ctx);

  const i = pressed === '6' ? Math.min(index + 1, posts.length - 1)
          : pressed === '4' ? Math.max(index - 1, 0)
          : index;

  if (pressed === '8') return askWithState('post_details', { postId: String(posts[i]?.pid || '') }, ctx);
  if (pressed === '9') return askWithState('main', {}, ctx);

  const p = posts[i];
  const text = cleanHtml(p.content || '').substring(0, 280);
  return (
    sayText(`פוסט ${i + 1} מתוך ${posts.length}`) +
    sayText(text) +
    sayMenu(['6 פוסט הבא', '4 פוסט קודם', '8 פרטי הפוסט', '9 תפריט ראשי'],
            'topic_posts', { topicId, index: i }, ctx)
  );
}

/* ========= פרטי פוסט ========= */

async function handlePostDetails(ctx) {
  const { pressed, postId } = ctx;
  if (!postId || pressed === '9') return askWithState('main', {}, ctx);

  const post = await fetchPostDetails(postId);
  if (!post) return sayText('הפוסט לא נמצא') + askWithState('main', {}, ctx);

  const date = post.timestamp ? new Date(post.timestamp).toLocaleDateString('he-IL') : 'לא ידוע';
  const replyTo = post.toPid ? `בתגובה לפוסט ${post.toPid}` : 'פוסט פתיחה';

  return (
    sayText('פרטי הפוסט') +
    sayText(`כותב: ${post.user?.username || 'לא ידוע'}`) +
    sayText(`תאריך: ${date}`) +
    sayText(replyTo) +
    sayText(`נושא: ${post.topic?.title || 'לא ידוע'}`) +
    sayText(`קטגוריה: ${post.category?.name || 'לא ידוע'}`) +
    sayMenu(['9 תפריט ראשי'], 'post_details', { postId }, ctx)
  );
}

/* ========= פרטי נושא ========= */

async function handleTopicDetails(ctx) {
  const { pressed, topicId } = ctx;
  if (!topicId || pressed === '9') return askWithState('main', {}, ctx);

  const topic = await fetchTopicDetails(topicId);
  if (!topic) return sayText('הנושא לא נמצא') + askWithState('main', {}, ctx);

  const date = topic.timestamp ? new Date(topic.timestamp).toLocaleDateString('he-IL') : 'לא ידוע';

  return (
    sayText('פרטי הנושא') +
    sayText(`כותרת: ${topic.title || 'ללא כותרת'}`) +
    sayText(`נפתח על ידי: ${topic.user?.username || 'לא ידוע'}`) +
    sayText(`תאריך: ${date}`) +
    sayText(`${topic.postcount || 0} תגובות, ${topic.viewcount || 0} צפיות`) +
    sayText(`קטגוריה: ${topic.category?.name || 'לא ידוע'}`) +
    sayMenu(['1 האזן לפוסטים', '9 תפריט ראשי'], 'topic_details', { topicId }, ctx)
  );
}

/* ========= עזר ========= */

function cleanHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, 'ו')
    .replace(/&lt;|&gt;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
