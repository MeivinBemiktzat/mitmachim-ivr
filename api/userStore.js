/**
 * מודול משותף: אחסון ושליפה של שיוך מספר-טלפון -> פרטי התחברות בפורום.
 * ==========================================================================
 * נטען מכמה מקומות:
 *   - api/register.js     (שמירה - הטופס הקולט מספר פלאפון + שם משתמש + סיסמא,
 *                          עבור אחד מהפורומים הנתמכים - ר' פרמטר system)
 *   - api/yemot/index.js   (שליפה - שלוחה 5 בגרסת פורום מתמחים טופ)
 *   - api/freeivr/index.js (שליפה - שלוחה 5 בגרסת פורום freeivr)
 *   - api/otzaria/index.js (שליפה - שלוחה 5 בגרסת פורום אוצריא)
 * הופרד לקובץ נפרד כדי שהנרמול של מספר הטלפון (normalizePhone) יהיה זהה
 * ב-100% בין כל הצרכנים - אם ייכתבו מימושים נפרדים יש סיכון ממשי שהפורמט
 * ייסטה (למשל טיפול שונה בקידומת 972) והזיהוי האוטומטי בשיחה ייכשל כי
 * המפתח שנשמר לא יתאים למפתח שמחפשים.
 *
 * תמיכה במספר פורומים (system): אותו מספר טלפון עשוי להיות משויך למספר
 * חשבונות שונים לגמרי - אחד בכל פורום נתמך (מתמחים טופ / freeivr / אוצריא) -
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

module.exports = { normalizePhone, saveUserCredentials, getUserCredentials };
