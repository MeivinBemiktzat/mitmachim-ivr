/**
 * מודול משותף: אחסון ושליפה של שיוך מספר-טלפון -> פרטי התחברות בפורום.
 * ==========================================================================
 * נטען מכמה מקומות:
 *   - api/register.js     (שמירה - הטופס הקולט מספר פלאפון + שם משתמש + סיסמא,
 *                          עבור אחד מהפורומים הנתמכים - ר' פרמטר system)
 *   - api/yemot/index.js   (שליפה - שלוחה 5 בגרסת פורום מתמחים טופ)
 *   - api/freeivr/index.js (שליפה - שלוחה 5 בגרסת פורום freeivr)
 *   - api/otzaria/index.js (שליפה - שלוחה 5 בגרסת פורום אוצריא)
 *   - api/goodlink/index.js (שליפה - שלוחה 5 בגרסת פורום גוד לינק)
 * הופרד לקובץ נפרד כדי שהנרמול של מספר הטלפון (normalizePhone) יהיה זהה
 * ב-100% בין כל הצרכנים - אם ייכתבו מימושים נפרדים יש סיכון ממשי שהפורמט
 * ייסטה (למשל טיפול שונה בקידומת 972) והזיהוי האוטומטי בשיחה ייכשל כי
 * המפתח שנשמר לא יתאים למפתח שמחפשים.
 *
 * תמיכה במספר פורומים (system): אותו מספר טלפון עשוי להיות משויך למספר
 * חשבונות שונים לגמרי - אחד בכל פורום נתמך (מתמחים טופ / freeivr / אוצריא /
 * גוד לינק) -
 * לכן מפתח ה-Redis כולל גם את זהות המערכת (system), לא רק את מספר הטלפון.
 * ערך ברירת המחדל של system הוא 'mitmachim' (שמירה על תאימות לאחור עם
 * רשומות שנשמרו לפני הוספת תמיכה בפורומים נוספים).
 *
 * אחסון: Upstash Redis REST API בלבד (ללא חבילת @upstash/redis) - קריאות
 * HTTP פשוטות עם axios, בהתאם לפורמט הרשמי: GET <URL>/<CMD>/<arg1>/<arg2>...
 * עם Authorization: Bearer <TOKEN>. ר' תיעוד רשמי: https://upstash.com/docs/redis/features/restapi
 *
 * משתני סביבה נדרשים (זהים לכל הצרכנים, משותפים בין שני הפורומים):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * הרשמה לצינתוקים (התראות טלפוניות): בנוסף לפרטי ההתחברות לפורום, מודול זה
 * מנהל גם רשומת "הרשמה לצינתוקים" נפרדת לכל צירוף (phone, system) - נשמרת
 * במפתח Redis נפרד (ר' tzintukKey למטה), כדי שהרשמה/הסרה מצינתוקים לא
 * תדרוס ולא תהיה תלויה בפרטי ההתחברות לפורום (saveUserCredentials/
 * getUserCredentials למעלה). הרשומה כוללת:
 *   {
 *     enabled: true,
 *     since: <ISO date>,
 *     lastNotifiedAt: <ISO date | null>,
 *     tzintukListId: <string | null>,
 *     listJoined: <boolean>
 *   }
 * since - הזמן שממנו מחשבים התראות כ"חדשות" (לפי בקשת המשתמש: "הזמן שממנו
 *   אנחנו מחשבים התראות כחדשות הוא החל מהזמן שבו המשתמש נרשם לצינתוקים").
 * lastNotifiedAt - הזמן (ISO) של ההתראה האחרונה שעבורה כבר נשלח צינתוק,
 *   כדי שלא יישלח צינתוק פעמיים על אותה התראה - ר' תיעוד מפורט ב-
 *   api/cron/check-notifications.js.
 * tzintukListId - מזהה רשימת הצינתוק האישית (tzl:) של המשתמש, כפי שנוצרה
 *   ע"י api/tzintukListManager.js (ensureTzintukExtension). המערכת עברה
 *   ממנגנון צינתוק ad-hoc למספר טלפון בודד למנגנון הרשמי של רשימות צינתוק
 *   חינמיות - ר' תיעוד מפורט ב-api/tzintukListManager.js וב-
 *   api/tzintukSender.js. null אצל מנוי שטרם הושלמה עבורו יצירת השלוחה
 *   האישית (למשל מנוי ישן מלפני השינוי - ר' getOrCreateTzintukListId למטה).
 * listJoined - true רק לאחר שהמשתמש ביצע בפועל את אישור ההצטרפות הטלפוני
 *   החד-פעמי לרשימה שלו (אין דרך API להוסיף אותו לרשימה מרחוק - ר' תיעוד
 *   ב-tzintukListManager.js). כל עוד false, אין טעם להפעיל RunTzintuk עבור
 *   הרשימה הזו (לא יגיע לאף אחד) - ר' cron/check-notifications.js.
 */

'use strict';

const axios = require('axios');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** זהות המערכת המשמשת כברירת מחדל כאשר לא צוין system מפורש - שומרת על
 *  תאימות לאחור עם רשומות שנשמרו לפני שנוספה תמיכה בפורום freeivr. */
const DEFAULT_SYSTEM = 'mitmachim';

/**
 * מנרמל מספר טלפון ישראלי לפורמט אחיד לשימוש כמפתח ב-Redis: מסיר כל תו
 * שאינו ספרה, ממיר קידומת בינלאומית 972 לקידומת מקומית 0, ומוודא שקיים 0
 * מוביל למספרים בני 9 ספרות (למשל "501234567" -> "0501234567").
 * הערה קריטית: ימות המשיח מעביר את מספר הטלפון של המתקשר (call.phone,
 * הנגזר משדה ApiPhone שנשלח מ-yemot-router2) בפורמט מקומי עם 0 מוביל
 * (למשל "0501234567") - ר' תיעוד snapshot של ימות. יש לנרמל לאותו פורמט
 * בדיוק גם כאשר המשתמש הזין את המספר בטופס עם קידומת 972+/972, רווחים
 * או מקפים.
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  if (!digits.startsWith('0') && digits.length === 9) digits = '0' + digits;
  return digits;
}

/** מנרמל את מזהה המערכת (system) - ברירת מחדל DEFAULT_SYSTEM אם לא סופק,
 *  ומוודא lowercase כדי שלא ייווצרו שני מפתחות שונים בגלל אות גדולה/קטנה. */
function normalizeSystem(system) {
  const s = (system || DEFAULT_SYSTEM).toString().trim().toLowerCase();
  return s || DEFAULT_SYSTEM;
}

function redisKey(phone, system) {
  return `mitmachim:phone:${normalizeSystem(system)}:${phone}`;
}

/** מפתח נפרד לרשומת הרשמה לצינתוקים (עצמאי ממפתח פרטי ההתחברות למעלה) -
 *  ר' תיעוד בראש הקובץ. */
function tzintukKey(phone, system) {
  return `mitmachim:tzintuk:${normalizeSystem(system)}:${phone}`;
}

/** מפתח עזר לסריקת SCAN (ר' listTzintukSubscribers) - תבנית עם כוכבית
 *  שתואמת לכל מספרי הטלפון תחת מערכת (system) נתונה. */
function tzintukScanPattern(system) {
  return `mitmachim:tzintuk:${normalizeSystem(system)}:*`;
}

/** קריאת פקודת Redis בודדת מול Upstash REST API (GET לפי path segments). */
async function upstashCommand(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN לא מוגדרים בסביבה');
  }
  const path = args.map((a) => encodeURIComponent(a)).join('/');
  const { data } = await axios.get(`${UPSTASH_URL}/${path}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 8000
  });
  return data?.result;
}

/** שומר את פרטי ההתחברות של המשתמש בפורום, ממופים למספר הטלפון המנורמל
 *  ולזהות המערכת (system) - כדי שאותו מספר טלפון יוכל להחזיק בו-זמנית
 *  שיוך נפרד לכל אחד מהפורומים הנתמכים (מתמחים טופ / freeivr / אוצריא).
 *  הערה קריטית (תוקן): בעבר הקוד לא בדק בכלל את תוצאת פקודת ה-SET מול
 *  Upstash - אם הפקודה נכשלה בצד Upstash מכל סיבה (auth זמני, timeout,
 *  תגובת שגיאה כלשהי) הקוד עדיין החזיר "הצלחה" למשתמש בטופס ההרשמה,
 *  והמשתמש היה משוכנע שהפרטים נשמרו כשבפועל הם מעולם לא נכתבו ל-Redis -
 *  בדיוק התסמין של "הנתונים נעלמים" (הם בכלל לא נשמרו מלכתחילה). כעת
 *  נבדק במפורש שהתגובה מ-Upstash היא 'OK' (זו תגובת ה-SET התקנית של
 *  Redis), ואם לא - נזרקת שגיאה ברורה כדי ש-register.js יציג למשתמש
 *  הודעת שגיאה אמיתית במקום הודעת הצלחה שגויה. */
async function saveUserCredentials(phone, username, password, system) {
  const normalizedPhone = normalizePhone(phone);
  const value = JSON.stringify({ username, password, updatedAt: new Date().toISOString() });
  const result = await upstashCommand('SET', redisKey(normalizedPhone, system), value);
  if (result !== 'OK') {
    console.error('[userStore] SET לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    throw new Error('השמירה ב-Redis לא אושרה (Upstash לא החזיר OK) - הפרטים כנראה לא נשמרו בפועל');
  }
  console.log(`[userStore] נשמר בהצלחה מפתח: ${redisKey(normalizedPhone, system)}`);
  return normalizedPhone;
}

/**
 * שולף את פרטי ההתחברות לפורום ששויכו למספר טלפון נתון עבור מערכת (system)
 * מסוימת, או null אם לא נמצא שיוך כזה (המשתמש עדיין לא נרשם באתר ההרשמה
 * עבור הפורום הזה - ייתכן שכן נרשם עבור הפורום האחר, תחת אותו מספר טלפון).
 */
async function getUserCredentials(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const key = redisKey(normalizedPhone, system);
  const raw = await upstashCommand('GET', key);
  if (!raw) {
    // לוג אבחוני קריטי: מציג בדיוק את המפתח שחיפשנו (כולל system מנורמל
    // ומספר טלפון מנורמל) - כדי שבמקרה של "המשתמש טוען שהוא נרשם אבל
    // המערכת לא מזהה אותו" ניתן יהיה להשוות ישירות מול Upstash Console
    // (Data Browser -> חיפוש לפי אותו מפתח בדיוק) ולראות אם המפתח קיים
    // שם עם ערך שונה, קיים תחת system אחר, או לא קיים כלל.
    console.log(`[userStore] לא נמצא מפתח בעת חיפוש: ${key} (טלפון גולמי: ${phone})`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.username || !parsed?.password) return null;
    return { username: parsed.username, password: parsed.password };
  } catch (err) {
    console.error('[userStore] שגיאה בפענוח פרטי משתמש שמורים', err.message);
    return null;
  }
}

/**
 * רושם מספר טלפון להתראות צינתוק עבור מערכת (system) נתונה. אם המשתמש כבר
 * רשום - הפעולה אינה משנה את since הקיים (אינה "מאפסת" את נקודת ההתחלה של
 * חישוב התראות חדשות) אלא רק מוודאת ש-enabled=true; זהו מצב אידמפוטנטי כדי
 * שהקשה חוזרת בטעות על "הרשמה" (שלוחה 9->1) לא תזיז את since קדימה ותגרום
 * להחמצת התראות שכבר נחשבו "חדשות" ביחס ל-since המקורי. הרשמה חדשה לגמרי
 * (אין רשומה קודמת, או שהיא הייתה enabled=false) מקבלת since=עכשיו בדיוק -
 * "הזמן שממנו אנחנו מחשבים התראות כחדשות הוא החל מהזמן שבו המשתמש נרשם".
 * מחזיר את רשומת ההרשמה המעודכנת.
 *
 * הערה: פונקציה זו אינה יוצרת/מוודאת כאן את שלוחת הצינתוק האישית (tzl:) -
 * זו אחריות של getOrCreateTzintukListId (קורא ל-tzintukListManager.js,
 * שמבצע קריאות רשת ל-Management API). subscribeToTzintuk עצמה נשארת
 * פעולת Redis בלבד, כמו שהייתה - כך שקריאה מ-register.js (טופס אתר,
 * ללא אינטראקציית טלפון) לא נכשלת/נתקעת רק בגלל תלות ברשת ימות.
 */
async function subscribeToTzintuk(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('מספר טלפון לא תקין');
  const key = tzintukKey(normalizedPhone, system);
  const existing = await getTzintukSubscription(normalizedPhone, system);
  if (existing?.enabled) {
    // כבר רשום - לא נוגעים ב-since הקיים, מחזירים את הרשומה כפי שהיא.
    return existing;
  }
  const record = {
    enabled: true,
    since: new Date().toISOString(),
    lastNotifiedAt: null,
    // תאימות לאחור: אם הייתה רשומה קודמת (enabled=false) עם tzintukListId/
    // listJoined משויכים כבר (למשל המשתמש ביטל ואז נרשם שוב) - משמרים אותם,
    // כדי לא לאבד שלוחה/הצטרפות שכבר קיימות בפועל בממשק ימות.
    tzintukListId: existing?.tzintukListId || null,
    listJoined: existing?.listJoined || false
  };
  const result = await upstashCommand('SET', key, JSON.stringify(record));
  if (result !== 'OK') {
    console.error('[userStore] SET (tzintuk subscribe) לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    throw new Error('הרשמה לצינתוקים נכשלה (Upstash לא החזיר OK)');
  }
  console.log(`[userStore] נרשם לצינתוקים: ${key}`);
  return record;
}

/**
 * מעדכן ברשומת ההרשמה הקיימת של המשתמש את tzintukListId (וזאת בלבד) -
 * נקראת ע"י getOrCreateTzintukListId לאחר שנוצרה בהצלחה השלוחה האישית
 * בממשק ימות (tzintukListManager.ensureTzintukExtension). לא נוגעת ב-
 * enabled/since/lastNotifiedAt/listJoined הקיימים.
 */
async function setTzintukListId(phone, system, listId) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('מספר טלפון לא תקין');
  const key = tzintukKey(normalizedPhone, system);
  const existing = await getTzintukSubscription(normalizedPhone, system);
  if (!existing) {
    console.error(`[userStore] setTzintukListId: אין רשומת הרשמה קיימת עבור ${key}`);
    return false;
  }
  const record = { ...existing, tzintukListId: listId };
  const result = await upstashCommand('SET', key, JSON.stringify(record));
  if (result !== 'OK') {
    console.error('[userStore] SET (setTzintukListId) לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    return false;
  }
  return true;
}

/**
 * מסמן שהמשתמש ביצע בפועל את אישור ההצטרפות הטלפוני החד-פעמי לרשימת
 * הצינתוק האישית שלו (listJoined=true) - ר' תיעוד מפורט ב-
 * tzintukListManager.js לגבי הסיבה שאין דרך API לבצע זאת מרחוק. נקראת רק
 * לאחר שהמשתמש עצמו חייג לשלוחה האישית שלו ואישר (ר' tzintukSettingsFlow
 * בכל אחד מקבצי ה-IVR) - זהו סימון "אני יודע שהוא בטח הצטרף", לא אימות
 * אמיתי מול ימות (אין API לכך), ולכן הוא רק best-effort.
 */
async function markTzintukListJoined(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('מספר טלפון לא תקין');
  const key = tzintukKey(normalizedPhone, system);
  const existing = await getTzintukSubscription(normalizedPhone, system);
  if (!existing) {
    console.error(`[userStore] markTzintukListJoined: אין רשומת הרשמה קיימת עבור ${key}`);
    return false;
  }
  const record = { ...existing, listJoined: true };
  const result = await upstashCommand('SET', key, JSON.stringify(record));
  if (result !== 'OK') {
    console.error('[userStore] SET (markTzintukListJoined) לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    return false;
  }
  return true;
}

/**
 * מסיר מספר טלפון מהרשמה לצינתוקים עבור מערכת (system) נתונה. שומר את
 * הרשומה עם enabled=false (ולא מוחק אותה לגמרי) כדי לשמר היסטוריה (since
 * המקורי) למקרה שהמשתמש יירשם שוב בעתיד - אז ייפתח since חדש (ר'
 * subscribeToTzintuk למעלה, שבודק enabled ולא רק קיום הרשומה).
 */
async function unsubscribeFromTzintuk(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('מספר טלפון לא תקין');
  const key = tzintukKey(normalizedPhone, system);
  const existing = await getTzintukSubscription(normalizedPhone, system);
  const record = {
    enabled: false,
    since: existing?.since || new Date().toISOString(),
    lastNotifiedAt: existing?.lastNotifiedAt || null,
    // tzintukListId נשמר (לא מנוקה) - השלוחה עצמה נשארת קיימת בממשק ימות,
    // ורק הרשימה מאופסת בפועל מול ה-API (ר' resetTzintukList, נקרא בנפרד
    // ע"י הקורא ל-unsubscribeFromTzintuk לפני/אחרי הקריאה הזו - ר'
    // tzintukSettingsFlow). listJoined מתאפס ל-false כי הרשימה מתרוקנת -
    // הצטרפות חוזרת (אם המשתמש יירשם שוב) תדרוש אישור טלפוני מחדש.
    tzintukListId: existing?.tzintukListId || null,
    listJoined: false
  };
  const result = await upstashCommand('SET', key, JSON.stringify(record));
  if (result !== 'OK') {
    console.error('[userStore] SET (tzintuk unsubscribe) לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    throw new Error('הסרה מצינתוקים נכשלה (Upstash לא החזיר OK)');
  }
  console.log(`[userStore] הוסר מצינתוקים: ${key}`);
  return record;
}

/**
 * שולף את רשומת ההרשמה לצינתוקים של מספר טלפון עבור מערכת נתונה, או null
 * אם מעולם לא נרשם/הוסר. משמש גם את שלוחה 9->1 (הצגת מצב נוכחי למשתמש
 * ותפריט הרשמה/הסרה דינמי) וגם את שלוחה 5 (בדיקת "יש X התראות חדשות").
 */
async function getTzintukSubscription(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const key = tzintukKey(normalizedPhone, system);
  const raw = await upstashCommand('GET', key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.enabled !== 'boolean' || !parsed?.since) return null;
    return {
      enabled: parsed.enabled,
      since: parsed.since,
      lastNotifiedAt: parsed.lastNotifiedAt || null,
      // תאימות לאחור: רשומות שנשמרו לפני המעבר למנגנון רשימות tzl: לא
      // כוללות את השדות האלו כלל - null/false הם ברירת המחדל הבטוחה
      // (מסמנת "עדיין לא נוצרה שלוחה אישית / עדיין לא הצטרף בפועל"),
      // ר' getOrCreateTzintukListId שמטפל בהשלמת ההרשמה למשתמשים כאלה.
      tzintukListId: parsed.tzintukListId || null,
      listJoined: parsed.listJoined === true
    };
  } catch (err) {
    console.error('[userStore] שגיאה בפענוח רשומת הרשמה לצינתוקים', err.message);
    return null;
  }
}

/** קיצור נוח: true אם המספר רשום כרגע (enabled=true) לצינתוקים במערכת הנתונה. */
async function isSubscribedToTzintuk(phone, system) {
  const sub = await getTzintukSubscription(phone, system);
  return !!sub?.enabled;
}

/**
 * מעדכן את lastNotifiedAt ברשומת ההרשמה לצינתוקים, לאחר ששלחנו בפועל צינתוק
 * על התראה בזמן notifTimeIso נתון - כדי שלא יישלח צינתוק פעמיים על אותה
 * התראה (ר' תיעוד מפורט ב-api/cron/check-notifications.js). לא נוגע ב-
 * enabled/since הקיימים. אם אין רשומה קיימת (מצב לא אמור לקרות בזרימה
 * הרגילה, כי הפונקציה נקראת רק על מנויים פעילים) - לא עושה כלום ומחזיר
 * false, כדי לא "ליצור" רשומת הרשמה חדשה בטעות מתוך תהליך ה-cron.
 */
async function updateLastNotifiedTimestamp(phone, system, notifTimeIso) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return false;
  const key = tzintukKey(normalizedPhone, system);
  const existing = await getTzintukSubscription(normalizedPhone, system);
  if (!existing) {
    console.error(`[userStore] updateLastNotifiedTimestamp: אין רשומת הרשמה קיימת עבור ${key}`);
    return false;
  }
  const record = { ...existing, lastNotifiedAt: notifTimeIso };
  const result = await upstashCommand('SET', key, JSON.stringify(record));
  if (result !== 'OK') {
    console.error('[userStore] SET (updateLastNotifiedTimestamp) לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    return false;
  }
  return true;
}

/**
 * סורק (SCAN, לא KEYS - בטוח יותר על Redis בפרודקשן) את כל רשומות ההרשמה
 * לצינתוקים הפעילות (enabled=true) עבור מערכת (system) נתונה, ומחזיר מערך
 * של { phone, since, lastNotifiedAt }. משמש את api/cron/check-notifications.js
 * כדי לדעת אילו משתמשים לבדוק עבור התראות חדשות בכל הרצה. גודל הפרויקט קטן
 * (משתמשים בודדים עד עשרות), כך שסריקה מלאה בכל הרצת cron היא זולה וסבירה -
 * אין צורך באינדקס נפרד של "רשימת מנויים".
 */
async function listTzintukSubscribers(system) {
  const pattern = tzintukScanPattern(system);
  const results = [];
  let cursor = '0';
  do {
    const scanResult = await upstashCommand('SCAN', cursor, 'MATCH', pattern, 'COUNT', '100');
    if (!Array.isArray(scanResult) || scanResult.length < 2) break;
    cursor = scanResult[0];
    const keys = scanResult[1] || [];
    for (const key of keys) {
      const raw = await upstashCommand('GET', key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.enabled !== true || !parsed?.since) continue;
        // חילוץ מספר הטלפון מתוך המפתח עצמו (הסיומת אחרי הקידומת הקבועה),
        // ולא מתוך הערך - הערך לא כולל את מספר הטלפון בכוונה (ר' תיעוד למעלה).
        const prefix = `mitmachim:tzintuk:${normalizeSystem(system)}:`;
        const phone = key.startsWith(prefix) ? key.slice(prefix.length) : null;
        if (!phone) continue;
        results.push({
          phone,
          since: parsed.since,
          lastNotifiedAt: parsed.lastNotifiedAt || null,
          // ר' הערת תאימות לאחור זהה ב-getTzintukSubscription למעלה.
          tzintukListId: parsed.tzintukListId || null,
          listJoined: parsed.listJoined === true
        });
      } catch (err) {
        console.error('[userStore] שגיאה בפענוח רשומת מנוי בעת סריקה', key, err.message);
      }
    }
  } while (cursor !== '0');
  return results;
}

module.exports = {
  normalizePhone,
  saveUserCredentials,
  getUserCredentials,
  subscribeToTzintuk,
  unsubscribeFromTzintuk,
  getTzintukSubscription,
  isSubscribedToTzintuk,
  updateLastNotifiedTimestamp,
  listTzintukSubscribers,
  setTzintukListId,
  markTzintukListJoined
};
