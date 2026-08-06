// 3-line integration:
const express = require('express');
const { sentinelMiddleware } = require('sentinel-limiter'); // or '../src' inside this repo

const app = express();
app.use(sentinelMiddleware('./sentinel.config.json'));

app.get('/api/search', (req, res) => res.json({ results: [] }));
app.listen(3000);
