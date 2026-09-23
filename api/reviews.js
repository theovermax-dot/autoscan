// Серверная функция для Vercel: публичные отзывы о сайте.
// Хранит отзывы в файле data/reviews.json прямо в этом GitHub-репозитории через GitHub API —
// поэтому отдельная база данных не нужна, только токен доступа к репозиторию.
// Ключ берётся из переменной окружения GITHUB_TOKEN (fine-grained personal access token
// с правом "Contents: Read and write" для этого репозитория).

var OWNER = process.env.GITHUB_OWNER || 'theovermax-dot';
var REPO = process.env.GITHUB_REPO || 'autoscan';
var BRANCH = process.env.GITHUB_BRANCH || 'main';
var FILE_PATH = process.env.GITHUB_REVIEWS_PATH || 'data/reviews.json';
var MAX_REVIEWS = 300;

function contentsUrl() {
  return 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH;
}

function githubHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'autoscan-reviews'
  };
}

async function readFile(token) {
  var resp = await fetch(contentsUrl() + '?ref=' + encodeURIComponent(BRANCH), {
    headers: githubHeaders(token)
  });
  if (resp.status === 404) return { sha: null, reviews: [] };
  if (!resp.ok) {
    var errBody = await resp.text().catch(function () { return ''; });
    var err = new Error('github_read_failed: ' + resp.status + ' ' + errBody);
    err.status = resp.status;
    throw err;
  }
  var data = await resp.json();
  var content = '';
  try { content = Buffer.from(data.content || '', 'base64').toString('utf8'); } catch (e) {}
  var reviews = [];
  try {
    reviews = JSON.parse(content);
    if (!Array.isArray(reviews)) reviews = [];
  } catch (e) { reviews = []; }
  return { sha: data.sha, reviews: reviews };
}

async function writeFile(token, reviews, sha) {
  var body = {
    message: 'Новый отзыв на сайте',
    content: Buffer.from(JSON.stringify(reviews, null, 2), 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  return fetch(contentsUrl(), {
    method: 'PUT',
    headers: Object.assign({ 'content-type': 'application/json' }, githubHeaders(token)),
    body: JSON.stringify(body)
  });
}

function sanitizeText(v, max) {
  v = String(v == null ? '' : v);
  v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  v = v.trim();
  if (v.length > max) v = v.slice(0, max);
  return v;
}

module.exports = async function handler(req, res) {
  var token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'server_misconfigured', message: 'GITHUB_TOKEN is not set' });
    return;
  }

  if (req.method === 'GET') {
    try {
      var current = await readFile(token);
      res.status(200).json({ reviews: current.reviews });
    } catch (err) {
      console.error('reviews GET failed:', err);
      res.status(502).json({ error: 'upstream_error', message: String((err && err.message) || err) });
    }
    return;
  }

  if (req.method === 'POST') {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    var name = sanitizeText(body && body.name, 60);
    var text = sanitizeText(body && body.text, 600);
    var rating = Number(body && body.rating);
    if (!isFinite(rating) || rating < 1 || rating > 5) rating = 5;
    rating = Math.round(rating);

    if (!name) {
      res.status(400).json({ error: 'bad_request', message: 'name is required' });
      return;
    }
    if (text.length < 3) {
      res.status(400).json({ error: 'bad_request', message: 'text is too short' });
      return;
    }

    var review = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: name,
      rating: rating,
      text: text,
      date: new Date().toISOString()
    };

    try {
      var attempt = 0;
      var putResp;
      while (attempt < 2) {
        attempt++;
        var current = await readFile(token);
        var reviews = [review].concat(current.reviews).slice(0, MAX_REVIEWS);
        putResp = await writeFile(token, reviews, current.sha);
        if (putResp.ok) break;
        if (putResp.status === 409 && attempt < 2) continue;
        break;
      }
      if (!putResp.ok) {
        var errBody = await putResp.text().catch(function () { return ''; });
        console.error('reviews PUT failed:', putResp.status, errBody);
        res.status(502).json({ error: 'upstream_error', message: 'GitHub write failed: ' + putResp.status });
        return;
      }
      res.status(200).json({ review: review });
    } catch (err) {
      console.error('reviews POST crashed:', err);
      res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
    }
    return;
  }

  res.status(405).json({ error: 'bad_request', message: 'Method not allowed' });
};
