/**
 * מודול משותף: שליחת צינתוק (שיחת "ping") למנוי בודד, דרך ה-Management API
 * הרשמי של ימות המשיח (RunTzintuk) - ר' תיעוד מלא: post 64941 בפורום
 * f2.freeivr.co.il (https://f2.freeivr.co.il/post/64941).
 * ==========================================================================
 * נטען מ-api/cron/check-notifications.js - שם המדובר קורא למודול הזה פעם
 * אחת לכל משתמש רשום שיש לו התראה חדשה (ר' תיעוד שם).
 *
 * שימוש ב-token ניהולי יחיד (YEMOT_MANAGEMENT_TOKEN) - אותו טוקן שכבר משמש
 * את downloadRecording בכל אחת משלושת גרסאות ה-IVR (ר' תיעוד שם) ואת
 * api/tzintukListManager.js (יצירת השלוחות האישיות): זהו הטוקן שהונפק
 * באתר הניהול של ימות המשיח (לא token בפורמט "מספר_מערכת:סיסמה"), ומכסה
 * את כל שלושת הפורומים הנתמכים תחת אותה מערכת ימות אחת.
 *
 * שינוי ארכיטקטוני (הוחלף מנגנון ad-hoc למנגנון רשימות tzl:): בעבר המודול
 * הזה שלח phones=<מספר טלפון מפורש> ל-RunTzintuk - כל צינתוק כזה כפוף
 * לעלות שימוש (0.1 יחידה למספר, ר' post 64941). כעת, בהתאם לדרישה לעבור
 * למנגנון הרשמי של רשימות צינתוק חינמיות, כל משתמש מקבל שלוחה אישית
 * מסוג type=tzintuk עם list_tzintuk=<מזהה ייחודי משלו> (ר' יצירתה ב-
 * api/tzintukListManager.js), והמודול הזה מפעיל אותה על ידי
 * phones=tzl:<מזהה הרשימה> - פרמטר זה, כאשר מזהה הרשימה שייך לרשימת tzl:
 * ולא לרשימת תפוצה רגילה (tpl:) ולא למספר מפורש, פועל ללא עלות יחידות
 * (ר' post 64941 וכן "צינתוקים במערכת תוכן (IVR) ללא עלות יחידות").
 * מכיוון שלכל משתמש רשימה אישית נפרדת משלו (לא רשימה משותפת לכל המנויים),
 * הפעלת tzl:<מזהה> מצנתקת רק את מי שהצטרף לרשימה הספציפית הזו - כלומר רק
 * את המשתמש הרלוונטי, בדיוק כמו שהתנהג המנגנון הקודם למספר בודד, אך ללא
 * עלות. אין יותר נתיב קוד ששולח phones=<מספר טלפון גולמי> ל-RunTzintuk.
 */

'use strict';

const axios = require('axios');

const YEMOT_MANAGEMENT_BASE = 'https://www.call2all.co.il/ym/api';

/**
 * שולח צינתוק (שיחת ping קצרה) לכל מי שהצטרף בפועל לרשימת הצינתוק האישית
 * שמזהה אותה listId - בפועל, בזכות הארכיטקטורה של שלוחה אישית לכל משתמש
 * (ר' api/tzintukListManager.js), זהו תמיד משתמש בודד בלבד.
 * @param {string} listId - מזהה רשימת הצינתוק (list_tzintuk) של המשתמש,
 *   כפי שנשמר ב-userStore (tzintukListId). *לא* מספר טלפון.
 * @param {object} [opts]
 * @param {number} [opts.timeoutSeconds] - TzintukTimeOut - זמן הצלצול המקסימלי
 *   בשניות (ברירת מחדל בימות: 9, מקסימום מתועד: 16).
 * @returns {Promise<object>} תגובת ה-API הגולמית (למקרה שיידרש ניפוי שגיאות).
 */
async function sendTzintuk(listId, opts = {}) {
  const token = process.env.YEMOT_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error('YEMOT_MANAGEMENT_TOKEN לא מוגדר בסביבה - לא ניתן לשלוח צינתוק');
  }
  if (!listId) {
    throw new Error('sendTzintuk: מזהה רשימת צינתוק (listId) חסר');
  }

  const params = { token, phones: `tzl:${listId}` };
  if (opts.timeoutSeconds) {
    params.TzintukTimeOut = opts.timeoutSeconds;
  }

  const { data } = await axios.get(`${YEMOT_MANAGEMENT_BASE}/RunTzintuk`, {
    params,
    timeout: 10000
  });

  // ל-RunTzintuk (כמו שאר ה-Management API של ימות) יש קונבנציית responseStatus -
  // 'OK' בהצלחה, אחרת שדה message עם תיאור השגיאה. ר' תיעוד snapshot כללי של
  // ה-Management API (api-and-integrations.md, מבנה תגובה משותף לכל הפקודות).
  if (data?.responseStatus && data.responseStatus !== 'OK') {
    throw new Error(`RunTzintuk נכשל עבור רשימה tzl:${listId}: ${data.message || JSON.stringify(data)}`);
  }

  console.log(`[tzintukSender] צינתוק נשלח בהצלחה לרשימה tzl:${listId}`);
  return data;
}

module.exports = { sendTzintuk };
