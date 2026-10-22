const express = require('express');
const app = express();
const __path = process.cwd();
const PORT = process.env.PORT || 8000;
let code = require('./pair'); 

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/code', code);

app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/pair.html')
});

app.use('/settings', async (req, res, next) => {
    res.sendFile(__path + '/settings.html')
});

app.get('/movie', (req, res) => {
    res.sendFile(__path + '/movie-request.html');
});

app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html')
});

app.listen(PORT, () => {
  console.log(`╔═══════════════════════════╗`);
  console.log(`║  DESHAN MD— ONLINE  Port: ${PORT}   ║`);
  console.log(`╚═══════════════════════════╝`);
});

module.exports = app;