/**
 * מודול משותף: סיכום נושא (topic) בעברית באמצעות Google Gemini API, לשימוש
 * במקש # בתוך topicFlow (ר' aiSummaryFlow בכל אחד מקבצי ה-IVR).
 * ==========================================================================
 * המשתמש מזין מראש באתר ההרשמה (api/register.js, טופס "סיכום AI" נפרד -
 * ללא שם משתמש/סיסמא) מפתח API אחד או כמה, שנשמרים לפי מספר טלפון בלבד
 * (ר' api/aiKeyStore.js). המודול הזה מקבל את רשימת המפתחות ומנסה אותם
 * בזה אחר זה (fallback) - מועיל אם מפתח מסוים עבר את המכסה החינמית היומית
 * של Gemini או אינו תקין, בלי שהמשתמש יצטרך לדעת איזה מפתח "עבד".
 *
 * מודל: gemini-2.0-flash (מהיר וזול, מתאים לסיכום קצר) - קריאה ל-REST API
 * הרשמי של Google AI Studio: generativelanguage.googleapis.com, עם המפתח
 * כפרמטר query (key=), לפי הדוקומנטציה הרשמית של Gemini API.
 *
 * הגבלת אורך טקסט המקור (MAX_SOURCE_CHARS) - כדי להישאר בגבולות סבירים של
 * חלון ההקשר של המודל ושל זמן התגובה, ולמנוע עלות/זמן עיבוד מוגזמים על
 * אשכולות ארוכים במיוחד.
 */

'use strict';

const axios = require('axios');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_SOURCE_CHARS = 20000;

/** בונה את ה-prompt לסיכום - מנחה במפורש לעברית פשוטה, בלי עיצוב/תווים
 *  מיוחדים (כדי שהתוצאה תהיה מוכנה להקראה קולית ללא צורך בניקוי נוסף,
 *  ר' sanitizeForSpeech שמופעל בכל זאת כרשת הגנה נוספת בקוד הקורא). */
function buildPrompt(topicTitle, postsText) {
  return [
    'סכם את הנושא הבא מתוך פורום אינטרנטי, בעברית פשוטה וברורה, בכמה משפטים קצרים בלבד (עד כ-5 משפטים).',
    'הסיכום מיועד להשמעה קולית בטלפון בלבד - אין להשתמש בכל עיצוב, כוכביות, מספור, סימני פיסוק מיוחדים או תגי HTML, רק טקסט רגיל וזורם.',
    `כותרת הנושא: ${topicTitle || 'ללא כותרת'}`,
    'תוכן ההודעות בנושא (לפי סדר כרונולוגי):',
    postsText.slice(0, MAX_SOURCE_CHARS)
  ].join('\n\n');
}

/** קריאה בודדת ל-Gemini עם מפתח API יחיד. זורקת שגיאה אם הקריאה נכשלה
 *  (מפתח שגוי/מכסה נוצלה/שגיאת רשת) או אם לא התקבל טקסט סיכום בפועל. */
async function callGeminiOnce(apiKey, prompt) {
  const { data } = await axios.post(
    `${GEMINI_BASE}?key=${encodeURIComponent(apiKey)}`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { timeout: 20000, headers: { 'Content-Type': 'application/json' } }
  );

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    ?.filter(Boolean)
    ?.join(' ')
    ?.trim();

  if (!text) {
    throw new Error('תגובת Gemini לא כללה טקסט סיכום תקין');
  }
  return text;
}

/**
 * מסכם נושא, עם fallback אוטומטי בין כל מפתחות ה-API שסופקו (בסדר שהוזנו
 * ע"י המשתמש) - עוצר בהצלחה הראשונה. אם כל המפתחות נכשלו, זורק שגיאה עם
 * פירוט השגיאה האחרונה שהתקבלה (מועיל לניפוי שגיאות בלוג).
 * @param {string|string[]} apiKeys - מפתח/מפתחות Gemini API של המשתמש.
 * @param {string} topicTitle - כותרת הנושא (להקשר בפרומפט).
 * @param {string} postsText - טקסט מרוכז של כל הודעות הנושא (מנוקה מ-HTML).
 * @returns {Promise<string>} טקסט הסיכום המוכן להקראה.
 */
async function summarizeTopic(apiKeys, topicTitle, postsText) {
  const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('לא סופק אף מפתח Gemini API');
  }
  if (!postsText || !postsText.trim()) {
    throw new Error('אין תוכן טקסטואלי לסיכום');
  }

  const prompt = buildPrompt(topicTitle, postsText);
  let lastErr;
  for (const key of keys) {
    try {
      return await callGeminiOnce(key, prompt);
    } catch (err) {
      lastErr = err;
      const detail = err.response?.data?.error?.message || err.message;
      console.error('[geminiSummarizer] מפתח נכשל, מנסה את המפתח הבא אם קיים:', detail);
    }
  }

  const lastDetail = lastErr?.response?.data?.error?.message || lastErr?.message || 'שגיאה לא ידועה';
  throw new Error(`כל מפתחות ה-AI נכשלו: ${lastDetail}`);
}

module.exports = { summarizeTopic };
