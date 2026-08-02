"""
תמלול קול - שלוחה 4 (חיפוש קולי)
====================================
פונקציית Vercel Python נפרדת מהמערכת הראשית (Node.js), אחראית אך ורק על
תמלול קובץ הקלטה (wav) לטקסט. הקוד ב-api/yemot/index.js (Node.js) מוריד את
ההקלטה מימות ושולח את בייטי ה-wav הגולמיים ל-endpoint הזה בבקשת POST.

שיטת התמלול: ספריית SpeechRecognition (PyPI), עם recognize_google() -
זו שיטת Google Web Speech API עם מפתח ברירת מחדל המוטמע בספרייה עצמה,
ולכן אינה דורשת הנפקת API key או חשבון Google Cloud. חשוב לדעת: זהו
שימוש לא-רשמי במפתח פנימי, ולכן אין ערבות רשמית לזמינות/יציבות ארוכת-טווח
מצד גוגל - מתאים לפרויקט בהיקף כזה, אך לא לשירות production בקנה מידה גדול.

ריפוד השקט: לפני שליחת האודיו לתמלול, מוסיפים חצי שנייה של שקט בתחילת
ובסוף ההקלטה (כפי שהתבקש) - כדי שהתמלול לא "יבלע" חצאי מילים בקצוות
ההקלטה. זה נעשה כאן (בפייתון) על בייטי ה-wav שהתקבלו, ולא בצד ימות - אין
אפשרות ב-type='record' של ימות להוסיף שקט לתוך ההקלטה עצמה.
"""

import io
import json

import speech_recognition as sr
from pydub import AudioSegment

# שפת התמלול - עברית. ניתן לשנות ל-'en-US' וכו' אם יידרש בעתיד.
TRANSCRIBE_LANGUAGE = 'he-IL'

# משך ריפוד השקט לפני/אחרי ההקלטה (מילישניות)
SILENCE_PADDING_MS = 500


def pad_with_silence(wav_bytes: bytes) -> bytes:
    """מוסיף שקט לפני ואחרי קובץ wav, ומחזיר בייטים של wav חדש."""
    audio = AudioSegment.from_wav(io.BytesIO(wav_bytes))
    silence = AudioSegment.silent(duration=SILENCE_PADDING_MS, frame_rate=audio.frame_rate)
    padded = silence + audio + silence
    out = io.BytesIO()
    padded.export(out, format='wav')
    return out.getvalue()


def transcribe_wav_bytes(wav_bytes: bytes) -> str:
    """מתמלל בייטי wav לטקסט. מחזיר מחרוזת ריקה אם לא זוהה דיבור."""
    padded_bytes = pad_with_silence(wav_bytes)

    recognizer = sr.Recognizer()
    with sr.AudioFile(io.BytesIO(padded_bytes)) as source:
        audio_data = recognizer.record(source)

    try:
        return recognizer.recognize_google(audio_data, language=TRANSCRIBE_LANGUAGE)
    except sr.UnknownValueError:
        # לא זוהה דיבור בהקלטה - לא שגיאה, פשוט אין תוצאה
        return ''
    except sr.RequestError as exc:
        raise RuntimeError(f'שירות התמלול של גוגל לא זמין כרגע: {exc}') from exc


# --- Vercel Python serverless handler (BaseHTTPRequestHandler convention) ---
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            wav_bytes = self.rfile.read(content_length)

            if not wav_bytes:
                self._send_json(400, {'error': 'לא התקבל קובץ אודיו'})
                return

            text = transcribe_wav_bytes(wav_bytes)
            self._send_json(200, {'text': text})

        except Exception as exc:  # noqa: BLE001 - צריך להחזיר כל שגיאה כ-JSON ל-Node.js
            self._send_json(500, {'error': str(exc)})

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
