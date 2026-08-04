/**
 * מודול משותף: ניהול שלוחות/רשימות צינתוק אישיות (tzl:) דרך ה-Management API
 * הרשמי של ימות המשיח - UpdateExtension ו-TzintukimListManagement.
 * ==========================================================================
 * רקע (ר' גם תיעוד מפורט ב-userStore.js וב-api/tzintukSender.js): המערכת
 * עברה ממנגנון צינתוק בעלות (RunTzintuk עם phones=<מספר טלפון מפורש>,
 * 0.1 יחידה לכל התראה) למנגנון הרשמי של "רשימות צינתוק חינמיות" - ר' תיעוד
 * ימות: "צינתוקים במערכת תוכן (IVR) ללא עלות יחידות" ופוסט RunTzintuk
 * (f2.freeivr.co.il/post/64941): "ניתן גם להוציא צינתוק לרשימת צינתוק חינמי
 * על ידי ציון tzl:XX" - ללא עלות יחידות בניגוד לצינתוק למספר מפורש.
 *
 * לכל משתמש שלוחת תוכן אישית ("שלוחת הצטרפות") מסוג type=tzintuk עם
 * list_tzintuk=<מזהה ייחודי לאותו משתמש בלבד> - כך שהצטרפות אליה מצנתקת
 * רק את המשתמש הזה (בדיוק כמו הפעלת צינתוק פרטני למספר בודד, אך ללא עלות).
 *
 * הערה ארכיטקטונית קריטית (הסיבה שאין "אישור הצטרפות אוטומטי מרחוק"):
 * לימות המשיח *אין* API להוספת מספר טלפון לרשימת tzl: מרחוק - ההוספה
 * מתבצעת אך ורק על ידי חיוג בפועל של המשתמש (ממספר מזוהה) לשלוחת ההצטרפות
 * ולחיצה על 1 (ר' תיעוד "צינתוקים במערכת תוכן (IVR) ללא עלות יחידות":
 * "הכניסה לשלוחה הינו ע"י טלפון מזוהה בלבד"). זהו אישור חד-פעמי מכוון של
 * ימות (לא באג/מגבלה שניתן לעקוף): המנגנון קיים כדי שלא ניתן יהיה לצנתק
 * מספרים שלא ביקשו זאת בפועל.
 *
 * הערה ארכיטקטונית שנייה, קריטית לא פחות: שלושת קבצי ה-IVR של הפרויקט הזה
 * (api/yemot|freeivr|otzaria/index.js) פועלים דרך שלוחת API יחידה בימות
 * (ר' ההערה בראש כל אחד מהם: "אסור להשתמש ב-call.go_to_folder לניווט פנימי
 * ... כל הניווט חייב לקרות בתוך הקוד עצמו"). המשמעות: לא ניתן "להעביר" את
 * המתקשר בתוך אותה שיחה עצמה לשלוחת ההצטרפות האישית שנוצרה כאן - זו שלוחה
 * נפרדת לגמרי בעץ החיוג של ימות, ו-go_to_folder לשלוחה חיצונית כזו ייכשל
 * (ר' אותה הערה). לכן תהליך ההצטרפות בפועל הוא: המערכת יוצרת (בפעם
 * הראשונה, כאן) את השלוחה האישית ומודיעה למשתמש בשיחה הנוכחית את *מספר
 * השלוחה* שאליה עליו לחייג בנפרד (חיוג חדש, ממש כמו לכל שלוחה אחרת בימות)
 * כדי להשלים את ההצטרפות בעצמו - ר' tzintukSettingsFlow בכל קובץ IVR.
 *
 * אימות ההצטרפות בפועל (checkListJoined למטה) נעשה best-effort, על ידי
 * שאילתת TzintukimListManagement action=getlistEnteres (מחזירה את רשימת
 * המספרים שהצטרפו בפועל לרשימה - ר' תיעוד: f2.freeivr.co.il/post/65034)
 * ובדיקה אם מספר הטלפון של המשתמש נמצא בה - ולא על ידי callback/webhook,
 * כי UpdateExtension לא תומך בפרמטר callback כלשהו לשלוחת type=tzintuk
 * (ר' תיעוד UpdateExtension: אין פרמטר "after_play"/"send_to_api" מתועד
 * לסוג שלוחה זה - ניחוש כזה היה עלול ליצור התנהגות בלתי צפויה בממשק ימות).
 */

'use strict';

const axios = require('axios');
const { normalizePhone } = require('./userStore');

const YEMOT_MANAGEMENT_BASE = 'https://www.call2all.co.il/ym/api';

/** מספר תת-שלוחת האב שתחתיה נוצרות כל שלוחות ההצטרפות האישיות לצינתוקים
 *  (אחת לכל משתמש, ר' extensionNumberForPhone למטה) - קבוע בכוונה, בדיוק
 *  כמו VOICE_SEARCH_EXTENSION_NUMBER בכל אחד מקבצי ה-IVR (ר' שם), כדי
 *  שהמספר לא יתנגש עם שלוחות תוכן אחרות שהוגדרו ידנית בממשק הניהול. */
const TZINTUK_PARENT_EXTENSION_NUMBER = '50';

/**
 * גוזר, באופן דטרמיניסטי מתוך מספר הטלפון המנורמל, מספר תת-שלוחה ייחודי
 * תחת TZINTUK_PARENT_EXTENSION_NUMBER - כדי שלא יידרש מונה/רישום מרכזי של
 * "מספר השלוחה הבא הפנוי" (מקור אפשרי לתנאי מירוץ בין קריאות מקבילות).
 * שימוש בספרות מספר הטלפון עצמו (ללא ה-0 המוביל) כמזהה השלוחה - ייחודי
 * מטבעו לכל מספר טלפון ישראלי, וקריא לצורך ניפוי שגיאות בממשק הניהול.
 */
function extensionNumberForPhone(normalizedPhone) {
  const digits = normalizedPhone.replace(/^0/, '');
  return digits;
}

/** בונה את מזהה רשימת הצינתוק (list_tzintuk) עבור מספר טלפון+מערכת נתונים -
 *  כולל את זהות המערכת (system) בתוך המזהה עצמו, כדי ששני פורומים שונים
 *  (למשל mitmachim ו-freeivr) עבור אותו מספר טלפון בדיוק יקבלו שתי רשימות
 *  צינתוק *נפרדות* לגמרי בממשק ימות (אותו הגיון בדיוק כמו מפתחות Redis
 *  נפרדים לפי system ב-userStore.js). */
function buildListId(normalizedPhone, system) {
  return `${system}_${normalizedPhone.replace(/^0/, '')}`;
}

/** בונה את נתיב ה-Management API (path) של שלוחת ההצטרפות האישית של מספר
 *  טלפון נתון - תמיד תת-שלוחה מספרית תחת TZINTUK_PARENT_EXTENSION_NUMBER,
 *  ר' הערת extensionNumberForPhone למעלה לגבי הבחירה הדטרמיניסטית. */
function buildExtensionPath(normalizedPhone) {
  return `ivr2:/${TZINTUK_PARENT_EXTENSION_NUMBER}/${extensionNumberForPhone(normalizedPhone)}`;
}

/** מספר השלוחה "האנושי" (כפי שיש להקריא למשתמש בשיחה כדי שיחייג אליו בנפרד -
 *  ר' תיעוד בראש הקובץ) - זהה לנתיב הפנימי אך ללא הקידומת ivr2:/. */
function buildHumanExtensionNumber(normalizedPhone) {
  return `${TZINTUK_PARENT_EXTENSION_NUMBER}/${extensionNumberForPhone(normalizedPhone)}`;
}

function requireManagementToken() {
  const token = process.env.YEMOT_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error('YEMOT_MANAGEMENT_TOKEN לא מוגדר בסביבה - לא ניתן לנהל שלוחות/רשימות צינתוק');
  }
  return token;
}

/**
 * יוצר (או מוודא קיום, אם כבר נוצרה בעבר) את שלוחת ההצטרפות האישית של
 * המשתמש בממשק ימות: type=tzintuk, list_tzintuk=<מזהה אישי>, ומודיע
 * M3338 ("הצינתוק הופעל בהצלחה" / הודעת ברירת המחדל של ימות) - ר' תיעוד
 * ברירת המחדל של שלוחות tzintuk ב-"צינתוקים במערכת תוכן (IVR) ללא עלות
 * יחידות". קריאה ל-UpdateExtension יוצרת שלוחה אם אינה קיימת עדיין
 * (ר' תיעוד UpdateExtension הרשמי: "במידה והשלוחה לא קיימת במערכת, תיווצר
 * שלוחה חדשה"), ואינה מוחקת מידע קיים אם כבר קיימת (בניגוד ל-UploadTextFile)
 * - כלומר קריאה חוזרת לכאן (idempotent) בטוחה ולא "מאפסת" רשימה שכבר יש
 * לה מצטרפים בפועל.
 *
 * @param {string} phone - מספר טלפון (גולמי או מנורמל, יעבור נרמול).
 * @param {string} system - זהות המערכת/פורום (ר' תיעוד system ב-userStore.js).
 * @returns {Promise<{listId: string, extensionNumber: string}>}
 */
async function ensureTzintukExtension(phone, system) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('ensureTzintukExtension: מספר טלפון לא תקין');

  const token = requireManagementToken();
  const listId = buildListId(normalizedPhone, system);
  const path = buildExtensionPath(normalizedPhone);

  const { data } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/UpdateExtension`, {
    params: {
      token,
      path,
      type: 'tzintuk',
      list_tzintuk: listId
    },
    timeout: 10000
  });

  // ר' הערה זהה ב-ensureRecordingFolder (api/yemot/index.js): Management API
  // של ימות מחזיר HTTP 200 גם בכשלים לוגיים - יש לבדוק responseStatus במפורש.
  if (data?.responseStatus && data.responseStatus !== 'OK') {
    throw new Error(`יצירת שלוחת הצטרפות לצינתוק (${path}) נכשלה: ${data.message || JSON.stringify(data)}`);
  }

  return { listId, extensionNumber: buildHumanExtensionNumber(normalizedPhone) };
}

/**
 * שולף (מ-Redis, דרך userStore) את מזהה רשימת הצינתוק הקיים של המשתמש, ואם
 * אינו קיים עדיין - יוצר את שלוחת ההצטרפות בממשק ימות (ensureTzintukExtension)
 * ושומר את המזהה שנוצר ב-Redis (setTzintukListId) לשימוש עתידי, כדי
 * שהיצירה בממשק ימות תתבצע פעם אחת בלבד לכל משתמש. מחזיר גם את מספר
 * השלוחה "האנושי" (עבור tzintukSettingsFlow, כדי להקריא אותו למשתמש).
 *
 * הערה: מקבל את userStore כפרמטר (ולא דרך require ישיר) כדי למנוע תלות
 * מעגלית - userStore.js עצמו אינו תלוי במודול הזה, אך קבצי ה-IVR הקוראים
 * לפונקציה הזו כבר מחזיקים את userStore טעון בכל מקרה.
 *
 * @param {string} phone
 * @param {string} system
 * @param {{getTzintukSubscription: Function, setTzintukListId: Function}} userStore
 * @returns {Promise<{listId: string, extensionNumber: string}>}
 */
async function getOrCreateTzintukListId(phone, system, userStore) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('getOrCreateTzintukListId: מספר טלפון לא תקין');

  const existing = await userStore.getTzintukSubscription(normalizedPhone, system);
  if (existing?.tzintukListId) {
    return {
      listId: existing.tzintukListId,
      extensionNumber: buildHumanExtensionNumber(normalizedPhone)
    };
  }

  const { listId, extensionNumber } = await ensureTzintukExtension(normalizedPhone, system);
  await userStore.setTzintukListId(normalizedPhone, system, listId);
  return { listId, extensionNumber };
}

/**
 * בודק, מול ה-Management API (TzintukimListManagement, action=getlistEnteres -
 * ר' תיעוד: f2.freeivr.co.il/post/65034), האם מספר הטלפון הנתון נמצא בפועל
 * ברשימת הצינתוק listId - כלומר האם המשתמש כבר חייג לשלוחת ההצטרפות שלו
 * ולחץ 1 (ר' תיעוד ארכיטקטוני בראש הקובץ - זו הדרך היחידה לבדוק זאת, אין
 * callback). best-effort: כל שגיאת רשת/API נלכדת ומוחזרת כ-false (לא
 * זורקת), כדי שקריאה לפונקציה הזו (למשל מ-tzintukSettingsFlow או מה-cron
 * לפני שליחת RunTzintuk) לעולם לא תפיל את הזרימה שקוראת לה - היא רק אמצעי
 * לוודא/לרענן את הדגל listJoined שנשמר ב-Redis (ר' markTzintukListJoined
 * ב-userStore.js).
 *
 * @param {string} listId - מזהה רשימת הצינתוק (list_tzintuk), לא מספר טלפון.
 * @param {string} phone - מספר טלפון לבדיקה (יעבור נרמול).
 * @returns {Promise<boolean>}
 */
async function checkListJoined(listId, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!listId || !normalizedPhone) return false;

  try {
    const token = requireManagementToken();
    const { data } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/TzintukimListManagement`, {
      params: { token, action: 'getlistEnteres', TzintukimList: listId },
      timeout: 10000
    });

    if (data?.responseStatus && data.responseStatus !== 'OK') {
      console.error(`[tzintukListManager] getlistEnteres נכשל עבור רשימה ${listId}: ${data.message || JSON.stringify(data)}`);
      return false;
    }

    const enteres = Array.isArray(data?.enteres) ? data.enteres : [];
    return enteres.some((entry) => normalizePhone(entry?.phone) === normalizedPhone);
  } catch (err) {
    console.error(`[tzintukListManager] שגיאה בבדיקת הצטרפות לרשימה ${listId}`, err.message);
    return false;
  }
}

/**
 * מאפס את רשימת הצינתוק בממשק ימות (TzintukimListManagement, action=resetList
 * - ר' תיעוד: f2.freeivr.co.il/post/65034) - קורא ל-Management API כדי לרוקן
 * בפועל את הרשימה בצד שרתי ימות (לא רק את הדגל המקומי enabled=false ב-
 * userStore, שמתעדכן בנפרד ע"י unsubscribeFromTzintuk). השלוחה עצמה
 * (type=tzintuk) *אינה* נמחקת - רק רשימת המצטרפים בתוכה מתאפסת; הרשמה
 * מחודשת בעתיד תדרוש חיוג+הקשה חדשים לאותה שלוחה בדיוק (ר' תיעוד
 * listJoined ב-userStore.js).
 *
 * @param {string} listId
 * @returns {Promise<boolean>} true אם האיפוס הצליח בפועל.
 */
async function resetTzintukList(listId) {
  if (!listId) return false;
  try {
    const token = requireManagementToken();
    const { data } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/TzintukimListManagement`, {
      params: { token, action: 'resetList', TzintukimList: listId },
      timeout: 10000
    });
    if (data?.responseStatus && data.responseStatus !== 'OK') {
      console.error(`[tzintukListManager] resetList נכשל עבור רשימה ${listId}: ${data.message || JSON.stringify(data)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[tzintukListManager] שגיאה באיפוס רשימה ${listId}`, err.message);
    return false;
  }
}

module.exports = {
  ensureTzintukExtension,
  getOrCreateTzintukListId,
  checkListJoined,
  resetTzintukList,
  buildHumanExtensionNumber
};
