/**
 * Yemot IVR Response Builder
 * בונה תגובות בפורמט מודול API של ימות המשיח
 *
 * פורמט תגובה מקובל:
 *   id_list_message=v:<tts_text>,
 *   id_list_ask=apiDtmf,<digits_count>,<callback_url>,
 *   stop_call
 */

const BASE_URL = process.env.API_BASE_URL || '';

/**
 * השמע טקסט TTS
 */
function sayText(text) {
  if (!text || !text.trim()) return '';
  const clean = sanitize(text);
  return `id_list_message=v:${clean},\n`;
}

/**
 * בנה תפריט + קליטת מקש
 * @param {string[]} optionLines - ['1 פוסטים', '2 נושאים']
 * @param {string} nextStep - שלב הבא
 * @param {object} stateOverride - פרמטרים לשלב הבא
 * @param {object} ctx - הקשר נוכחי
 */
function sayMenu(optionLines, nextStep, stateOverride, ctx) {
  const menuText = optionLines.map(line => {
    const [key, ...rest] = line.split(' ');
    return `לחץ ${key} ל${rest.join(' ')}`;
  }).join('. ');

  const url = buildUrl(nextStep, stateOverride, ctx);
  return (
    sayText(menuText) +
    `id_list_ask=apiDtmf,1,${url},\n`
  );
}

/**
 * מעבר אוטומטי לשלב הבא (ללא קליטת מקש)
 * ימות תתקשר מיד ל-URL
 */
function askWithState(nextStep, stateOverride, ctx) {
  const url = buildUrl(nextStep, stateOverride, ctx);
  // digits=0 = ימות לא תחכה ללחיצה, תפנה מיד
  return `id_list_ask=apiDtmf,0,${url},\n`;
}

/**
 * ניתוק
 */
function endCall() {
  return `stop_call\n`;
}

/* ─── עזר ─────────────────────────────────────────────────────────────── */

function buildUrl(step, override, ctx) {
  const state = {
    step,
    index:       '0',
    topicId:     ctx.topicId || '',
    categoryId:  ctx.categoryId || '',
    parentCatId: ctx.parentCatId || '',
    postId:      ctx.postId || '',
    ...Object.fromEntries(
      Object.entries(override || {}).map(([k, v]) => [k, String(v)])
    ),
  };

  // הסר ערכים ריקים
  Object.keys(state).forEach(k => {
    if (!state[k]) delete state[k];
  });

  

  const url = `${BASE_URL}/api?${new URLSearchParams(state).toString()}`;

console.log('Generated URL:', url);

return url;
}

function sanitize(text) {
  return text
    .replace(/[|,\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { sayText, sayMenu, askWithState, endCall };
