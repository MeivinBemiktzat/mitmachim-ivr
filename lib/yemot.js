/**
 * Yemot IVR Response Builder
 */

const BASE_URL = process.env.API_BASE_URL || '';

function sayText(text) {
  if (!text || !text.trim()) return '';

  const clean = sanitize(text);

  return `id_list_message=v:${clean},`;
}

function sayMenu(optionLines, nextStep, stateOverride, ctx) {
  const menuText = optionLines
    .map(line => {
      const [key, ...rest] = line.split(' ');
      return `לחץ ${key} ל${rest.join(' ')}`;
    })
    .join('. ');

  const url = buildUrl(nextStep, stateOverride, ctx);

  return (
    sayText(menuText) +
    `id_list_ask=apiDtmf,1,${url},`
  );
}

function askWithState(nextStep, stateOverride, ctx) {
  const url = buildUrl(nextStep, stateOverride, ctx);

  return `id_list_ask=apiDtmf,0,${url},`;
}

function endCall() {
  return `stop_call,`;
}

/* ---------- עזר ---------- */

function buildUrl(step, override, ctx) {
  const state = {
    step,
    index: '0',
    topicId: ctx.topicId || '',
    categoryId: ctx.categoryId || '',
    parentCatId: ctx.parentCatId || '',
    postId: ctx.postId || '',
    ...Object.fromEntries(
      Object.entries(override || {}).map(([k, v]) => [k, String(v)])
    ),
  };

  Object.keys(state).forEach(k => {
    if (!state[k]) {
      delete state[k];
    }
  });

  const url =
    `${BASE_URL}/api?${new URLSearchParams(state).toString()}`;

  console.log('Generated URL:', url);

  return url;
}

function sanitize(text) {
  return text
    .replace(/[|,\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  sayText,
  sayMenu,
  askWithState,
  endCall,
};
