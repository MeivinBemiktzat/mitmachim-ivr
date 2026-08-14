/**
 * מודול משותף: שלוחת "צ'אטים אישיים" (הודעות פרטיות) עבור כל אחד מ-5
 * הפורומים הנתמכים (מתמחים טופ / בינת טופ / freeivr / good-link / אוצריא).
 * ==========================================================================
 * כל 5 הפורומים מבוססים NodeBB, וכולם חושפים את אותה שכבת REST תחת api/ -
 * כולל את מנגנון הצ'אטים הפרטיים המובנה של NodeBB (Chats/Messaging, לא PM
 * מבוסס תוסף חיצוני - אומת בפועל מול mitmachim.top, ר' תיעוד למטה).
 * המודול הזה ממומש *פעם אחת* ומיובא בזהות מלאה מכל אחד מ-5 קבצי ה-index.js
 * של הפורומים, כדי שלא יהיו 5 מימושים כמעט-זהים עם סיכון לסטייה ביניהם.
 *
 * ---------------------------------------------------------------------
 * מה אומת בפועל מול שרת חי (mitmachim.top), ומה מבוסס על תיעוד NodeBB
 * הרשמי בלבד וטרם נבדק מול שרת חי - חשוב לבדוק לפני production:
 * ---------------------------------------------------------------------
 *   [אומת בפועל - ע"י המשתמש, מול mitmachim.top בדפדפן, כשמחובר]:
 *     GET {FORUM_BASE}/api/user/{userslug}/chats/
 *       -> { rooms: [ { roomId, roomName, users:[...], unread, teaser:{...},
 *                       lastUser, usernames, chatWithMessage, groupChat,
 *                       messageCount, ... }, ... ] }
 *     זהו הנתיב היחיד שאומת בפועל. כל שאר הנתיבים למטה מבוססים על
 *     המוסכמות הידועות/מתועדות של NodeBB Read/Write API (אותה שיטת cookie+
 *     csrf-token שכבר משמשת בקוד הקיים ב-loginAsUser/authenticatedGet),
 *     ולא נבדקו מול שרת חי - יש לבדוק בסביבת בדיקה לפני הפעלה בפרודקשן!
 *
 *   [CORRECTED after live testing — the previous version of this file used
 *    guessed paths (/api/v3/rooms/{roomId} etc.) that returned "קריאת API
 *    שגויה" (invalid API call) in production. The paths below were pulled
 *    directly from NodeBB's own client-side source
 *    (public/src/client/chats/messages.js in NodeBB/NodeBB on GitHub,
 *    function messages.sendMessage / messages.loadMoreMessages), which is
 *    what the official web UI itself calls - i.e. these are the exact
 *    calls the browser makes, not a documentation guess. The send-message
 *    call (POST /api/chats/{roomId}) is the one that was actually
 *    confirmed live (the failing call in the log was corrected to this
 *    exact path/body). The messages-list call below uses the same
 *    endpoint/params the client's "load more" pagination uses; it has not
 *    been separately confirmed live yet for the *first* page specifically -
 *    please do one more test call end-to-end before relying on it heavily]:
 *
 *     GET  {FORUM_BASE}/api/chats/{roomId}/messages?uid=<uid>&start=<n>&direction=<1|-1>
 *       -> { messages: [ { content, cleanedContent, fromuid, mid/messageId,
 *                           fromUser:{username,displayname,...}, timestamp,
 *                           timestampISO, self, ... }, ... ] }
 *       (uid = the *viewing* user's uid, i.e. the logged-in user; start=0
 *       for the first page, direction=-1 to page further into history -
 *       ר' messages.loadMoreMessages בקוד הקליינט הרשמי)
 *
 *     POST {FORUM_BASE}/api/chats/{roomId}
 *       body: { message: "<טקסט ההודעה>", toMid: "" }
 *       headers: { 'x-csrf-token': <מה-config>, Cookie: userCookie }
 *       (ר' messages.sendMessage בקוד הקליינט הרשמי - זהו הקריאה המדויקת
 *       שהדפדפן עצמו מבצע, לא ניחוש)
 *
 *   [עדיין לא בשימוש במודול הזה, אך תועד למקרה הצורך - עריכה/מחיקה של
 *    הודעה קיימת, מאותו קובץ מקור]:
 *     PUT    {FORUM_BASE}/api/chats/{roomId}/messages/{mid}   body:{message}
 *     DELETE {FORUM_BASE}/api/chats/{roomId}/messages/{messageId}
 *
 * ---------------------------------------------------------------------
 * ממשק המודול - כל פונקציה מקבלת "הקשר פורום" (forumCtx) הבנוי מתוך
 * הקבועים/הפונקציות שכבר קיימים בכל אחד מקבצי ה-index.js:
 * ---------------------------------------------------------------------
 *   createChatFlow({
 *     http,                 // axios instance עם baseURL=FORUM_BASE (קיים)
 *     FORUM_SYSTEM_ID,       // מזהה המערכת ל-userStore (קיים)
 *     loginAsUser,           // (username, password) -> userCookie (קיים)
 *     sanitizeForSpeech,      // (raw) -> string (קיים)
 *     getUserCredentials,      // מיובא מ-userStore.js בקובץ הקורא (קיים)
 *     GoToMainMenu,             // מחלקת השגיאה הפנימית לחזרה לתפריט (קיימת)
 *     MENU_READ_OPTS,            // אפשרויות read סטנדרטיות (קיימות)
 *     navHintMessage,              // רמז ניווט סטנדרטי (קיים)
 *     transcribeViaRecording,       // (recordResult) -> טקסט מתומלל, כאשר
 *                                     recordResult הוא הערך הגולמי שהוחזר
 *                                     מ-call.read(mode='record') (הנתיב
 *                                     האמיתי שימות שמרה את הקובץ בו - ר'
 *                                     ההערה הקריטית ב-voiceSearchFlow
 *                                     הקיים). עוטף ensureRecordingFolder+
 *                                     downloadRecording+transcribeRecording
 *                                     הקיימים, ר' shim בקובץ הקורא למטה
 *     chatRecordSubExtNumber,      // מספר תת-שלוחה קבוע (למשל '10') לשמירת
 *                                    הקלטות תגובה בצ'אט - שונה מ-VOICE_SEARCH
 *                                    (8) כדי לא להתנגש עמו
 *     ensureChatRecordingFolder     // () -> Promise<void> - מוודא/יוצר את
 *                                    תת-שלוחת ההקלטות הייעודית לתגובות
 *                                    צ'אט (מקביל ל-ensureRecordingFolder
 *                                    הקיים עבור voiceSearchFlow, אך עם
 *                                    מספר תת-שלוחה נפרד)
 *   })
 *   מחזיר: { chatsFlow } - פונקציה אסינכרונית async (call) שמהווה את שלוחה 6.
 */

'use strict';

/** בונה את מודול שלוחת הצ'אטים האישיים, סגור (closure) מעל הקשר הפורום
 *  הספציפי שהועבר. ר' תיעוד המודול למעלה למבנה forumCtx המלא. */
function createChatFlow(forumCtx) {
  const {
    http,
    FORUM_SYSTEM_ID,
    loginAsUser,
    sanitizeForSpeech,
    getUserCredentials,
    GoToMainMenu,
    MENU_READ_OPTS,
    navHintMessage,
    transcribeViaRecording,
    chatRecordSubExtNumber,
    ensureChatRecordingFolder
  } = forumCtx;

  /** שולף csrf_token טרי + userCookie מוכן לשימוש, לפי אותה שיטה בדיוק
   *  שמשמשת loginAsUser/authenticatedGet הקיימות - כדי שקריאות ה-Write
   *  API (שליחת הודעה) יעברו אימות CSRF תקין, לא רק אימות session. */
  async function getCsrfTokenWithCookie(userCookie) {
    const { data, headers } = await http.get('/api/config', { headers: { Cookie: userCookie } });
    const csrfToken = data?.csrf_token;
    if (!csrfToken) throw new Error('לא התקבל csrf_token מ-/api/config עבור session המשתמש');
    // NodeBB עשוי לרענן/להאריך את עוגיית ה-session גם כאן (set-cookie) -
    // אם כן, ממזגים אותה עם ה-cookie הקיים כדי לא לאבד ערכים קיימים.
    const setCookie = headers['set-cookie'];
    if (Array.isArray(setCookie) && setCookie.length) {
      const refreshed = setCookie.map((c) => c.split(';')[0]).join('; ');
      return { csrfToken, userCookie: `${userCookie}; ${refreshed}` };
    }
    return { csrfToken, userCookie };
  }

  /** מתחבר בשם המשתמש לפי פרטי ההתחברות השמורים (userStore.js), ומחזיר
   *  { userCookie, userslug, uid } - זורק שגיאה ברורה בכל שלב (אין הרשמה,
   *  התחברות נכשלה) כדי שהמסך הקורא יוכל להשמיע הודעה מתאימה. */
  async function loginForChats(phone) {
    let creds;
    try {
      creds = await getUserCredentials(phone, FORUM_SYSTEM_ID);
    } catch (err) {
      throw new Error(`שגיאה בשליפת פרטי משתמש: ${err.message}`);
    }
    if (!creds) {
      const e = new Error('NO_CREDS');
      e.code = 'NO_CREDS';
      throw e;
    }
    let userCookie;
    try {
      userCookie = await loginAsUser(creds.username, creds.password);
    } catch (err) {
      const e = new Error(`LOGIN_FAILED: ${err.message}`);
      e.code = 'LOGIN_FAILED';
      throw e;
    }
    // userslug/uid לצורך /api/chats/{roomId}/messages (uid) ו-/api/user/{userslug}/chats/
    // (userslug) - נשלף מ-/api/self (נתיב read API סטנדרטי של NodeBB
    // למשתמש המחובר לפי ה-session), כדי לא להסתמך על ניחוש.
    let userslug;
    let uid;
    try {
      const { data: self } = await http.get('/api/self', { headers: { Cookie: userCookie } });
      userslug = self?.userslug;
      uid = self?.uid;
      if (!userslug || !uid) throw new Error('לא התקבל userslug/uid מ-/api/self');
    } catch (err) {
      const e = new Error(`SELF_FAILED: ${err.message}`);
      e.code = 'SELF_FAILED';
      throw e;
    }
    return { userCookie, userslug, uid };
  }

  /** שולף את רשימת חדרי הצ'אט האישיים של המשתמש. ר' תיעוד המודול למעלה -
   *  זהו הנתיב היחיד שאומת בפועל מול mitmachim.top. */
  async function fetchChatRooms(userCookie, userslug) {
    const { data } = await http.get(`/api/user/${encodeURIComponent(userslug)}/chats/`, {
      headers: { Cookie: userCookie }
    });
    return data?.rooms || [];
  }

  /** שולף את היסטוריית ההודעות של חדר צ'אט ספציפי, לפי הנתיב/פרמטרים
   *  המדויקים שקוד הקליינט הרשמי של NodeBB משתמש בהם (messages.loadMoreMessages
   *  ב-public/src/client/chats/messages.js) - start=0 מביא את ההודעות
   *  האחרונות/הראשונות בעמוד הראשון. ר' תיעוד המודול למעלה. */
  async function fetchChatMessages(userCookie, uid, roomId) {
    const { data } = await http.get(`/api/chats/${roomId}/messages`, {
      params: { uid, start: 0, direction: 1 },
      headers: { Cookie: userCookie }
    });
    return data?.messages || [];
  }

  /** שולח הודעת צ'אט חדשה לחדר קיים, בדיוק לפי הקריאה שקוד הקליינט הרשמי
   *  של NodeBB מבצע בפועל (messages.sendMessage ב-
   *  public/src/client/chats/messages.js: api.post(`/chats/${roomId}`,
   *  { message, toMid })) - עם אימות cookie+CSRF (אותה שיטה המשמשת את
   *  /login הקיים). תוקן לאחר בדיקה בפועל שגילתה שהנתיב הקודם
   *  (/api/v3/rooms/{roomId}) שגוי - ר' תיעוד המודול למעלה. */
  async function sendChatMessage(userCookie, roomId, messageText) {
    const { csrfToken, userCookie: freshCookie } = await getCsrfTokenWithCookie(userCookie);
    const { data } = await http.post(`/api/chats/${roomId}`, { message: messageText, toMid: '' }, {
      headers: {
        Cookie: freshCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json'
      },
      validateStatus: (s) => s < 500
    });
    if (data?.status?.code && data.status.code !== 'ok') {
      throw new Error(`שליחת ההודעה נכשלה: ${data.status.message || data.status.code}`);
    }
    if (data?.error || data?.message === '[[error:email-not-confirmed-chat]]') {
      throw new Error(data.message || data.error);
    }
    return data;
  }

  /** שם תצוגה "הצד השני" של חדר צ'אט דו-אישי (לא קבוצתי) - להשמעה קולית
   *  ("צ'אט עם X"). לחדרים קבוצתיים (groupChat=true) נופל בחזרה לשם החדר
   *  עצמו (roomName) אם קיים, או לרשימת שמות המשתמשים (usernames). */
  function roomDisplayName(room) {
    if (room.roomName) return room.roomName;
    if (room.usernames) return room.usernames;
    const other = (room.users || []).find((u) => u && u.isLocal === false) || (room.users || [])[0];
    return other?.displayname || other?.username || 'משתמש לא ידוע';
  }

  /** בונה הודעת הקראה קצרה לפריט אחד ברשימת הצ'אטים (לשלב הבחירה). */
  function buildRoomTeaserMessages(room, index, total) {
    const name = sanitizeForSpeech(roomDisplayName(room));
    const teaserContent = room.teaser?.content ? sanitizeForSpeech(room.teaser.content) : '';
    const unreadLabel = room.unread ? 'הודעות חדשות' : 'נקרא';
    const msgs = [
      { type: 'text', data: `צ'אט ${index + 1} מתוך ${total} - ${name} - ${unreadLabel}`, removeInvalidChars: true }
    ];
    if (teaserContent) {
      msgs.push({ type: 'text', data: `הודעה אחרונה: ${teaserContent}`, removeInvalidChars: true });
    }
    return msgs;
  }

  /** בונה הודעת הקראה להודעה בודדת בתוך חדר צ'אט פתוח. */
  function buildChatMessageMessages(msg, index, total) {
    const authorName = sanitizeForSpeech(msg.fromUser?.displayname || msg.fromUser?.username || 'אנונימי');
    const content = sanitizeForSpeech(msg.cleanedContent || msg.content || '');
    const date = new Date(msg.timestamp || Date.now());
    const dateStr = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    return [
      { type: 'text', data: `הודעה ${index + 1} מתוך ${total}`, removeInvalidChars: true },
      { type: 'text', data: `מאת ${authorName}`, removeInvalidChars: true },
      { type: 'date', data: dateStr },
      { type: 'text', data: content || 'הודעה ללא תוכן טקסטואלי', removeInvalidChars: true }
    ];
  }

  /* ---------- תגובה בהקלטה קולית -> תמלול -> אישור/תיקון ---------- */

  /** מקליטה תגובה, מתמללת אותה, ומריצה לולאת אישור/תיקון: המשתמש שומע את
   *  הטקסט המתומלל ובוחר 1=שליחה, 2=הקלטה מחדש, 0=ביטול. מחזירה את הטקסט
   *  הסופי לשליחה, או null אם בוטל.
   *  הערה: בדיוק כמו ב-voiceSearchFlow הקיים, call.read(mode='record')
   *  מחזיר את הנתיב *האמיתי* שבו ימות שמרה את הקובץ (val_2) - זהו מקור
   *  האמת היחיד להורדה, ולא ניחוש קבוע. transcribeViaRecording (שהועבר
   *  ע"י הקובץ הקורא, ר' תיעוד המודול למעלה) עוטף בדיוק את אותה לוגיקת
   *  נרמול+הורדה+תמלול הקיימת ב-voiceSearchFlow, ומקבלת את הנתיב הגולמי
   *  הזה כפרמטר. */
  async function recordAndConfirmReply(call) {
    try {
      await ensureChatRecordingFolder();
    } catch (err) {
      console.error('[chatFlow] שגיאה בוידוא תיקיית הקלטות תגובה', err.message);
      await call.id_list_message([
        { type: 'text', data: 'שירות ההקלטה אינו זמין כרגע, אנא נסו שוב מאוחר יותר או השתמשו בהקלדת טקסט', removeInvalidChars: true }
      ], { prependToNextAction: true });
      return null;
    }
    for (;;) {
      const recordResult = await call.read([
        { type: 'text', data: 'אנא הקליטו את תוכן ההודעה שברצונכם לשלוח, ובסיום הקישו סולמית', removeInvalidChars: true }
      ], 'record', {
        path: `/${chatRecordSubExtNumber}`,
        no_confirm_menu: true,
        min_length: 1,
        max_length: 60
      });

      let text;
      try {
        text = await transcribeViaRecording(recordResult);
      } catch (err) {
        console.error('[chatFlow] שגיאת תמלול תגובה', err.message);
        const retry = await call.read([
          { type: 'text', data: 'לא ניתן היה לתמלל את ההקלטה, לניסיון חוזר הקישו 1, לביטול הקישו 0', removeInvalidChars: true }
        ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });
        if (retry === '1') continue;
        return null;
      }

      if (!text) {
        const retry = await call.read([
          { type: 'text', data: 'לא זוהה דיבור בהקלטה, לניסיון חוזר הקישו 1, לביטול הקישו 0', removeInvalidChars: true }
        ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });
        if (retry === '1') continue;
        return null;
      }

      const choice = await call.read([
        { type: 'text', data: `זוהה הטקסט הבא: ${sanitizeForSpeech(text)}`, removeInvalidChars: true },
        { type: 'text', data: 'לשליחה הקישו 1, להקלטה מחדש הקישו 2, לביטול הקישו 0', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      if (choice === '1') return text;
      if (choice === '2') continue;
      return null;
    }
  }

  /* ---------- תגובה בהקלדת טקסט (מודול ההקלדה המובנה של ימות) ---------- */

  /** קולטת תגובה בהקלדת טקסט דרך typing_playback_mode='HebrewKeyboard' -
   *  מקלדת רב-הקשה מובנית של ימות המשיח (זהה בעיקרון להקלדת שם משתמש/
   *  סיסמא/מפתח AI הקיימת ב-credentialsEntryFlow/aiKeyEntryFlow, אך במצב
   *  HebrewKeyboard במקום EnglishKeyboard - כדי לאפשר הקלדת תוכן ההודעה
   *  בעברית). מריצה לולאת אישור דומה: 1=שליחה, 2=הקלדה מחדש, 0=ביטול. */
  async function typeAndConfirmReply(call) {
    for (;;) {
      const text = await call.read([
        { type: 'text', data: 'אנא הקישו את תוכן ההודעה באמצעות מקלדת הטלפון, ולאחר מכן הקישו סולמית פעמיים לסיום', removeInvalidChars: true }
      ], 'tap', { max_digits: 300, min_digits: 1, sec_wait: 25, typing_playback_mode: 'HebrewKeyboard' });

      if (!text) {
        return null;
      }

      const choice = await call.read([
        { type: 'text', data: `זוהה הטקסט הבא: ${sanitizeForSpeech(text)}`, removeInvalidChars: true },
        { type: 'text', data: 'לשליחה הקישו 1, להקלדה מחדש הקישו 2, לביטול הקישו 0', removeInvalidChars: true }
      ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

      if (choice === '1') return text;
      if (choice === '2') continue;
      return null;
    }
  }

  /* ---------- זרימת חדר צ'אט פתוח: עיון בהודעות + מענה ---------- */

  async function openRoomFlow(call, userCookie, uid, room) {
    let messages;
    try {
      messages = await fetchChatMessages(userCookie, uid, room.roomId);
    } catch (err) {
      console.error('[chatFlow] שגיאה בשליפת הודעות צ\'אט', err.message);
      return call.id_list_message([
        { type: 'text', data: 'לא ניתן לטעון כרגע את הודעות הצ\'אט, אנא נסו שוב', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    if (messages.length === 0) {
      await call.id_list_message([
        { type: 'text', data: 'אין עדיין הודעות בצ\'אט זה', removeInvalidChars: true }
      ], { prependToNextAction: true });
    } else {
      let i = Math.max(0, messages.length - 1); // מתחילים מההודעה האחרונה (החדשה ביותר)
      let browsing = true;
      while (browsing) {
        const msgs = [
          ...buildChatMessageMessages(messages[i], i, messages.length),
          { type: 'text', data: 'הקישו 9 להודעה הבאה, 7 להודעה הקודמת, 5 להשיב לצ\'אט, 0 לחזרה, כוכבית לתפריט הראשי', removeInvalidChars: true }
        ];
        const key = await call.read(msgs, 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '0' });

        if (key === '9') { if (i + 1 < messages.length) i++; continue; }
        if (key === '7') { if (i > 0) i--; continue; }
        if (key === '5') { browsing = false; continue; }
        if (key === '0' || key === '') return; // חזרה לרשימת הצ'אטים (קורא חוזר לזרימה שקראה לפונקציה הזו)
        if (key === '*') throw new GoToMainMenu();
        continue; // הקשה לא מזוהה - חזרה על אותה הודעה
      }
    }

    // שלב המענה: בחירת שיטת מענה (הקלטה+תמלול, או הקלדת טקסט), אישור/תיקון,
    // ואז שליחה בפועל.
    const replyMethod = await call.read([
      { type: 'text', data: 'להשבה בהקלטה קולית שתתומלל הקישו 1, להשבה בהקלדת טקסט הקישו 2, לביטול הקישו 0', removeInvalidChars: true }
    ], 'tap', { ...MENU_READ_OPTS, max_digits: 1 });

    let finalText = null;
    if (replyMethod === '1') finalText = await recordAndConfirmReply(call);
    else if (replyMethod === '2') finalText = await typeAndConfirmReply(call);
    else return; // ביטול/הקשה אחרת - חזרה לרשימת הצ'אטים

    if (!finalText) {
      return call.id_list_message([
        { type: 'text', data: 'התגובה בוטלה', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    try {
      await sendChatMessage(userCookie, room.roomId, finalText);
    } catch (err) {
      console.error('[chatFlow] שגיאה בשליחת הודעה', err.message);
      return call.id_list_message([
        { type: 'text', data: 'שליחת ההודעה נכשלה, אנא נסו שוב מאוחר יותר', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    return call.id_list_message([
      { type: 'text', data: 'ההודעה נשלחה בהצלחה', removeInvalidChars: true }
    ], { prependToNextAction: true });
  }

  /* ---------- שלוחה 6: רשימת הצ'אטים האישיים ---------- */

  async function chatsFlow(call) {
    let session;
    try {
      session = await loginForChats(call.phone);
    } catch (err) {
      if (err.code === 'NO_CREDS') {
        return call.id_list_message([
          { type: 'text', data: 'מספר הטלפון שלכם אינו רשום לשירות הצ\'אטים האישיים', removeInvalidChars: true },
          { type: 'text', data: 'כדי להירשם, אנא היכנסו לאתר ההרשמה ומלאו את הפרטים שלכם בפורום, או הקישו בתפריט ההגדרות להזנת הפרטים דרך הטלפון', removeInvalidChars: true }
        ], { prependToNextAction: true });
      }
      console.error('[chatFlow] שגיאת התחברות', err.message);
      return call.id_list_message([
        { type: 'text', data: 'לא ניתן היה להתחבר לחשבון שלכם בפורום, אנא ודאו שהפרטים שהזנתם נכונים', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    const { userCookie, userslug, uid } = session;

    let rooms;
    try {
      rooms = await fetchChatRooms(userCookie, userslug);
    } catch (err) {
      console.error('[chatFlow] שגיאה בשליפת רשימת צ\'אטים', err.message);
      return call.id_list_message([
        { type: 'text', data: 'לא ניתן לטעון כרגע את הצ\'אטים שלכם, אנא נסו שוב', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    if (rooms.length === 0) {
      return call.id_list_message([
        { type: 'text', data: 'אין לכם כרגע צ\'אטים אישיים בפורום', removeInvalidChars: true }
      ], { prependToNextAction: true });
    }

    let i = 0;
    for (;;) {
      const msgs = [
        ...buildRoomTeaserMessages(rooms[i], i, rooms.length),
        { type: 'text', data: 'הקישו 9 לצ\'אט הבא, 7 לצ\'אט הקודם, 5 לפתיחת הצ\'אט, 0 לתפריט הראשי', removeInvalidChars: true }
      ];
      const key = await call.read(msgs, 'tap', { ...MENU_READ_OPTS, max_digits: 1, allow_empty: true, empty_val: '5' });

      if (key === '9') { if (i + 1 < rooms.length) i++; continue; }
      if (key === '7') { if (i > 0) i--; continue; }
      if (key === '5' || key === '') { await openRoomFlow(call, userCookie, uid, rooms[i]); continue; }
      if (key === '0' || key === '*') throw new GoToMainMenu();
      continue;
    }
  }

  return { chatsFlow };
}

module.exports = { createChatFlow };
