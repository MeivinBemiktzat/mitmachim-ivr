/**
 * מודול משותף: אחסון ושליפה של שיוך מספר-טלפון -> פרטי התחברות בפורום.
 * ==========================================================================
 * נטען משני מקומות:
 *   - api/register.js    (שמירה - הטופס הקולט מספר פלאפון + שם משתמש + סיסמא)
 *   - api/yemot/index.js (שליפה - שלוחה 5, לפי call.phone של המתקשר)
 * הופרד לקובץ נפרד כדי שהנרמול של מספר הטלפון (normalizePhone) יהיה זהה
 * ב-100% משני הכיוונים - אם ייכתבו שתי מימושים נפרדים יש סיכון ממשי
 * שהפורמט ייסטה (למשל טיפול שונה בקידומת 972) והזיהוי האוטומטי בשיחה ייכשל
 * כי המפתח שנשמר לא יתאים למפתח שמחפשים.
 *
 * אחסון: Upstash Redis REST API בלבד (ללא חבילת @upstash/redis) - קריאות
 * HTTP פשוטות עם axios, בהתאם לפורמט הרשמי: GET <URL>/<CMD>/<arg1>/<arg2>...
 * עם Authorization: Bearer <TOKEN>. ר' תיעוד רשמי: https://upstash.com/docs/redis/features/restapi
 *
 * משתני סביבה נדרשים (זהים בשני הקבצים הצורכים את המודול):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

'use strict';

const axios = require('axios');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

function redisKey(phone) {
  return `mitmachim:phone:${phone}`;
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

/** שומר את פרטי ההתחברות של המשתמש בפורום, ממופים למספר הטלפון המנורמל. */
async function saveUserCredentials(phone, username, password) {
  const normalizedPhone = normalizePhone(phone);
  const value = JSON.stringify({ username, password, updatedAt: new Date().toISOString() });
  await upstashCommand('SET', redisKey(normalizedPhone), value);
  return normalizedPhone;
}

/**
 * שולף את פרטי ההתחברות לפורום ששויכו למספר טלפון נתון, או null אם לא
 * נמצא שיוך כזה (המשתמש עדיין לא נרשם באתר ההרשמה).
 */
async function getUserCredentials(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const raw = await upstashCommand('GET', redisKey(normalizedPhone));
  if (!raw) return null;
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
