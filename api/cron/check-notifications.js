/**
 * Endpoint: בדיקת התראות חדשות ושליחת צינתוקים למנויים - מופעל ע"י Upstash
 * QStash (Scheduler חיצוני), לא ע"י Vercel Cron Jobs ולא ע"י GitHub Actions.
 * ==========================================================================
 * מוגדר ב-Upstash QStash כ-Schedule שרץ כל 2 דקות ומבצע HTTP GET/POST לכתובת
 * הזו (ר' README / הדרכת ההגדרה שנמסרה בנפרד). מבצע עבור כל אחד מארבעת
 * הפורומים הנתמכים (mitmachim / freeivr / otzaria / goodlink / binatop):
 *
 *   1. שליפת כל המנויים הפעילים לצינתוקים (listTzintukSubscribers, ר'
 *      userStore.js) - כל מי שיש לו רשומה עם enabled=true תחת אותה מערכת.
 *   2. עבור כל מנוי: שליפת פרטי ההתחברות שלו לפורום (getUserCredentials),
 *      login כמשתמש הזה עצמו (loginAsUser) ושליפת רשימת ההתראות שלו
 *      (fetchUserNotifications) - *אותה לוגיקה בדיוק* שמשמשת את שלוחה 5
 *      בכל אחת מגרסאות ה-IVR (api/yemot|freeivr|otzaria/index.js), נחשפת
 *      דרך app.loginAsUser/app.fetchUserNotifications כדי לא לשכפל קוד.
 *   3. איתור התראות "חדשות באמת" - שתי בדיקות משולבות:
 *        a. newer than sub.since  - "חדש" מוגדר החל מרגע ההרשמה לצינתוקים.
 *        b. newer than sub.lastNotifiedAt (אם קיים) - כדי לא לשלוח שוב על
 *           התראה שכבר צונתקה בהרצה קודמת.
 *      נלקח הזמן היעיל (effective floor) = המאוחר מבין שני התאריכים האלו.
 *   4. אם נמצאו התראות חדשות וגם המשתמש כבר הצטרף בפועל לרשימת הצינתוק שלו
 *      (listJoined=true, ר' userStore.js) - שליחת צינתוק בודד (לא אחד לכל
 *      התראה) דרך tzintukSender.js, לפי tzintukListId (לא לפי מספר הטלפון
 *      - ר' תיקון קריטי בסעיף "תיקון באג" למטה), ולאחר מכן עדכון
 *      lastNotifiedAt לזמן ההתראה החדשה ביותר שנמצאה.
 *   5. עדכון lastNotifiedAt מתבצע *רק אחרי* שליחת הצינתוק הצליחה בפועל -
 *      אם השליחה נכשלה, lastNotifiedAt לא מתעדכן, כדי שההתראה תנוסה שוב
 *      בהרצה הבאה ולא "תאבד" בשקט.
 *
 * ------------------------------------------------------------------------
 * תיקון באג קריטי (בעת המעבר מ-GitHub Actions ל-QStash):
 * הקוד הקודם קרא ל-sendTzintuk(phone) - אך tzintukSender.sendTzintuk מצפה
 * לקבל listId (מזהה רשימת tzl:), לא מספר טלפון גולמי, ומרכיב בעצמו את
 * phones=tzl:<listId>. שליחת מספר טלפון גולמי לפרמטר שאמור להכיל רק listId
 * הייתה עלולה לגרום לכשל בקריאה ל-RunTzintuk (הפרמטר בפועל היה הופך ל-
 * phones=tzl:0501234567 - מזהה רשימה שלא קיים). כעת נקרא עם subscriber.
 * tzintukListId בלבד, ורק אם גם listJoined===true (אחרת אין טעם להפעיל
 * את הרשימה - היא ריקה, ר' תיעוד ב-userStore.js).
 * ------------------------------------------------------------------------
 *
 * אבטחה (שתי שכבות עצמאיות, שתיהן חייבות לעבור אם מוגדרות):
 *   1. Authorization: Bearer <CRON_SECRET> - סוד סטטי שמוגדר גם ב-Upstash
 *      QStash (כ-Header קבוע על ה-Schedule/Endpoint) וגם במשתני הסביבה של
 *      Vercel. מונע קריאה ע"י מי שלא מכיר את הסוד, גם אם ה-URL ידוע.
 *   2. Upstash-Signature - חתימת HMAC שQStash עצמו מצרף לכל קריאה, מאומתת
 *      מול @upstash/qstash Receiver (currentSigningKey/nextSigningKey) לפי
 *      ההמלצה הרשמית של Upstash. מוודאת שהבקשה אכן הגיעה מ-QStash עצמו
 *      (ולא רק ממי שגילה את ה-CRON_SECRET, שכבת הגנה נוספת ובלתי תלויה).
 *   שתי הבדיקות מדולגות רק אם משתנה הסביבה הרלוונטי אינו מוגדר כלל בסביבה
 *   (root cause: פיתוח מקומי) - ר' פירוט בקוד עצמו.
 *
 * מניעת Timeout מול QStash: QStash מצפה לתגובה מהירה ועושה Retry עם
 * Backoff אם ה-endpoint לא עונה בזמן (ר' תיעוד QStash Retries). מאחר שריצה
 * מלאה על כל המנויים בכל הפורומים עלולה לקחת כמה שניות (login+fetch לכל
 * מנוי, ברצף), אך עדיין בטווח סביר למגבלת הזמן של פונקציית Vercel (ר'
 * maxDuration=60 ב-vercel.json), הבחירה כאן היא *לא* "ירה ותשכח" (לא
 * fire-and-forget) אלא להריץ באופן סינכרוני ולהחזיר את סיכום התוצאה בפועל
 * - כך שגם QStash Logs וגם Vercel Dashboard משקפים בדיוק מה קרה בכל הרצה,
 * וגם כדי ש-Idempotency Lock (ר' למטה) יינעל וישוחרר בתוך אותה בקשה בלבד.
 * אם בעתיד מספר המנויים יגדל משמעותית ו-60 שניות לא יספיקו - יש להמיר
 * לדפוס "202 מיידי + עיבוד ברקע" (למשל ע"י פרסום הודעה חדשה ל-QStash
 * שמפעילה endpoint נפרד לעיבוד בפועל).
 *
 * מניעת הרצות כפולות (Idempotency): QStash מבטיח at-least-once delivery -
 * כלומר יכול לבצע Retry (Timeout/שגיאת רשת/5xx) ולקרוא לנקודת הקצה הזו
 * פעמיים או יותר עבור אותה "הרצה מתוזמנת" בפועל. כדי שזה לא יגרום לצינתוק
 * כפול, נעשה שימוש בשני מנגנונים משלימים:
 *   א. Deduplication ברמת ה-message: כותרת Upstash-Deduplication-Id (ר'
 *      תיעוד QStash) - QStash עצמו מזהה ולא מפעיל פעמיים את אותה הודעה
 *      אם הוגדר Content-Based Deduplication ב-Schedule (ר' הדרכת ההגדרה).
 *   ב. Idempotency Lock ברמת האפליקציה (הגנה עצמאית, לא תלויה בהגדרות
 *      QStash הספציפיות): לפני תחילת עיבוד, ננעל מפתח Redis זמני
 *      (mitmachim:cron:lock, TTL קצר מהתדירות של 2 דקות) באמצעות
 *      SET ... NX EX - אם הנעילה נכשלת (כלומר כבר יש הרצה פעילה/שהסתיימה
 *      זה עתה), מוחזר מיידית 200 עם status='skipped-duplicate' בלי לגעת
 *      במנויים כלל. הנעילה משוחררת (DEL) בסוף ההרצה (finally), כדי שההרצה
 *      התקינה הבאה (בעוד ~2 דקות) לא תיחסם.
 *
 * לוגים: כל שלב מתועד ל-console (נצפה ב-Vercel Dashboard -> Project ->
 * Logs) - כולל metadata על הבקשה עצמה (IP, Request-Id, זמן), תוצאות
 * האימותים, וסטטיסטיקת ריצה מפורטת per-forum ו-per-subscriber.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const { Receiver } = require('@upstash/qstash');

const {
  getUserCredentials,
  listTzintukSubscribers,
  updateLastNotifiedTimestamp
} = require('../userStore');
const { sendTzintuk } = require('../tzintukSender');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** מפתח הנעילה של הרצת ה-cron (ר' תיעוד Idempotency בראש הקובץ). קבוע
 *  (אין תלות ב-system/phone) - כי המטרה היא למנוע *הרצה כפולה כוללת* של
 *  כל הבדיקה, לא לנעול per-subscriber (ר' גם עדכון lastNotifiedAt הקיים,
 *  שמשמש כשכבת הגנה נוספת ברמת ה-subscriber הבודד). */
const LOCK_KEY = 'mitmachim:cron:lock';
/** TTL של הנעילה בשניות - נמוך מהתדירות המתוכננת (2 דקות = 120 שניות) כדי
 *  שלא תישאר נעילה "תקועה" זמן רב אם ה-finally לא הופעל מסיבה חריגה
 *  (למשל crash קשה של התהליך) - במקרה כזה, ההרצה הבאה בעוד עד 90 שניות
 *  תצליח להינעל מחדש. */
const LOCK_TTL_SECONDS = 90;

/** אחת לכל פורום נתמך: system (מזהה ב-userStore) ו-app (אובייקט ה-Express
 *  המיוצא מאותו קובץ IVR, שעליו נחשפים loginAsUser/fetchUserNotifications). */
const FORUMS = [
  { system: 'mitmachim', app: require('../yemot/index') },
  { system: 'freeivr', app: require('../freeivr/index') },
  { system: 'otzaria', app: require('../otzaria/index') },
  { system: 'goodlink', app: require('../goodlink/index') },
  { system: 'binatop', app: require('../binatop/index') }
];

/** קריאת פקודת Redis בודדת מול Upstash REST API - זהה בעיקרון ל-upstashCommand
 *  הפנימי ב-userStore.js, אך משוכפל פה במכוון (ולא exported משם) כי מדובר
 *  בפונקציונליות ספציפית לנעילת ה-cron (SET NX EX / DEL) שאינה קשורה
 *  לתחום האחריות הרגיל של userStore (ניהול פרטי משתמשים/הרשמות לצינתוק). */
async function upstashCommand(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN לא מוגדרים בסביבה');
  }
  const axios = require('axios');
  const path = args.map((a) => encodeURIComponent(a)).join('/');
  const { data } = await axios.get(`${UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 8000
  });
  return data?.result;
}

/** מנסה לנעול את ריצת ה-cron הנוכחית. מחזיר true אם הנעילה התקבלה (אין
 *  הרצה מקבילה/כפולה פעילה כרגע), false אם כבר קיימת נעילה תקפה (כלומר
 *  זו כנראה קריאת Retry כפולה מ-QStash על אותה הרצה מתוזמנת, או שתי
 *  הרצות שהצטלבו בזמן) - ר' תיעוד Idempotency בראש הקובץ.
 *  שים לב: אם Upstash Redis עצמו לא זמין/נכשל, אנחנו *לא* חוסמים את
 *  הריצה (fail-open) - עדיף לקחת סיכון נמוך של הרצה כפולה מדי פעם מאשר
 *  להפסיק לשלוח התראות לחלוטין בגלל תקלה זמנית בשכבת הנעילה. השגיאה
 *  מתועדת ללוג בכל מקרה.
 */
async function acquireRunLock(requestId) {
  try {
    const result = await upstashCommand('SET', LOCK_KEY, requestId, 'NX', 'EX', String(LOCK_TTL_SECONDS));
    return result === 'OK';
  } catch (err) {
    console.error('[cron/check-notifications] שגיאה בניסיון נעילת הרצה (fail-open, ממשיכים בכל זאת)', err.message);
    return true;
  }
}

/** משחרר את נעילת ריצת ה-cron. נקרא תמיד ב-finally, בין אם ההרצה הצליחה
 *  ובין אם נכשלה - כדי שההרצה המתוזמנת הבאה (בעוד כ-2 דקות) לא תיחסם. */
async function releaseRunLock() {
  try {
    await upstashCommand('DEL', LOCK_KEY);
  } catch (err) {
    console.error('[cron/check-notifications] שגיאה בשחרור נעילת הרצה (תתפוגג ממילא לפי TTL)', err.message);
  }
}

/**
 * מטפל במנוי בודד עבור מערכת (system) נתונה: שולף התראות, מאתר "חדשות
 * באמת", שולח צינתוק אם צריך (ורק אם listJoined===true), ומעדכן
 * lastNotifiedAt. לעולם לא זורק - שגיאה במנוי בודד לא אמורה לעצור את
 * הבדיקה של שאר המנויים באותה הרצה (ר' הלולאה הראשית למטה).
 */
async function processSubscriber(forum, subscriber, log) {
  const { system, app } = forum;
  const { phone } = subscriber;

  const creds = await getUserCredentials(phone, system);
  if (!creds) {
    log(`מנוי ${phone} (${system}): אין פרטי התחברות שמורים - מדלגים`);
    return { phone, status: 'skipped-no-credentials' };
  }

  if (!subscriber.tzintukListId) {
    log(`מנוי ${phone} (${system}): אין עדיין tzintukListId (שלוחה אישית טרם נוצרה) - מדלגים`);
    return { phone, status: 'skipped-no-list-id' };
  }

  if (!subscriber.listJoined) {
    log(`מנוי ${phone} (${system}): טרם אישר הצטרפות טלפונית לרשימה (listJoined=false) - מדלגים`);
    return { phone, status: 'skipped-not-joined' };
  }

  const userCookie = await app.loginAsUser(creds.username, creds.password);
  const data = await app.fetchUserNotifications(userCookie);
  const notifications = data?.notifications || [];
  log(`מנוי ${phone} (${system}): נשלפו ${notifications.length} התראות בסה"כ`);

  const sinceTime = new Date(subscriber.since).getTime();
  const lastNotifiedTime = subscriber.lastNotifiedAt
    ? new Date(subscriber.lastNotifiedAt).getTime()
    : null;
  const floorTime = lastNotifiedTime && lastNotifiedTime > sinceTime ? lastNotifiedTime : sinceTime;

  let newestNewTime = null;
  let newCount = 0;
  for (const notif of notifications) {
    const t = new Date(notif.datetimeISO || notif.datetime || 0).getTime();
    if (isNaN(t) || t <= floorTime) continue;
    newCount++;
    if (newestNewTime === null || t > newestNewTime) newestNewTime = t;
  }

  if (newCount === 0) {
    log(`מנוי ${phone} (${system}): אין התראות חדשות (floor=${new Date(floorTime).toISOString()})`);
    return { phone, status: 'no-new-notifications' };
  }

  log(`מנוי ${phone} (${system}): נמצאו ${newCount} התראות חדשות - שולח צינתוק לרשימה tzl:${subscriber.tzintukListId}`);
  // תיקון קריטי: שולחים לפי tzintukListId (מזהה רשימת tzl:), *לא* לפי
  // מספר הטלפון - ר' תיעוד "תיקון באג" בראש הקובץ.
  await sendTzintuk(subscriber.tzintukListId);

  await updateLastNotifiedTimestamp(phone, system, new Date(newestNewTime).toISOString());
  log(`מנוי ${phone} (${system}): צינתוק נשלח בהצלחה, lastNotifiedAt עודכן ל-${new Date(newestNewTime).toISOString()}`);

  return { phone, status: 'tzintuk-sent', newCount };
}

/** מטפל בכל המנויים הפעילים של מערכת (system/forum) אחת. שגיאה במנוי בודד
 *  נלכדת ומדווחת בנפרד (לא זורקת החוצה) כדי שלא תעצור מנויים אחרים -
 *  ר' דרישת "שיפור אמינות": כשל חלקי לא אמור לגרום לאובדן מידע, כל מנוי
 *  אחר ימשיך להיבדק כרגיל, וכל מנוי שנכשל ייבדק שוב בהרצה הבאה (כי
 *  lastNotifiedAt לא מתעדכן לו במקרה כשל). */
async function processForum(forum, log) {
  const results = { system: forum.system, checked: 0, sent: 0, failed: 0, skipped: 0, details: [] };

  let subscribers;
  try {
    subscribers = await listTzintukSubscribers(forum.system);
    log(`מערכת ${forum.system}: נמצאו ${subscribers.length} מנויים פעילים לבדיקה`);
  } catch (err) {
    console.error(`[cron/check-notifications] שגיאה בשליפת רשימת מנויים ��בור ${forum.system}`, err.message);
    results.details.push({ status: 'list-error', error: err.message });
    return results;
  }

  for (const subscriber of subscribers) {
    results.checked++;
    try {
      const outcome = await processSubscriber(forum, subscriber, log);
      results.details.push(outcome);
      if (outcome.status === 'tzintuk-sent') results.sent++;
      else if (outcome.status.startsWith('skipped')) results.skipped++;
    } catch (err) {
      results.failed++;
      console.error(
        `[cron/check-notifications] שגיאה בטיפול במנוי ${subscriber.phone} (${forum.system})`,
        err.message
      );
      results.details.push({ phone: subscriber.phone, status: 'error', error: err.message });
    }
  }

  return results;
}

const app = express();
app.disable('x-powered-by');
// נדרש raw body (לא JSON מפורק) לצורך אימות חתימת QStash (HMAC על התוכן
// הגולמי המדויק שנשלח) - ר' תיעוד Receiver.verify של @upstash/qstash.
// express.raw שומר את req.body כ-Buffer; הופך אותו למחרוזת מפורשות בהמשך.
app.use('/api/cron/check-notifications', express.raw({ type: '*/*' }));

let qstashReceiver = null;
if (process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY) {
  qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY
  });
}

app.all('/api/cron/check-notifications', async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const nowIso = new Date().toISOString();

  const log = (msg) => console.log(`[cron/check-notifications][${requestId}] ${msg}`);

  log(`התקבלה קריאה חדשה | method=${req.method} | ip=${ip} | time=${nowIso}`);

  // --- שכבת אימות 1: CRON_SECRET (סוד סטטי משותף) ---
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers['authorization'] || '';
    const authOk = authHeader === `Bearer ${expectedSecret}`;
    log(`אימות Authorization (CRON_SECRET): ${authOk ? 'הצליח' : 'נכשל'}`);
    if (!authOk) {
      log('בקשה נדחתה - Authorization header לא תואם ל-CRON_SECRET');
      return res.status(401).json({ error: 'Unauthorized', requestId });
    }
  } else {
    log('אימות Authorization (CRON_SECRET): דולג - CRON_SECRET לא מוגדר בסביבה');
  }

  // --- שכבת אימות 2: חתימת QStash (Upstash-Signature) ---
  if (qstashReceiver) {
    // ר' הערת Upstash: בחלק מהפלטפורמות (כולל Vercel) ה-header עשוי להגיע
    // באותיות קטנות - Express כבר מנרמל שמות headers לאותיות קטנות, כך
    // ש-req.headers['upstash-signature'] תמיד עובד ללא תלות בקידוד המקורי.
    const signature = req.headers['upstash-signature'];
    if (!signature) {
      log('אימות חתימת QStash: נכשל - header Upstash-Signature חסר');
      return res.status(401).json({ error: 'Missing Upstash-Signature header', requestId });
    }
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      // בונים את כתובת ה-URL המלאה כפי שהיא מוכרת מבחוץ (Vercel נמצא מאחורי
      // proxy, ולכן יש להסתמך על x-forwarded-host/proto ולא על req.headers.host
      // הפנימי בלבד) - נדרש כדי שהחתימה (הכוללת את ה-URL) תאומת נכון.
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers['host'];
      const fullUrl = `${proto}://${host}${req.originalUrl || req.url}`;
      const isValid = await qstashReceiver.verify({ signature, body: rawBody, url: fullUrl });
      log(`אימות חתימת QStash: ${isValid ? 'הצליח' : 'נכשל'}`);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid QStash signature', requestId });
      }
    } catch (err) {
      log(`אימות חתימת QStash: נכשל עם שגיאה - ${err.message}`);
      return res.status(401).json({ error: 'QStash signature verification failed', requestId });
    }
  } else {
    log('אימות חתימת QStash: דולג - QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY לא מוגדרים בסביבה');
  }

  // --- מניעת הרצות כפולות ברמת האפליקציה (ר' תיעוד Idempotency בראש הקובץ) ---
  const lockAcquired = await acquireRunLock(requestId);
  if (!lockAcquired) {
    log('הרצה נדחתה - קיימת כבר הרצה פעילה/שהסתיימה זה עתה (ננעלה ב-Redis) - כנראה Retry כפול של QStash');
    return res.status(200).json({
      ok: true,
      status: 'skipped-duplicate',
      requestId,
      durationMs: Date.now() - startedAt
    });
  }
  log('נעילת הרצה התקבלה - מתחילים עיבוד');

  try {
    const results = [];
    for (const forum of FORUMS) {
      results.push(await processForum(forum, log));
    }

    const totals = results.reduce(
      (acc, r) => ({
        checked: acc.checked + r.checked,
        sent: acc.sent + r.sent,
        failed: acc.failed + r.failed,
        skipped: acc.skipped + r.skipped
      }),
      { checked: 0, sent: 0, failed: 0, skipped: 0 }
    );

    const summary = {
      ok: true,
      requestId,
      durationMs: Date.now() - startedAt,
      totals,
      forums: results
    };

    log(
      `סיכום הרצה: נבדקו=${totals.checked} | צינתוקים נשלחו=${totals.sent} | ` +
      `דולגו=${totals.skipped} | נכשלו=${totals.failed} | משך=${summary.durationMs}ms`
    );

    return res.status(200).json(summary);
  } catch (err) {
    console.error(`[cron/check-notifications][${requestId}] שגיאה כללית בלתי צפויה בהרצה`, err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      requestId,
      durationMs: Date.now() - startedAt
    });
  } finally {
    // חובה לשחרר את הנעילה גם אם הייתה שגיאה - אחרת ההרצות הבאות ייחסמו
    // עד לפקיעת ה-TTL (90 שניות, ר' LOCK_TTL_SECONDS).
    await releaseRunLock();
    log('נעילת הרצה שוחררה');
  }
});

if (require.main === module) {
  const port = process.env.PORT || 3003;
  app.listen(port, () => console.log(`Cron check-notifications פועל על פורט ${port}`));
}

module.exports = app;
