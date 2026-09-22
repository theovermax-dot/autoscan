// Серверная функция для Vercel: принимает фото + переписку с фронтенда
// и обращается к бесплатному Google Gemini API (Google AI Studio) от имени владельца сайта.
// Ключ берётся из переменной окружения GEMINI_API_KEY.
// Никаких npm-зависимостей не требуется — используется встроенный fetch (Node.js 18+).

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'bad_request', message: 'Method not allowed' });
    return;
  }

  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'GEMINI_API_KEY is not set' });
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
    var contents = turns.map(function (t, idx) {
      var isLastUser = idx === turns.length - 1 && t.role === 'user';
      var parts = [{ text: String(t.content || '') }];
      if (isLastUser && images.length > 0) {
        images.forEach(function (img) {
          parts.push({
            inline_data: {
              mime_type: img.mediaType || 'image/jpeg',
              data: img.data
            }
          });
        });
      }
      return { role: t.role === 'assistant' ? 'model' : 'user', parts: parts };
    });

    var model = 'gemini-flash-latest';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);

    var upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: contents,
        generationConfig: { maxOutputTokens: 2048, response_mime_type: 'application/json' }
      })
    });

    var data = await upstream.json().catch(function () { return null; });

    if (!upstream.ok) {
      var msg = (data && data.error && data.error.message) || ('Upstream error ' + upstream.status);
      console.error('Gemini upstream error', upstream.status, msg);
      if (upstream.status === 429) {
        res.status(429).json({ error: 'rate_limited', message: msg });
        return;
      }
      res.status(upstream.status >= 400 && upstream.status < 500 ? 400 : 502).json({ error: 'upstream_error', message: msg });
      return;
    }

    var candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    var parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    var text = parts.map(function (p) { return (p && p.text) || ''; }).join('');

    if (!text) {
      var reason = candidate && candidate.finishReason;
      console.error('Gemini empty response, finishReason:', reason, JSON.stringify(data));
      res.status(502).json({ error: 'upstream_error', message: 'Empty response from model (finishReason: ' + reason + ')' });
      return;
    }

    res.status(200).json({ text: text });
  } catch (err) {
    console.error('analyze.js crashed:', err);
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
