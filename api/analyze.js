// Серверная функция для Vercel: принимает фото + переписку с фронтенда и отдаёт ответ ИИ.
//
// Два бесплатных провайдера по очереди:
//   1) Google Gemini (ключ GEMINI_API_KEY) — лучшее качество, но на бесплатном тарифе бывает «перегружен»;
//   2) Groq, модель Qwen (ключ GROQ_API_KEY) — очень быстрый, подхватывает, если Gemini не ответил.
// Если какого-то ключа нет — этот провайдер просто пропускается.
// Никаких npm-зависимостей не требуется — используется встроенный fetch (Node.js 18+).

var GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash'];
// На Groq сейчас одна модель с поддержкой фото — https://console.groq.com/docs/vision
var GROQ_MODEL = 'qwen/qwen3.8-27b';
var CALL_TIMEOUT_MS = 20000;

function fetchWithTimeout(url, options, ms) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
    .finally(function () { clearTimeout(timer); });
}

async function tryGemini(apiKey, turns, images) {
  var contents = turns.map(function (t, idx) {
    var isLastUser = idx === turns.length - 1 && t.role === 'user';
    var parts = [{ text: String(t.content || '') }];
    if (isLastUser) {
      images.forEach(function (img) {
        parts.push({ inline_data: { mime_type: img.mediaType || 'image/jpeg', data: img.data } });
      });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts: parts };
  });
  var body = JSON.stringify({
    contents: contents,
    generationConfig: { maxOutputTokens: 2048, response_mime_type: 'application/json' }
  });

  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var model = GEMINI_MODELS[i];
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
      ':generateContent?key=' + encodeURIComponent(apiKey);
    try {
      var r = await fetchWithTimeout(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: body
      }, CALL_TIMEOUT_MS);
      var data = await r.json().catch(function () { return null; });
      if (r.ok) {
        var cand = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
        var parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
        var text = parts.map(function (p) { return (p && p.text) || ''; }).join('');
        if (text) return { ok: true, text: text, provider: 'gemini:' + model };
        console.error('Gemini empty [' + model + '] finishReason:', cand && cand.finishReason);
        continue;
      }
      console.error('Gemini error [' + model + ']', r.status, (data && data.error && data.error.message) || '');
      if (r.status === 400) return { ok: false, status: 400, message: (data && data.error && data.error.message) || 'bad request' };
    } catch (e) {
      console.error('Gemini timeout/network [' + model + ']', String((e && e.message) || e));
    }
  }
  return { ok: false, status: 503 };
}

async function tryGroq(apiKey, turns, images) {
  var messages = turns.map(function (t, idx) {
    var isLastUser = idx === turns.length - 1 && t.role === 'user';
    if (!isLastUser || images.length === 0) {
      return { role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '') };
    }
    var content = [{ type: 'text', text: String(t.content || '') }];
    images.forEach(function (img) {
      content.push({ type: 'image_url', image_url: { url: 'data:' + (img.mediaType || 'image/jpeg') + ';base64,' + img.data } });
    });
    return { role: 'user', content: content };
  });
  // Qwen умеет «думать вслух» — просим скрыть рассуждения; если параметр не поддержан, пробуем без него
  var variants = [{ reasoning_format: 'hidden' }, {}];
  for (var v = 0; v < variants.length; v++) {
    try {
      var payload = Object.assign({ model: GROQ_MODEL, messages: messages, temperature: 0.3, max_completion_tokens: 4096 }, variants[v]);
      var r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(payload)
      }, CALL_TIMEOUT_MS);
      var data = await r.json().catch(function () { return null; });
      if (r.ok) {
        var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (text) text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (text) return { ok: true, text: text, provider: 'groq:' + GROQ_MODEL };
        console.error('Groq empty response');
        return { ok: false, status: 502 };
      }
      var msg = (data && data.error && data.error.message) || '';
      console.error('Groq error', r.status, msg);
      if (r.status === 400 && v === 0) continue;   // возможно, не поддержан reasoning_format — пробуем без него
      return { ok: false, status: r.status === 429 ? 429 : 503 };
    } catch (e) {
      console.error('Groq timeout/network', String((e && e.message) || e));
      return { ok: false, status: 503 };
    }
  }
  return { ok: false, status: 503 };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'bad_request', message: 'Method not allowed' });
    return;
  }

  var geminiKey = process.env.GEMINI_API_KEY;
  var groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'No AI API keys set' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  var turns = body && Array.isArray(body.turns) ? body.turns : null;
  var images = body && Array.isArray(body.images) ? body.images : [];
  if (!turns || turns.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'turns is required' });
    return;
  }
  if (images.length > 3) {
    res.status(400).json({ error: 'bad_request', message: 'too many images' });
    return;
  }

  try {
    var result = { ok: false, status: 503 };
    if (geminiKey) result = await tryGemini(geminiKey, turns, images);
    if (!result.ok && result.status !== 400 && groqKey) result = await tryGroq(groqKey, turns, images);

    if (result.ok) {
      console.log('Answered by', result.provider);
      res.status(200).json({ text: result.text });
      return;
    }
    if (result.status === 400) {
      res.status(400).json({ error: 'upstream_error', message: result.message || 'bad request' });
      return;
    }
    if (result.status === 429) {
      res.status(429).json({ error: 'rate_limited', message: 'Rate limited' });
      return;
    }
    res.status(503).json({ error: 'model_overloaded', message: 'All providers busy' });
  } catch (err) {
    console.error('analyze.js crashed:', err);
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
