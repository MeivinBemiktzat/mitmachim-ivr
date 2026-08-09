/**
 * מודול משותף: אחסון ושליפה של מפתח/מפתחות Gemini API לסיכום נושאים בבינה
 * מלאכותית, לפי מספר טלפון בלבד - בלי תלות בפורום/שם משתמש/סיסמא.
 * ==========================================================================
 * נטען מ:
 *   - api/register.js (שמירה - טופס נפרד "סיכום AI" באתר ההרשמה, ללא שם
 *     משתמש/סיסמא כלל - רק מספר טלפון ומפתח/מפתחות Gemini API)
 *   - api/yemot|freeivr|otzaria|goodlink|binatop|rechavim/index.js (שליפה -
 *     מקש # בתוך topicFlow, ר' aiSummaryFlow בכל אחד מהקבצים)
 *
 * תמיכה במספר מפתחות למשתמש: מאפשרת fallback אוטומטי (ר' geminiSummarizer.js)
 * אם מפתח אחד נכשל/עבר את המכסה החינמית - מנסים את המפתח הבא ברשימה.
 *
 * אחסון: Upstash Redis REST API בלבד (כמו userStore.js) - אין תלות בחבילת
 * @upstash/redis, רק axios. משתני סביבה נדרשים (משותפים לכל הפרויקט):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * מפתח האחסון: `mitmachim:aikey:<מספר טלפון מנורמל>` -> JSON string עם
 * { keys: string[], updatedAt }. הנרמול (normalizePhone) מיובא מ-userStore.js
 * כדי להבטיח שהוא זהה בדיוק לנרמול שמשמש את שאר המערכת (ר' תיעוד שם) -
 * אחרת חיפוש לפי call.phone בזמן שיחה לא ימצא מפתח שנשמר בפורמט אחר.
 */

'use strict';

const axios = require('axios');
const { normalizePhone } = require('./userStore');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function aiKeyRedisKey(phone) {
  return `mitmachim:aikey:${phone}`;
}

/** קריאת פקודת Redis בודדת מול Upstash REST API - זהה בעיקרון ל-upstashCommand
 *  הפנימי ב-userStore.js, משוכפל פה במכוון כדי לשמור על מודול זה עצמאי
 *  (ללא תלות הדדית מעבר לnormalizePhone). */
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

/**
 * שומר מפתח/מפתחות Gemini API עבור מספר טלפון נתון. מקבל מערך מפתחות (או
 * מפתח בודד) - מנקה ערכים ריקים/רווחים, ודוחה שמירה אם לא נותר אף מפתח תקין.
 * @param {string} phone
 * @param {string|string[]} keys
 * @returns {Promise<string[]>} רשימת המפתחות שנשמרו בפועל (מנוקה).
 */
async function saveAiKeys(phone, keys) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('מספר טלפון לא תקין');

  const cleanKeys = (Array.isArray(keys) ? keys : [keys])
    .flatMap((k) => String(k || '').split(/[,\n\r]+/))
    .map((k) => k.trim())
    .filter(Boolean);

  if (cleanKeys.length === 0) {
    throw new Error('לא הוזן אף מפתח AI תקין');
  }

  const value = JSON.stringify({ keys: cleanKeys, updatedAt: new Date().toISOString() });
  const result = await upstashCommand('SET', aiKeyRedisKey(normalizedPhone), value);
  if (result !== 'OK') {
    console.error('[aiKeyStore] SET לא אושר ע"י Upstash, תגובה בפועל:', JSON.stringify(result));
    throw new Error('שמירת מפתח/מפתחות ה-AI ב-Redis לא אושרה (Upstash לא החזיר OK)');
  }
  console.log(`[aiKeyStore] נשמרו ${cleanKeys.length} מפתח/מפתחות AI עבור ${aiKeyRedisKey(normalizedPhone)}`);
  return cleanKeys;
}

/**
 * שולף את מפתחות ה-Gemini API השמורים למספר טלפון נתון, או מערך ריק אם
 * המשתמש עדיין לא הזין אף מפתח (ר' aiSummaryFlow - במקרה זה מוצגת הודעה
 * שמכוונת אותו לאתר ההרשמה, במקום שגיאה).
 * @param {string} phone
 * @returns {Promise<string[]>}
 */
async function getAiKeys(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return [];
  const raw = await upstashCommand('GET', aiKeyRedisKey(normalizedPhone));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.keys) ? parsed.keys.filter(Boolean) : [];
  } catch (err) {
    console.error('[aiKeyStore] שגיאה בפענוח מפתחות AI שמורים', err.message);
    return [];
  }
}

module.exports = { saveAiKeys, getAiKeys };
