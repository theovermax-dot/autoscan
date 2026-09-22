// Серверная функция для Vercel: принимает фото + переписку с фронтенда
// и обращается к Anthropic API от имени владельца сайта (по ключу из переменной окружения).
// Никаких npm-зависимостей не требуется — используется встроенный fetch (Node.js 18+).

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'bad_request', message: 'Method not allowed' });
    return;
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', message: 'ANTHROPIC_API_KEY is not set' });
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
    var messages = turns.map(function (t, idx) {
      var isLastUser = idx === turns.length - 1 && t.role === 'user';
      if (isLastUser && images.length > 0) {
        var content = images.map(function (img) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType || 'image/jpeg',
              data: img.data
            }
          };
        });
        content.push({ type: 'text', text: String(t.content || '') });
        return { role: 'user', content: content };
      }
      return { role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '') };
    });

    var upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        messages: messages
      })
    });

    var data = await upstream.json().catch(function () { return null; });

    if (!upstream.ok) {
      var msg = (data && data.error && data.error.message) || ('Upstream error ' + upstream.status);
      res.status(upstream.status >= 400 && upstream.status < 500 ? 400 : 502).json({ error: 'upstream_error', message: msg });
      return;
    }

    var blocks = (data && data.content) || [];
    var text = blocks.map(function (b) { return (b && b.text) || ''; }).join('');

    res.status(200).json({ text: text });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
