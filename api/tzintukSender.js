/**
 * מודול משותף: שליחת צינתוק (שיחת "ping") למספר טלפון בודד, דרך ה-Management
 * API הרשמי של ימות המשיח (RunTzintuk) - ר' תיעוד מלא: post 64941 בפורום
 * f2.freeivr.co.il (https://f2.freeivr.co.il/post/64941).
 * ==========================================================================
 * נטען מ-api/cron/check-notifications.js - שם המדובר קורא למודול הזה פעם
 * אחת לכל משתמש רשום שיש לו התראה חדשה (ר' תיעוד שם).
 *
 * שימוש ב-token ניהולי יחיד (YEMOT_MANAGEMENT_TOKEN) - אותו טוקן שכבר משמש
 * את downloadRecording בכל אחת משלושת גרסאות ה-IVR (ר' תיעוד שם): זהו הטוקן
 * שהונפק באתר הניהול של ימות המשיח (לא token בפורמט "מספר_מערכת:סיסמה"),
 * ומכסה את כל שלושת הפורומים הנתמכים תחת אותה מערכת ימות אחת - כך שאין
 * צורך במשתני סביבה נפרדים לכל פורום.
 *
 * למה מספר בודד ("ad-hoc") ולא רשימת צינתוק (tzl:) של ימות: הדרישה היא
 * לצנתק *רק* את המשתמש הספציפי שיש לו התראה חדשה, לא את כל הרשומים. רשימת
 * tzl: משותפת הייתה מצנתקת את כולם יחד בכל הפעלה - לא מתאים. לעומת זאת,
 * הפרמטר phones תומך (מתועד באותו post) ברשימה מפורשת של מספרים מופרדת
 * ב-":" גם עבור מספר בודד - זו הדרך התקנית לצנתק מספר ad-hoc אחד בלי
 * להזדקק לרשימת צינתוק מוגדרת מראש בממשק הניהול. שימו לב: שליחה למספר בודד
 * בדרך זו (לא tzl:) כפופה לעלות שימוש (0.1 יחידה למספר, נכון לתיעוד שצוין
 * לעיל - עשוי להשתנות, ר' התיעוד המקורי).
 */

'use strict';

const axios = require('axios');

const YEMOT_MANAGEMENT_BASE = 'https://www.call2all.co.il/ym/api';

/**
 * שולח צינתוק (שיחת ping קצרה) למספר טלפון בודד.
 * @param {string} phone - מספר הטלפון לצינתוק, בפורמט מקומי (למשל '0501234567').
 * @param {object} [opts]
 * @param {number} [opts.timeoutSeconds] - TzintukTimeOut - זמן הצלצול המקסימלי
 *   בשניות (ברירת מחדל בימות: 9, מקסימום מתועד: 16).
 * @returns {Promise<object>} תגובת ה-API הגולמית (למקרה שיידרש ניפוי שגיאות).
 */
async function sendTzintuk(phone, opts = {}) {
  const token = process.env.YEMOT_MANAGEMENT_TOKEN;
  if (!token) {
    throw new Error('YEMOT_MANAGEMENT_TOKEN לא מוגדר בסביבה - לא ניתן לשלוח צינתוק');
  }
  if (!phone) {
    throw new Error('sendTzintuk: מספר טלפון חסר');
  }

  const params = { token, phones: phone };
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
    throw new Error(`RunTzintuk נכשל עבור ${phone}: ${data.message || JSON.stringify(data)}`);
  }

  console.log(`[tzintukSender] צינתוק נשלח בהצלחה ל-${phone}`);
  return data;
}

module.exports = { sendTzintuk };
