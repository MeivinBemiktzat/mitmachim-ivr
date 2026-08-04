/**
 * Vercel Cron Job: בדיקת התראות חדשות ושליחת צינתוקים למנויים.
 * ==========================================================================
 * רץ אוטומטית לפי לוח הזמנים המוגדר ב-vercel.json (ר' שם), ומבצע עבור כל
 * אחד משלושת הפורומים הנתמכים (mitmachim / freeivr / otzaria):
 *
 *   1. שליפת כל המנויים הפעילים לצינתוקים (listTzintukSubscribers, ר'
 *      userStore.js) - כל מי שיש לו רשומה עם enabled=true תחת אותה מערכת.
 *   2. עבור כל מנוי: שליפת פרטי ההתחברות שלו לפורום (getUserCredentials),
 *      login כמשתמש הזה עצמו (loginAsUser) ושליפת רשימת ההתראות שלו
 *      (fetchUserNotifications) - *אותה לוגיקה בדיוק* שמשמשת את שלוחה 5
 *      בכל אחת מגרסאות ה-IVR (api/yemot|freeivr|otzaria/index.js), נחשפת
 *      דרך app.loginAsUser/app.fetchUserNotifications כדי לא לשכפל קוד.
 *   3. איתור התראות "חדשות באמת" - שתי בדיקות משולבות, בדיוק לפי הדרישה
 *      המקורית ("צינתוקים יישלחו רק על התראות חדשות, ולא פעמיים על אותה
 *      התראה"):
 *        a. newer than sub.since  - "חדש" מוגדר החל מרגע ההרשמה לצינתוקים.
 *        b. newer than sub.lastNotifiedAt (אם קיים) - כדי לא לשלוח שוב על
 *           התראה שכבר צונתקה בהרצה קודמת של ה-cron.
 *      נלקח הזמן היעיל (effective floor) = המאוחר מבין שני התאריכים האלו.
 *   4. אם נמצאו התראות חדשות - שליחת צינתוק בודד (לא אחד לכל התראה, כדי לא
 *      "להפציץ" את המשתמש בכמה שיחות רצופות אם הצטברו כמה התראות בין הרצה
 *      אחת לשנייה) דרך tzintukSender.js, ולאחר מכן עדכון lastNotifiedAt
 *      (updateLastNotifiedTimestamp) לזמן ההתראה החדשה ביותר שנמצאה - כדי
 *      שההתראות האלו לא ייחשבו "חדשות" שוב בהרצה הבאה.
 *   5. עדכון lastNotifiedAt מתבצע *רק אחרי* שליחת הצינתוק הצליחה בפועל -
 *      אם השליחה נכשלה (שגיאת רשת/API), lastNotifiedAt לא מתעדכן, כדי
 *      שההתראה תנוסה שוב בהרצה הבאה של ה-cron ולא "תאבד" בשקט.
 *
 * אבטחה: Vercel Cron Jobs שולחים בקשה עם header 'Authorization: Bearer
 * <CRON_SECRET>' (ר' תיעוד רשמי של Vercel Cron Jobs), ומאמתים כנגד משתנה
 * הסביבה CRON_SECRET שיש להגדיר ב-Vercel Project Settings. אם המשתנה
 * מוגדר, מסרבים לכל בקשה שלא נושאת את אותו secret בדיוק - כדי שגורם חיצוני
 * לא יוכל להפעיל את ה-endpoint הזה (ולגרום לשליחת צינתוקים לא רצויים,
 * שיש להם עלות) על ידי קריאה ישירה לכתובת הציבורית שלו. אם המשתנה אינו
 * מוגדר בסביבה (למשל בפיתוח מקומי), הבדיקה מדולגת - ר' הערה בקוד עצמו.
 *
 * מבנה תגובה: JSON עם סיכום ריצה (per-system: כמה מנויים נבדקו, כמה
 * צינתוקים נשלחו בהצלחה, כמה נכשלו) - מיועד לצפייה ביומני הרצת ה-cron
 * ב-Vercel Dashboard, לא נצרך על ידי צד לקוח כלשהו.
 */

'use strict';

const express = require('express');

const {
  getUserCredentials,
  listTzintukSubscribers,
  updateLastNotifiedTimestamp
} = require('../userStore');
const { sendTzintuk } = require('../tzintukSender');

/** אחת לכל פורום נתמך: system (מזהה ב-userStore, זהה ל-FORUM_SYSTEM_ID/
 *  'mitmachim' בכל אחת מגרסאות ה-IVR), ו-app (אובייקט ה-Express המיוצא
 *  מאותו קובץ IVR, שעליו נחשפים loginAsUser/fetchUserNotifications - ר'
 *  ההערה שנוספה בסוף כל אחד משלושת קבצי ה-IVR). ה-require מתבצע פה (לא
 *  ברמת המודול הגלובלית של כל קובץ IVR) בלי סיכון ל-side effects נוספים -
 *  כל קובצי ה-IVR כבר בטוחים ל-require מרובה (app.listen רק תחת
 *  require.main === module, ר' סוף כל קובץ).
 */
const FORUMS = [
  { system: 'mitmachim', app: require('../yemot/index') },
  { system: 'freeivr', app: require('../freeivr/index') },
  { system: 'otzaria', app: require('../otzaria/index') }
];

/**
 * מטפל במנוי בודד עבור מערכת (system) נתונה: שולף התראות, מאתר "חדשות
 * באמת" (ר' תיעוד בראש הקובץ), שולח צינתוק אם צריך, ומעדכן lastNotifiedAt.
 * לעולם לא זורק - שגיאה במנוי בודד לא אמורה לעצור את הבדיקה של שאר
 * המנויים באותה הרצה (ר' הלולאה הראשית למטה).
 */
async function processSubscriber(forum, subscriber) {
  const { system, app } = forum;
  const { phone } = subscriber;

  const creds = await getUserCredentials(phone, system);
  if (!creds) {
    // מצב לא אמור לקרות בזרימה הרגילה (הרשמה לצינתוקים דורשת פרטי
    // התחברות קיימים תחילה - ר' tzintukSettingsFlow בכל קובץ IVR), אבל
    // ייתכן תיאורטית אם המשתמש מחק את שיוך הפורום שלו מבלי לבטל את
    // ההרשמה לצינתוקים. מדלגים בשקט, לא שגיאה.
    return { phone, status: 'skipped-no-credentials' };
  }

  const userCookie = await app.loginAsUser(creds.username, creds.password);
  const data = await app.fetchUserNotifications(userCookie);
  const notifications = data?.notifications || [];

  const sinceTime = new Date(subscriber.since).getTime();
  const lastNotifiedTime = subscriber.lastNotifiedAt
    ? new Date(subscriber.lastNotifiedAt).getTime()
    : null;
  // הזמן היעיל שממנו התראה נחשבת "חדשה וטרם צונתקה": המאוחר מבין since
  // (מועד ההרשמה) לבין lastNotifiedAt (מועד ההתראה האחרונה שכבר צונתקה) -
  // ר' תיעוד מפורט בראש הקובץ, סעיף 3.
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
    return { phone, status: 'no-new-notifications' };
  }

  await sendTzintuk(phone);

  // עדכון lastNotifiedAt רק אחרי ששליחת הצינתוק הצליחה בפועל (השורה
  // הקודמת הייתה זורקת ולא היינו מגיעים לכאן אם sendTzintuk נכשל) - כך
  // שאם השליחה נכשלת, ההתראות האלו יינסו שוב בהרצה הבאה של ה-cron ולא
  // "יאבדו" בשקט (ר' תיעוד בראש הקובץ, סעיף 5).
  await updateLastNotifiedTimestamp(phone, system, new Date(newestNewTime).toISOString());

  return { phone, status: 'tzintuk-sent', newCount };
}

/** מטפל בכל המנויים הפעילים של מערכת (system/forum) אחת. שגיאה במנוי בודד
 *  נלכדת ומדווחת בנפרד (לא זורקת החוצה) כדי שלא תעצור מנויים אחרים באותה
 *  מערכת או במערכות האחרות. */
async function processForum(forum) {
  const results = { system: forum.system, checked: 0, sent: 0, failed: 0, details: [] };

  let subscribers;
  try {
    subscribers = await listTzintukSubscribers(forum.system);
  } catch (err) {
    console.error(`[cron/check-notifications] שגיאה בשליפת רשימת מנויים עבור ${forum.system}`, err.message);
    results.details.push({ status: 'list-error', error: err.message });
    return results;
  }

  for (const subscriber of subscribers) {
    results.checked++;
    try {
      const outcome = await processSubscriber(forum, subscriber);
      results.details.push(outcome);
      if (outcome.status === 'tzintuk-sent') results.sent++;
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

app.get('/api/cron/check-notifications', async (req, res) => {
  // אימות מול CRON_SECRET (ר' תיעוד מפורט בראש הקובץ) - מדלגים על הבדיקה
  // רק אם המשתנה כלל לא מוגדר בסביבה (למשל ריצה מקומית לצורך בדיקות).
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${expectedSecret}`) {
      console.error('[cron/check-notifications] בקשה נדחתה - Authorization header לא תואם ל-CRON_SECRET');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const startedAt = Date.now();
  const results = [];
  for (const forum of FORUMS) {
    results.push(await processForum(forum));
  }

  const summary = {
    ok: true,
    durationMs: Date.now() - startedAt,
    forums: results
  };
  console.log('[cron/check-notifications] סיכום הרצה', JSON.stringify(summary));
  return res.status(200).json(summary);
});

if (require.main === module) {
  const port = process.env.PORT || 3003;
  app.listen(port, () => console.log(`Cron check-notifications פועל על פורט ${port}`));
}

module.exports = app;
